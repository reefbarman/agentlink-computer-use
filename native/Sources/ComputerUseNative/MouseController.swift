import ApplicationServices
import CoreGraphics
import Foundation

enum MouseButton: String, CaseIterable, Comparable {
    case left
    case right
    case middle

    static func < (lhs: MouseButton, rhs: MouseButton) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    fileprivate var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    fileprivate var downEventType: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    fileprivate var upEventType: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }

    fileprivate var draggedEventType: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }
}

@MainActor
final class MouseController {
    private(set) var heldButtons: Set<MouseButton> = []

    func position() throws -> CGPoint {
        guard let event = CGEvent(source: nil) else {
            throw SpikeError.actionFailed("Could not read the current cursor position")
        }
        return event.location
    }

    func move(to target: CGPoint, durationMs: Int) async throws -> CGPoint {
        try ensurePostEventAccess()
        try validatePoint(target)
        guard heldButtons.count <= 1 else {
            throw SpikeError.actionFailed(
                "Cannot move while multiple mouse buttons are held; call input_release_all first")
        }

        let start = try position()
        let steps = max(1, Int(ceil(Double(durationMs) / (1_000.0 / 60.0))))
        let eventType = heldButtons.first?.draggedEventType ?? .mouseMoved
        let eventButton = heldButtons.first?.cgButton ?? .left

        for step in 1...steps {
            try requireActiveControl()
            let progress = CGFloat(step) / CGFloat(steps)
            let point = CGPoint(
                x: start.x + (target.x - start.x) * progress,
                y: start.y + (target.y - start.y) * progress)
            guard CGWarpMouseCursorPosition(point) == .success else {
                throw SpikeError.actionFailed("Could not commit mouse cursor position")
            }
            try postMouseEvent(type: eventType, button: eventButton, point: point)
            if step < steps, durationMs > 0 {
                try await Task.sleep(for: .milliseconds(durationMs / steps))
            }
            if step < steps {
                try await controlCheckpoint()
            }
        }

        for _ in 0..<10 {
            try requireActiveControl()
            guard CGWarpMouseCursorPosition(target) == .success else {
                throw SpikeError.actionFailed("Could not commit final mouse cursor position")
            }
            try postMouseEvent(type: eventType, button: eventButton, point: target)
            try await Task.sleep(for: .milliseconds(10))
            try await controlCheckpoint()
            let observed = try position()
            if hypot(observed.x - target.x, observed.y - target.y) <= 1 {
                return observed
            }
        }
        throw SpikeError.actionFailed("Mouse cursor did not reach the requested point")
    }

    func setButton(_ button: MouseButton, down: Bool, point: CGPoint?) async throws -> CGPoint {
        try ensurePostEventAccess()
        if let point {
            _ = try await move(to: point, durationMs: 0)
        }
        let current = try position()

        if down {
            guard !heldButtons.contains(button) else {
                throw SpikeError.actionFailed("Mouse button '\(button.rawValue)' is already held")
            }
            try postMouseEvent(type: button.downEventType, button: button.cgButton, point: current)
            heldButtons.insert(button)
        } else {
            guard heldButtons.contains(button) else {
                throw SpikeError.actionFailed("Mouse button '\(button.rawValue)' is not held")
            }
            try postMouseEvent(type: button.upEventType, button: button.cgButton, point: current)
            heldButtons.remove(button)
        }
        return current
    }

