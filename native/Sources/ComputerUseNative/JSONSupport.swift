import AppKit
import CoreGraphics
import Foundation

struct JSONOutput {
    static func write(_ value: Any, prettyPrinted: Bool = true) throws {
        let options: JSONSerialization.WritingOptions =
            prettyPrinted
            ? [.prettyPrinted, .sortedKeys]
            : [.sortedKeys]
        let data = try JSONSerialization.data(withJSONObject: value, options: options)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    static func writeError(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        try? write(["ok": false, "error": message])
    }
}

func rectJSON(_ rect: CGRect) -> [String: Double] {
    [
        "x": rect.origin.x,
        "y": rect.origin.y,
        "width": rect.size.width,
        "height": rect.size.height,
    ]
}

func pointJSON(_ point: CGPoint) -> [String: Double] {
    ["x": point.x, "y": point.y]
}

func applicationJSON(_ application: NSRunningApplication) -> [String: Any] {
    [
        "processId": application.processIdentifier,
        "bundleIdentifier": application.bundleIdentifier ?? NSNull(),
        "name": application.localizedName ?? application.bundleIdentifier ?? "Unknown",
        "bundlePath": application.bundleURL?.path ?? NSNull(),
        "isActive": application.isActive,
        "isHidden": application.isHidden,
        "activationPolicy": application.activationPolicy.rawValue,
    ]
}

func architectureName() -> String {
    #if arch(arm64)
        "arm64"
    #elseif arch(x86_64)
        "x86_64"
    #else
        "unknown"
    #endif
}
