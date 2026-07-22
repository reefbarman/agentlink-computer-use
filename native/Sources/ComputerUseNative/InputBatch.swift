import CoreGraphics
import Foundation

private let maximumInputBatchSteps = 25
private let maximumInputBatchDurationMs = 30_000
private let maximumInputBatchUnits = 4_096

private enum InputBatchStep {
    case mouseMove(to: CGPoint, durationMs: Int)
    case mouseButton(button: MouseButton, down: Bool, point: CGPoint?)
    case mouseClick(button: MouseButton, count: Int, intervalMs: Int, point: CGPoint?)
    case mouseDrag(button: MouseButton, from: CGPoint?, to: CGPoint, durationMs: Int)
    case mouseScroll(deltaX: Int32, deltaY: Int32, unit: CGScrollEventUnit, point: CGPoint?)
    case keyboardType(text: String, intervalMs: Int)
    case keyboardKey(key: KeyboardKey, action: String, modifiers: [KeyboardKey], repeatCount: Int)
    case keyboardShortcut(keys: [KeyboardKey], holdMs: Int)
    case wait(durationMs: Int)

    var type: String {
        switch self {
        case .mouseMove: "mouse_move"
        case .mouseButton: "mouse_button"
        case .mouseClick: "mouse_click"
        case .mouseDrag: "mouse_drag"
        case .mouseScroll: "mouse_scroll"
        case .keyboardType: "keyboard_type"
        case .keyboardKey: "keyboard_key"
        case .keyboardShortcut: "keyboard_shortcut"
        case .wait: "wait"
        }
    }

    var postsInput: Bool {
        if case .wait = self { return false }
        return true
    }

    var inputUnits: Int {
        switch self {
        case .mouseClick(_, let count, _, _):
            count
        case .keyboardType(let text, _):
            text.unicodeScalars.count
        case .keyboardKey(_, _, _, let repeatCount):
            repeatCount
        case .keyboardShortcut(let keys, _):
            keys.count
        default:
            1
        }
    }

    var declaredDurationMs: Int {
        switch self {
        case .mouseMove(_, let durationMs):
            durationMs
        case .mouseDrag(_, _, _, let durationMs):
            durationMs
        case .wait(let durationMs):
            durationMs
        case .mouseClick(_, let count, let intervalMs, _):
            (count - 1) * intervalMs
        case .keyboardType(let text, let intervalMs):
            max(0, text.unicodeScalars.count - 1) * intervalMs
        case .keyboardShortcut(_, let holdMs):
            holdMs
        case .mouseButton, .mouseScroll, .keyboardKey:
            0
        }
    }
}

