/**
 * Text injection at the cursor.
 *
 * Why clipboard+paste rather than the Accessibility API:
 * AXUIElementSetAttributeValue (direct AX text writes) silently no-ops in
 * Electron apps, Qt/GTK apps, games, and terminals — the call returns success
 * and nothing happens on screen. Clipboard snapshot -> write -> synthesized
 * Cmd+V -> restore is the mechanism that actually works across the long tail of
 * apps, and it's what comparable dictation tools land on too.
 *
 * The native parts (CGEvent posting, full-fidelity clipboard access) live in a
 * small compiled Swift helper — see ../../helpers/inject.swift. Node has no
 * binding for either.
 *
 * That helper now runs as a LONG-LIVED DAEMON, spawned once, spoken to over
 * stdin/stdout with one JSON object per line. It used to be invoked per
 * operation via execFile, which meant a process spawn — and an AppKit load —
 * for each of read-clipboard, write-clipboard, paste, and restore. Four or five
 * spawns per dictation, plus a hard 250ms sleep waiting for the paste to land,
 * made this the second largest latency term in the app after the LLM that used
 * to run on the Jetson. Now an injection is one pipe write.
 *
 * JSON rather than argv for the protocol because dictated text contains
 * newlines, quotes, and emoji. argv couldn't carry those, and the old
 * `print()` + `.trim()` round-trip actively destroyed trailing whitespace in
 * the very clipboard contents it was meant to preserve.
 */

const { spawn } = require('child_process');
const path = require('path');

const HELPER_PATH = path.join(__dirname, '..', '..', 'helpers', 'inject');

// How long to wait for a daemon reply before rejecting. Generous: the slowest
// command is `paste`, which internally polls the pasteboard's changeCount for up
// to 250ms before restoring. This ceiling exists so a wedged helper surfaces as
// an error rather than a promise that never settles.
const REQUEST_TIMEOUT_MS = 2000;

let child = null;
let nextRequestId = 1;
const pending = new Map();
let stdoutBuffer = '';

function rejectAllPending(err) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(err);
  }
  pending.clear();
}

/**
 * Handles a chunk of the daemon's stdout. Responses are newline-delimited JSON,
 * but a chunk boundary can fall anywhere — including mid-line — so buffer and
 * only parse complete lines.
 */
function onStdoutChunk(chunk) {
  stdoutBuffer += chunk;

  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;

    let response;
    try {
      response = JSON.parse(line);
    } catch (err) {
      console.error('inject daemon: unparseable response line:', line);
      continue;
    }

    const entry = pending.get(response.id);
    if (!entry) {
      // A reply to a request we already timed out. Nothing to do.
      continue;
    }
    pending.delete(response.id);
    clearTimeout(entry.timer);

    if (response.ok) {
      entry.resolve(response.value);
    } else {
      entry.reject(new Error(`inject daemon: ${response.error || 'unknown error'}`));
    }
  }
}

function startDaemon() {
  child = spawn(HELPER_PATH, ['daemon'], { stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onStdoutChunk);

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => {
    // The helper logs CGEvent/CGEventSource failures here. Usually means
    // Accessibility permission hasn't been granted.
    console.error('inject daemon stderr:', data.trim());
  });

  // Without a listener, an EPIPE on the pipe (helper died between our writable
  // check and the write) is an unhandled stream error, which is fatal in the
  // Electron main process. The 'exit' handler does the actual recovery.
  child.stdin.on('error', (err) => {
    console.error('inject daemon stdin error:', err.message);
  });

  child.on('error', (err) => {
    console.error('inject daemon failed to start:', err.message);
    child = null;
    rejectAllPending(err);
  });

  child.on('exit', (code, signal) => {
    // Don't respawn here — the next request does that lazily. Respawning on
    // exit would spin if the helper is crashing on startup (missing binary,
    // denied permission), and a tight spawn loop is worse than a failed paste.
    console.error(`inject daemon exited (code=${code} signal=${signal})`);
    child = null;
    stdoutBuffer = '';
    rejectAllPending(new Error('inject daemon exited'));
  });

  return child;
}

