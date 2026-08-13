// inject.swift
//
// Minimal compiled helper for the things pure JS/Node cannot do: posting
// synthetic CGEvents and reading/writing the system clipboard with full
// fidelity. See ../src/lib/textInject.js for why clipboard+paste is the primary
// text-injection mechanism rather than the Accessibility API (short version:
// AXUIElementSetAttributeValue silently no-ops in Electron, Qt/GTK, terminals,
// and games — it returns success and nothing appears on screen).
//
// Build:
//   swiftc -O inject.swift -o inject
//
// This binary needs Accessibility permission granted to whatever process runs
// it (in development that's your terminal or IDE; in a packaged app it's the
// Electron app itself) — System Settings > Privacy & Security > Accessibility.
//
// TWO MODES.
//
// `inject daemon` is what the app actually uses. It reads one JSON request per
// line on stdin and writes one JSON response per line to stdout, staying alive
// for the lifetime of the app. This exists because the one-shot mode below cost
// a process spawn per operation — and the inject path needs four or five of them
// per dictation, each one paying AppKit's load cost. That was the second largest
// latency term in the whole app, after the LLM that used to run on the Jetson.
//
// The one-shot argv commands are kept for debugging and manual testing:
//   inject read-clipboard | write-clipboard <text> | paste | select-all
//   inject type-text <text> | backspace <count> | frontmost-app
//
// Note that one-shot mode cannot carry text containing newlines through argv
// cleanly, and `print()` appends a newline that the caller then has to strip —
// which is exactly how the old implementation destroyed trailing whitespace in
// the clipboard it was supposed to be preserving. The daemon protocol uses JSON
// on both sides specifically to avoid that class of bug.

import AppKit
import Foundation

// MARK: - Event source
//
// `.privateState` rather than `.hidSystemState`, and every event's flags set
// explicitly. This is load-bearing, not stylistic.
//
// The dictation hotkey is Right-Command, held down for the duration of the
// utterance while live partial text is being typed. An event built from
// `.hidSystemState` inherits the *current hardware modifier state* — which
// includes that held Command key. So every character typed during a partial
// update could arrive at the target app as Cmd+<char>: Cmd+S, Cmd+W, Cmd+Q.
// `.privateState` gives an event source with its own independent modifier state,
// so synthetic keystrokes mean exactly what they say.
func makeEventSource() -> CGEventSource? {
    return CGEventSource(stateID: .privateState)
}

// MARK: - Clipboard
//
// Snapshot/restore covers every pasteboard item and every type on each item, not
// just plain text. Reading only `.string` (as this helper used to) means that
// restoring after a paste *destroys* whatever was actually on the clipboard when
// it wasn't plain text: images, file references, rich text, anything. Since the
// whole point of snapshot/restore is to leave the user's clipboard as they left
// it, losing everything but plain text defeats it.

struct PasteboardSnapshot {
    // One dictionary per item, mapping raw pasteboard type -> data.
    let items: [[String: Data]]
}

func snapshotPasteboard() -> PasteboardSnapshot {
    let pasteboard = NSPasteboard.general
    var captured: [[String: Data]] = []

    for item in pasteboard.pasteboardItems ?? [] {
        var typeMap: [String: Data] = [:]
        for type in item.types {
            // `data(forType:)` returns nil for types the item advertises but
            // can't materialize (lazy providers whose owner has gone away).
            // Skip those rather than storing empty data, which would otherwise
            // resurrect the type as a valid-but-empty entry on restore.
            if let data = item.data(forType: type) {
                typeMap[type.rawValue] = data
            }
        }
        if !typeMap.isEmpty {
            captured.append(typeMap)
        }
    }

    return PasteboardSnapshot(items: captured)
}

func restorePasteboard(_ snapshot: PasteboardSnapshot) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()

    guard !snapshot.items.isEmpty else { return }

    var items: [NSPasteboardItem] = []
    for typeMap in snapshot.items {
        let item = NSPasteboardItem()
        for (rawType, data) in typeMap {
            item.setData(data, forType: NSPasteboard.PasteboardType(rawType))
        }
        items.append(item)
    }
    pasteboard.writeObjects(items)
}

