/**
 * Text injection at the cursor.
 *
 * See ../../../CLAUDE.md Decisions section 1 before changing anything here.
 * Summary of why this file is shaped the way it is: AXUIElementSetAttributeValue
 * (direct Accessibility-API text writes) silently no-ops in Electron apps,
 * Qt/GTK apps, games, and terminals — the call returns success but nothing
 * happens on screen. The reliable mechanism across real-world dictation
 * apps (FreeFlow, OpenWhispr, and a macOS-26 SpeechAnalyzer+Ollama dictation
 * app shared on Apple's developer forums) is clipboard snapshot -> write ->
 * synthesized Cmd+V -> restore.
 *
 * This module shells out to a tiny compiled Swift/AppleScript helper for
 * the parts Node can't do natively (reading/writing the system clipboard
 * with full fidelity, and posting synthetic CGEvents) — see
 * helpers/inject.swift. Electron/Node has no built-in CGEventPost binding,
 * so this is the one place in the Mac app that isn't pure JS. This is a
 * much smaller and narrower native surface than a full SpeechAnalyzer-based
 * Path A helper would have been (see CLAUDE.md's Architecture section on
 * why Path B was chosen) — it does exactly two things: clipboard read/write
 * and synthetic Cmd+V / Cmd+A, nothing else.
 */

const { execFile } = require('child_process');
const path = require('path');

const HELPER_PATH = path.join(__dirname, '..', '..', 'helpers', 'inject');

function runHelper(args) {
  return new Promise((resolve, reject) => {
    execFile(HELPER_PATH, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`inject helper failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Injects text at the current cursor position by:
 *   1. Snapshotting whatever's currently on the clipboard
 *   2. Writing `text` to the clipboard
 *   3. Synthesizing Cmd+V
 *   4. Restoring the original clipboard contents after a short delay
 *
 * The delay before restoring matters — restore too fast and the target
 * app may not have finished reading the pasteboard yet, especially on a
 * loaded system. 250ms is a reasonable default; if you see pastes
 * occasionally containing the OLD clipboard contents instead of the new
 * text, that's a sign this needs to be longer for your hardware.
 */
async function injectViaClipboardPaste(text) {
  const previousClipboard = await runHelper(['read-clipboard']);
  await runHelper(['write-clipboard', text]);
  await runHelper(['paste']);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await runHelper(['write-clipboard', previousClipboard]);
}

/**
 * Selects all currently-selected/focused text and replaces it via
 * clipboard-paste. Used when swapping the raw partial transcript for the
 * polished final version. Falls back to a blunt Cmd+A (select-all in the
 * focused field) rather than a precise Accessibility-API range-select,
 * because AXUIElement text-range operations have the same unreliable-in-
 * many-apps problem as direct writes do — see CLAUDE.md Decisions section 1.
 * This is intentionally blunter than a "perfect" implementation in exchange
 * for actually working across the long tail of apps.
 */
async function replaceCurrentTextViaClipboardPaste(text) {
  await runHelper(['select-all']);
  await injectViaClipboardPaste(text);
}

/**
 * Types text incrementally via synthetic keystrokes rather than clipboard-
 * paste. Used ONLY for the live "text grows as you speak" partial-result
 * effect (see CLAUDE.md Decisions section 2) — NOT for the final polished
 * replace, which uses clipboard-paste instead. Expect occasional desync in
 * apps with debounced/managed input (rich text editors, some Electron
 * apps); this is a known rough edge across all comparable dictation tools,
 * not a bug worth chasing indefinitely.
 *
 * `delta` should be just the NEW text since the last partial update, not
 * the full accumulated transcript — the caller (main.js) is responsible
 * for diffing successive partial results and passing only the delta here.
 */
async function typeIncrementalDelta(delta) {
  if (!delta) return;
  await runHelper(['type-text', delta]);
}

/**
 * Reads the bundle id of the frontmost (focused) app — the app dictated text
 * will be injected into. Used for per-app metrics and personalization, not
 * for injection itself. Returns null on any failure (helper missing, no
 * frontmost app) so callers can treat per-app context as simply "unknown"
 * rather than erroring — it's a nice-to-have dimension, never load-bearing.
 */
async function getFrontmostAppBundleId() {
  try {
    const out = await runHelper(['frontmost-app']);
    return out || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  injectViaClipboardPaste,
  replaceCurrentTextViaClipboardPaste,
  typeIncrementalDelta,
  getFrontmostAppBundleId,
};
