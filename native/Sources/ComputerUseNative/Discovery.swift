import AppKit
import CoreGraphics
import Darwin
import Foundation
@preconcurrency import ScreenCaptureKit

@MainActor
func listDisplays() async throws -> [String: Any] {
    let content = try await shareableContent()
    let screensById = Dictionary(
        uniqueKeysWithValues: NSScreen.screens.compactMap {
            screen -> (CGDirectDisplayID, NSScreen)? in
            guard
                let displayId = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]
                    as? CGDirectDisplayID
            else {
                return nil
            }
            return (displayId, screen)
        })

    let displays: [[String: Any]] = content.displays
        .filter { $0.frame.width > 0 && $0.frame.height > 0 && $0.width > 0 && $0.height > 0 }
        .sorted { $0.displayID < $1.displayID }
        .map { display in
            let bounds = CGDisplayBounds(display.displayID)
            return [
                "displayId": String(display.displayID),
                "name": screensById[display.displayID]?.localizedName
                    ?? "Display \(display.displayID)",
                "bounds": rectJSON(display.frame),
                "pixelSize": ["width": display.width, "height": display.height],
                "pixelsPerPoint": [
                    "x": Double(display.width) / display.frame.width,
                    "y": Double(display.height) / display.frame.height,
                ],
                "isMain": CGDisplayIsMain(display.displayID) != 0,
                "coreGraphicsBoundsMatch": bounds.equalTo(display.frame),
            ]
        }

    return ["displays": displays]
}

@MainActor
func listApplications(includeBackground: Bool) -> [String: Any] {
    let applications = NSWorkspace.shared.runningApplications
        .filter {
            !$0.isTerminated && !isCurrentHelperProcess($0.processIdentifier)
                && (includeBackground || $0.activationPolicy == .regular)
        }
        .sorted {
            let left = $0.localizedName ?? $0.bundleIdentifier ?? ""
            let right = $1.localizedName ?? $1.bundleIdentifier ?? ""
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
        .map(applicationJSON)

    return ["applications": applications]
}

@MainActor
func listWindows(
    bundleIdentifier: String?, processId: pid_t?, onScreenOnly: Bool, includeUntitled: Bool
) async throws -> [String: Any] {
    let content = try await shareableContent()
    let windows: [[String: Any]] = content.windows
        .filter { window in
            guard let app = window.owningApplication, !isCurrentHelperProcess(app.processID) else {
                return false
            }
            if let bundleIdentifier, app.bundleIdentifier != bundleIdentifier {
                return false
            }
            if let processId, app.processID != processId {
                return false
            }
            if onScreenOnly, !window.isOnScreen {
                return false
            }
            if !includeUntitled, (window.title ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
                return false
            }
            return true
        }
        .sorted {
            if $0.owningApplication?.applicationName != $1.owningApplication?.applicationName {
                return ($0.owningApplication?.applicationName ?? "")
                    < ($1.owningApplication?.applicationName ?? "")
            }
            return ($0.title ?? "") < ($1.title ?? "")
        }
        .compactMap { window in
            guard let app = window.owningApplication else {
                return nil
            }
            return [
                "windowId": String(window.windowID),
                "title": window.title ?? "",
                "bounds": rectJSON(window.frame),
                "isOnScreen": window.isOnScreen,
                "isActive": window.isActive,
                "owningApplication": [
                    "bundleIdentifier": app.bundleIdentifier,
                    "name": app.applicationName,
                    "processId": app.processID,
                ],
            ]
        }

    return ["windows": windows]
}
