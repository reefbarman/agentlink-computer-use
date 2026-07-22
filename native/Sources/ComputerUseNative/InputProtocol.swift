import CoreGraphics
import Foundation

@MainActor let mouseController = MouseController()
@MainActor let keyboardController = KeyboardController()

private func mouseButton(
    _ parameters: [String: Any], default defaultButton: MouseButton = .left
) throws -> MouseButton {
    guard let value = parameters["button"] else {
        return defaultButton
    }
    guard let name = value as? String, let button = MouseButton(rawValue: name) else {
        throw SpikeError.invalidArguments("Parameter 'button' must be left, right, or middle")
    }
    return button
}

private func keyboardModifiers(_ parameters: [String: Any]) throws -> [KeyboardKey] {
    guard parameters["modifiers"] != nil else {
        return []
    }
    let modifiers = try requiredStringArray(
        parameters, key: "modifiers", minimumCount: 0, maximumCount: 5
    ).map(keyboardKey)
    guard modifiers.allSatisfy({ $0.modifierFlag != nil }) else {
        throw SpikeError.invalidArguments("Parameter 'modifiers' may contain only modifier keys")
    }
    guard Set(modifiers).count == modifiers.count else {
        throw SpikeError.invalidArguments("Parameter 'modifiers' must not contain duplicates")
    }
    return modifiers
}

@MainActor
private func keyboardStateResult() -> [String: Any] {
    [
        "heldKeys": keyboardController.heldKeys.map(\.name),
        "heldModifiers": keyboardController.heldModifiers.map(\.name),
    ]
}

@MainActor
private func mouseStateResult(position: CGPoint) -> [String: Any] {
    [
        "position": pointJSON(position),
        "heldButtons": mouseController.heldButtons.sorted().map(\.rawValue),
    ]
}

@MainActor
func releaseInputState() -> [String: Any] {
    let releasedKeyboard = keyboardController.releaseAll()
    let releasedButtons = mouseController.releaseAll()
    var result = mouseStateResult(position: (try? mouseController.position()) ?? .zero)
    result.merge(keyboardStateResult()) { _, keyboardValue in keyboardValue }
    result["releasedButtons"] = releasedButtons.map(\.rawValue)
    result["releasedKeys"] = releasedKeyboard.keys.map(\.name)
    result["releasedModifiers"] = releasedKeyboard.modifiers.map(\.name)
    return result
}

@MainActor
func mouseRequest(method: String, parameters: [String: Any]) async throws -> [String: Any] {
    switch method {
    case "mouse.position":
        return mouseStateResult(position: try mouseController.position())
    case "mouse.move":
        let position = try await mouseController.move(
            to: requiredPoint(parameters, key: "to"),
            durationMs: optionalBoundedInt(
                parameters, key: "durationMs", default: 0, minimum: 0, maximum: 10_000))
        return mouseStateResult(position: position)
    case "mouse.button":
        guard let action = try optionalString(parameters, key: "action"),
            action == "down" || action == "up"
        else {
            throw SpikeError.invalidArguments("Parameter 'action' must be down or up")
        }
        let position = try await mouseController.setButton(
            mouseButton(parameters), down: action == "down",
            point: optionalPoint(parameters, key: "point"))
        return mouseStateResult(position: position)
    case "mouse.click":
        let position = try await mouseController.click(
            button: mouseButton(parameters),
            count: optionalBoundedInt(
                parameters, key: "count", default: 1, minimum: 1, maximum: 3),
            intervalMs: optionalBoundedInt(
                parameters, key: "intervalMs", default: 100, minimum: 0, maximum: 1_000),
            point: optionalPoint(parameters, key: "point"))
        return mouseStateResult(position: position)
    case "mouse.drag":
        let position = try await mouseController.drag(
            button: mouseButton(parameters),
            from: optionalPoint(parameters, key: "from"),
            to: requiredPoint(parameters, key: "to"),
            durationMs: optionalBoundedInt(
                parameters, key: "durationMs", default: 500, minimum: 0, maximum: 10_000))
        return mouseStateResult(position: position)
    case "mouse.scroll":
        let deltaX = try requiredSignedInt32(parameters, key: "deltaX")
        let deltaY = try requiredSignedInt32(parameters, key: "deltaY")
        guard deltaX != 0 || deltaY != 0 else {
            throw SpikeError.invalidArguments("At least one scroll delta must be nonzero")
        }
        let unitName = try optionalString(parameters, key: "unit") ?? "line"
        let unit: CGScrollEventUnit
        switch unitName {
        case "line": unit = .line
        case "pixel": unit = .pixel
        default:
            throw SpikeError.invalidArguments("Parameter 'unit' must be line or pixel")
        }
        let position = try await mouseController.scroll(
            deltaX: deltaX, deltaY: deltaY, unit: unit,
            point: optionalPoint(parameters, key: "point"))
        return mouseStateResult(position: position)
    case "input.releaseAll":
        return releaseInputState()
    default:
        throw SpikeError.invalidArguments("Unknown mouse method '\(method)'")
    }
}