    func click(
        button: MouseButton, count: Int, intervalMs: Int, point: CGPoint?
    ) async throws -> CGPoint {
        try ensurePostEventAccess()
        guard !heldButtons.contains(button) else {
            throw SpikeError.actionFailed(
                "Mouse button '\(button.rawValue)' is held; call input_release_all first")
        }
        if let point {
            _ = try await move(to: point, durationMs: 0)
        }

        do {
            for clickNumber in 1...count {
                let current = try position()
                try postMouseEvent(
                    type: button.downEventType, button: button.cgButton, point: current,
                    clickState: clickNumber)
                heldButtons.insert(button)
                try postMouseEvent(
                    type: button.upEventType, button: button.cgButton, point: current,
                    clickState: clickNumber)
                heldButtons.remove(button)
                if clickNumber < count, intervalMs > 0 {
                    try await Task.sleep(for: .milliseconds(intervalMs))
                }
                if clickNumber < count {
                    try await controlCheckpoint()
                }
            }
        } catch {
            _ = releaseAll()
            throw error
        }
        return try position()
    }

    func drag(
        button: MouseButton, from: CGPoint?, to: CGPoint, durationMs: Int
    ) async throws -> CGPoint {
        guard heldButtons.isEmpty else {
            throw SpikeError.actionFailed(
                "Cannot start a drag while a mouse button is held; call input_release_all first")
        }
        if let from {
            _ = try await move(to: from, durationMs: 0)
        }

        do {
            _ = try await setButton(button, down: true, point: nil)
            let final = try await move(to: to, durationMs: durationMs)
            _ = try await setButton(button, down: false, point: nil)
            return final
        } catch {
            _ = releaseAll()
            throw error
        }
    }

    func scroll(
        deltaX: Int32, deltaY: Int32, unit: CGScrollEventUnit, point: CGPoint?
    ) async throws -> CGPoint {
        try ensurePostEventAccess()
        if let point {
            _ = try await move(to: point, durationMs: 0)
        }
        guard
            let event = CGEvent(
                scrollWheelEvent2Source: nil,
                units: unit,
                wheelCount: 2,
                wheel1: deltaY,
                wheel2: deltaX,
                wheel3: 0)
        else {
            throw SpikeError.actionFailed("Could not construct mouse scroll event")
        }
        try requireActiveControl()
        tagNativeInputEvent(event)
        event.post(tap: .cghidEventTap)
        return try position()
    }

    @discardableResult
    func releaseAll() -> [MouseButton] {
        let buttons = heldButtons.sorted()
        guard !buttons.isEmpty else {
            return []
        }

        let current = (try? position()) ?? .zero
        for button in buttons {
            if let event = CGEvent(
                mouseEventSource: nil,
                mouseType: button.upEventType,
                mouseCursorPosition: current,
                mouseButton: button.cgButton)
            {
                tagNativeInputEvent(event)
                event.post(tap: .cghidEventTap)
            }
            heldButtons.remove(button)
        }
        return buttons
    }

    private func ensurePostEventAccess() throws {
        try requireActiveControl()
        guard CGPreflightPostEventAccess() else {
            throw SpikeError.permissionDenied(
                "Post Event access is required for CGEvent input injection")
        }
    }

    func validatePoint(_ point: CGPoint) throws {
        guard point.x.isFinite, point.y.isFinite else {
            throw SpikeError.invalidArguments("Mouse point must be finite")
        }

        var displayCount: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &displayCount) == .success else {
            throw SpikeError.actionFailed("Could not enumerate active displays")
        }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        guard CGGetActiveDisplayList(displayCount, &displays, &displayCount) == .success,
            displays.prefix(Int(displayCount)).contains(where: {
                CGDisplayBounds($0).contains(point)
            })
        else {
            throw SpikeError.invalidArguments("Mouse point is outside all active displays")
        }
    }

    private func postMouseEvent(
        type: CGEventType,
        button: CGMouseButton,
        point: CGPoint,
        clickState: Int? = nil
    ) throws {
        try requireActiveControl()
        guard
            let event = CGEvent(
                mouseEventSource: nil,
                mouseType: type,
                mouseCursorPosition: point,
                mouseButton: button)
        else {
            throw SpikeError.actionFailed("Could not construct mouse event")
        }
        if let clickState {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        }
        tagNativeInputEvent(event)
        event.post(tap: .cghidEventTap)
    }
}
