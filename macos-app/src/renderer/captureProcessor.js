/**
 * AudioWorkletProcessor that runs on the renderer's audio rendering thread.
 * Receives float32 audio frames from the microphone (via getUserMedia + an
 * AudioWorkletNode in renderer/audioCapture.js) and forwards them to the
 * main render thread as raw float32 frames, which renderer/audioCapture.js
 * then resamples, coalesces, converts to int16, and ships to the Electron main
 * process over IPC.
 *
 * Why an AudioWorklet and not the deprecated ScriptProcessorNode: the
 * Worklet runs off the main thread, so it doesn't risk audio glitches from
 * UI work, and it's the currently-supported Web Audio API for this —
 * ScriptProcessorNode is deprecated and Electron's Chromium build will
 * eventually drop it.
 */

class YapflowCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Mic typically arrives at 48kHz from the OS; the pipeline standardizes on
    // 16kHz (see jetson-server/asr.py PCM_SAMPLE_RATE). We do NOT resample or
    // buffer here — both happen downstream in renderer/audioCapture.js, which
    // keeps a stateful resampler and coalesces into ~20ms frames. This
    // processor's only job is to copy each quantum off the audio thread.
    //
    // Keeping the buffering out of here is deliberate: this method runs on the
    // real-time audio rendering thread, where allocating and holding state
    // risks glitching capture.
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0]; // mono
      if (channelData && channelData.length > 0) {
        // Copy because the underlying buffer is reused by the audio engine
        // between calls — without copying, by the time this reaches the
        // main thread via postMessage's structured clone, the source data
        // could already have been overwritten by the next render quantum.
        const copy = new Float32Array(channelData.length);
        copy.set(channelData);
        this.port.postMessage({ type: 'audio', samples: copy }, [copy.buffer]);
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor('yapflow-capture-processor', YapflowCaptureProcessor);
