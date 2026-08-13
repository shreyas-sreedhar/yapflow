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
func postKeyCombo(virtualKey: CGKeyCode, flags: CGEventFlags) {
    guard let source = makeEventSource() else {
        FileHandle.standardError.write("Failed to create CGEventSource\n".data(using: .utf8)!)
        return
    }

    guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
        FileHandle.standardError.write("Failed to create CGEvent\n".data(using: .utf8)!)
        return
    }

    keyDown.flags = flags
    keyUp.flags = flags

    // .cgAnnotatedSessionEventTap targets the active session's input stream
    // ("as if a physical key was pressed"), which is what we want for injecting
    // into whatever app currently has focus.
    keyDown.post(tap: .cgAnnotatedSessionEventTap)
    keyUp.post(tap: .cgAnnotatedSessionEventTap)
}

func paste() {
    postKeyCombo(virtualKey: 0x09, flags: .maskCommand) // kVK_ANSI_V
}

func selectAll() {
    postKeyCombo(virtualKey: 0x00, flags: .maskCommand) // kVK_ANSI_A
}

/// Sends `count` backspaces. Used to retract previously-typed live partial text
/// without resorting to Cmd+A, which would select — and therefore destroy — text
/// the user already had in the field.
func backspace(count: Int) {
    guard count > 0 else { return }
    for _ in 0..<count {
        postKeyCombo(virtualKey: 0x33, flags: []) // kVK_Delete
    }
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
func typeText(_ text: String) {
    guard let source = makeEventSource() else {
        FileHandle.standardError.write("Failed to create CGEventSource\n".data(using: .utf8)!)
        return
    }

    var utf16 = Array(text.utf16)
    guard !utf16.isEmpty else { return }

    guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        return
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
// Writes text, posts Cmd+V, waits for the target app to actually read the
// pasteboard, then puts the user's clipboard back.
//
// The wait used to be a flat 250ms sleep on the JS side, which was both too slow
// in the common case and not actually a guarantee in the slow case. Instead poll
// `changeCount`: when it moves past our own write, something else has taken the
// pasteboard and restoring is safe. Cap the wait so a target app that never
// touches the pasteboard can't strand the user's clipboard.

let restorePollInterval: TimeInterval = 0.005
let restorePollTimeout: TimeInterval = 0.25

func pasteTextPreservingClipboard(_ text: String) {
    let snapshot = snapshotPasteboard()
    let ourChangeCount = writeClipboard(text)
    paste()

    let deadline = Date().addingTimeInterval(restorePollTimeout)
    while Date() < deadline {
        if NSPasteboard.general.changeCount != ourChangeCount {
            break
        }
        Thread.sleep(forTimeInterval: restorePollInterval)
    }

    restorePasteboard(snapshot)
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

    case "paste":
        guard let text = text else {
            respond(id: id, ok: false, error: "paste requires text")
            return
        }
        pasteTextPreservingClipboard(text)
        respond(id: id, ok: true)

    case "type":
        guard let text = text else {
            respond(id: id, ok: false, error: "type requires text")
            return
        }
        typeText(text)
        respond(id: id, ok: true)

    case "backspace":
        // JSONSerialization hands back NSNumber for JSON numbers.
        guard let count = (request["count"] as? NSNumber)?.intValue else {
            respond(id: id, ok: false, error: "backspace requires an integer count")
            return
        }
        backspace(count: count)
        respond(id: id, ok: true)

    case "select-all":
        selectAll()
        respond(id: id, ok: true)

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
