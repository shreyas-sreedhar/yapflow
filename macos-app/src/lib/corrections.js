/**
 * Local SQLite storage for two things, per docs/yapflow-master-plan.md
 * Sections 3 and 4:
 *
 *   1. `corrections` — the personal-dictionary learning loop. NOT
 *      fine-tuning (see CLAUDE.md Decisions section 5) — just a growing
 *      word-list consulted at inference time, fed back into the Gemma
 *      polish prompt on every future dictation.
 *
 *   2. `sessions` — per-dictation metrics (timing, word counts, ASR path,
 *      app context, correction-follow-up), purely for the user's own
 *      visibility. No leaderboard framing, no comparison to anyone else.
 *
 * Lives on the Mac, not the Jetson — see CLAUDE.md Decisions / Architecture
 * section for why (zero network round-trip needed to consult before every
 * dictation, and it's meaningless without the Mac client running anyway).
 */

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

const DB_PATH = path.join(app.getPath('userData'), 'yapflow.db');

let db = null;

function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_raw_text TEXT NOT NULL,
      original_polished_text TEXT NOT NULL,
      corrected_text TEXT NOT NULL,
      term_diff TEXT,
      app_bundle_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      raw_word_count INTEGER,
      polished_word_count INTEGER,
      speaking_duration_ms INTEGER,
      release_to_text_latency_ms INTEGER,
      time_to_first_partial_ms INTEGER,
      release_to_polished_ms INTEGER,
      paste_ms INTEGER,
      asr_finalize_ms INTEGER,
      gemma_ms INTEGER,
      asr_path TEXT,
      app_bundle_id TEXT,
      had_followup_correction INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_corrections_app ON corrections(app_bundle_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
  `);

  migrateSessionsColumns(db);

  return db;
}

/**
 * Additive schema migration for the per-stage latency columns (master-plan
 * §4 instrumentation). A DB created before these columns existed won't have
 * them, and `CREATE TABLE IF NOT EXISTS` won't add them to an existing table
 * — so add each missing column idempotently. SQLite has no `ADD COLUMN IF
 * NOT EXISTS`, hence the table_info check.
 */
function migrateSessionsColumns(database) {
  const existing = new Set(
    database.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name)
  );
  const wanted = [
    'time_to_first_partial_ms',
    'release_to_polished_ms',
    'paste_ms',
    'asr_finalize_ms',
    'gemma_ms',
  ];
  for (const col of wanted) {
    if (!existing.has(col)) {
      database.exec(`ALTER TABLE sessions ADD COLUMN ${col} INTEGER`);
    }
  }
}

/**
 * Very small word-level diff: returns the single (or first) span of words
 * that differ between two short strings. Good enough for catching "one or
 * two words changed" corrections per the spec's heuristic — not meant to be
 * a general-purpose diff algorithm. If you need something more robust later,
 * consider the `diff` npm package, but this keeps the dependency footprint
 * minimal for what's actually a narrow job.
 */
function simpleWordDiff(a, b) {
  const wordsA = a.trim().split(/\s+/);
  const wordsB = b.trim().split(/\s+/);
  let start = 0;
  while (start < wordsA.length && start < wordsB.length && wordsA[start] === wordsB[start]) {
    start++;
  }
  let endA = wordsA.length - 1;
  let endB = wordsB.length - 1;
  while (endA >= start && endB >= start && wordsA[endA] === wordsB[endB]) {
    endA--;
    endB--;
  }
  const changedFrom = wordsA.slice(start, endA + 1).join(' ');
  const changedTo = wordsB.slice(start, endB + 1).join(' ');
  if (!changedFrom && !changedTo) return null;
  return { from: changedFrom, to: changedTo };
}

/**
 * Heuristic for "is this re-dictation actually a correction of the last
 * one, or an unrelated new dictation?" — see
 * docs/yapflow-master-plan.md Section 3.2 for the full reasoning
 * (timing + word-overlap as proxies for the "alternates list" signal that
 * UI-based correction systems use, which this app doesn't have).
 */
function looksLikeCorrection(previous, current, msSinceLast) {
  const CORRECTION_WINDOW_MS = 15000;
  if (msSinceLast > CORRECTION_WINDOW_MS) return false;

  const diff = simpleWordDiff(previous, current);
  if (!diff) return false;

  // Small, localized edit — not a full rewrite. If more than half the
  // words changed, this is more likely an unrelated new dictation than a
  // correction of the same thought.
  const totalWords = previous.trim().split(/\s+/).length;
  const changedWords = diff.from.split(/\s+/).filter(Boolean).length;
  return changedWords > 0 && changedWords <= Math.max(2, Math.ceil(totalWords * 0.5));
}

/**
 * Call this after injecting polished text, if a new dictation starts within
 * the correction window. Logs the diff if it looks like a correction.
 * Returns the diff object if logged, null otherwise.
 */
function recordIfCorrection({ previousPolishedText, currentRawText, currentPolishedText, appBundleId, msSinceLast }) {
  if (!looksLikeCorrection(previousPolishedText, currentPolishedText, msSinceLast)) {
    return null;
  }

  const diff = simpleWordDiff(previousPolishedText, currentPolishedText);
  if (!diff) return null;

  const database = getDb();
  database
    .prepare(
      `INSERT INTO corrections (original_raw_text, original_polished_text, corrected_text, term_diff, app_bundle_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      currentRawText,
      previousPolishedText,
      currentPolishedText,
      JSON.stringify(diff),
      appBundleId || null,
      Date.now()
    );

  return diff;
}

