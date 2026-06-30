/**
 * Per-dictation latency instrumentation.
 *
 * Per ../../../CLAUDE.md ("Working discipline → Log-driven development") and
 * docs/yapflow-master-plan.md Section 4: capture per-stage timestamps, not
 * just one end-to-end number, so a latency regression is attributable to a
 * specific stage (the bottleneck is far more often ASR finalization or
 * buffering than Gemma — only a per-stage trace makes that visible).
 *
 * Clock-skew note: every mark here is taken on a SINGLE clock (the Mac's),
 * so the deltas between Mac marks are skew-free. Work done on the Jetson
 * (ASR finalize, Gemma) is NOT compared by absolute timestamp — it arrives
 * separately as DURATIONS in the 'polished' message (see wsClient.js /
 * jetson-server) and is merged into the summary by the caller. Comparing
 * cross-machine wall-clocks would be meaningless without clock sync we
 * deliberately don't have (single user, single device pair — no infra).
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
   * `jetson` is the optional `{ asrFinalizeMs, gemmaMs }` object from the
   * 'polished' message — passed through verbatim so the persisted record and
   * the log line carry the whole pipeline, not just the Mac half.
   */
  summary(jetson = {}) {
    return {
      // Headline number §4 actually defines: hotkey-RELEASE to text appearing.
      // (Measuring from press would fold in the user's speaking time, which
      // is not latency — see the bug this replaced in main.js.)
      releaseToTextMs: this._delta('hotkeyUp', 'pasteDone'),
      // The user's actual speaking duration, for the WPM trend in §4.
      speakingDurationMs: this._delta('hotkeyDown', 'hotkeyUp'),
      // Live-feedback responsiveness: audio-flowing to first words on screen.
      timeToFirstPartialMs: this._delta('firstChunkSent', 'firstPartial'),
      // Release to polished bytes in hand (network + server-side work).
      releaseToPolishedMs: this._delta('hotkeyUp', 'polishedReceived'),
      // Just the local clipboard-paste injection cost.
      pasteMs: this._delta('polishedReceived', 'pasteDone'),
      // Jetson-measured durations, merged in (null if not reported).
      asrFinalizeMs: jetson.asrFinalizeMs ?? null,
      gemmaMs: jetson.gemmaMs ?? null,
    };
  }

  /**
   * A single structured line for the dev console, so the latency trace
   * exists from the very first run (per the log-driven-development rule).
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
      `gemma=${fmt(s.gemmaMs)}`
    );
  }
}

module.exports = { DictationTimer, STAGES };
