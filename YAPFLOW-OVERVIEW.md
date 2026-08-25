# Yapflow — Project Overview

> A living context document describing everything built so far. Use this to brief
> other people or to seed a fresh conversation. Last updated: 2026-07-01.

---

## 1. What Yapflow Is

Yapflow is a **push-to-talk voice dictation system** with a **Mac client + Jetson server** split.

You hold a hotkey (Right-Command by default), speak naturally, and polished text
appears at your cursor in whatever app you're in. It runs entirely on your own
hardware over your home network — **no cloud, no telemetry.**

- **Mac client (Electron)** — captures mic audio, streams it to the Jetson,
  shows live partial transcripts as you speak, and injects the final polished
  text at the cursor. Also keeps a local SQLite DB of corrections (personal
  dictionary) and per-dictation metrics.
- **Jetson server (Python)** — receives audio over WebSocket, runs streaming
  speech-to-text (Moonshine v2), then runs a single-pass LLM cleanup
  (Gemma 3 4B via Ollama). Holds no persistent state beyond the resident models.

**Headline goal:** minimize *release-to-text latency* (hotkey release → polished
text on screen), instrumented per-stage so bottlenecks are visible.

---

## 2. Tech Stack at a Glance

| Layer | Technology |
|-------|-----------|
| Mac app framework | **Electron** ^31 (Node.js main + hidden renderer) |
| Global hotkey | **uiohook-napi** ^1.5.5 (libuiohook / CGEventTap) |
| Audio capture | **Web Audio API** (`getUserMedia` + AudioWorklet) in hidden renderer |
| Audio codec (optional) | **@discordjs/opus** ^0.9.0 (lazy-loaded; off by default) |
| Text injection | Compiled **Swift** helper (`inject.swift`) — clipboard + CGEvent |
| Local storage | **better-sqlite3** ^11 |
| Transport | **WebSocket** — `ws` ^8.18 (Mac) / `websockets` ≥12 (Jetson) |
| Speech-to-text (ASR) | **Moonshine v2** (`moonshine-voice` ≥0.0.49) — streaming |
| LLM polish | **Gemma 3 4B** via **Ollama** (`ollama` ≥0.3) |
| Numerics | **numpy** ≥1.24 (int16↔float32 PCM) |

> **Not used:** TensorRT, ONNX, Whisper, faster-whisper, PyTorch, vLLM.
> ASR is pure `moonshine-voice`; LLM is served by Ollama.

---

## 3. Repository Layout

```
yapflow/
├── .gitignore                 # ignores venv/, docs/, CLAUDE.MD, readme.*, node_modules, helpers/*
├── .claude/settings.local.json
├── jetson-server/             # Python WebSocket server (ARM64 Linux / Jetson)
│   ├── server.py              # WebSocket server + per-session orchestration
│   ├── asr.py                 # Moonshine v2 streaming ASR wrapper
│   ├── polish.py              # Gemma 3 4B polish via Ollama
│   ├── config.py              # Config + env-var overrides
│   └── requirements.txt
└── macos-app/                 # Electron client (macOS)
    ├── package.json
    ├── src/
    │   ├── main.js            # Main process: hotkey → capture → WS → inject → metrics
    │   ├── preload.js         # IPC bridge (window.flowLocal)
    │   ├── lib/
    │   │   ├── hotkey.js       # Global hold-to-dictate hotkey
    │   │   ├── wsClient.js     # WebSocket client (one connection per dictation)
    │   │   ├── textInject.js   # Clipboard-paste + synthetic keystroke injection
    │   │   ├── corrections.js  # SQLite: corrections + sessions tables
    │   │   ├── timing.js       # Per-stage latency marks
    │   │   └── metrics.js      # Read-only aggregate queries for dashboard
    │   ├── renderer/
    │   │   ├── capture.html         # Hidden window hosting the audio graph
    │   │   ├── audioCapture.js      # getUserMedia + resample to 16kHz int16
    │   │   └── captureProcessor.js  # AudioWorklet processor (off-thread capture)
    │   └── dashboard/
    │       ├── index.html      # Metrics dashboard UI (self-contained, no CDN)
    │       ├── dashboard.js     # Hand-rolled SVG charts
    │       └── preload.js
    ├── helpers/
    │   ├── inject.swift        # Swift source: clipboard/CGEvent/frontmost-app
    │   └── inject              # Compiled binary (build: swiftc inject.swift -o inject)
    └── assets/tray-icon.png
```

