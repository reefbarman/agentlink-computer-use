import AppKit
import Foundation

@MainActor
private func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    else {
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

@MainActor
private final class KeyboardEventView: NSTextView {
    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        super.keyDown(with: event)
        emit(record(for: event, type: "keyDown", text: string))
    }

    override func keyUp(with event: NSEvent) {
        emit(record(for: event, type: "keyUp"))
        super.keyUp(with: event)
    }

    override func flagsChanged(with event: NSEvent) {
        emit(record(for: event, type: "flagsChanged"))
        super.flagsChanged(with: event)
    }

    private func record(for event: NSEvent, type: String, text: String? = nil) -> [String: Any] {
        var value: [String: Any] = [
            "type": type,
            "key": keyName(for: event),
            "keyCode": Int(event.keyCode),
            "modifierFlags": event.modifierFlags.intersection(.deviceIndependentFlagsMask).rawValue,
            "userData": event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0,
            "isRepeat": event.isARepeat,
            "characters": event.characters ?? "",
            "charactersIgnoringModifiers": event.charactersIgnoringModifiers ?? "",
        ]
        if let text {
            value["text"] = text
        }
        return value
    }

    private func keyName(for event: NSEvent) -> String {
        if let name = Self.keyNames[event.keyCode] {
            return name
        }
        if let character = event.charactersIgnoringModifiers, !character.isEmpty {
            return character
        }
        return "keyCode\(event.keyCode)"
    }

    private static let keyNames: [UInt16: String] = [
        0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x",
        8: "c", 9: "v", 11: "b", 12: "q", 13: "w", 14: "e", 15: "r", 16: "y",
        17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5",
        24: "equal", 25: "9", 26: "7", 27: "minus", 28: "8", 29: "0",
        30: "rightBracket", 31: "o", 32: "u", 33: "leftBracket", 34: "i", 35: "p",
        36: "return", 37: "l", 38: "j", 39: "quote", 40: "k", 41: "semicolon",
        42: "backslash", 43: "comma", 44: "slash", 45: "n", 46: "m", 47: "period",
        48: "tab", 49: "space", 50: "grave", 51: "delete", 53: "escape",
        54: "rightCommand", 55: "leftCommand", 56: "leftShift", 57: "capsLock",
        58: "leftOption", 59: "leftControl", 60: "rightShift", 61: "rightOption",
        62: "rightControl", 63: "function", 64: "f17", 65: "keypadDecimal",
        67: "keypadMultiply", 69: "keypadPlus", 71: "keypadClear", 72: "volumeUp",
        73: "volumeDown", 74: "mute", 75: "keypadDivide", 76: "keypadEnter",
        78: "keypadMinus", 79: "f18", 80: "f19", 81: "keypadEqual", 82: "keypad0",
        83: "keypad1", 84: "keypad2", 85: "keypad3", 86: "keypad4", 87: "keypad5",
        88: "keypad6", 89: "keypad7", 90: "f20", 91: "keypad8", 92: "keypad9",
        96: "f5", 97: "f6", 98: "f7", 99: "f3", 100: "f8", 101: "f9",
        103: "f11", 105: "f13", 106: "f16", 107: "f14", 109: "f10",
        111: "f12", 113: "f15", 114: "help", 115: "home", 116: "pageUp",
        117: "forwardDelete", 118: "f4", 119: "end", 120: "f2", 121: "pageDown",
        122: "f1", 123: "leftArrow", 124: "rightArrow", 125: "downArrow", 126: "upArrow",
    ]
}

@MainActor
private final class ApplicationDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var eventView: KeyboardEventView?
    private var didEmitReady = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let width: CGFloat = 480
        let height: CGFloat = 240
        let window = NSWindow(
            contentRect: NSRect(x: 160, y: 160, width: width, height: height),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false)
        window.title = "Computer Use Keyboard Test Target"
        window.delegate = self

        let eventView = KeyboardEventView(
            frame: NSRect(x: 16, y: 16, width: width - 32, height: height - 32))
        eventView.isEditable = true
        eventView.isSelectable = true
        eventView.isRichText = false
        eventView.font = .monospacedSystemFont(ofSize: 16, weight: .regular)
        eventView.autoresizingMask = [.width, .height]

        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        container.addSubview(eventView)
        window.contentView = container

        self.window = window
        self.eventView = eventView

        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        installResponderAndEmitReadyIfPossible()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        installResponderAndEmitReadyIfPossible()
    }

    private func installResponderAndEmitReadyIfPossible() {
        guard !didEmitReady, let window, let eventView, window.isKeyWindow else {
            return
        }
        guard window.makeFirstResponder(eventView), window.firstResponder === eventView else {
            return
        }
        didEmitReady = true
        emit([
            "type": "ready",
            "processId": ProcessInfo.processInfo.processIdentifier,
        ])
    }
}

let application = NSApplication.shared
private let delegate = MainActor.assumeIsolated { ApplicationDelegate() }
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
