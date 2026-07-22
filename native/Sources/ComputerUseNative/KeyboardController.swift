import ApplicationServices
import CoreGraphics
import Foundation

struct KeyboardKey: Hashable, Comparable {
    let name: String
    fileprivate let keyCode: CGKeyCode
    fileprivate let modifierFlagRawValue: UInt64?

    static func < (lhs: KeyboardKey, rhs: KeyboardKey) -> Bool {
        lhs.name < rhs.name
    }

    var modifierFlag: CGEventFlags? {
        modifierFlagRawValue.map(CGEventFlags.init(rawValue:))
    }
}

private let namedKeyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "equal": 24, "9": 25, "7": 26, "minus": 27, "8": 28,
    "0": 29, "right-bracket": 30, "o": 31, "u": 32, "left-bracket": 33,
    "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "quote": 39,
    "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44,
    "n": 45, "m": 46, "period": 47, "tab": 48, "space": 49, "grave": 50,
    "backspace": 51, "escape": 53, "caps-lock": 57, "f17": 64, "f18": 79, "f19": 80,
    "f20": 90, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100,
    "f9": 101, "f11": 103, "f13": 105, "f16": 106, "f14": 107,
    "f10": 109, "f12": 111, "f15": 113, "home": 115, "page-up": 116,
    "forward-delete": 117, "f4": 118, "end": 119, "f2": 120, "page-down": 121,
    "f1": 122, "left-arrow": 123, "right-arrow": 124, "down-arrow": 125,
    "up-arrow": 126,
]

private let modifierKeyDefinitions: [String: (keyCode: CGKeyCode, flag: CGEventFlags)] = [
    "command": (55, .maskCommand),
    "shift": (56, .maskShift),
    "option": (58, .maskAlternate),
    "control": (59, .maskControl),
]

func keyboardKey(named requestedName: String) throws -> KeyboardKey {
    let name = requestedName == "delete" ? "backspace" : requestedName
    if let definition = modifierKeyDefinitions[name] {
        return KeyboardKey(
            name: name, keyCode: definition.keyCode,
            modifierFlagRawValue: definition.flag.rawValue)
    }
    guard let keyCode = namedKeyCodes[name] else {
        throw SpikeError.invalidArguments("Unknown keyboard key '\(requestedName)'")
    }
    return KeyboardKey(name: name, keyCode: keyCode, modifierFlagRawValue: nil)
}

@MainActor
final class KeyboardController {
    private(set) var heldKeys: [KeyboardKey] = []
    private(set) var heldModifiers: [KeyboardKey] = []
    private var pressOrder: [KeyboardKey] = []
    private var isReleasingAll = false

    func setKey(_ key: KeyboardKey, down: Bool) throws {
        try ensurePostEventAccess()
        guard key.name != "caps-lock" else {
            throw SpikeError.invalidArguments("Caps Lock supports only a one-shot press action")
        }
        if let modifierFlag = key.modifierFlag {
            try setModifier(key, flag: modifierFlag, down: down)
        } else {
            try setRegularKey(key, down: down)
        }
    }

    func press(
        _ key: KeyboardKey, modifiers: [KeyboardKey], repeatCount: Int
    ) async throws {
        let transientModifiers = modifiers.filter { !heldModifiers.contains($0) }
        do {
            for modifier in transientModifiers {
                try setKey(modifier, down: true)
                try await controlCheckpoint()
            }
            for index in 0..<repeatCount {
                try setKey(key, down: true)
                try await controlCheckpoint()
                try setKey(key, down: false)
                if index + 1 < repeatCount {
                    try await controlCheckpoint()
                }
            }
            for modifier in transientModifiers.reversed() {
                try setKey(modifier, down: false)
                try await controlCheckpoint()
            }
        } catch {
            _ = releaseAll()
            throw error
        }
    }

    func typeText(_ text: String, intervalMs: Int) async throws {
        try ensurePostEventAccess()
        guard heldKeys.isEmpty, heldModifiers.isEmpty else {
            throw SpikeError.actionFailed(
                "Cannot type text while keyboard state is held; call input_release_all first")
        }
        let scalars = Array(text.unicodeScalars)
        guard !scalars.isEmpty else {
            throw SpikeError.invalidArguments("Parameter 'text' must be non-empty")
        }
        guard (scalars.count - 1) * intervalMs <= 10_000 else {
            throw SpikeError.invalidArguments("Keyboard typing delay may not exceed 10000 ms")
        }

        for (index, scalar) in scalars.enumerated() {
            let units: [UniChar] = Array(String(scalar).utf16)
            try postUnicodeEvent(units: units, keyDown: true)
            try postUnicodeEvent(units: units, keyDown: false)
            if index + 1 < scalars.count, intervalMs > 0 {
                try await Task.sleep(for: .milliseconds(intervalMs))
            }
            if index + 1 < scalars.count {
                try await controlCheckpoint()
            }
        }
    }

