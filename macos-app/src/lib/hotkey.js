/**
 * Global hotkey detection for hold-to-dictate.
 *
 * IMPORTANT — see ../../../CLAUDE.md Decisions section 3: this deliberately
 * does NOT use Electron's built-in `globalShortcut` module, because
 * globalShortcut only fires a single combined event on key-down — it has no
 * concept of "held" vs "released", which is the entire UX this app needs
 * (hold to dictate, release to finalize). It also does not use
 * `NSEvent.addGlobalMonitorForEvents`-style APIs, which are documented to
 * crash with a Bus error on macOS 26 due to a Swift actor runtime issue.
 *
 * uiohook-napi is used instead. It's backed by libuiohook, which uses
 * CGEventTap on macOS — the same underlying mechanism the spec calls for —
 * and gives real keydown/keyup events, which is what hold-to-talk requires.
 *
 * Requires Accessibility permission to be granted to this app (System
 * Settings > Privacy & Security > Accessibility). See requestPermissions()
 * in main.js for how that's surfaced to the user.
 */

const { uIOhook, UiohookKey } = require('uiohook-napi');
const { EventEmitter } = require('events');

// The hold-to-dictate key. Default is Right-Ctrl (UiohookKey.CtrlRight) —
// chosen because Right-Command's keycode is reported inconsistently across
// libuiohook/uiohook-napi versions (see note below), so Right-Ctrl is the
// reliable default. Override without editing code by setting
// YAPFLOW_HOTKEY_KEYCODE to the numeric keycode you want (discover it with
// YAPFLOW_DEBUG_KEYS=1, which logs every keydown's keycode).
const HOTKEY_CODE = process.env.YAPFLOW_HOTKEY_KEYCODE
  ? parseInt(process.env.YAPFLOW_HOTKEY_KEYCODE, 10)
  : UiohookKey.CtrlRight;

// When set, log the keycode of every keydown so you can identify the code
// for the physical key you want to bind, then set YAPFLOW_HOTKEY_KEYCODE.
const DEBUG_KEYS = Boolean(process.env.YAPFLOW_DEBUG_KEYS);

/**
 * NOTE on Right-Command specifically: uiohook-napi's UiohookKey enum does
 * not expose a distinct Right-Command keycode on all versions — Meta/Cmd
 * keys can be inconsistently reported as left vs right across platforms in
 * libuiohook. If UiohookKey.MetaRight (or similar) is available in the
 * installed version, prefer it over CtrlRight above. Verify by logging
 * `e.keycode` for actual Right-Cmd presses on your machine during Step 0
 * of the build (see docs/yapflow-master-plan.md execution checklist) and
 * hard-code the confirmed numeric keycode here if the named export doesn't
 * match what you expect. This is exactly the kind of thing that's faster
 * to verify empirically on real hardware than to guess from documentation.
 */

class Hotkey extends EventEmitter {
  constructor() {
    super();
    this._isDown = false;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    console.log(
      `[hotkey] listening for keycode ${HOTKEY_CODE}` +
        (process.env.YAPFLOW_HOTKEY_KEYCODE ? ' (from YAPFLOW_HOTKEY_KEYCODE)' : ' (default Right-Ctrl)') +
        (DEBUG_KEYS ? ' — DEBUG_KEYS on, logging all keydowns' : '')
    );

    uIOhook.on('keydown', (e) => {
      if (DEBUG_KEYS) console.log(`[hotkey] keydown keycode=${e.keycode}`);
      if (e.keycode === HOTKEY_CODE && !this._isDown) {
        this._isDown = true;
        this.emit('hotkey-down');
      }
    });

    uIOhook.on('keyup', (e) => {
      if (e.keycode === HOTKEY_CODE && this._isDown) {
        this._isDown = false;
        this.emit('hotkey-up');
      }
    });

    uIOhook.start();
  }

  stop() {
    if (!this._started) return;
    uIOhook.stop();
    this._started = false;
  }
}

module.exports = { Hotkey };
