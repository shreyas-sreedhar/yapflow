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
 * This file is loaded by a renderer window — wire it up via preload.js's
 * contextBridge, not direct node integration, per Electron security
 * best practice.
 */

const TARGET_SAMPLE_RATE = 16000;

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

  sourceNode.connect(workletNode);
  // Deliberately do NOT connect workletNode to audioContext.destination —
  // we don't want to play the mic input back out of the speakers.

  isCapturing = true;
  console.log('[latency] capture: mic capture started', Date.now());
}

function stopCapture() {
  if (!isCapturing) return;

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
}

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
