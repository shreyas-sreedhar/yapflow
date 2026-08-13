/**
 * Runs in the renderer process (a hidden/background BrowserWindow — see
 * main.js). Uses the standard Web Audio API (getUserMedia + AudioWorklet)
 * to capture microphone audio, since that's the robust, well-maintained
 * path in current Electron — native main-process mic bindings (naudiodon
 * and similar) carry real native-compile and maintenance risk by
 * comparison. Captured audio is resampled to 16kHz mono int16 and shipped to
 * the main process over IPC, which forwards it to the Jetson (see
 * lib/wsClient.js).
 *
 * This file is loaded by a renderer window — wire it up via preload.js's
 * contextBridge, not direct node integration, per Electron security
 * best practice.
 *
 * Two things here are deliberate and worth not undoing:
 *
 * 1. Audio is COALESCED into ~20ms frames before being sent. The worklet fires
 *    once per 128-sample render quantum, which at 48kHz is every 2.7ms. Sending
 *    each one produced ~375 WebSocket frames per second carrying 84 bytes each —
 *    all framing overhead, no benefit, since Moonshine only re-runs
 *    transcription every 300ms anyway.
 *
 * 2. Resampling is STATEFUL across chunks. Each quantum used to be resampled
 *    independently, which restarted the interpolation at every boundary and
 *    dropped the fractional phase — audible as periodic distortion, and worse
 *    at non-integer ratios like 44.1kHz -> 16kHz. The resampler now carries its
 *    read cursor and the unconsumed input tail between calls.
 */

const TARGET_SAMPLE_RATE = 16000;

// Samples per outgoing frame at 16kHz. 320 = 20ms = 640 bytes as int16.
const FRAME_SAMPLES = 320;

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let sourceNode = null;
let isCapturing = false;
// One-shot guard so the "first chunk" stage log fires once per capture, not
// every audio frame (see Log-driven-development in CLAUDE.md). The
// authoritative per-stage trace lives in the main process (lib/timing.js);
// these renderer logs just make the capture stage self-documenting.
let loggedFirstChunk = false;

// --- Streaming resampler state ---
//
// `pendingInput` holds native-rate samples not yet consumed; `readCursor` is the
// fractional read position within it. Both persist across worklet callbacks,
// which is what makes the resampling continuous rather than per-chunk.
let pendingInput = new Float32Array(0);
let readCursor = 0;

// Resampled 16kHz samples waiting to reach FRAME_SAMPLES.
let outputBuffer = new Float32Array(0);

function concatFloat32(a, b) {
  const merged = new Float32Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
}

function resetAudioBuffers() {
  pendingInput = new Float32Array(0);
  readCursor = 0;
  outputBuffer = new Float32Array(0);
}

/**
 * Linear-interpolation resampler, stateful across calls.
 *
 * Mic input usually arrives at 44.1kHz or 48kHz; this pipeline standardizes on
 * 16kHz (see jetson-server/asr.py PCM_SAMPLE_RATE). Linear interpolation isn't
 * broadcast-quality, but it's more than sufficient for speech at this bitrate and
 * cheap enough to run in real time without a DSP dependency.
 *
 * Appends `chunk` to the pending input and returns every output sample that can
 * now be produced. Interpolation needs both neighbours, so it stops one sample
 * short of the end and keeps the remainder — along with the fractional cursor —
 * for the next call.
 */
