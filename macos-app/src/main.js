/**
 * Yapflow — Electron main process.
 *
 * Orchestrates: global hotkey (hold-to-dictate) -> hidden renderer captures
 * mic audio -> streamed over WebSocket to the Jetson -> partial results typed
 * live at the cursor -> on hotkey release, the touched-up final text replaces
 * the raw text via clipboard-paste.
 *
 * Three deliberate decisions in here, none of them defaults:
 *
 *   - Injection is clipboard-paste plus synthetic keystrokes, never the
 *     Accessibility API, which silently no-ops in a long tail of apps. See
 *     lib/textInject.js.
 *   - Replacing already-typed text uses counted backspaces, never Cmd+A.
 *     Select-all cannot tell our own output from text the user already had in
 *     the field, so it destroyed the latter. See syncInjectedText() below.
 *   - The hotkey is CGEventTap-backed (uiohook) rather than Electron's
 *     globalShortcut, which has no concept of held-vs-released. See lib/hotkey.js.
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, systemPreferences } = require('electron');
const path = require('path');

const { Hotkey } = require('./lib/hotkey');
const { DictationConnection } = require('./lib/wsClient');
const {
  warmUp: warmUpInjectHelper,
  shutdown: shutdownInjectHelper,
  injectViaClipboardPaste,
  typeIncrementalDelta,
  retractAndInject,
  getFrontmostAppBundleId,
} = require('./lib/textInject');
const { recordIfCorrection, getLearnedTerms, recordSession } = require('./lib/corrections');
const { DictationTimer } = require('./lib/timing');
const { getMetrics } = require('./lib/metrics');

// --- Configuration ---
// In a real build, surface these in a settings window rather than hardcoding.
// Keeping them as simple constants here since the settings UI is explicitly
// out of scope for this first pass, to keep the always-running surface area
// minimal.
const JETSON_HOST = process.env.YAPFLOW_JETSON_HOST || 'jetson.local';
const JETSON_PORT = process.env.YAPFLOW_JETSON_PORT || '8765';
const JETSON_URL = `ws://${JETSON_HOST}:${JETSON_PORT}`;
const SHARED_SECRET = process.env.YAPFLOW_SECRET || null; // must match jetson-server/config.py

let tray = null;
let captureWindow = null; // hidden window that runs renderer/audioCapture.js
let dashboardWindow = null; // metrics dashboard, opened on demand from the tray
let hotkey = null;

let currentConnection = null;
let currentTimer = null; // per-stage latency trace for the in-flight dictation (see lib/timing.js)
let injectedText = ''; // exactly what we have typed at the cursor in the CURRENT dictation; drives retraction
let lastCompletedPolishedText = ''; // the polished result of the most recently FINISHED dictation, used for cross-dictation correction detection
let lastPolishedAt = 0;
let lastFrontmostAppBundleId = null; // bundle id of the app being dictated into; refreshed per dictation (see startDictation)

function createCaptureWindow() {
  // Hidden, never shown — exists purely to host the renderer-side
  // getUserMedia/AudioWorklet capture pipeline (see renderer/audioCapture.js
  // for why mic capture lives in the renderer rather than a native
  // main-process binding).
  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWindow.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
}

function openDashboard() {
  // Occasionally-opened metrics window, kept off the always-running surface
  // to keep the always-running surface area minimal. Reuse the
  // window if it's already open rather than stacking duplicates.
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 960,
    height: 800,
    title: 'Yapflow — Metrics',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'dashboard', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}

async function requestPermissions() {
  // Microphone permission is requested implicitly by getUserMedia in the
  // renderer the first time it's called. Accessibility permission (needed
  // by helpers/inject for clipboard+CGEvent operations) has to be granted
  // manually by the user in System Settings — Electron/Node can't prompt
  // for that the way it can for mic/camera. Surface a clear message if the
  // helper's stderr is surfaced by textInject.js rather than failing silently.
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }
}

/**
 * Number of backspaces needed to retract `text`.
 *
 * Not `text.length`: that counts UTF-16 code units, while a backspace in a
 * macOS text field deletes one grapheme cluster. An emoji, a ZWJ sequence, or a
 * combining accent is several code units but one backspace, so using .length
 * would over-retract and eat the user's surrounding text.
 *
 * Intl.Segmenter is the correct tool and is available in Electron's V8; the
 * Array.from fallback counts code points, which is still better than code units
 * if it's ever missing.
 */
