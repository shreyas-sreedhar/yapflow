# Deploying the Yapflow ASR server

Runs the dictation ASR on a Jetson as a systemd service that starts on boot.

**Target hardware:** Jetson Orin Nano (8GB), JetPack 6.x — Ubuntu 22.04, glibc
2.35, Python 3.10+.

**The original Jetson Nano will not work.** JetPack 4.x is Ubuntu 18.04 with
glibc 2.27 and Python 3.6, and `moonshine-voice` publishes no aarch64 wheel that
old — pip falls through to a source build that won't succeed. `install.sh` checks
for this and refuses rather than half-installing. That board would need a
different ASR backend (whisper.cpp built from source, or a hand-built ONNX
Runtime), which this server isn't written for.

## Install

From a checkout on the Jetson:

```bash
sudo ./deploy/install.sh
```

That will:

1. Verify the architecture, glibc, and Python version.
2. Create a `yapflow` system account with no login shell.
3. Copy the runtime modules to `/opt/yapflow/app`.
4. Build a virtualenv at `/opt/yapflow/venv` and install dependencies.
5. Pre-download the Moonshine English model into `/var/lib/yapflow/models`.
6. Install, enable, and start the systemd unit.

Re-running it updates the code and restarts the service.

### Why a venv and not `pip install --break-system-packages`

Earlier versions of `requirements.txt` recommended that flag. Don't. Ubuntu
22.04's system Python is PEP 668 externally-managed, and JetPack installs its own
NVIDIA-built Python packages into it. Installing over that can break CUDA tooling
in ways that are unpleasant to diagnose. The venv costs nothing.

### Why the model is pre-downloaded

`get_model_for_language()` downloads on first use. Without pre-downloading, a
Jetson that boots without internet has a dictation that hangs instead of
transcribing, and the first dictation after any fresh install is slow. The
installer does it once, while the network is known to be up.

## Operating it

```bash
systemctl status yapflow           # is it up?
journalctl -u yapflow -f           # follow the log
sudo systemctl restart yapflow     # graceful: SIGTERM is handled
sudo systemctl stop yapflow
```

Health-check from the Mac without dictating — the server answers `ping` with
`pong` on the same socket:

```bash
nc -z jetson.local 8765 && echo "port open"
```

```python
# A real protocol-level check
import asyncio, json, websockets
async def check():
    async with websockets.connect("ws://jetson.local:8765") as ws:
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(json.dumps({"type": "ping"}))
        print(await ws.recv())          # {"type": "pong"}
asyncio.run(check())
```

## Latency: set the power mode

Do this. The Orin Nano's default power profile throttles inference noticeably,
and max-performance mode is free latency:

```bash
sudo nvpmodel -m 0
sudo jetson_clocks
```

`nvpmodel` persists across reboots; `jetson_clocks` does not, so add it to the
unit or a boot script if you want it always on.

## Configuration

All via environment variables, set in the unit file or an `EnvironmentFile`:

| Variable | Default | Notes |
|---|---|---|
| `YAPFLOW_HOST` | `0.0.0.0` | Bind address |
| `YAPFLOW_PORT` | `8765` | Must match the Mac app |
| `YAPFLOW_SECRET` | unset | Shared secret; unset disables the check |
| `YAPFLOW_ASR_MODEL` | `SMALL_STREAMING` | Or `TINY_STREAMING` / `MEDIUM_STREAMING` |
| `YAPFLOW_ASR_UPDATE_INTERVAL` | `0.3` | Seconds between partial transcript updates |
| `YAPFLOW_LOG_LEVEL` | `INFO` | |
| `MOONSHINE_VOICE_CACHE` | set by the unit | Where model files live |

### Setting a shared secret

Unit files are world-readable, so use an `EnvironmentFile`:

```bash
sudo mkdir -p /etc/yapflow
echo "YAPFLOW_SECRET=$(openssl rand -hex 24)" | sudo tee /etc/yapflow/yapflow.env
sudo chmod 600 /etc/yapflow/yapflow.env
sudo chown yapflow:yapflow /etc/yapflow/yapflow.env
```

Uncomment the `EnvironmentFile` line in `yapflow.service`, then set the same
value as `YAPFLOW_SECRET` in the Mac app's environment. A mismatch closes the
connection with code 4003, and the Mac reports it rather than retrying forever.

### Choosing a model size

`SMALL_STREAMING` (123M params, 7.84% WER) is the default. It was chosen when
this box also hosted Gemma 3 4B; that's gone, so roughly 3-4GB is free and
`MEDIUM_STREAMING` (245M params, 6.65% WER — better than Whisper Large v3) is
affordable.

Worth measuring rather than assuming. Set `YAPFLOW_ASR_MODEL=MEDIUM_STREAMING`,
restart, dictate the same set of utterances, and compare `asr_finalize_ms` p95
in the Mac's metrics dashboard along with accuracy by eye. Keep the winner.

A typo in this variable raises on startup rather than silently falling back to
the library default — a silent fallback previously meant latency measurements
could be attributed to a model you weren't actually running.

## Mac app configuration

The Mac app finds the server at `ws://jetson.local:8765` by default, which
assumes the board advertises itself over mDNS (Avahi, installed by default on
JetPack). Override with:

```bash
export YAPFLOW_JETSON_HOST=192.168.1.50
export YAPFLOW_JETSON_PORT=8765
export YAPFLOW_SECRET=...              # if configured on the Jetson
```

The Mac connects once at app start and keeps the socket open, reconnecting with
backoff. It does not connect per dictation.

## Troubleshooting

**Service won't start.** `journalctl -u yapflow -n 50`. Most likely a bad
`YAPFLOW_ASR_MODEL` (raises `ValueError` listing the valid values) or the model
cache not being readable by the `yapflow` user.

**Service starts but times out on the first dictation.** The model download
didn't complete during install. Re-run:

```bash
sudo MOONSHINE_VOICE_CACHE=/var/lib/yapflow/models \
  /opt/yapflow/venv/bin/python -m moonshine_voice.download --language en
sudo chown -R yapflow:yapflow /var/lib/yapflow
sudo systemctl restart yapflow
```

**Mac can't reach it.** Check `jetson.local` resolves (`ping jetson.local`); if
not, use the IP via `YAPFLOW_JETSON_HOST`. Confirm the server is bound to
`0.0.0.0` and not `127.0.0.1`.

**Restart takes 90 seconds.** That means SIGTERM isn't being handled and systemd
is falling back to SIGKILL — you're running a build from before the signal
handler was added. Update.

**Dictation loses everything before a pause.** A build from before the transcript
accumulator was fixed. `jetson-server/test_asr_accumulation.py` covers it.

## Running from a checkout, without systemd

For development:

```bash
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python -m moonshine_voice.download --language en
./venv/bin/python server.py
```

## Tests

Neither suite needs a model, a GPU, or a Jetson — the ASR library is stubbed:

```bash
python3 test_asr_accumulation.py   # transcript accumulator
python3 test_protocol.py           # real server, real WebSocket client
```
