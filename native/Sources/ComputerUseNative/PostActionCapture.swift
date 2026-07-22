import CoreFoundation
import CoreGraphics
import Foundation

func validateCaptureParameters(_ parameters: [String: Any]) throws {
    guard let target = parameters["target"] as? [String: Any],
        let kind = target["kind"] as? String
    else {
        throw SpikeError.invalidArguments("Parameter 'target' must be a capture target object")
    }

    _ = try optionalString(parameters, key: "format")
    if let format = try optionalString(parameters, key: "format"), format != "png", format != "jpeg"
    {
        throw SpikeError.invalidArguments("Parameter 'format' must be 'png' or 'jpeg'")
    }

    if let scale = parameters["scale"] {
        if let name = scale as? String {
            guard name == "logical" || name == "native" else {
                throw SpikeError.invalidArguments(
                    "Parameter 'scale' must be 'logical', 'native', or a positive number")
            }
        } else {
            guard CFGetTypeID(scale as CFTypeRef) != CFBooleanGetTypeID(),
                let number = scale as? NSNumber, number.doubleValue.isFinite,
                number.doubleValue > 0, number.doubleValue <= 4
            else {
                throw SpikeError.invalidArguments(
                    "Numeric parameter 'scale' must be greater than 0 and no greater than 4")
            }
        }
    }

    _ = try optionalPositiveInt(parameters, key: "maxWidth")
    _ = try optionalPositiveInt(parameters, key: "maxHeight")
    _ = try optionalBool(parameters, key: "includeCursor", default: false)
    _ = try optionalBoundedInt(
        parameters, key: "settleMs", default: 100, minimum: 0, maximum: 2_000)

    switch kind {
    case "display":
        guard let value = try optionalString(target, key: "displayId"),
            CGDirectDisplayID(value) != nil
        else {
            throw SpikeError.invalidArguments("Display target requires a numeric 'displayId'")
        }
    case "window":
        _ = try requiredWindowId(target)
    case "region":
        let bounds = try requiredRect(target, key: "bounds")
        guard bounds.width > 0, bounds.height > 0 else {
            throw SpikeError.invalidArguments("Region bounds must be positive and finite")
        }
    default:
        throw SpikeError.invalidArguments("Unknown capture target kind '\(kind)'")
    }
}

@MainActor
func withPostActionCapture(
    parameters: [String: Any],
    interaction: () async throws -> [String: Any]
) async throws -> [String: Any] {
    guard let value = parameters["captureAfter"] else {
        return try await interaction()
    }
    guard let captureParameters = value as? [String: Any] else {
        throw SpikeError.invalidArguments(
            "Parameter 'captureAfter' must be a capture request object")
    }

    try validateCaptureParameters(captureParameters)
    try await prepareCaptureContent()
    let settleMs = try optionalBoundedInt(
        captureParameters, key: "settleMs", default: 100, minimum: 0, maximum: 2_000)
    let interactionResult = try await interaction()

    do {
        let capture = try await requireControlSafetyController().withCaptureActivity {
            if settleMs > 0 {
                try await Task.sleep(for: .milliseconds(settleMs))
            }
            return try await captureArtifact(captureParameters)
        }
        return [
            "interaction": interactionResult,
            "capture": capture,
        ]
    } catch {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return [
            "interaction": interactionResult,
            "captureError": [
                "code": nativeErrorCode(error),
                "message": message,
            ],
        ]
    }
}