private func inputBatchMouseButton(
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

private func inputBatchKeyboardModifiers(_ parameters: [String: Any]) throws -> [KeyboardKey] {
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
private func parseInputBatchStep(_ value: Any, index: Int) throws -> InputBatchStep {
    guard let parameters = value as? [String: Any], let type = parameters["type"] as? String else {
        throw SpikeError.invalidArguments("Batch step \(index) must be an object with a type")
    }

    switch type {
    case "mouse_move":
        let point = try requiredPoint(parameters, key: "to")
        try mouseController.validatePoint(point)
        return .mouseMove(
            to: point,
            durationMs: try optionalBoundedInt(
                parameters, key: "durationMs", default: 0, minimum: 0, maximum: 10_000))
    case "mouse_button":
        guard let action = try optionalString(parameters, key: "action"),
            action == "down" || action == "up"
        else {
            throw SpikeError.invalidArguments("Parameter 'action' must be down or up")
        }
        let point = try optionalPoint(parameters, key: "point")
        if let point {
            try mouseController.validatePoint(point)
        }
        return .mouseButton(
            button: try inputBatchMouseButton(parameters), down: action == "down", point: point)
    case "mouse_click":
        let point = try optionalPoint(parameters, key: "point")
        if let point {
            try mouseController.validatePoint(point)
        }
        return .mouseClick(
            button: try inputBatchMouseButton(parameters),
            count: try optionalBoundedInt(
                parameters, key: "count", default: 1, minimum: 1, maximum: 3),
            intervalMs: try optionalBoundedInt(
                parameters, key: "intervalMs", default: 100, minimum: 0, maximum: 1_000),
            point: point)
    case "mouse_drag":
        let from = try optionalPoint(parameters, key: "from")
        let to = try requiredPoint(parameters, key: "to")
        if let from {
            try mouseController.validatePoint(from)
        }
        try mouseController.validatePoint(to)
        return .mouseDrag(
            button: try inputBatchMouseButton(parameters), from: from, to: to,
            durationMs: try optionalBoundedInt(
                parameters, key: "durationMs", default: 500, minimum: 0, maximum: 10_000))
    case "mouse_scroll":
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
        let point = try optionalPoint(parameters, key: "point")
        if let point {
            try mouseController.validatePoint(point)
        }
        return .mouseScroll(deltaX: deltaX, deltaY: deltaY, unit: unit, point: point)
    case "keyboard_type":
        guard let text = parameters["text"] as? String, !text.isEmpty,
            text.utf16.count <= 4_096
        else {
            throw SpikeError.invalidArguments(
                "Parameter 'text' must contain between 1 and 4096 UTF-16 code units")
        }
        let intervalMs = try optionalBoundedInt(
            parameters, key: "intervalMs", default: 0, minimum: 0, maximum: 1_000)
        guard max(0, text.unicodeScalars.count - 1) * intervalMs <= 10_000 else {
            throw SpikeError.invalidArguments("Keyboard typing delay may not exceed 10000 ms")
        }
        return .keyboardType(text: text, intervalMs: intervalMs)
    case "keyboard_key":
        guard let keyName = try optionalString(parameters, key: "key") else {
            throw SpikeError.invalidArguments("Missing keyboard key")
        }
        let action = try optionalString(parameters, key: "action") ?? "press"
        guard action == "press" || action == "down" || action == "up" else {
            throw SpikeError.invalidArguments("Parameter 'action' must be press, down, or up")
        }
        let key = try keyboardKey(named: keyName)
        let modifiers = try inputBatchKeyboardModifiers(parameters)
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
        } else if action == "press", modifiers.contains(key) {
            throw SpikeError.invalidArguments("A key cannot also be its own transient modifier")
        }
        return .keyboardKey(
            key: key, action: action, modifiers: modifiers, repeatCount: repeatCount)
    case "keyboard_shortcut":
        let keys = try requiredStringArray(
            parameters, key: "keys", minimumCount: 2, maximumCount: 8
        ).map(keyboardKey)
        guard Set(keys).count == keys.count else {
            throw SpikeError.invalidArguments("Parameter 'keys' must not contain duplicates")
        }
        guard !keys.contains(where: { $0.name == "caps-lock" }) else {
            throw SpikeError.invalidArguments("Caps Lock cannot be part of a shortcut")
        }
        return .keyboardShortcut(
            keys: keys,
            holdMs: try optionalBoundedInt(
                parameters, key: "holdMs", default: 0, minimum: 0, maximum: 10_000))
    case "wait":
        guard parameters["durationMs"] != nil else {
            throw SpikeError.invalidArguments("Missing wait duration parameter 'durationMs'")
        }
        return .wait(
            durationMs: try optionalBoundedInt(
                parameters, key: "durationMs", default: 0, minimum: 0, maximum: 5_000))
    default:
        throw SpikeError.invalidArguments("Unknown batch step type '\(type)' at index \(index)")
    }
}

@MainActor
private func executeInputBatchStep(_ step: InputBatchStep) async throws -> [String: Any] {
    switch step {
    case .mouseMove(let to, let durationMs):
        return inputBatchMouseState(
            position: try await mouseController.move(to: to, durationMs: durationMs))
    case .mouseButton(let button, let down, let point):
        return inputBatchMouseState(
            position: try await mouseController.setButton(button, down: down, point: point))
    case .mouseClick(let button, let count, let intervalMs, let point):
        return inputBatchMouseState(
            position: try await mouseController.click(
                button: button, count: count, intervalMs: intervalMs, point: point))
    case .mouseDrag(let button, let from, let to, let durationMs):
        return inputBatchMouseState(
            position: try await mouseController.drag(
                button: button, from: from, to: to, durationMs: durationMs))
    case .mouseScroll(let deltaX, let deltaY, let unit, let point):
        return inputBatchMouseState(
            position: try await mouseController.scroll(
                deltaX: deltaX, deltaY: deltaY, unit: unit, point: point))
    case .keyboardType(let text, let intervalMs):
        try await keyboardController.typeText(text, intervalMs: intervalMs)
        return inputBatchKeyboardState()
    case .keyboardKey(let key, let action, let modifiers, let repeatCount):
        if key.name == "caps-lock" {
            try keyboardController.toggleCapsLock()
        } else if action == "press" {
            try await keyboardController.press(
                key, modifiers: modifiers, repeatCount: repeatCount)
        } else {
            try keyboardController.setKey(key, down: action == "down")
        }
        return inputBatchKeyboardState()
    case .keyboardShortcut(let keys, let holdMs):
        try await keyboardController.shortcut(keys: keys, holdMs: holdMs)
        return inputBatchKeyboardState()
    case .wait(let durationMs):
        if durationMs > 0 {
            try await Task.sleep(for: .milliseconds(durationMs))
        }
        return ["waitedMs": durationMs]
    }
}

@MainActor
private func inputBatchKeyboardState() -> [String: Any] {
    [
        "heldKeys": keyboardController.heldKeys.map(\.name),
        "heldModifiers": keyboardController.heldModifiers.map(\.name),
    ]
}

@MainActor
private func inputBatchMouseState(position: CGPoint) -> [String: Any] {
    [
        "position": pointJSON(position),
        "heldButtons": mouseController.heldButtons.sorted().map(\.rawValue),
    ]
}

@MainActor
func inputBatchPostsInput(_ parameters: [String: Any]) -> Bool {
    guard let values = parameters["steps"] as? [[String: Any]] else {
        return true
    }
    return values.contains { $0["type"] as? String != "wait" }
}

@MainActor
func inputBatchRequest(parameters: [String: Any]) async throws -> [String: Any] {
    guard let values = parameters["steps"] as? [Any], !values.isEmpty,
        values.count <= maximumInputBatchSteps
    else {
        throw SpikeError.invalidArguments(
            "Parameter 'steps' must contain between 1 and \(maximumInputBatchSteps) steps")
    }

    let steps = try values.enumerated().map { index, value in
        do {
            return try parseInputBatchStep(value, index: index)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            throw SpikeError.invalidArguments("Invalid batch step \(index): \(message)")
        }
    }
    guard steps.reduce(0, { $0 + $1.declaredDurationMs }) <= maximumInputBatchDurationMs else {
        throw SpikeError.invalidArguments(
            "Declared batch duration may not exceed \(maximumInputBatchDurationMs) ms")
    }
    guard steps.reduce(0, { $0 + $1.inputUnits }) <= maximumInputBatchUnits else {
        throw SpikeError.invalidArguments(
            "Batch input workload may not exceed \(maximumInputBatchUnits) units")
    }

    var results: [[String: Any]] = []
    for (index, step) in steps.enumerated() {
        do {
            if step.postsInput {
                try await controlCheckpoint()
            }
            results.append([
                "index": index,
                "type": step.type,
                "result": try await executeInputBatchStep(step),
            ])
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return [
                "completed": false,
                "completedCount": results.count,
                "results": results,
                "failure": [
                    "index": index,
                    "type": step.type,
                    "error": ["code": nativeErrorCode(error), "message": message],
                    "cleanup": releaseInputState(),
                ],
            ]
        }
    }

    return [
        "completed": true,
        "completedCount": results.count,
        "results": results,
    ]
}