function graphemeCount(text) {
  if (!text) return 0;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let count = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _segment of segmenter.segment(text)) count++;
    return count;
  }
  return Array.from(text).length;
}

/**
 * Length of the longest common prefix of two strings, measured in whole
 * grapheme clusters so the split point never lands inside one.
 */
function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  // Back off if we've split a surrogate pair, which would produce a lone
  // surrogate on either side of the cut.
  if (i > 0 && i < a.length) {
    const code = a.charCodeAt(i - 1);
    if (code >= 0xd800 && code <= 0xdbff) i--;
  }
  return i;
}

/**
 * Serializes injection work.
 *
 * Partial results arrive faster than a round-trip to the inject helper
 * completes, and these operations are stateful — a backspace and a type from two
 * different updates interleaving would corrupt the text at the cursor and
 * desync our idea of what we've typed. Chaining guarantees one at a time and
 * preserves order.
 */
let injectionChain = Promise.resolve();
function queueInjection(work) {
  injectionChain = injectionChain.then(work).catch((err) => {
    console.error('Injection step failed:', err.message);
  });
  return injectionChain;
}

/**
 * Brings the text at the cursor in line with `target` by retracting only what
 * diverges and typing the rest.
 *
 * This replaces a Cmd+A-then-paste fallback. Select-all could not distinguish
 * our own output from text the user already had in the field, so dictating into
 * a partially-filled field destroyed its contents. Backspacing exactly the
 * grapheme count we typed touches nothing else.
 *
 * Caveat worth knowing: this assumes the cursor is still immediately after the
 * text we typed. If the user clicks elsewhere mid-dictation, the backspaces
 * apply at the new location. There's no way to detect that without the same
 * unreliable Accessibility APIs we avoid for injection, and it's the same
 * limitation every keystroke-based dictation tool has.
 */
async function syncInjectedText(target) {
  if (target === injectedText) return;

  const prefixLength = commonPrefixLength(injectedText, target);
  const retractCount = graphemeCount(injectedText.slice(prefixLength));
  const tail = target.slice(prefixLength);

  // injectedText is updated after EACH step, not once at the end. If the second
  // step throws — the helper died, a request timed out — a single trailing
  // assignment would leave injectedText claiming text that is no longer at the
  // cursor, and the next sync would retract more characters than we own, eating
  // the user's surrounding text. Updating per step keeps it honest under failure.
  if (retractCount > 0) {
    await retractAndInject(retractCount, '');
    injectedText = injectedText.slice(0, prefixLength);
  }
  if (tail) {
    await typeIncrementalDelta(tail);
    injectedText += tail;
  }
}

/**
 * Final swap: replace whatever live partial text we typed with the touched-up
 * transcript.
 *
 * Uses paste rather than keystrokes for the tail so the final text lands
 * atomically. Because the touch-up is deterministic and light, the final usually
 * shares a long prefix with the raw partials — so in practice this is a handful
 * of backspaces plus a short paste, not a full replace.
 */
async function replaceInjectedText(finalText) {
  const prefixLength = commonPrefixLength(injectedText, finalText);
  const retractCount = graphemeCount(injectedText.slice(prefixLength));
  const tail = finalText.slice(prefixLength);

  // Two separate steps, each followed by its own state update, for the same
  // reason as syncInjectedText: a failure between them must not leave
  // injectedText describing text that isn't at the cursor.
  if (retractCount > 0) {
    await retractAndInject(retractCount, '');
    injectedText = injectedText.slice(0, prefixLength);
  }
  if (tail) {
    // Paste rather than keystrokes so the final text lands atomically.
    await injectViaClipboardPaste(tail);
    injectedText += tail;
  }
}

