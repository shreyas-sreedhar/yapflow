/**
 * Runs in the renderer process (a hidden/background BrowserWindow — see
 * main.js). Uses the standard Web Audio API (getUserMedia + AudioWorklet)
 * to capture microphone audio, since that's the robust, well-maintained
 * path in current Electron — native main-process mic bindings (naudiodon
 * and similar) carry real native-compile and maintenance risk by
 * comparison. Captured audio is resampled to 16kHz mono and shipped to the
 * main process over IPC, where it gets Opus-encoded and sent to the Jetson
 * (see lib/audioCapture.js and lib/wsClient.js).
 *
 * Latency + privacy design (see the mic-warm discussion in the project
 * notes): the audio GRAPH — the AudioContext, the worklet module, and the
 * worklet node — is built ONCE and reused for the life of the app. Building
 * it touches NO microphone (no getUserMedia), so it activates no input
 * device and shows no macOS mic indicator. Only on hotkey-down do we call
 * getUserMedia (mic turns on, indicator shows) and connect it to the
 * pre-built graph; on hotkey-up we release the mic (indicator off). So the
 * mic is live strictly while the hotkey is held — never idling in the
 * background — yet a press no longer pays to rebuild the whole graph, which
 * was the bulk of the old capture-start lag that clipped the first words.
 *
 * This file is loaded by a renderer window — wire it up via preload.js's
 * contextBridge, not direct node integration, per Electron security
 * best practice.
 */

const TARGET_SAMPLE_RATE = 16000;

// Long-lived graph — created once, reused across every dictation. None of
// these touch the microphone; only mediaStream/sourceNode (acquired per
// press) do.
let audioContext = null;
let workletNode = null;
let graphReady = null; // Promise cache so concurrent/repeat callers share one init

// Per-dictation mic resources — acquired on hotkey-down, released on hotkey-up.
let mediaStream = null;
let sourceNode = null;
let isCapturing = false;
// One-shot guard so the "first chunk" stage log fires once per capture, not
// every audio frame (see Log-driven-development in CLAUDE.md). The
// authoritative per-stage trace lives in the main process (lib/timing.js);
// these renderer logs just make the capture stage self-documenting.
let loggedFirstChunk = false;

/**
 * Minimal linear-interpolation resampler. Mic input usually arrives at
 * 44.1kHz or 48kHz; Moonshine and the rest of this pipeline standardize on
 * 16kHz (see jetson-server/asr.py and the spec's Opus-chunk reasoning).
 * Linear interpolation is not broadcast-quality resampling, but it's more
 * than sufficient for speech at this bitrate and is cheap enough to run in
 * real time without pulling in a DSP dependency for this one step.
 */
function resampleFloat32(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
    const frac = srcIndex - srcIndexFloor;
    output[i] = input[srcIndexFloor] * (1 - frac) + input[srcIndexCeil] * frac;
  }
  return output;
}

function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16Array;
}

/**
 * Build the audio graph once (AudioContext + worklet module + worklet node).
 * Deliberately does NOT call getUserMedia — so no microphone is opened and
 * no mic indicator appears. The worklet only ever emits frames while a mic
 * source is connected AND isCapturing is true, so a resident graph is inert
 * between dictations. Cached via `graphReady`; on failure the cache is
 * cleared so the next press retries.
 */
function ensureGraph() {
  if (graphReady) return graphReady;
  graphReady = (async () => {
    audioContext = new AudioContext(); // device's native rate, e.g. 48000
    await audioContext.audioWorklet.addModule('./captureProcessor.js');
    workletNode = new AudioWorkletNode(audioContext, 'yapflow-capture-processor');
    workletNode.port.onmessage = (event) => {
      // Ignore frames when not actively dictating (e.g. a stray frame while
      // tearing down) — the mic source is disconnected between dictations,
      // so normally none arrive anyway.
      if (!isCapturing || event.data.type !== 'audio') return;
      const resampled = resampleFloat32(event.data.samples, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      const int16 = float32ToInt16(resampled);
      if (!loggedFirstChunk) {
        loggedFirstChunk = true;
        console.log('[latency] capture: first audio chunk forwarded to main', Date.now());
      }
      // Forward to the main process for Opus encoding + websocket send. See
      // preload.js for the contextBridge surface (`window.flowLocal.sendAudioChunk`).
      window.flowLocal.sendAudioChunk(int16.buffer);
    };
  })().catch((err) => {
    graphReady = null; // allow a later press to retry the build
    throw err;
  });
  return graphReady;
}

async function startCapture() {
  if (isCapturing) return;

  // Reuse the pre-built graph; this is fast (or instant if it was warmed at
  // load). The only per-press cost is getUserMedia below.
  await ensureGraph();

  // Acquire the mic ONLY now — this is what turns the macOS mic indicator on.
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // A graph created before any user gesture may be suspended by the autoplay
  // policy — resume it now that we're in a hotkey (gesture) context.
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  loggedFirstChunk = false;
  isCapturing = true; // set before connect so the first frames aren't gated out
  sourceNode.connect(workletNode);
  // Deliberately do NOT connect workletNode to audioContext.destination —
  // we don't want to play the mic input back out of the speakers.

  console.log('[latency] capture: mic capture started', Date.now());
}

function stopCapture() {
  if (!isCapturing) return;

  isCapturing = false;
  if (sourceNode) sourceNode.disconnect();
  // Stopping the tracks releases the microphone → macOS mic indicator turns
  // off. The AudioContext and worklet node are deliberately KEPT alive and
  // reused for the next dictation (do NOT close() them here — that rebuild
  // was the old startup lag).
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());

  sourceNode = null;
  mediaStream = null;
  loggedFirstChunk = false;
}

// Pre-build the graph at load so even the FIRST dictation skips graph setup.
// No getUserMedia happens here, so no microphone opens and no indicator shows
// — it only prepares the (inert) processing graph.
ensureGraph().catch((err) => {
  window.flowLocal.reportError(`Audio graph init failed: ${err.message}`);
});

// main.js tells this renderer when the hotkey is pressed/released via IPC,
// relayed through preload.js.
window.flowLocal.onHotkeyDown(() => {
  startCapture().catch((err) => {
    window.flowLocal.reportError(`Microphone capture failed to start: ${err.message}`);
  });
});

window.flowLocal.onHotkeyUp(() => {
  stopCapture();
});