@MainActor
func keyboardRequest(method: String, parameters: [String: Any]) async throws -> [String: Any] {
    switch method {
    case "keyboard.type":
        guard let text = parameters["text"] as? String, !text.isEmpty,
            text.utf16.count <= 4_096
        else {
            throw SpikeError.invalidArguments(
                "Parameter 'text' must contain between 1 and 4096 UTF-16 code units")
        }
        let intervalMs = try optionalBoundedInt(
            parameters, key: "intervalMs", default: 0, minimum: 0, maximum: 1_000)
        try await keyboardController.typeText(text, intervalMs: intervalMs)
        return keyboardStateResult()
    case "keyboard.key":
        guard let keyName = try optionalString(parameters, key: "key") else {
            throw SpikeError.invalidArguments("Missing keyboard key")
        }
        guard let action = try optionalString(parameters, key: "action"),
            action == "press" || action == "down" || action == "up"
        else {
            throw SpikeError.invalidArguments("Parameter 'action' must be press, down, or up")
        }
        let key = try keyboardKey(named: keyName)
        let modifiers = try keyboardModifiers(parameters)
        let repeatCount = try optionalBoundedInt(
            parameters, key: "repeat", default: 1, minimum: 1, maximum: 100)
        if action != "press", !modifiers.isEmpty || repeatCount != 1 {
            throw SpikeError.invalidArguments(
                "Modifiers and repeat are supported only when action is press")
        }
        if key.name == "caps-lock" {
            guard action == "press", modifiers.isEmpty, repeatCount == 1 else {
                throw SpikeError.invalidArguments(
                    "Caps Lock supports only a one-shot press without modifiers or repeat")
            }
            try keyboardController.toggleCapsLock()
        } else if action == "press" {
            guard !modifiers.contains(key) else {
                throw SpikeError.invalidArguments("A key cannot also be its own transient modifier")
            }
            try await keyboardController.press(
                key, modifiers: modifiers, repeatCount: repeatCount)
        } else {
            try keyboardController.setKey(key, down: action == "down")
        }
        return keyboardStateResult()
    case "keyboard.shortcut":
        let keys = try requiredStringArray(
            parameters, key: "keys", minimumCount: 2, maximumCount: 8
        ).map(keyboardKey)
        guard Set(keys).count == keys.count else {
            throw SpikeError.invalidArguments("Parameter 'keys' must not contain duplicates")
        }
        let holdMs = try optionalBoundedInt(
            parameters, key: "holdMs", default: 0, minimum: 0, maximum: 10_000)
        try await keyboardController.shortcut(keys: keys, holdMs: holdMs)
        return keyboardStateResult()
    default:
        throw SpikeError.invalidArguments("Unknown keyboard method '\(method)'")
    }
}