func readClipboard() -> String {
    return NSPasteboard.general.string(forType: .string) ?? ""
}

/// Writes text and returns the resulting `changeCount`, so a caller can tell
/// when some other process has since taken the pasteboard.
@discardableResult
func writeClipboard(_ text: String) -> Int {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    return pasteboard.changeCount
}

// MARK: - Key events

/// Posts a synthetic key combo with exactly the given flags — never the
/// hardware's current modifiers. See makeEventSource().
///
/// Returns false if the event could not be created or posted. Callers MUST
/// propagate that: reporting success for a keystroke that never happened desyncs
/// the JS side's idea of what is at the cursor, and every subsequent diff is then
/// computed against text that isn't there.
@discardableResult
func postKeyCombo(virtualKey: CGKeyCode, flags: CGEventFlags) -> Bool {
    guard let source = makeEventSource() else {
        FileHandle.standardError.write("Failed to create CGEventSource\n".data(using: .utf8)!)
        return false
    }

    guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
        FileHandle.standardError.write("Failed to create CGEvent\n".data(using: .utf8)!)
        return false
    }

    keyDown.flags = flags
    keyUp.flags = flags

    // .cgAnnotatedSessionEventTap targets the active session's input stream
    // ("as if a physical key was pressed"), which is what we want for injecting
    // into whatever app currently has focus.
    keyDown.post(tap: .cgAnnotatedSessionEventTap)
    keyUp.post(tap: .cgAnnotatedSessionEventTap)
    return true
}

@discardableResult
func paste() -> Bool {
    return postKeyCombo(virtualKey: 0x09, flags: .maskCommand) // kVK_ANSI_V
}

@discardableResult
func selectAll() -> Bool {
    return postKeyCombo(virtualKey: 0x00, flags: .maskCommand) // kVK_ANSI_A
}

/// Sends `count` backspaces. Used to retract previously-typed live partial text
/// without resorting to Cmd+A, which would select — and therefore destroy — text
/// the user already had in the field.
///
/// Returns false if ANY backspace failed, and stops at the first failure. A
/// partially-completed retraction is the dangerous case: reporting success would
/// leave the JS side believing more text was removed than actually was, so the
/// next diff over-retracts into the user's own text.
@discardableResult
func backspace(count: Int) -> Bool {
    guard count > 0 else { return true }
    for _ in 0..<count {
        if !postKeyCombo(virtualKey: 0x33, flags: []) { // kVK_Delete
            return false
        }
    }
    return true
}

/// Types literal text via synthetic Unicode keystrokes.
///
/// Flags are explicitly cleared on every event (see makeEventSource) so a
/// physically-held Right-Command can't turn dictated characters into shortcuts.
///
/// Iterates UTF-16 code units, not unicodeScalars: keyboardSetUnicodeString
/// takes UTF-16, so a scalar outside the BMP (emoji, for instance) has to be
/// delivered as its full surrogate pair. Truncating each scalar to a single
/// UniChar — as this function used to — silently mangled anything above U+FFFF.
@discardableResult
func typeText(_ text: String) -> Bool {
    guard let source = makeEventSource() else {
        FileHandle.standardError.write("Failed to create CGEventSource\n".data(using: .utf8)!)
        return false
    }

    var utf16 = Array(text.utf16)
    guard !utf16.isEmpty else { return true }

    guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        FileHandle.standardError.write("Failed to create CGEvent for typeText\n".data(using: .utf8)!)
        return false
    }
    keyDown.flags = []
    keyUp.flags = []

    // One event pair for the whole string. keyboardSetUnicodeString accepts a
    // multi-unit string, so there's no need for the per-character loop this used
    // to run — which posted two events per character and could overrun apps that
    // debounce their input.
    keyDown.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    keyUp.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    keyDown.post(tap: .cgAnnotatedSessionEventTap)
    keyUp.post(tap: .cgAnnotatedSessionEventTap)
    return true
}

/// Returns the bundle identifier of the app that currently has focus — the app
/// dictated text will land in. Used for per-app metrics and personalization. The
/// hidden Electron capture window never takes focus and the tray app has no key
/// window, so the frontmost app stays the user's actual target.
func frontmostAppBundleId() -> String {
    return NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
}

