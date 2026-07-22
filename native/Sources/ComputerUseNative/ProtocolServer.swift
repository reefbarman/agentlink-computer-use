import Foundation

@MainActor
func serve() async throws {
    for try await line in FileHandle.standardInput.bytes.lines {
        guard !line.isEmpty else {
            continue
        }

        var requestId: Any = NSNull()
        do {
            guard let data = line.data(using: .utf8),
                let request = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                throw SpikeError.invalidArguments("Request must be a JSON object")
            }

            requestId = request["id"] ?? NSNull()
            guard let version = request["version"] as? Int, version == 1 else {
                throw SpikeError.invalidArguments("Unsupported or missing protocol version")
            }
            guard let method = request["method"] as? String else {
                throw SpikeError.invalidArguments("Missing method")
            }

            let parameters = try requestParameters(request)
            let result: [String: Any]
            switch method {
            case "health":
                result = permissionStatus()
            case "display.list":
                result = try await listDisplays()
            case "application.list":
                result = listApplications(
                    includeBackground: try optionalBool(
                        parameters, key: "includeBackground", default: false))
            case "application.activate":
                let processId = try optionalProcessId(parameters, key: "processId")
                let bundleIdentifier = try optionalString(parameters, key: "bundleIdentifier")
                guard (processId == nil) != (bundleIdentifier == nil) else {
                    throw SpikeError.invalidArguments(
                        "Provide exactly one of 'processId' or 'bundleIdentifier'")
                }
                result = try await withPostActionCapture(parameters: parameters) {
                    try await requireControlSafetyController().withControlActivity {
                        try await activateApplication(
                            processId: processId, bundleIdentifier: bundleIdentifier)
                    }
                }
            case "window.list":
                result = try await listWindows(
                    bundleIdentifier: optionalString(parameters, key: "bundleIdentifier"),
                    processId: optionalProcessId(parameters, key: "processId"),
                    onScreenOnly: optionalBool(
                        parameters, key: "onScreenOnly", default: true),
                    includeUntitled: optionalBool(
                        parameters, key: "includeUntitled", default: false))
            case "window.focus":
                let windowId = try requiredWindowId(parameters)
                result = try await withPostActionCapture(parameters: parameters) {
                    try await requireControlSafetyController().withControlActivity {
                        try await focusWindow(windowId: windowId)
                    }
                }
            case "screen.capture":
                try await prepareCaptureContent()
                result = try await requireControlSafetyController().withCaptureActivity {
                    try await captureArtifact(parameters)
                }
            case "keyboard.type", "keyboard.key", "keyboard.shortcut":
                result = try await withPostActionCapture(parameters: parameters) {
                    try await requireControlSafetyController().withControlActivity {
                        try await keyboardRequest(method: method, parameters: parameters)
                    }
                }
            case "mouse.position", "input.releaseAll":
                result = try await mouseRequest(method: method, parameters: parameters)
            case "input.batch":
                result = try await withPostActionCapture(parameters: parameters) {
                    if inputBatchPostsInput(parameters) {
                        return try await requireControlSafetyController().withControlActivity {
                            try await inputBatchRequest(parameters: parameters)
                        }
                    }
                    return try await inputBatchRequest(parameters: parameters)
                }
            case "mouse.move", "mouse.button", "mouse.click", "mouse.drag", "mouse.scroll":
                result = try await withPostActionCapture(parameters: parameters) {
                    try await requireControlSafetyController().withControlActivity {
                        try await mouseRequest(method: method, parameters: parameters)
                    }
                }
            default:
                throw SpikeError.invalidArguments("Unknown native method '\(method)'")
            }

            try JSONOutput.write(
                ["id": requestId, "ok": true, "result": result], prettyPrinted: false)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            try? JSONOutput.write(
                [
                    "id": requestId,
                    "ok": false,
                    "error": ["code": nativeErrorCode(error), "message": message],
                ],
                prettyPrinted: false)
        }
    }
}
