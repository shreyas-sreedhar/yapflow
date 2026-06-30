/**
 * Yapflow — Electron main process.
 *
 * Orchestrates: global hotkey (hold-to-dictate) -> hidden renderer captures
 * mic audio -> streamed over WebSocket to the Jetson -> partial results
 * typed live at the cursor -> on hotkey release, final polished text
 * replaces the raw text via clipboard-paste.
 *
 * Read ../../CLAUDE.md before changing the architecture here — several
 * decisions in this file (clipboard-paste for injection, CGEventTap-backed
 * hotkey, one-connection-per-dictation) are deliberate, not defaults.
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, systemPreferences } = require('electron');
const path = require('path');

const { Hotkey } = require('./lib/hotkey');
const { DictationConnection } = require('./lib/wsClient');
const {
  replaceCurrentTextViaClipboardPaste,
  typeIncrementalDelta,
  getFrontmostAppBundleId,
} = require('./lib/textInject');
const { recordIfCorrection, getLearnedTerms, recordSession } = require('./lib/corrections');
const { DictationTimer } = require('./lib/timing');

// --- Configuration ---
// In a real build, surface these in a settings window rather than hardcoding.
// Keeping them as simple constants here since the settings UI is explicitly
// out of scope for this first pass (see CLAUDE.md: "keep the always-running
// surface area minimal").
const JETSON_HOST = process.env.YAPFLOW_JETSON_HOST || 'jetson.local';
const JETSON_PORT = process.env.YAPFLOW_JETSON_PORT || '8765';
const JETSON_URL = `ws://${JETSON_HOST}:${JETSON_PORT}`;
const SHARED_SECRET = process.env.YAPFLOW_SECRET || null; // must match jetson-server/config.py

let tray = null;
let captureWindow = null; // hidden window that runs renderer/audioCapture.js
let hotkey = null;

let currentConnection = null;
let currentTimer = null; // per-stage latency trace for the in-flight dictation (see lib/timing.js)
let lastInjectedText = ''; // tracks live partial text WITHIN the current dictation only
let lastCompletedPolishedText = ''; // the polished result of the most recently FINISHED dictation, used for cross-dictation correction detection
let lastPolishedAt = 0;
let lastFrontmostAppBundleId = null; // bundle id of the app being dictated into; refreshed per dictation (see startDictation)

function createCaptureWindow() {
  // Hidden, never shown — exists purely to host the renderer-side
  // getUserMedia/AudioWorklet capture pipeline (see renderer/audioCapture.js
  // and the comment in package.json/CLAUDE.md about why mic capture lives
  // in the renderer rather than a native main-process binding).
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

async function requestPermissions() {
  // Microphone permission is requested implicitly by getUserMedia in the
  // renderer the first time it's called. Accessibility permission (needed
  // by helpers/inject for clipboard+CGEvent operations) has to be granted
  // manually by the user in System Settings — Electron/Node can't prompt
  // for that the way it can for mic/camera. Surface a clear message if the
  // helper fails rather than failing silently; see textInject.js's runHelper.
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }
}

function startDictation() {
  // Starts the per-stage latency trace; the constructor stamps hotkeyDown
  // (≈ mic-start) immediately. See lib/timing.js.
  currentTimer = new DictationTimer();
  lastInjectedText = '';

  // Capture which app we're dictating into, for per-app metrics and
  // personalization. Read asynchronously so we don't add a process-spawn to
  // the hotkey-down hot path — it resolves long before the session is
  // recorded (on 'polished'). The knownTerms lookup below may use the prior
  // value; getLearnedTerms tolerates that (it always includes app-agnostic
  // terms too), so the only cost is a marginally-less-targeted term list on
  // the very first dictation into a newly-focused app.
  getFrontmostAppBundleId()
    .then((id) => {
      lastFrontmostAppBundleId = id;
    })
    .catch(() => {});

  // Personal-dictionary learning loop (see CLAUDE.md Decisions section 5 /
  // docs/yapflow-master-plan.md Section 3.3): pull the locally-learned
  // terms relevant to the current frontmost app (if known) and send them
  // to the Jetson so the Gemma polish call can use them. This is a plain
  // word-list consulted at inference time, not fine-tuning — see the
  // master plan for why that distinction matters.
  const knownTerms = getLearnedTerms({ appBundleId: lastFrontmostAppBundleId });

  currentConnection = new DictationConnection(JETSON_URL, SHARED_SECRET, knownTerms);

  currentConnection.on('partial', ({ text, isFinal }) => {
    if (currentTimer) currentTimer.markOnce('firstPartial');
    // Live partial injection: type only the delta since the last update,
    // via synthetic keystrokes — NOT clipboard-paste, per CLAUDE.md
    // Decisions section 2. The final polished replace (below, on
    // 'polished') is what uses clipboard-paste.
    if (text.length > lastInjectedText.length && text.startsWith(lastInjectedText)) {
      const delta = text.slice(lastInjectedText.length);
      typeIncrementalDelta(delta).catch((err) => {
        console.error('Failed to type incremental delta:', err);
      });
    } else if (text !== lastInjectedText) {
      // Text diverged in a way that isn't a simple append (Moonshine
      // revised an earlier word) — fall back to a full select-all-replace
      // rather than trying to reconcile a complex diff via keystrokes.
      replaceCurrentTextViaClipboardPaste(text).catch((err) => {
        console.error('Failed to replace diverged partial text:', err);
      });
    }
    lastInjectedText = text;
  });

  currentConnection.on('polished', ({ rawText, polishedText, timings }) => {
    // `timings` is the Jetson-measured { asrFinalizeMs, gemmaMs } durations,
    // present once the server side reports them (see wsClient.js); harmless
    // and null-valued until then.
    const timer = currentTimer;
    if (timer) timer.markOnce('polishedReceived');

    if (!polishedText) {
      // No speech detected (very short utterance) — per the spec's
      // resilience checklist, don't error or hang, just leave whatever
      // (likely nothing) is already at the cursor.
      currentConnection.close();
      currentConnection = null;
      return;
    }

    replaceCurrentTextViaClipboardPaste(polishedText)
      .then(() => {
        if (timer) timer.markOnce('pasteDone');
        const now = Date.now();
        const msSinceLast = now - lastPolishedAt;

        // Per-stage latency trace (see lib/timing.js / master-plan §4). Log
        // it every dictation so a regression is visible from the first run,
        // and persist the breakdown alongside the session metrics.
        const t = timer ? timer.summary(timings || {}) : {};
        if (timer) console.log(timer.logLine(timings || {}));

        // Check whether this dictation looks like a correction of the
        // immediately-previous one, and log it to the learning store if so.
        // Compare against lastCompletedPolishedText (the previous FINISHED
        // dictation), not lastInjectedText (which only tracks live partials
        // within THIS dictation and would always equal polishedText itself
        // by this point, making the comparison meaningless).
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
          gemmaMs: t.gemmaMs ?? null,
          asrPath: 'B', // Path B per CLAUDE.md architecture decision
          appBundleId: lastFrontmostAppBundleId,
          hadFollowupCorrection: Boolean(diff),
        });

        lastPolishedAt = now;
        lastCompletedPolishedText = polishedText;
      })
      .catch((err) => {
        console.error('Failed to inject polished text:', err);
      })
      .finally(() => {
        if (currentConnection) {
          currentConnection.close();
          currentConnection = null;
        }
      });
  });

  currentConnection.on('error', (err) => {
    console.error('Jetson connection error:', err.message);
    // Per the spec's resilience checklist (Step 6): on a dropped
    // connection mid-dictation, leave whatever raw partial text is already
    // injected in place rather than losing it. We deliberately do nothing
    // further here — lastInjectedText already reflects the best transcript
    // we had before the drop.
  });

  currentConnection.on('server-error', (message) => {
    console.error('Jetson server reported an error:', message);
  });

  currentConnection.connect();
}

function endDictation() {
  // end-of-speech: stamp it before signalling the server so the
  // release→polished and release→text deltas measure from the true release.
  if (currentTimer) currentTimer.markOnce('hotkeyUp');
  if (currentConnection) {
    currentConnection.endUtterance();
  }
}

function setupTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'tray-icon.png'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Yapflow — hold Right-Cmd to dictate', enabled: false },
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

ipcMain.on('renderer-error', (event, message) => {
  console.error('Renderer reported error:', message);
});

app.on('window-all-closed', () => {
  // Don't quit — this is a tray app with no normal windows to begin with.
});

app.on('before-quit', () => {
  if (hotkey) hotkey.stop();
});
