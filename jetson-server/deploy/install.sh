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

# Two flags here are load-bearing and easy to get wrong:
#
#   --stt         Without a mode flag the module prints usage and exits 1, which
#                 under `set -e` aborts the install after the venv exists but
#                 before systemd is configured. The upstream README's
#                 `--language en` example predates this requirement.
#
#   --model-arch  Without it, get_model_for_language() resolves to
#                 available_models[0], NOT the arch the server will ask for. The
#                 wrong weights get cached, and the server then downloads the
#                 right ones at first use — silently defeating the whole point of
#                 pre-downloading.
#
# The arch number must match config.MOONSHINE_MODEL_ARCH. Read it from the
# library's own enum rather than hardcoding, so this can't drift if upstream
# renumbers: ModelArch is the single source of truth on both sides.

ASR_MODEL="${YAPFLOW_ASR_MODEL:-SMALL_STREAMING}"
log "Pre-downloading the Moonshine English model ($ASR_MODEL) into $MODEL_CACHE"
mkdir -p "$MODEL_CACHE"

MODEL_ARCH="$("$VENV_DIR/bin/python" -c "
import sys
from moonshine_voice import ModelArch
try:
    print(int(ModelArch['$ASR_MODEL']))
except KeyError:
    # __members__, not dir(): ModelArch is an IntEnum, so dir() also lists every
    # inherited int method (bit_count, as_integer_ratio, …).
    print(f\"'$ASR_MODEL' is not a valid ModelArch. Valid: {', '.join(ModelArch.__members__)}\", file=sys.stderr)
    sys.exit(1)
")" || die "invalid YAPFLOW_ASR_MODEL"

log "Resolved $ASR_MODEL to model-arch $MODEL_ARCH"
MOONSHINE_VOICE_CACHE="$MODEL_CACHE" "$VENV_DIR/bin/python" -m moonshine_voice.download \
  --language en --stt --model-arch "$MODEL_ARCH"

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

PORT="${YAPFLOW_PORT:-8765}"

# `systemctl is-active` is useless as a readiness check here: the unit is
# Type=simple, so systemd reports active the instant it forks, long before the
# model is loaded and the socket is bound. A server that dies three seconds into
# loading weights would have reported "Done", and Restart=always would then hide
# the crash loop behind a service that looks up.
#
# So probe the actual protocol: connect, handshake, ping, expect pong. That's the
# only check that proves the thing works.
log "Waiting for the server to accept connections on port $PORT"

READY=0
for _ in $(seq 1 90); do
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    printf '\n'
    systemctl status "$SERVICE_NAME" --no-pager || true
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
    die "service exited during startup — see the log above"
  fi

  if MOONSHINE_VOICE_CACHE="$MODEL_CACHE" "$VENV_DIR/bin/python" - "$PORT" <<'PROBE' 2>/dev/null
import asyncio, json, sys
import websockets

async def probe(port):
    async with websockets.connect(f"ws://127.0.0.1:{port}", open_timeout=3) as ws:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(json.dumps({"type": "ping"}))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
        return reply.get("type") == "pong"

try:
    sys.exit(0 if asyncio.run(probe(int(sys.argv[1]))) else 1)
except Exception:
    sys.exit(1)
PROBE
  then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  printf '\n'
  systemctl status "$SERVICE_NAME" --no-pager || true
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  die "server never answered a ping — see the log above.
     If a shared secret is configured via EnvironmentFile, this probe cannot
     authenticate and will always fail; that case is expected, check the log
     for 'Ready — listening for dictations' instead."
fi

log "Server answered a ping — it's up and serving"

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
