// inject.swift
//
// Minimal compiled helper for the one job pure JS/Node cannot do: posting
// synthetic CGEvents and doing full-fidelity clipboard read/write. This is
// intentionally narrow — see ../src/lib/textInject.js for why it exists and
// ../../CLAUDE.md Decisions section 1 for why clipboard+paste is the
// primary text-injection mechanism rather than the Accessibility API.
//
// Build:
//   swiftc inject.swift -o inject
//   (then make sure the compiled `inject` binary ships alongside the
//   Electron app — see mac-app/README.md for packaging notes)
//
// This binary needs Accessibility permission granted to whatever process
// ultimately runs it (in development, that's likely Terminal or your IDE;
// in a packaged app, it's the Electron app itself) — System Settings >
// Privacy & Security > Accessibility.
//
// Usage:
//   inject read-clipboard                 -> prints current clipboard text to stdout
//   inject write-clipboard "<text>"       -> sets the clipboard to <text>
//   inject paste                          -> synthesizes Cmd+V
//   inject select-all                     -> synthesizes Cmd+A
//   inject type-text "<text>"             -> synthesizes the literal text as keystrokes

import AppKit
import Foundation

func readClipboard() -> String {
    let pasteboard = NSPasteboard.general
    return pasteboard.string(forType: .string) ?? ""
}

func writeClipboard(_ text: String) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
}

/// Posts a synthetic key event with the given modifier flags. Used for
/// Cmd+V and Cmd+A. virtualKey codes are the standard macOS HID usage
/// values for the US keyboard layout (kVK_ANSI_V = 0x09, kVK_ANSI_A = 0x00).
func postKeyCombo(virtualKey: CGKeyCode, flags: CGEventFlags) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        FileHandle.standardError.write("Failed to create CGEventSource\n".data(using: .utf8)!)
        exit(1)
    }

    guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
        FileHandle.standardError.write("Failed to create CGEvent\n".data(using: .utf8)!)
        exit(1)
    }

    keyDown.flags = flags
    keyUp.flags = flags

    // .cgAnnotatedSessionEventTap targets the active session's input stream
    // (i.e. "as if a physical key was pressed"), which is what we want for
    // injecting into whatever app currently has focus.
    keyDown.post(tap: .cgAnnotatedSessionEventTap)
    keyUp.post(tap: .cgAnnotatedSessionEventTap)
}

func paste() {
    postKeyCombo(virtualKey: 0x09, flags: .maskCommand) // kVK_ANSI_V
}

func selectAll() {
    postKeyCombo(virtualKey: 0x00, flags: .maskCommand) // kVK_ANSI_A
}

/// Types literal text via synthetic Unicode keystrokes, used only for the
/// live incremental partial-result effect (see textInject.js
/// typeIncrementalDelta — NOT used for the final polished replace, which
/// uses clipboard+paste instead).
func typeText(_ text: String) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        FileHandle.standardError.write("Failed to create CGEventSource\n".data(using: .utf8)!)
        exit(1)
    }

    for scalar in text.unicodeScalars {
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            continue
        }
        var utf16Char = [UniChar(scalar.value)]
        keyDown.keyboardSetUnicodeString(stringLength: 1, unicodeString: &utf16Char)
        keyUp.keyboardSetUnicodeString(stringLength: 1, unicodeString: &utf16Char)
        keyDown.post(tap: .cgAnnotatedSessionEventTap)
        keyUp.post(tap: .cgAnnotatedSessionEventTap)
    }
}

// --- entry point ---

let arguments = CommandLine.arguments

guard arguments.count >= 2 else {
    FileHandle.standardError.write("Usage: inject <read-clipboard|write-clipboard|paste|select-all|type-text> [text]\n".data(using: .utf8)!)
    exit(1)
}

let command = arguments[1]

switch command {
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

default:
    FileHandle.standardError.write("Unknown command: \(command)\n".data(using: .utf8)!)
    exit(1)
}