/**
 * Creates the persistent connection to the Jetson and attaches its handlers.
 *
 * Called once at app start, not per dictation. The connection used to be built
 * on hotkey-down, which put a TCP connect and handshake in the hot path; now
 * hotkey-down is just a control message on an already-open socket. Handlers live
 * here rather than in startDictation() so they're registered exactly once —
 * re-attaching per dictation on a long-lived emitter would leak listeners.
 */
function setupConnection() {
  currentConnection = new DictationConnection(JETSON_URL, SHARED_SECRET);

  currentConnection.on('partial', ({ text, sessionText }) => {
    if (currentTimer) currentTimer.markOnce('firstPartial');

    // Use the server's cumulative sessionText, not the per-line `text`.
    // Moonshine's events are per-line and a line ends at every natural speech
    // pause, so `text` restarts from the beginning each time the speaker pauses
    // — it does not grow monotonically across a dictation. Diffing against it
    // made a mid-sentence pause wipe everything already at the cursor.
    // Older servers don't send sessionText; fall back so a version-skewed pair
    // still works.
    const target = sessionText != null ? sessionText : text;
    queueInjection(() => syncInjectedText(target));
  });

  currentConnection.on('polished', ({ rawText, polishedText, timings }) => {
    // `timings` is the Jetson-measured { asrFinalizeMs, touchupMs } durations
    // (see wsClient.js); null-valued against an older server.
    const timer = currentTimer;
    currentTimer = null;
    if (timer) timer.markOnce('polishedReceived');

    if (!polishedText) {
      // No speech detected, or everything said was filler. Retract any live
      // partial text we typed so we don't strand a fragment at the cursor, then
      // stop — never error, never hang. The connection stays open for the next
      // dictation.
      queueInjection(() => replaceInjectedText(''));
      return;
    }

    // Queued behind any in-flight partial injection: a partial that arrived just
    // before the final result must finish typing before we diff against it, or
    // injectedText won't describe what's actually at the cursor.
    queueInjection(() => replaceInjectedText(polishedText))
      .then(() => {
        if (timer) timer.markOnce('pasteDone');
        const now = Date.now();
        const msSinceLast = now - lastPolishedAt;

        // Per-stage latency trace (see lib/timing.js). Log
        // it every dictation so a regression is visible from the first run,
        // and persist the breakdown alongside the session metrics.
        const t = timer ? timer.summary(timings || {}) : {};
        if (timer) console.log(timer.logLine(timings || {}));

        // Check whether this dictation looks like a correction of the
        // immediately-previous one, and log it to the learning store if so.
        // Compare against lastCompletedPolishedText (the previous FINISHED
        // dictation), not injectedText (which tracks live partials within THIS
        // dictation and equals polishedText by this point, making the
        // comparison meaningless).
        const diff = recordIfCorrection({
          previousPolishedText: lastCompletedPolishedText,
          currentRawText: rawText,
          currentPolishedText: polishedText,
          appBundleId: lastFrontmostAppBundleId,
          msSinceLast,
        });

        recordSession({
          rawWordCount: rawText.trim().split(/\s+/).filter(Boolean).length,
          polishedWordCount: polishedText.trim().split(/\s+/).filter(Boolean).length,
          speakingDurationMs: t.speakingDurationMs ?? null,
          releaseToTextLatencyMs: t.releaseToTextMs ?? null,
          timeToFirstPartialMs: t.timeToFirstPartialMs ?? null,
          releaseToPolishedMs: t.releaseToPolishedMs ?? null,
          pasteMs: t.pasteMs ?? null,
          asrFinalizeMs: t.asrFinalizeMs ?? null,
          // The DB column is still named gemma_ms; the value is now the
          // deterministic touch-up's duration. Renaming the column would need a
          // migration and would break the existing dashboard queries, so the
          // name stays and touchupMs feeds it.
          gemmaMs: t.touchupMs ?? t.gemmaMs ?? null,
          asrPath: 'B',
          appBundleId: lastFrontmostAppBundleId,
          hadFollowupCorrection: Boolean(diff),
        });

        lastPolishedAt = now;
        lastCompletedPolishedText = polishedText;
      })
      .catch((err) => {
        console.error('Failed to inject polished text:', err);
      });
    // Note: no connection teardown here. The socket is long-lived now and stays
    // open for the next dictation.
  });

  currentConnection.on('error', (err) => {
    console.error('Jetson connection error:', err.message);
    // On a drop mid-dictation, leave whatever raw partial text is already
    // injected in place rather than losing it — injectedText holds the best
    // transcript we had, and it's more useful at the cursor than discarded.
    // Reconnection is wsClient's job; nothing to do here.
  });

  currentConnection.on('server-error', (message) => {
    console.error('Jetson server reported an error:', message);
  });

  currentConnection.on('open', () => {
    console.log(`Connected to Jetson at ${JETSON_URL}`);
  });

  currentConnection.on('close', ({ code }) => {
    console.warn(`Jetson connection closed (code=${code}); will reconnect if transient`);
  });

  currentConnection.start();
}

