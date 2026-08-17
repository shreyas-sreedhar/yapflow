# Yapflow

Local push-to-talk dictation. Hold a hotkey, speak, and the cleaned-up text lands at the cursor — without streaming the microphone to someone else's API.

Two pieces on the same network: a Mac Electron app, and a WebSocket server meant to run on a Jetson (or any machine that can load the models). Personal tool, not a product. No installer, no account.

## What it does

1. Hold the hotkey (Right-Command by default). The Mac app captures the mic.
2. Audio is streamed to the server over a WebSocket.
3. [Moonshine](https://github.com/usefulsensors/moonshine) transcribes as you speak and emits partials.
4. A Gemma 3 4B pass via [Ollama](https://ollama.com) punctuates, drops filler, and applies a small personal dictionary.
5. A Swift helper writes the result to the clipboard and synthesizes Cmd+V so it works in whatever app is in front.

## Layout

```
macos-app/        Electron client (hotkey, mic, inject-at-cursor)
jetson-server/    Python WebSocket server (Moonshine + Ollama polish)
```

## Run the server

On the machine that will do inference (Jetson Orin Nano is the intended host):

```bash
cd jetson-server
pip install -r requirements.txt
# Jetson system Python often needs: pip install -r requirements.txt --break-system-packages
python server.py
```

Defaults (override with env vars of the same name):

| Variable | Default | Purpose |
| --- | --- | --- |
| `YAPFLOW_HOST` | `0.0.0.0` | Bind address |
| `YAPFLOW_PORT` | `8765` | WebSocket port |
| `YAPFLOW_SECRET` | unset | Optional shared secret; must match the Mac app |
| `YAPFLOW_ASR_MODEL` | `SMALL_STREAMING` | Moonshine arch |
| `YAPFLOW_LLM_MODEL` | `gemma3:4b` | Ollama model for polish |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama |

Ollama needs to be running locally with the polish model available (`ollama pull gemma3:4b` on first run, or the server will pull it).

## Run the Mac app

```bash
cd macos-app
npm install
npm run rebuild   # native modules: opus, sqlite, uiohook
npm start
```

The client looks for `ws://jetson.local:8765` unless you set `YAPFLOW_JETSON_HOST` / `YAPFLOW_JETSON_PORT`. If you set `YAPFLOW_SECRET` on the server, set the same value here.

## Notes

- One WebSocket per dictation. The server warms Moonshine and Gemma at startup so the first utterance is not a cold start.
- There is no packaged installer. Point the app at a host you control.