> **Gitignored (local-only) docs:** `docs/yapflow-master-plan.md` and `CLAUDE.md`
> hold the full spec and architecture-decision notes. Code cross-references them
> by section number (e.g. "Section 4", "Decision 1").

---

## 4. End-to-End Dictation Flow

```
Press Right-Cmd
  → hotkey.js emits 'hotkey-down'
  → main.js startDictation(): opens DictationConnection (WebSocket), stamps timing,
    reads frontmost app bundle id, fetches learned terms for that app
  → renderer startCapture(): getUserMedia (mic indicator on) → AudioWorklet
  → audio resampled to 16kHz mono int16 → IPC 'audio-chunk' → main.js → WebSocket

Jetson server:
  → 'start' msg validates optional shared secret, opens Moonshine StreamingSession
  → PCM frames fed to Moonshine → partial/final callbacks → 'partial' msgs to Mac
  → Mac injects partials live via synthetic keystrokes (delta typing)

Release Right-Cmd
  → 'hotkey-up' → renderer stopCapture() (releases mic, keeps audio graph alive)
  → main.js endDictation() → sends 'end_of_utterance'
  → server finalize() (final transcript) → polish.polish() (Gemma) → 'polished' msg
    with {raw_text, polished_text, timings:{asr_finalize_ms, gemma_ms}}
  → Mac replaces on-screen text via Cmd+A + clipboard-paste
  → corrections.js: detect if this was a correction of the previous dictation
  → recordSession(): persist latency/word-counts/app to SQLite
  → WebSocket closes. Ready for next dictation.
```

**One WebSocket connection per dictation** — opened on press, closed after the
polished result. Keeps session state trivial.

---

## 5. Jetson Server — File Details

### `server.py` — WebSocket server & session orchestration
- `_handle_session(websocket)` — full lifecycle for one dictation: auth → receive
  audio → stream partials → finalize ASR → Gemma polish → send result + timings.
- `_stream_results_to_client()` — forwards Moonshine partial/final results to the Mac.
- `_warm_models()` — preloads Moonshine + Gemma at startup (no cold-start).
- `main()` — starts the server on `HOST:PORT`.
- Close codes: `4001` auth timeout, `4002` malformed start JSON, `4003` bad secret.
- `EXPECT_RAW_PCM = True` — expects raw PCM from the Mac (Opus decoding stays client-side).

### `config.py` — configuration (all overridable via env vars)
| Setting | Default | Env var |
|---------|---------|---------|
| `HOST` | `0.0.0.0` | `YAPFLOW_HOST` |
| `PORT` | `8765` | `YAPFLOW_PORT` |
| `SHARED_SECRET` | `None` | `YAPFLOW_SECRET` |
| `MOONSHINE_MODEL_ARCH` | `SMALL_STREAMING` | `YAPFLOW_ASR_MODEL` |
| `ASR_UPDATE_INTERVAL_SECONDS` | `0.3` | — |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | `OLLAMA_HOST` |
| `OLLAMA_MODEL` | `gemma3:4b` | `YAPFLOW_LLM_MODEL` |
| `OLLAMA_NUM_CTX` | `1024` | `YAPFLOW_NUM_CTX` |
| `OLLAMA_KEEP_ALIVE` | `-1` (resident forever) | `YAPFLOW_KEEP_ALIVE` |
| `LOG_LEVEL` | `INFO` | `YAPFLOW_LOG_LEVEL` |

Moonshine arch options: `TINY_STREAMING`, `SMALL_STREAMING` (recommended, ~123M params), `MEDIUM_STREAMING`.

### `asr.py` — Moonshine v2 streaming ASR
- `get_transcriber()` — lazy-loads the model once per process (singleton).
- `PartialResult` — dataclass `(text, is_final)`.
- `_QueueListener(TranscriptEventListener)` — bridges Moonshine's synchronous
  callbacks (`on_line_text_changed`, `on_line_completed`) into an asyncio queue.
