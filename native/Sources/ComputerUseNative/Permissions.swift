import ApplicationServices
import CoreGraphics
import Foundation

private enum Permission: String, CaseIterable {
    case screenCapture = "screen-capture"
    case accessibility
    case postEvent = "post-event"

    var granted: Bool {
        switch self {
        case .screenCapture:
            CGPreflightScreenCaptureAccess()
        case .accessibility:
            AXIsProcessTrusted()
        case .postEvent:
            CGPreflightPostEventAccess()
        }
    }
}

@MainActor
func permissionStatus() -> [String: Any] {
    var status: [String: Any] = [
        "permissions": Dictionary(
            uniqueKeysWithValues: Permission.allCases.map { ($0.rawValue, $0.granted) }),
        "process": [
            "pid": ProcessInfo.processInfo.processIdentifier
        ],
        "system": [
            "operatingSystemVersion": ProcessInfo.processInfo.operatingSystemVersionString,
            "architecture": architectureName(),
        ],
        "control": controlSafetyController?.statusJSON() ?? [
            "inputEnabled": false,
            "indicatorAvailable": false,
            "state": ComputerUseActivity.paused.rawValue,
        ],
    ]
    if let artifactStore {
        status["artifactRoot"] = artifactStore.rootURL.path
    }
    return status
}