function resampleStreaming(chunk, inputRate, outputRate) {
  pendingInput = concatFloat32(pendingInput, chunk);

  if (inputRate === outputRate) {
    const passthrough = pendingInput;
    pendingInput = new Float32Array(0);
    return passthrough;
  }

  const ratio = inputRate / outputRate;
  const produced = [];

  while (Math.floor(readCursor) + 1 < pendingInput.length) {
    const index = Math.floor(readCursor);
    const frac = readCursor - index;
    produced.push(pendingInput[index] * (1 - frac) + pendingInput[index + 1] * frac);
    readCursor += ratio;
  }

  // Discard input we've read past, and rebase the cursor onto what's left.
  //
  // Clamping to the buffer length is essential, not defensive. At a
  // non-unit ratio the cursor routinely ends up PAST the end of the buffer —
  // e.g. length 5, cursor 6.5 — and subtracting the unclamped floor would
  // silently discard that overhang, drifting the read position by up to one
  // sample per callback. That drift showed up as steadily accumulating
  // interpolation error and a few hundred extra output samples per second.
  // Leaving readCursor >= pendingInput.length is correct and self-healing: it
  // means "skip that far into whatever arrives next".
  const consumed = Math.min(Math.floor(readCursor), pendingInput.length);
  if (consumed > 0) {
    pendingInput = pendingInput.slice(consumed);
    readCursor -= consumed;
  }

  return Float32Array.from(produced);
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
 * Emits as many whole FRAME_SAMPLES frames as `outputBuffer` holds.
 * With `flush`, also emits a final short frame so the tail of the utterance
 * isn't dropped on hotkey release.
 */
function emitFrames({ flush = false } = {}) {
  while (outputBuffer.length >= FRAME_SAMPLES) {
    const frame = outputBuffer.subarray(0, FRAME_SAMPLES);
    outputBuffer = outputBuffer.slice(FRAME_SAMPLES);
    sendFrame(frame);
  }

  if (flush && outputBuffer.length > 0) {
    sendFrame(outputBuffer);
    outputBuffer = new Float32Array(0);
  }
}

function sendFrame(float32Frame) {
  const int16 = float32ToInt16(float32Frame);
  if (!loggedFirstChunk) {
    loggedFirstChunk = true;
    console.log('[latency] capture: first audio frame forwarded to main', Date.now());
  }
  // See preload.js for the contextBridge surface (`window.flowLocal.sendAudioChunk`).
  window.flowLocal.sendAudioChunk(int16.buffer);
}

async function startCapture() {
  if (isCapturing) return;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext(); // uses the device's native rate, e.g. 48000
  await audioContext.audioWorklet.addModule('./captureProcessor.js');

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'yapflow-capture-processor');

  workletNode.port.onmessage = (event) => {
    if (event.data.type !== 'audio') return;
    const resampled = resampleStreaming(
      event.data.samples,
      audioContext.sampleRate,
      TARGET_SAMPLE_RATE
    );
    outputBuffer = concatFloat32(outputBuffer, resampled);
    emitFrames();
  };

  sourceNode.connect(workletNode);
  // Deliberately do NOT connect workletNode to audioContext.destination —
  // we don't want to play the mic input back out of the speakers.

  isCapturing = true;
  console.log('[latency] capture: mic capture started', Date.now());
}

function stopCapture() {
  if (!isCapturing) return;

  // Flush before tearing anything down. Coalescing means up to ~20ms of audio is
  // sitting in outputBuffer at release; dropping it would clip the end of the
  // last word.
  emitFrames({ flush: true });

  if (sourceNode) sourceNode.disconnect();
  if (workletNode) workletNode.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();

  sourceNode = null;
  workletNode = null;
  mediaStream = null;
  audioContext = null;
  isCapturing = false;
  loggedFirstChunk = false;
  resetAudioBuffers();
}

// main.js tells this renderer when the hotkey is pressed/released via IPC,
// relayed through preload.js.
window.flowLocal.onHotkeyDown(() => {
  resetAudioBuffers();
  startCapture().catch((err) => {
    window.flowLocal.reportError(`Microphone capture failed to start: ${err.message}`);
  });
});

window.flowLocal.onHotkeyUp(() => {
  stopCapture();
  // Tell main the last audio frame is on its way, so it can send
  // end_of_utterance AFTER the flush rather than racing it. Without this the
  // server can finalize before the tail arrives — the audio would be sent but
  // arrive too late to be transcribed.
  window.flowLocal.notifyCaptureStopped();
});
