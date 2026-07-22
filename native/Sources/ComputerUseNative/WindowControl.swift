import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

@MainActor
func activateApplication(processId: pid_t?, bundleIdentifier: String?) async throws
    -> [String: Any]
{
    let candidates = NSWorkspace.shared.runningApplications.filter { application in
        guard !application.isTerminated else {
            return false
        }
        if let processId {
            return application.processIdentifier == processId
        }
        return application.bundleIdentifier == bundleIdentifier
    }
    guard candidates.count == 1, let application = candidates.first else {
        throw SpikeError.targetNotFound(
            "Expected one running application match, found \(candidates.count)")
    }

    try requireActiveControl()
    guard application.activate(options: [.activateAllWindows]) else {
        throw SpikeError.actionFailed(
            "macOS rejected activation for process \(application.processIdentifier)")
    }

    for _ in 0..<10 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier
            == application.processIdentifier
        {
            return ["application": applicationJSON(application), "verified": true]
        }
        try await Task.sleep(for: .milliseconds(50))
        try await controlCheckpoint()
    }

    throw SpikeError.actionFailed(
        "Application process \(application.processIdentifier) did not become frontmost")
}

private func axValue<T>(_ element: AXUIElement, attribute: String, as type: T.Type = T.self) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? T
}

private func axPoint(_ element: AXUIElement, attribute: String) -> CGPoint? {
    guard let value: AXValue = axValue(element, attribute: attribute),
        AXValueGetType(value) == .cgPoint
    else {
        return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, attribute: String) -> CGSize? {
    guard let value: AXValue = axValue(element, attribute: attribute),
        AXValueGetType(value) == .cgSize
    else {
        return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

private func normalizedTitle(_ title: String) -> String {
    title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

@MainActor
func focusWindow(windowId: CGWindowID) async throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        throw SpikeError.permissionDenied(
            "Accessibility permission is required for specific-window focus")
    }

    let content = try await shareableContent()
    guard let scWindow = content.windows.first(where: { $0.windowID == windowId }),
        let application = scWindow.owningApplication
    else {
        throw SpikeError.targetNotFound("Window \(windowId) was not found")
    }

    guard let runningApplication = NSRunningApplication(processIdentifier: application.processID)
    else {
        throw SpikeError.targetNotFound(
            "Owning application process \(application.processID) is no longer running")
    }

    let appElement = AXUIElementCreateApplication(application.processID)
    let axWindows: [AXUIElement] = axValue(appElement, attribute: kAXWindowsAttribute) ?? []
    let targetTitle = normalizedTitle(scWindow.title ?? "")

    let candidates: [(element: AXUIElement, score: CGFloat)] = axWindows.compactMap { element in
        let title: String = axValue(element, attribute: kAXTitleAttribute) ?? ""
        guard targetTitle.isEmpty || normalizedTitle(title) == targetTitle,
            let position = axPoint(element, attribute: kAXPositionAttribute),
            let size = axSize(element, attribute: kAXSizeAttribute)
        else {
            return nil
        }

        let frame = CGRect(origin: position, size: size)
        let score =
            abs(frame.minX - scWindow.frame.minX)
            + abs(frame.minY - scWindow.frame.minY)
            + abs(frame.width - scWindow.frame.width)
            + abs(frame.height - scWindow.frame.height)
        return (element, score)
    }.sorted { $0.score < $1.score }

    guard let bestMatch = candidates.first, bestMatch.score <= 8 else {
        throw SpikeError.actionFailed("No close AX geometry match for window \(windowId)")
    }
    if candidates.count > 1, abs(candidates[1].score - bestMatch.score) < 0.5 {
        throw SpikeError.actionFailed("Ambiguous AX geometry match for window \(windowId)")
    }
    let targetWindow = bestMatch.element

    try requireActiveControl()
    _ = runningApplication.activate(options: [.activateAllWindows])
    try requireActiveControl()
    _ = AXUIElementSetAttributeValue(
        targetWindow, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    try requireActiveControl()
    _ = AXUIElementSetAttributeValue(targetWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
    try requireActiveControl()
    let raiseResult = AXUIElementPerformAction(targetWindow, kAXRaiseAction as CFString)
    try await Task.sleep(for: .milliseconds(150))
    try await controlCheckpoint()

    guard let focusedWindow: AXUIElement = axValue(appElement, attribute: kAXFocusedWindowAttribute)
    else {
        throw SpikeError.actionFailed("Application did not expose a focused AX window after raise")
    }

    guard CFEqual(focusedWindow, targetWindow) else {
        throw SpikeError.actionFailed("The raised AX window did not become focused")
    }

    return [
        "windowId": String(windowId),
        "title": scWindow.title ?? "",
        "application": [
            "bundleIdentifier": application.bundleIdentifier,
            "name": application.applicationName,
            "processId": application.processID,
        ],
        "raiseResult": raiseResult.rawValue,
        "verified": true,
    ]
}
