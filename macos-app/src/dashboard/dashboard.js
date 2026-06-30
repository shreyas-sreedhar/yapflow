/**
 * Metrics dashboard renderer. Pulls aggregates via window.metrics.get()
 * (see preload.js) and draws everything with hand-rolled inline SVG — no
 * external chart library, no network — per the project's zero-cloud ethos.
 *
 * What it surfaces (docs/yapflow-master-plan.md Section 4): WPM trend (is
 * dictation making you faster?), correction-rate trend (is the personal
 * dictionary working? — falling is the signature of success), release→text
 * latency percentiles, the per-stage latency breakdown (where the time
 * actually goes), and a per-app breakdown.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : `${ms} ms`);
const pct = (r) => `${Math.round((r || 0) * 100)}%`;

/** Minimal responsive SVG line chart from [{day, value}] points. */
function lineChart(points, { yLabel, color = '#6ea8fe', format = (v) => v }) {
  const valid = points.filter((p) => p.value !== null && p.value !== undefined);
  if (valid.length === 0) return '<p class="empty">Not enough data yet.</p>';
  const W = 520, H = 180, padL = 44, padR = 12, padT = 12, padB = 28;
  const xs = (i) => padL + (valid.length === 1 ? (W - padL - padR) / 2 : (i / (valid.length - 1)) * (W - padL - padR));
  const vals = valid.map((p) => p.value);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const ys = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
  const path = valid.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(' ');
  const dots = valid.map((p, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.value).toFixed(1)}" r="2.5" fill="${color}"/>`).join('');
  // y gridlines at min / mid / max
  const gridVals = [min, min + span / 2, max];
  const grid = gridVals.map((v) => {
    const y = ys(v).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2a2e3c"/>` +
           `<text x="${padL - 6}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${format(Math.round(v * 10) / 10)}</text>`;
  }).join('');
  // x labels: first, middle, last day
  const labelIdx = [...new Set([0, Math.floor((valid.length - 1) / 2), valid.length - 1])];
  const xlabels = labelIdx.map((i) =>
    `<text x="${xs(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(valid[i].day.slice(5))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" aria-label="${esc(yLabel)}">` +
         `${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>${dots}${xlabels}</svg>`;
}

/** Horizontal bar rows for the per-stage latency breakdown. */
function barRows(rows) {
  const present = rows.filter((r) => r.value !== null && r.value !== undefined);
  if (present.length === 0) return '<p class="empty">No timing data yet.</p>';
  const max = Math.max(...present.map((r) => r.value)) || 1;
  return rows.map((r) => {
    const v = r.value;
    const w = v ? Math.max(2, (v / max) * 100) : 0;
    return `<div class="bar-row"><div>${esc(r.label)}</div>` +
      `<div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>` +
      `<div class="bar-val">${fmtMs(v)}</div></div>`;
  }).join('');
}

function render(m) {
  const root = document.getElementById('root');
  if (!m || m.totals.dictations === 0) {
    root.innerHTML = '<p class="empty">No dictations recorded yet. Hold the hotkey and speak — your trends will appear here.</p>';
    return;
  }

  const cards = `
    <div class="cards">
      <div class="card"><div class="label">Dictations</div><div class="value">${m.totals.dictations}</div></div>
      <div class="card"><div class="label">Median latency</div><div class="value">${m.latency.p50 ?? '—'}<small> ms release→text</small></div></div>
      <div class="card"><div class="label">Correction rate</div><div class="value">${pct(m.totals.correctionRate)}</div></div>
      <div class="card"><div class="label">Words dictated</div><div class="value">${m.totals.totalWords}</div></div>
    </div>`;

  const latencyPanel = `
    <div class="panel">
      <h2>Release → text latency</h2>
      <div class="hint">Time from releasing the hotkey to polished text on screen. Watch the percentiles for regressions.</div>
      <table><thead><tr><th>p50</th><th>p90</th><th>p99</th><th class="num">samples</th></tr></thead>
      <tbody><tr><td>${fmtMs(m.latency.p50)}</td><td>${fmtMs(m.latency.p90)}</td><td>${fmtMs(m.latency.p99)}</td><td class="num">${m.latency.count}</td></tr></tbody></table>
    </div>`;

  const stagePanel = `
    <div class="panel">
      <h2>Where the time goes (avg per stage)</h2>
      <div class="hint">The bottleneck is usually ASR finalize or buffering, not Gemma — this is how you confirm it.</div>
      ${barRows([
        { label: 'Audio → 1st partial', value: m.stageAverages.timeToFirstPartialMs },
        { label: 'ASR finalize', value: m.stageAverages.asrFinalizeMs },
        { label: 'Gemma polish', value: m.stageAverages.gemmaMs },
        { label: 'Release → polished', value: m.stageAverages.releaseToPolishedMs },
        { label: 'Clipboard paste', value: m.stageAverages.pasteMs },
      ])}
    </div>`;

  const trends = `
    <div class="grid2">
      <div class="panel">
        <h2>Words per minute</h2>
        <div class="hint">Speaking duration vs. words produced — is dictation actually making you faster?</div>
        ${lineChart(m.wpmTrend.map((d) => ({ day: d.day, value: d.wpm })), { yLabel: 'WPM', color: '#5fd08a' })}
      </div>
      <div class="panel">
        <h2>Correction rate over time</h2>
        <div class="hint">Falling over time is the visible signature of the personal dictionary working.</div>
        ${lineChart(m.correctionRateTrend.map((d) => ({ day: d.day, value: d.rate })), { yLabel: 'rate', color: '#f0b95b', format: (v) => `${Math.round(v * 100)}%` })}
      </div>
    </div>`;

  const perApp = `
    <div class="panel">
      <h2>By app</h2>
      <table>
        <thead><tr><th>App</th><th class="num">Dictations</th><th class="num">Avg latency</th><th class="num">Correction rate</th></tr></thead>
        <tbody>${m.perApp.map((a) =>
          `<tr><td>${esc(a.app)}</td><td class="num">${a.count}</td><td class="num">${fmtMs(a.avgLatencyMs)}</td><td class="num">${pct(a.correctionRate)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  root.innerHTML = cards + latencyPanel + stagePanel + trends + perApp;
}

async function load() {
  try {
    const m = await window.metrics.get();
    render(m);
  } catch (err) {
    document.getElementById('root').innerHTML = `<p class="empty">Failed to load metrics: ${esc(err.message || err)}</p>`;
  }
}

document.getElementById('reload').addEventListener('click', load);
load();
