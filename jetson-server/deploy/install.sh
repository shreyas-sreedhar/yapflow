#!/usr/bin/env bash
#
# Installs the Yapflow ASR server as a systemd service on a Jetson.
#
# Target: Jetson Orin Nano, JetPack 6.x (Ubuntu 22.04, glibc 2.35, Python 3.10+).
#
# Run from anywhere:  sudo ./deploy/install.sh
# Re-running is safe: it updates the code and restarts the service.
#
# Why a venv rather than `pip install --break-system-packages`, which this
# project's requirements.txt used to recommend: Ubuntu 22.04's system Python is
# PEP 668 externally-managed, and JetPack ships its own NVIDIA-built Python
# packages into it. Installing over that risks breaking CUDA tooling in ways that
# are painful to unpick. A venv costs nothing here.

set -euo pipefail

INSTALL_ROOT=/opt/yapflow
APP_DIR="$INSTALL_ROOT/app"
VENV_DIR="$INSTALL_ROOT/venv"
MODEL_CACHE=/var/lib/yapflow/models
SERVICE_USER=yapflow
SERVICE_NAME=yapflow

# Resolve the jetson-server directory containing this script, so the script works
# regardless of the working directory it's invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (use sudo)"
[[ -f "$SOURCE_DIR/server.py" ]] || die "cannot find server.py next to deploy/ — run this from a checkout"

# --- Sanity-check the platform -------------------------------------------------
#
# moonshine-voice publishes manylinux_2_34_aarch64 and manylinux_2_31_aarch64
# wheels. On anything older there is no wheel and pip falls through to a source
# build that won't succeed. The original Jetson Nano (JetPack 4.x, Ubuntu 18.04,
# glibc 2.27, Python 3.6) is the case this catches.

ARCH="$(uname -m)"
[[ "$ARCH" == "aarch64" ]] || log "WARNING: architecture is $ARCH, not aarch64 — expected a Jetson"

GLIBC_VERSION="$(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)"
if [[ "$(printf '%s\n2.31\n' "$GLIBC_VERSION" | sort -V | head -1)" != "2.31" ]]; then
  die "glibc $GLIBC_VERSION is too old for the moonshine-voice aarch64 wheels (need >= 2.31).
     This is almost certainly an original Jetson Nano on JetPack 4.x. That board
     cannot run this server as written — it needs a different ASR backend."
fi

command -v python3 >/dev/null || die "python3 not found"
PYTHON_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
log "Platform: $ARCH, glibc $GLIBC_VERSION, Python $PYTHON_VERSION"

if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  die "Python $PYTHON_VERSION is too old — moonshine-voice needs >= 3.8"
fi

# --- Dependencies -------------------------------------------------------------

log "Installing python3-venv (needed to create the virtualenv)"
apt-get update -qq
apt-get install -y -qq python3-venv >/dev/null

# --- Service account ----------------------------------------------------------

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service account '$SERVICE_USER'"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
else
  log "Service account '$SERVICE_USER' already exists"
fi

# Audio group isn't needed — the microphone is on the Mac, not here. Deliberately
# not added.

# --- Copy the application -----------------------------------------------------

log "Installing application to $APP_DIR"
mkdir -p "$APP_DIR"
# Only the runtime modules. Tests and deploy scripts don't belong on the box.
for f in server.py asr.py polish.py config.py requirements.txt; do
  install -m 0644 "$SOURCE_DIR/$f" "$APP_DIR/$f"
done

# --- Virtualenv ---------------------------------------------------------------

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  log "Creating virtualenv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

log "Installing Python dependencies"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# --- Pre-download the model ---------------------------------------------------
#
# Without this, get_model_for_language() downloads on first use — so a Jetson
# that boots without internet has a dictation that hangs, and the very first
# dictation after any fresh install is slow. Do it now, at install time, when the
# network is known to be up.

log "Pre-downloading the Moonshine English model into $MODEL_CACHE"
mkdir -p "$MODEL_CACHE"
MOONSHINE_VOICE_CACHE="$MODEL_CACHE" "$VENV_DIR/bin/python" -m moonshine_voice.download --language en

# The download runs as root; the service runs as $SERVICE_USER and must be able
# to read it.
chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/yapflow
chmod -R u=rwX,go=rX /var/lib/yapflow

# --- systemd ------------------------------------------------------------------

log "Installing systemd unit"
install -m 0644 "$SCRIPT_DIR/yapflow.service" /etc/systemd/system/yapflow.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# --- Verify -------------------------------------------------------------------

log "Waiting for the service to come up"
for _ in $(seq 1 60); do
  if systemctl is-active --quiet "$SERVICE_NAME"; then break; fi
  sleep 1
done

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  printf '\n'
  systemctl status "$SERVICE_NAME" --no-pager || true
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  die "service failed to start — see the log above"
fi

PORT="$(grep -oP 'YAPFLOW_PORT.*?"\K[0-9]+' "$APP_DIR/config.py" 2>/dev/null || echo 8765)"

cat <<EOF

==> Done.

    Service:  systemctl status $SERVICE_NAME
    Logs:     journalctl -u $SERVICE_NAME -f
    Listening on port $PORT (all interfaces)

    From your Mac, confirm reachability:
      nc -z $(hostname).local $PORT && echo reachable

    For the lowest latency, put the board in max-performance mode. The default
    power profile throttles inference noticeably and this costs nothing:
      sudo nvpmodel -m 0 && sudo jetson_clocks

EOF