// MARK: - Paste-with-restore
//
// Writes text, posts Cmd+V, gives the target app time to read the pasteboard,
// then puts the user's clipboard back.
//
// A NOTE ON WHY THIS IS STILL A SLEEP.
//
// An earlier version polled `NSPasteboard.general.changeCount`, on the theory
// that it would move once the target app had taken the pasteboard, letting the
// restore happen as soon as it was safe. That does not work: changeCount
// increments on WRITES (clearContents/declareTypes), and an app servicing Cmd+V
// only READS. The count therefore never moved, the loop always ran to its
// timeout, and the "fast path" was a fixed 250ms sleep wearing a costume.
//
// There is no public API that reports "the frontmost app has finished reading the
// pasteboard", so a delay is the only option. What we can do is keep it off the
// critical path: post Cmd+V, return to the caller immediately, and do the wait
// and restore on a background queue. The user gets their text at Cmd+V time; the
// clipboard heals a moment later.
//
// The tradeoff that remains: an app slower than restoreDelay to service the paste
// gets the restored (old) clipboard instead of the dictated text. 250ms is very
// generous for a local paste, and losing a paste is recoverable — the text is
// still in the transcript — whereas making every dictation wait is not.

let restoreDelay: TimeInterval = 0.25
private let restoreQueue = DispatchQueue(label: "ai.yapflow.inject.restore")
// Tracks deferred restores that haven't run yet, so shutdown can wait for them.
private let pendingRestores = DispatchGroup()

@discardableResult
func pasteTextPreservingClipboard(_ text: String) -> Bool {
    let snapshot = snapshotPasteboard()
    writeClipboard(text)
    let posted = paste()

    // Off the critical path. Serialized on one queue so overlapping pastes restore
    // in order rather than racing each other, and tracked in a group so shutdown
    // can wait rather than abandoning the user's clipboard.
    pendingRestores.enter()
    restoreQueue.asyncAfter(deadline: .now() + restoreDelay) {
        restorePasteboard(snapshot)
        pendingRestores.leave()
    }

    return posted
}

// MARK: - Daemon
//
// Line-delimited JSON in both directions. Requests carry an `id` which is echoed
// on the response so the JS side can correlate without assuming strict ordering.
//
//   {"id":1,"cmd":"paste","text":"hello"}      -> {"id":1,"ok":true}
//   {"id":2,"cmd":"type","text":"hi"}          -> {"id":2,"ok":true}
//   {"id":3,"cmd":"backspace","count":4}       -> {"id":3,"ok":true}
//   {"id":4,"cmd":"frontmost"}                 -> {"id":4,"ok":true,"value":"com.apple.Safari"}
//   {"id":5,"cmd":"read-clipboard"}            -> {"id":5,"ok":true,"value":"..."}
//   {"id":6,"cmd":"write-clipboard","text":"x"}-> {"id":6,"ok":true}
//   {"id":7,"cmd":"select-all"}                -> {"id":7,"ok":true}
//   {"id":8,"cmd":"ping"}                      -> {"id":8,"ok":true}
//
// `paste` is the fast path the dictation flow uses: snapshot, write, Cmd+V,
// wait, restore — all inside one request, so it costs one pipe write from JS.