/**
 * Returns the most relevant learned terms to feed into the Gemma polish
 * prompt for this dictation, filtered by app where available. This is the
 * "personal dictionary" — see CLAUDE.md Decisions section 5: a word-list
 * consulted at inference time, not a fine-tuned model.
 */
function getLearnedTerms({ appBundleId, limit = 20 }) {
  const database = getDb();
  let rows;

  if (appBundleId) {
    rows = database
      .prepare(
        `SELECT term_diff FROM corrections
         WHERE app_bundle_id = ? OR app_bundle_id IS NULL
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(appBundleId, limit);
  } else {
    rows = database
      .prepare(`SELECT term_diff FROM corrections ORDER BY created_at DESC LIMIT ?`)
      .all(limit);
  }

  const terms = new Set();
  for (const row of rows) {
    try {
      const diff = JSON.parse(row.term_diff);
      if (diff && diff.to) terms.add(diff.to);
    } catch (err) {
      // malformed row, skip
    }
  }
  return Array.from(terms);
}

function recordSession({
  rawWordCount,
  polishedWordCount,
  speakingDurationMs,
  releaseToTextLatencyMs,
  timeToFirstPartialMs = null,
  releaseToPolishedMs = null,
  pasteMs = null,
  asrFinalizeMs = null,
  gemmaMs = null,
  asrPath,
  appBundleId,
  hadFollowupCorrection,
}) {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO sessions
       (created_at, raw_word_count, polished_word_count, speaking_duration_ms,
        release_to_text_latency_ms, time_to_first_partial_ms, release_to_polished_ms,
        paste_ms, asr_finalize_ms, gemma_ms, asr_path, app_bundle_id, had_followup_correction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Date.now(),
      rawWordCount,
      polishedWordCount,
      speakingDurationMs,
      releaseToTextLatencyMs,
      timeToFirstPartialMs,
      releaseToPolishedMs,
      pasteMs,
      asrFinalizeMs,
      gemmaMs,
      asrPath,
      appBundleId || null,
      hadFollowupCorrection ? 1 : 0
    );
}

module.exports = {
  getDb,
  recordIfCorrection,
  getLearnedTerms,
  recordSession,
  simpleWordDiff, // exported for testing
};