function startDictation() {
  // Retire any end-handshake still pending from the previous dictation before
  // bumping the generation, so neither its timer nor a late 'capture-stopped'
  // can end this one.
  clearPendingEnd();
  dictationGeneration++;

  // Starts the per-stage latency trace; the constructor stamps hotkeyDown
  // (≈ mic-start) immediately. See lib/timing.js.
  currentTimer = new DictationTimer();
  injectedText = '';

  // Capture which app we're dictating into, for per-app metrics and
  // personalization. Read asynchronously so we don't add a round-trip to the
  // hotkey-down hot path — it resolves long before the session is recorded (on
  // 'polished'). The knownTerms lookup below may use the prior value;
  // getLearnedTerms tolerates that (it always includes app-agnostic terms too),
  // so the only cost is a marginally-less-targeted term list on the very first
  // dictation into a newly-focused app.
  getFrontmostAppBundleId()
    .then((id) => {
      lastFrontmostAppBundleId = id;
    })
    .catch(() => {});

  // Personal-dictionary learning loop: pull the locally-learned terms relevant
  // to the current frontmost app and send them to the Jetson, where the touch-up
  // step uses them for whole-word substitution. A word-list consulted at
  // inference time, not fine-tuning.
  const knownTerms = getLearnedTerms({ appBundleId: lastFrontmostAppBundleId });

  if (!currentConnection) {
    console.error('No Jetson connection; dropping dictation');
    return;
  }
  if (!currentConnection.isConnected) {
    // Audio is still captured and buffered in wsClient, so a reconnect that
    // lands mid-utterance can still deliver it.
    console.warn('Jetson not connected yet; buffering this dictation');
  }
  currentConnection.beginUtterance(knownTerms);
}

// Guards the end-of-utterance handshake with the renderer. Audio is coalesced
// into ~20ms frames, so at hotkey release there's a partial frame still buffered
// in the renderer; it flushes that and then sends 'capture-stopped'. We wait for
// that signal before telling the server the utterance is over, otherwise the
// server can finalize before the tail of the last word arrives.
//
// The handshake is generation-tagged because it's asynchronous and the user can
// press the hotkey again before it completes. Without the tag, releasing and
// re-pressing inside the fallback window let the PREVIOUS dictation's pending
// end — either the stale timer or a late 'capture-stopped' — send
// end_of_utterance for the NEW dictation, cutting it off almost immediately.
let dictationGeneration = 0;
let pendingEndGeneration = null;
let endUtteranceTimer = null;