    func shortcut(keys: [KeyboardKey], holdMs: Int) async throws {
        guard !keys.contains(where: { $0.name == "caps-lock" }) else {
            throw SpikeError.invalidArguments("Caps Lock cannot be part of a shortcut")
        }
        guard heldKeys.isEmpty, heldModifiers.isEmpty else {
            throw SpikeError.actionFailed(
                "Cannot start a shortcut while keyboard state is held; call input_release_all first"
            )
        }
        do {
            for key in keys {
                try setKey(key, down: true)
                try await controlCheckpoint()
            }
            if holdMs > 0 {
                try await Task.sleep(for: .milliseconds(holdMs))
            }
            for key in keys.reversed() {
                try setKey(key, down: false)
                try await controlCheckpoint()
            }
        } catch {
            _ = releaseAll()
            throw error
        }
    }

    func toggleCapsLock() throws {
        try ensurePostEventAccess()
        let activeFlags = CGEventSource.flagsState(.combinedSessionState)
        let enabling = !activeFlags.contains(.maskAlphaShift)
        guard
            let keyCode = namedKeyCodes["caps-lock"],
            let event = CGEvent(
                keyboardEventSource: nil, virtualKey: keyCode, keyDown: enabling)
        else {
            throw SpikeError.actionFailed("Could not construct Caps Lock event")
        }
        event.type = .flagsChanged
        event.flags = flagsPreservingUnmanaged([], alphaShift: enabling)
        tagNativeInputEvent(event)
        event.post(tap: .cghidEventTap)
    }

    @discardableResult
    func releaseAll() -> (keys: [KeyboardKey], modifiers: [KeyboardKey]) {
        let releaseOrder = Array(pressOrder.reversed())
        isReleasingAll = true
        defer { isReleasingAll = false }
        var releasedKeys: [KeyboardKey] = []
        var releasedModifiers: [KeyboardKey] = []
        for key in releaseOrder {
            do {
                try setKey(key, down: false)
                if key.modifierFlag == nil {
                    releasedKeys.append(key)
                } else {
                    releasedModifiers.append(key)
                }
            } catch {
                continue
            }
        }
        return (releasedKeys, releasedModifiers)
    }

    private var currentModifierFlags: CGEventFlags {
        heldModifiers.reduce(into: CGEventFlags()) { flags, modifier in
            if let flag = modifier.modifierFlag {
                flags.insert(flag)
            }
        }
    }

    private func flagsPreservingUnmanaged(
        _ managedFlags: CGEventFlags, alphaShift: Bool? = nil
    ) -> CGEventFlags {
        let managedMask: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
        var flags = CGEventSource.flagsState(.combinedSessionState)
        flags.subtract(managedMask)
        flags.formUnion(managedFlags)
        if let alphaShift {
            flags.remove(.maskAlphaShift)
            if alphaShift {
                flags.insert(.maskAlphaShift)
            }
        }
        return flags
    }

    private func setRegularKey(_ key: KeyboardKey, down: Bool) throws {
        if down {
            guard !heldKeys.contains(key) else {
                throw SpikeError.actionFailed("Keyboard key '\(key.name)' is already held")
            }
        } else {
            guard heldKeys.contains(key) else {
                throw SpikeError.actionFailed("Keyboard key '\(key.name)' is not held")
            }
        }
        guard
            let event = CGEvent(
                keyboardEventSource: nil, virtualKey: key.keyCode, keyDown: down)
        else {
            throw SpikeError.actionFailed("Could not construct keyboard event")
        }
        event.flags = flagsPreservingUnmanaged(currentModifierFlags)
        tagNativeInputEvent(event)
        if down {
            heldKeys.append(key)
            pressOrder.append(key)
        }
        event.post(tap: .cghidEventTap)
        if !down {
            heldKeys.removeAll { $0 == key }
            pressOrder.removeAll { $0 == key }
        }
    }

    private func setModifier(_ key: KeyboardKey, flag: CGEventFlags, down: Bool) throws {
        if down {
            guard !heldModifiers.contains(key) else {
                throw SpikeError.actionFailed("Keyboard modifier '\(key.name)' is already held")
            }
        } else {
            guard heldModifiers.contains(key) else {
                throw SpikeError.actionFailed("Keyboard modifier '\(key.name)' is not held")
            }
        }
        guard
            let event = CGEvent(
                keyboardEventSource: nil, virtualKey: key.keyCode, keyDown: down)
        else {
            throw SpikeError.actionFailed("Could not construct keyboard modifier event")
        }
        var flags = currentModifierFlags
        if down {
            flags.insert(flag)
            heldModifiers.append(key)
            pressOrder.append(key)
        } else {
            flags.remove(flag)
        }
        event.type = .flagsChanged
        event.flags = flagsPreservingUnmanaged(flags)
        tagNativeInputEvent(event)
        event.post(tap: .cghidEventTap)
        if !down {
            heldModifiers.removeAll { $0 == key }
            pressOrder.removeAll { $0 == key }
        }
    }

    private func postUnicodeEvent(units: [UniChar], keyDown: Bool) throws {
        try requireActiveControl()
        guard
            let event = CGEvent(
                keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown)
        else {
            throw SpikeError.actionFailed("Could not construct Unicode keyboard event")
        }
        units.withUnsafeBufferPointer { buffer in
            event.keyboardSetUnicodeString(
                stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        tagNativeInputEvent(event)
        event.post(tap: .cghidEventTap)
    }

    private func ensurePostEventAccess() throws {
        if !isReleasingAll {
            try requireActiveControl()
        }
        guard CGPreflightPostEventAccess() else {
            throw SpikeError.permissionDenied(
                "Post Event access is required for CGEvent input injection")
        }
    }
}