function ensureDaemon() {
  if (child && !child.killed && child.exitCode === null) return child;
  return startDaemon();
}

/**
 * Sends one command to the daemon and resolves with its `value` (undefined for
 * commands that don't return one).
 */
function request(cmd, extra = {}) {
  return new Promise((resolve, reject) => {
    let daemon;
    try {
      daemon = ensureDaemon();
    } catch (err) {
      reject(err);
      return;
    }
    if (!daemon || !daemon.stdin.writable) {
      reject(new Error('inject daemon is not running'));
      return;
    }

    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`inject daemon: '${cmd}' timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    try {
      daemon.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

/** Starts the helper eagerly, so the first dictation doesn't pay the spawn. */
function warmUp() {
  return request('ping').catch((err) => {
    console.error('inject daemon warm-up failed:', err.message);
  });
}

function shutdown() {
  if (child) {
    child.stdin.end();
    child = null;
  }
}

/**
 * Injects text at the current cursor position: snapshot the clipboard, write
 * `text`, synthesize Cmd+V, then restore the original clipboard.
 *
 * All of that now happens inside the helper in a single request, which matters
 * for two reasons beyond speed. The snapshot covers every pasteboard item and
 * type rather than plain text only, so pasting no longer destroys an image or a
 * file reference the user had copied. And the restore waits on the pasteboard's
 * changeCount instead of a fixed 250ms sleep, so it's both faster in the common
 * case and correct on a loaded system.
 */
async function injectViaClipboardPaste(text) {
  await request('paste', { text });
}

/**
 * Selects all text in the focused field and replaces it via clipboard-paste.
 *
 * NOT used by the dictation path — Cmd+A selects the whole field, so this
 * destroys any text the user already had there. Kept because it's occasionally
 * the right tool deliberately, but prefer retractAndInject() for anything on the
 * dictation flow.
 */
async function replaceCurrentTextViaClipboardPaste(text) {
  await request('select-all');
  await injectViaClipboardPaste(text);
}

/**
 * Types text incrementally via synthetic keystrokes — the live "text grows as
 * you speak" effect. Pass only the NEW text since the last update, not the
 * accumulated transcript.
 *
 * Expect occasional desync in apps with debounced or managed input (rich text
 * editors, some Electron apps). That's a known rough edge of synthetic-keystroke
 * injection across every comparable tool, not a bug worth chasing indefinitely.
 */
async function typeIncrementalDelta(delta) {
  if (!delta) return;
  await request('type', { text: delta });
}

/**
 * Retracts `charCount` characters of previously-typed text and injects
 * `replacement` in their place.
 *
 * This is the non-destructive replacement primitive the dictation path uses
 * instead of Cmd+A. Backspacing exactly as many characters as we typed touches
 * only our own output and leaves the rest of the field alone; select-all-and-
 * paste cannot make that distinction and silently ate pre-existing text.
 *
 * `replacement` goes in via clipboard-paste rather than keystrokes so it lands
 * atomically — a long final transcript typed character-by-character is both
 * slower and more likely to desync.
 */
async function retractAndInject(charCount, replacement) {
  if (charCount > 0) {
    await request('backspace', { count: charCount });
  }
  if (replacement) {
    await injectViaClipboardPaste(replacement);
  }
}

/**
 * Reads the bundle id of the frontmost app — the app dictated text will be
 * injected into. Used for per-app metrics and personalization, never for
 * injection itself. Returns null on any failure so callers can treat per-app
 * context as simply "unknown" rather than erroring.
 */
async function getFrontmostAppBundleId() {
  try {
    const out = await request('frontmost');
    return out || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  warmUp,
  shutdown,
  injectViaClipboardPaste,
  replaceCurrentTextViaClipboardPaste,
  typeIncrementalDelta,
  retractAndInject,
  getFrontmostAppBundleId,
};