function clearPendingEnd() {
  if (endUtteranceTimer) {
    clearTimeout(endUtteranceTimer);
    endUtteranceTimer = null;
  }
  pendingEndGeneration = null;
}

/**
 * Ends the utterance, but only if `generation` is still the one waiting to end.
 * A mismatch means a newer dictation has started since, and this signal is stale.
 */
function sendEndUtterance(generation) {
  if (generation === null || generation !== pendingEndGeneration) return;
  clearPendingEnd();
  if (currentConnection) {
    currentConnection.endUtterance();
  }
}

function endDictation() {
  // Stamp end-of-speech before anything else, so release→polished and
  // release→text measure from the true release rather than from the handshake.
  if (currentTimer) currentTimer.markOnce('hotkeyUp');

  const generation = dictationGeneration;
  pendingEndGeneration = generation;

  // Fallback: if the renderer never reports back (capture failed to start, mic
  // permission denied, renderer crashed), still end the utterance rather than
  // leaving the dictation hanging. Normally 'capture-stopped' beats this by
  // ~1ms.
  endUtteranceTimer = setTimeout(() => {
    endUtteranceTimer = null;
    console.warn('Renderer did not report capture-stopped; ending utterance anyway');
    sendEndUtterance(generation);
  }, 150);
}

function setupTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'tray-icon.png'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Yapflow — hold Right-Cmd to dictate', enabled: false },
    { type: 'separator' },
    { label: 'Open metrics dashboard…', click: () => openDashboard() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip('Yapflow');
}

app.whenReady().then(async () => {
  await requestPermissions();

  createCaptureWindow();
  setupTray();

  // Spawn the inject helper and open the Jetson socket now rather than on the
  // first dictation, so neither the process start nor the WebSocket handshake is
  // paid inside the hotkey path.
  warmUpInjectHelper();
  setupConnection();

  hotkey = new Hotkey();
  hotkey.on('hotkey-down', () => {
    captureWindow.webContents.send('hotkey-down');
    startDictation();
  });
  hotkey.on('hotkey-up', () => {
    captureWindow.webContents.send('hotkey-up');
    endDictation();
  });
  hotkey.start();
});

ipcMain.on('audio-chunk', (event, arrayBuffer) => {
  if (currentConnection) {
    // First chunk reaching the main process ≈ "audio is flowing" — the
    // anchor for the time-to-first-partial responsiveness metric.
    if (currentTimer) currentTimer.markOnce('firstChunkSent');
    currentConnection.sendAudioChunk(Buffer.from(arrayBuffer));
  }
});

ipcMain.on('capture-stopped', () => {
  // The renderer has flushed its last audio frame; now it's safe to finalize.
  // Applies to whichever dictation is currently waiting to end — if a new one
  // has already started, pendingEndGeneration is null and this is a no-op.
  sendEndUtterance(pendingEndGeneration);
});

ipcMain.on('renderer-error', (event, message) => {
  console.error('Renderer reported error:', message);
});

app.on('before-quit', () => {
  // Close the helper's stdin so it exits its read loop cleanly instead of being
  // orphaned or killed mid-clipboard-restore.
  shutdownInjectHelper();
  if (currentConnection) {
    // stop(), not close() — this suppresses the reconnect timer so we don't
    // schedule a retry on the way out.
    currentConnection.stop();
    currentConnection = null;
  }
  if (hotkey) hotkey.stop();
});

// Dashboard renderer asks for the aggregated metrics (see dashboard/preload.js
// and lib/metrics.js). Read-only; runs the synchronous better-sqlite3 queries
// in the main process and returns a plain object.
ipcMain.handle('metrics:get', () => getMetrics());

app.on('window-all-closed', () => {
  // Don't quit — this is a tray app with no normal windows to begin with.
});

app.on('before-quit', () => {
  if (hotkey) hotkey.stop();
});