- `StreamingSession` — one Moonshine stream per dictation:
  - `feed_pcm_int16()` — int16 → float32, feed to stream.
  - `results()` — async generator of `PartialResult`s.
  - `finalize()` — stop stream, return final transcript.
  - `close()` — cleanup.
- Audio format: **int16, 16kHz, mono, little-endian**.
- **Why Moonshine, not Whisper:** Whisper reprocesses a fixed 30s window on every
  update; Moonshine processes exactly the audio given, so latency is paid
  incrementally while you talk.

### `polish.py` — Gemma 3 4B polish via Ollama
- `ensure_model_ready()` — idempotent: pulls model if missing, preloads, sets residency.
- `_build_system_prompt(personalize, known_terms)` — builds the polish prompt.
- `polish(raw_transcript, personalize=True, known_terms=None)` — single Ollama
  `chat()` call. Falls back to raw text on empty/error (never erases your words).
- Prompt does three jobs in one pass: (1) punctuation/capitalization,
  (2) filler removal (um/uh/like), (3) self-correction detection ("no wait",
  "I mean" → keep only the final version). Optional personalization block lists
  `known_terms` so Gemma prefers them for similar-sounding words.

---

## 6. macOS App — File Details

### `main.js` — main process orchestrator
- `createCaptureWindow()`, `openDashboard()`, `requestPermissions()`,
  `startDictation()`, `endDictation()`, `setupTray()`.
- Config: `JETSON_HOST` (`jetson.local`), `JETSON_PORT` (`8765`),
  `JETSON_URL` = `ws://host:port`, `SHARED_SECRET` (env `YAPFLOW_SECRET`).
- IPC: `hotkey-down`/`hotkey-up` (→ renderer), `audio-chunk` (← renderer),
  `renderer-error`, `metrics:get` (← dashboard).
- Tray-only app (no dock window); dashboard opens on demand.

### `lib/hotkey.js` — global hold-to-dictate hotkey
- `start()` / `stop()`, emits `hotkey-down` / `hotkey-up`.
- `HOTKEY_CODE = 3676` (Right-Command). Override: `YAPFLOW_HOTKEY_KEYCODE`.
  Debug all keys: `YAPFLOW_DEBUG_KEYS=1`.
- Uses **uiohook-napi** (CGEventTap) — needed for hold-to-release semantics that
  Electron's `globalShortcut` can't do. Requires **Accessibility** permission.

### `lib/wsClient.js` — WebSocket client
- Class `DictationConnection(url, sharedSecret, knownTerms)`:
  `connect()`, `sendAudioChunk()`, `endUtterance()`, `close()`.
- Emits: `open`, `partial {text,isFinal}`, `polished {rawText,polishedText,timings}`,
  `server-error`, `error`, `close`.
