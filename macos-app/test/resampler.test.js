/**
 * Tests for the streaming resampler in src/renderer/audioCapture.js.
 *
 * Mic input arrives at the device's native rate (usually 48kHz, sometimes
 * 44.1kHz) in 128-sample render quanta; the pipeline needs continuous 16kHz.
 * Two properties have to hold, and neither did before:
 *
 *   CONTINUITY — resampling each quantum independently restarts interpolation at
 *   every chunk boundary and throws away the fractional read position. On a
 *   linear input ramp, where output[k] must be exactly k*ratio, the old
 *   per-chunk approach drifted without bound.
 *
 *   RATE — output sample count must match input/ratio. Position drift also
 *   manifests as extra samples, which is audible as pitch/tempo error and
 *   silently corrupts what the ASR receives.
 *
 * A linear ramp is the test signal because linear interpolation reproduces it
 * exactly, so any nonzero error is the resampler's own bookkeeping rather than
 * interpolation loss.
 *
 * Mirrored from audioCapture.js rather than imported: that module runs in a
 * renderer and touches `window`/`navigator` at load. Keep in sync.
 *
 * Run: node test/resampler.test.js
 */

'use strict';

const assert = require('assert');

// --- mirrored from src/renderer/audioCapture.js ---

let pendingInput = new Float32Array(0);
let readCursor = 0;

function concatFloat32(a, b) {
  const merged = new Float32Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
}

function resetResampler() {
  pendingInput = new Float32Array(0);
  readCursor = 0;
}

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

  const consumed = Math.min(Math.floor(readCursor), pendingInput.length);
  if (consumed > 0) {
    pendingInput = pendingInput.slice(consumed);
    readCursor -= consumed;
  }

  return Float32Array.from(produced);
}

// --- helpers ---

/** Feeds a linear ramp through the resampler in `quantum`-sized chunks. */
function feedRamp(inputRate, quantum, chunkCount) {
  resetResampler();
  const output = [];
  let n = 0;
  for (let q = 0; q < chunkCount; q++) {
    const chunk = new Float32Array(quantum);
    for (let i = 0; i < quantum; i++) chunk[i] = n++;
    output.push(...resampleStreaming(chunk, inputRate, 16000));
  }
  return { output, inputCount: n };
}

/** Largest deviation from the exact expected value output[k] === k * ratio. */
function maxRampError(output, ratio) {
  let worst = 0;
  for (let k = 0; k < output.length; k++) {
    worst = Math.max(worst, Math.abs(output[k] - k * ratio));
  }
  return worst;
}

const tests = {
  '48kHz -> 16kHz stays exact across many chunk boundaries'() {
    const { output } = feedRamp(48000, 128, 400);
    // Integer ratio, linear input: interpolation should be bit-exact.
    assert.strictEqual(maxRampError(output, 3), 0);
  },

  '44.1kHz -> 16kHz stays within float epsilon'() {
    const { output } = feedRamp(44100, 128, 400);
    // Non-integer ratio, so float32 rounding applies, but error must not
    // accumulate — this bound is ~1e-3 on values up to 51200.
    assert.ok(maxRampError(output, 44100 / 16000) < 0.01, 'error accumulated across chunks');
  },

  'output rate matches input/ratio for 48kHz'() {
    const { output, inputCount } = feedRamp(48000, 128, 400);
    const expected = Math.floor(inputCount / 3);
    // One sample of slack: interpolation needs a right-hand neighbour, so the
    // final sample can't be produced until more input arrives.
    assert.ok(
      Math.abs(expected - output.length) <= 1,
      `expected ~${expected} samples, got ${output.length}`
    );
  },

  'output rate matches input/ratio for 44.1kHz'() {
    const { output, inputCount } = feedRamp(44100, 128, 400);
    const expected = Math.floor(inputCount / (44100 / 16000));
    assert.ok(
      Math.abs(expected - output.length) <= 1,
      `expected ~${expected} samples, got ${output.length}`
    );
  },

  'matching rates pass through untouched'() {
    const { output, inputCount } = feedRamp(16000, 128, 50);
    assert.strictEqual(output.length, inputCount);
    assert.strictEqual(maxRampError(output, 1), 0);
  },

  'cursor overhang past the buffer end does not drift'() {
    // The specific bug this guards: at a non-unit ratio the cursor routinely
    // lands beyond the buffer (length 5, cursor 6.5). Subtracting the unclamped
    // floor discarded that overhang, losing up to one sample of position per
    // callback. Tiny chunks maximise how often that happens.
    const { output } = feedRamp(48000, 4, 500);
    assert.strictEqual(maxRampError(output, 3), 0, 'position drifted with small chunks');
  },

  'irregular chunk sizes do not drift'() {
    resetResampler();
    const output = [];
    let n = 0;
    for (const size of [1, 7, 128, 3, 64, 129, 2, 256, 5, 33, 128, 128]) {
      const chunk = new Float32Array(size);
      for (let i = 0; i < size; i++) chunk[i] = n++;
      output.push(...resampleStreaming(chunk, 48000, 16000));
    }
    assert.strictEqual(maxRampError(output, 3), 0);
  },

  'a single short chunk produces no spurious output'() {
    resetResampler();
    const out = resampleStreaming(new Float32Array([0]), 48000, 16000);
    // One sample has no right-hand neighbour to interpolate against.
    assert.strictEqual(out.length, 0);
  },

  'no output is lost across a reset'() {
    const first = feedRamp(48000, 128, 10);
    const second = feedRamp(48000, 128, 10);
    assert.strictEqual(first.output.length, second.output.length);
    assert.strictEqual(maxRampError(second.output, 3), 0);
  },
};

let failures = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}
process.exit(failures ? 1 : 0);