func respond(id: Any?, ok: Bool, value: String? = nil, error: String? = nil) {
    var payload: [String: Any] = ["ok": ok]
    if let id = id { payload["id"] = id }
    if let value = value { payload["value"] = value }
    if let error = error { payload["error"] = error }

    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else {
        return
    }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func handleDaemonLine(_ line: String) {
    guard let data = line.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data),
          let request = parsed as? [String: Any],
          let cmd = request["cmd"] as? String else {
        respond(id: nil, ok: false, error: "malformed request")
        return
    }

    let id = request["id"]
    let text = request["text"] as? String

    switch cmd {
    case "ping":
        respond(id: id, ok: true)

    // Every event-synthesis command reports whether it actually happened. The JS
    // side tracks what it believes is at the cursor and diffs against it, so a
    // false success is worse than an error: it silently desyncs that model and
    // every later retraction is computed from the wrong length.
    case "paste":
        guard let text = text else {
            respond(id: id, ok: false, error: "paste requires text")
            return
        }
        if pasteTextPreservingClipboard(text) {
            respond(id: id, ok: true)
        } else {
            respond(id: id, ok: false, error: "failed to post Cmd+V (Accessibility permission?)")
        }

    case "type":
        guard let text = text else {
            respond(id: id, ok: false, error: "type requires text")
            return
        }
        if typeText(text) {
            respond(id: id, ok: true)
        } else {
            respond(id: id, ok: false, error: "failed to synthesize keystrokes (Accessibility permission?)")
        }

    case "backspace":
        // JSONSerialization hands back NSNumber for JSON numbers.
        guard let count = (request["count"] as? NSNumber)?.intValue else {
            respond(id: id, ok: false, error: "backspace requires an integer count")
            return
        }
        if backspace(count: count) {
            respond(id: id, ok: true)
        } else {
            respond(id: id, ok: false, error: "backspace incomplete (Accessibility permission?)")
        }

    case "select-all":
        if selectAll() {
            respond(id: id, ok: true)
        } else {
            respond(id: id, ok: false, error: "failed to post Cmd+A (Accessibility permission?)")
        }

    case "read-clipboard":
        respond(id: id, ok: true, value: readClipboard())

    case "write-clipboard":
        guard let text = text else {
            respond(id: id, ok: false, error: "write-clipboard requires text")
            return
        }
        writeClipboard(text)
        respond(id: id, ok: true)

    case "frontmost":
        respond(id: id, ok: true, value: frontmostAppBundleId())

    default:
        respond(id: id, ok: false, error: "unknown command: \(cmd)")
    }
}

func runDaemon() {
    // readLine() blocks on stdin and returns nil at EOF, which is our shutdown
    // signal: when the Electron app exits, the pipe closes and we fall out of
    // the loop. `strippingNewline: true` keeps the JSON parse clean.
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        handleDaemonLine(line)
    }

    // Clipboard restores are deferred, so a paste right before shutdown may still
    // have one pending. Exiting now would leave the dictated text on the user's
    // clipboard in place of whatever they had copied.
    //
    // A DispatchGroup, not restoreQueue.sync: the restores are scheduled with
    // asyncAfter, and a sync block submitted now would run BEFORE a delayed block
    // whose deadline hasn't arrived — waiting on the queue would prove nothing.
    // The timeout is a little over the delay so a wedged restore can't hang exit.
    _ = pendingRestores.wait(timeout: .now() + restoreDelay + 0.5)
}

// MARK: - Entry point

let arguments = CommandLine.arguments

guard arguments.count >= 2 else {
    FileHandle.standardError.write(
        """
        Usage: inject <command>

          daemon                    line-delimited JSON on stdin/stdout (what the app uses)
          read-clipboard            print the clipboard's plain text
          write-clipboard <text>    set the clipboard to <text>
          paste                     synthesize Cmd+V
          select-all                synthesize Cmd+A
          type-text <text>          synthesize <text> as keystrokes
          backspace <count>         synthesize <count> backspaces
          frontmost-app             print the frontmost app's bundle id

        """.data(using: .utf8)!
    )
    exit(1)
}

switch arguments[1] {
case "daemon":
    runDaemon()

case "read-clipboard":
    print(readClipboard())

case "write-clipboard":
    guard arguments.count >= 3 else {
        FileHandle.standardError.write("write-clipboard requires a text argument\n".data(using: .utf8)!)
        exit(1)
    }
    writeClipboard(arguments[2])

case "paste":
    paste()

case "select-all":
    selectAll()

case "type-text":
    guard arguments.count >= 3 else {
        FileHandle.standardError.write("type-text requires a text argument\n".data(using: .utf8)!)
        exit(1)
    }
    typeText(arguments[2])

case "backspace":
    guard arguments.count >= 3, let count = Int(arguments[2]) else {
        FileHandle.standardError.write("backspace requires an integer count\n".data(using: .utf8)!)
        exit(1)
    }
    backspace(count: count)

case "frontmost-app":
    print(frontmostAppBundleId())

default:
    FileHandle.standardError.write("Unknown command: \(arguments[1])\n".data(using: .utf8)!)
    exit(1)
}
