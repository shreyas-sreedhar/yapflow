/**
 * Per-dictation latency instrumentation.
 *
 * Capture per-stage timestamps, not just one end-to-end number, so a latency
 * regression is attributable to a specific stage. This has already earned its
 * keep twice: it's how the Gemma 3 4B touch-up was identified as several seconds
 * of the post-release path, and how clipboard injection was found to be ~375ms of
 * process-spawn overhead. With both fixed, the remaining stages are ASR finalize
 * (tens of ms) and paste (low tens); anything much larger is a regression.
 *
 * Clock-skew note: every mark here is taken on a SINGLE clock (the Mac's), so
 * deltas between Mac marks are skew-free. Work done on the Jetson (ASR finalize,
 * touch-up) is NOT compared by absolute timestamp — it arrives separately as
 * DURATIONS in the 'polished' message (see wsClient.js / jetson-server) and is
 * merged into the summary by value. Comparing cross-machine wall-clocks would be
 * meaningless without clock sync this deliberately doesn't require.
 */

// The milestones we mark over a single dictation, in causal order. Each
// fires exactly once per dictation, so markOnce semantics are correct for
// all of them (a late duplicate — e.g. a second 'partial' — is ignored).
const STAGES = [
  'hotkeyDown', // ≈ mic-start: user pressed and held the hotkey
  'firstChunkSent', // first audio chunk reached the main process (audio is flowing)
  'firstPartial', // first partial transcript came back from the Jetson
  'hotkeyUp', // end-of-speech: user released the hotkey
  'polishedReceived', // polished text bytes arrived from the Jetson
  'pasteDone', // polished text finished being injected at the cursor
];

class DictationTimer {
  constructor(now = Date.now()) {
    this._marks = Object.create(null);
    // Stamp the start immediately so callers don't have to remember to.
    this._marks.hotkeyDown = now;
  }

  /**
   * Record a milestone the first time it happens; ignore later repeats.
   * Returns the timestamp recorded (existing one if already set).
   */
  markOnce(stage, now = Date.now()) {
    if (!STAGES.includes(stage)) {
      throw new Error(`Unknown timing stage: ${stage}`);
    }
    if (this._marks[stage] === undefined) {
      this._marks[stage] = now;
    }
    return this._marks[stage];
  }

  has(stage) {
    return this._marks[stage] !== undefined;
  }

  _delta(from, to) {
    const a = this._marks[from];
    const b = this._marks[to];
    if (a === undefined || b === undefined) return null;
    return b - a;
  }

  /**
   * Derive the Mac-side per-stage durations. Any stage that never fired
   * (e.g. no partials came back, or the connection dropped before paste)
   * yields null rather than a bogus number.
   *
   * `jetson` is the optional `{ asrFinalizeMs, touchupMs }` object from the
   * 'polished' message — passed through verbatim so the persisted record and
   * the log line carry the whole pipeline, not just the Mac half.
   */
  summary(jetson = {}) {
    return {
      // The headline number: hotkey-RELEASE to text appearing. Measuring from
      // press would fold in the user's speaking time, which is not latency.
      releaseToTextMs: this._delta('hotkeyUp', 'pasteDone'),
      // The user's actual speaking duration, for the WPM trend.
      speakingDurationMs: this._delta('hotkeyDown', 'hotkeyUp'),
      // Live-feedback responsiveness: audio-flowing to first words on screen.
      timeToFirstPartialMs: this._delta('firstChunkSent', 'firstPartial'),
      // Release to polished bytes in hand (network + server-side work).
      releaseToPolishedMs: this._delta('hotkeyUp', 'polishedReceived'),
      // Just the local clipboard-paste injection cost.
      pasteMs: this._delta('polishedReceived', 'pasteDone'),
      // Jetson-measured durations, merged in (null if not reported).
      asrFinalizeMs: jetson.asrFinalizeMs ?? null,
      // Was gemmaMs when the touch-up was a Gemma 3 4B call; it's now a
      // deterministic pass, so expect well under 1ms here rather than seconds.
      // Falls back to the old name so a server that predates the rename still
      // reports.
      touchupMs: jetson.touchupMs ?? jetson.gemmaMs ?? null,
    };
  }

  /**
   * A single structured line for the dev console, so the latency trace exists
   * from the very first run rather than only once the dashboard is opened.
   */
  logLine(jetson = {}) {
    const s = this.summary(jetson);
    const fmt = (ms) => (ms === null ? '—' : `${ms}ms`);
    return (
      `[latency] release→text=${fmt(s.releaseToTextMs)} ` +
      `speaking=${fmt(s.speakingDurationMs)} ` +
      `firstPartial=${fmt(s.timeToFirstPartialMs)} ` +
      `release→polished=${fmt(s.releaseToPolishedMs)} ` +
      `paste=${fmt(s.pasteMs)} ` +
      `asrFinalize=${fmt(s.asrFinalizeMs)} ` +
      `touchup=${fmt(s.touchupMs)}`
    );
  }
}

module.exports = { DictationTimer, STAGES };
