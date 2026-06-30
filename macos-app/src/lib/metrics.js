/**
 * Read-only aggregate queries over the local `sessions` / `corrections`
 * tables, for the metrics dashboard (docs/yapflow-master-plan.md Section 4).
 *
 * This is the user's OWN visibility into whether dictation is making them
 * faster and whether the personal dictionary is working — explicitly not a
 * benchmark against anyone else (no leaderboard framing). Everything here is
 * derived from the one `sessions` table plus the `corrections` count.
 *
 * Lives in the main process (better-sqlite3 is synchronous and main-only);
 * the dashboard renderer pulls this via the `metrics:get` IPC channel.
 */

const { getDb } = require('./corrections');

/** Nearest-rank percentile over an ascending-sorted numeric array. */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(rank, sortedAsc.length) - 1];
}

/** Local-time YYYY-MM-DD bucket key for a millisecond timestamp. */
function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns every number the dashboard needs, as a single plain object safe to
 * pass over IPC. All latency values are milliseconds; rates are 0..1.
 */
function getMetrics() {
  const db = getDb();

  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) AS dictations,
              COALESCE(SUM(polished_word_count), 0) AS total_words,
              COALESCE(SUM(had_followup_correction), 0) AS corrections
       FROM sessions`
    )
    .get();
  const dictations = totalsRow.dictations;
  const corrections = totalsRow.corrections;

  // Headline latency: release→text percentiles (non-null only).
  const latencies = db
    .prepare(
      `SELECT release_to_text_latency_ms AS ms FROM sessions
       WHERE release_to_text_latency_ms IS NOT NULL
       ORDER BY release_to_text_latency_ms ASC`
    )
    .all()
    .map((r) => r.ms);

  // Average per-stage breakdown (SQLite AVG ignores nulls), rounded.
  const stageRow = db
    .prepare(
      `SELECT AVG(time_to_first_partial_ms) AS first_partial,
              AVG(release_to_polished_ms)   AS release_to_polished,
              AVG(asr_finalize_ms)          AS asr_finalize,
              AVG(gemma_ms)                 AS gemma,
              AVG(paste_ms)                 AS paste
       FROM sessions`
    )
    .get();
  const round = (v) => (v === null || v === undefined ? null : Math.round(v));

  // Per-day trends: WPM (total produced words / total speaking minutes) and
  // correction rate (corrections followed / dictations). Bucketed in JS so
  // the day boundary is the user's local midnight, not UTC.
  const trendRows = db
    .prepare(
      `SELECT created_at, polished_word_count, speaking_duration_ms, had_followup_correction
       FROM sessions ORDER BY created_at ASC`
    )
    .all();
  const byDay = new Map();
  for (const r of trendRows) {
    const key = dayKey(r.created_at);
    let bucket = byDay.get(key);
    if (!bucket) {
      bucket = { day: key, words: 0, speakingMs: 0, count: 0, corrections: 0 };
      byDay.set(key, bucket);
    }
    bucket.count += 1;
    bucket.corrections += r.had_followup_correction ? 1 : 0;
    if (r.speaking_duration_ms && r.speaking_duration_ms > 0 && r.polished_word_count) {
      bucket.words += r.polished_word_count;
      bucket.speakingMs += r.speaking_duration_ms;
    }
  }
  const wpmTrend = [];
  const correctionRateTrend = [];
  for (const b of byDay.values()) {
    const minutes = b.speakingMs / 60000;
    wpmTrend.push({ day: b.day, wpm: minutes > 0 ? +(b.words / minutes).toFixed(1) : null });
    correctionRateTrend.push({ day: b.day, rate: b.count ? b.corrections / b.count : 0, count: b.count });
  }

  // Per-app breakdown (NULL bundle id → "unknown").
  const perApp = db
    .prepare(
      `SELECT COALESCE(app_bundle_id, 'unknown') AS app,
              COUNT(*) AS count,
              AVG(release_to_text_latency_ms) AS avg_latency_ms,
              AVG(had_followup_correction) AS correction_rate
       FROM sessions
       GROUP BY COALESCE(app_bundle_id, 'unknown')
       ORDER BY count DESC`
    )
    .all()
    .map((r) => ({
      app: r.app,
      count: r.count,
      avgLatencyMs: round(r.avg_latency_ms),
      correctionRate: r.correction_rate ?? 0,
    }));

  return {
    totals: {
      dictations,
      totalWords: totalsRow.total_words,
      corrections,
      correctionRate: dictations ? corrections / dictations : 0,
    },
    latency: {
      count: latencies.length,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p99: percentile(latencies, 99),
    },
    stageAverages: {
      timeToFirstPartialMs: round(stageRow.first_partial),
      releaseToPolishedMs: round(stageRow.release_to_polished),
      asrFinalizeMs: round(stageRow.asr_finalize),
      gemmaMs: round(stageRow.gemma),
      pasteMs: round(stageRow.paste),
    },
    wpmTrend,
    correctionRateTrend,
    perApp,
  };
}

module.exports = { getMetrics, percentile, dayKey };