- `SAMPLE_RATE=16000`, `CHANNELS=1`, `SEND_OPUS_OVER_WIRE=false` (raw PCM default;
  Opus must stay in sync with server's `EXPECT_RAW_PCM`).

### `lib/textInject.js` — text injection
- `injectViaClipboardPaste()`, `replaceCurrentTextViaClipboardPaste()` (Cmd+A then paste),
  `typeIncrementalDelta()` (synthetic keystrokes for live partials),
  `getFrontmostAppBundleId()`, `runHelper()`.
- **Why clipboard-paste:** direct Accessibility writes silently no-op in Electron,
  Qt/GTK, games, terminals. Clipboard swap + synthetic Cmd+V works everywhere.
- Partials use synthetic keystrokes; final result uses clipboard-paste.

### `lib/corrections.js` — SQLite storage
- DB at `userData/yapflow.db` (WAL mode).
- **`corrections` table** — original raw/polished text, corrected text, term diff
  (JSON), app bundle id, timestamp.
- **`sessions` table** — word counts, speaking duration, all latency stages,
  `asr_path`, app bundle id, `had_followup_correction`.
- `getLearnedTerms({appBundleId})` — top recent terms → sent as `known_terms`.
- `looksLikeCorrection()` — heuristic: <15s gap + <50% words changed → correction.
- `recordIfCorrection()`, `recordSession()`.
- **Personal dictionary is a word-list consulted at inference time, NOT fine-tuning.**

### `lib/timing.js` — latency instrumentation
- Class `DictationTimer`: marks `hotkeyDown → firstChunkSent → firstPartial →
  hotkeyUp → polishedReceived → pasteDone`.
- Derives: `releaseToTextMs` (headline), `speakingDurationMs`,
  `timeToFirstPartialMs`, `releaseToPolishedMs`, `pasteMs`; merges Jetson-side
  `asrFinalizeMs`/`gemmaMs` by value (clocks aren't synced across machines).

### `lib/metrics.js` — dashboard aggregates
- `getMetrics()` returns totals, latency p50/p90/p99, per-stage averages,
  WPM trend, correction-rate trend, and per-app breakdown.

### `renderer/audioCapture.js` + `captureProcessor.js`
- Audio graph built **once** at load; `getUserMedia` only on hotkey-down (mic live
  only while held, but no per-press graph rebuild → less startup lag).
- `resampleFloat32()` (linear) → `float32ToInt16()` → IPC to main.
- Mic settings: mono, echoCancellation, noiseSuppression, autoGainControl.
- AudioWorklet runs off the main thread (no audio glitches; ScriptProcessorNode is deprecated).

### `dashboard/` — metrics UI
- Self-contained dark-theme UI, hand-rolled inline SVG charts, zero CDN/network
  (consistent with the no-cloud ethos). Cards + latency percentiles + "where the
  time goes" + WPM trend + correction-rate trend + per-app table.

### `helpers/inject.swift` — Swift injection helper
- CLI: `read-clipboard`, `write-clipboard <text>`, `paste` (Cmd+V),
  `select-all` (Cmd+A), `type-text <text>`, `frontmost-app`.
- Posts CGEvents via `.cgAnnotatedSessionEventTap`. Build: `swiftc inject.swift -o inject`.

---

## 7. WebSocket Protocol

JSON control messages interleaved with binary audio frames.

| Direction | Type | Payload |
|-----------|------|---------|
| Mac → Jetson | `start` | `{type, secret?, known_terms:[...]}` |
| Mac → Jetson | (binary) | raw int16 PCM (or Opus if enabled) |
| Mac → Jetson | `end_of_utterance` | `{type}` |
| Jetson → Mac | `partial` | `{type, text, is_final}` |
| Jetson → Mac | `polished` | `{type, raw_text, polished_text, timings:{asr_finalize_ms, gemma_ms}}` |
| Jetson → Mac | `error` | `{type, message}` |

---

## 8. Setup Notes

**Jetson server:**
```bash
pip install -r requirements.txt --break-system-packages   # Jetson system Python needs the flag
# Ollama must be installed & running with gemma3:4b available
python server.py
```
- Tuned for 8GB unified memory: small `NUM_CTX` (1024), `KEEP_ALIVE=-1` to avoid
  CMA fragmentation from repeated model unload/reload.

**Mac client:**
```bash
cd macos-app
npm install
npm run rebuild          # rebuild native modules (@discordjs/opus, better-sqlite3) for Electron ABI
swiftc helpers/inject.swift -o helpers/inject
npm start
```
- Grant **Microphone** (auto-prompted) and **Accessibility** (manual: System
  Settings → Privacy & Security → Accessibility) permissions.
- Point at the Jetson: `YAPFLOW_JETSON_HOST`, `YAPFLOW_JETSON_PORT`, `YAPFLOW_SECRET`.

---

## 9. Key Design Decisions

1. **Clipboard-paste for injection** — Accessibility API writes silently fail in many apps.
2. **Synthetic keystrokes for live partials** — clipboard-paste would be too disruptive mid-speech.
3. **uiohook-napi hotkey** — Electron `globalShortcut` has no hold-to-release semantics.
4. **Web Audio capture in a hidden renderer** — rather than a native main-process binding.
5. **Personal dictionary = word-list at inference time** — not model fine-tuning.
6. **Moonshine v2 over Whisper** — incremental streaming, not fixed-window reprocessing.
7. **Single Gemma call** — cleanup + personalization + self-correction in one prompt.
8. **Model residency (`KEEP_ALIVE=-1`)** — avoids memory fragmentation on the 8GB Jetson.
9. **One WebSocket per dictation** — trivial, isolated session state.
10. **Graceful fallback** — on any server/polish failure, the raw transcript is kept; user's words are never erased.
```
