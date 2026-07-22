import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit

private final class ScreenshotCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CGImage, Error>?

    init(_ continuation: CheckedContinuation<CGImage, Error>) {
        self.continuation = continuation
    }

    func resume(returning image: CGImage) {
        takeContinuation()?.resume(returning: image)
    }

    func resume(throwing error: Error) {
        takeContinuation()?.resume(throwing: error)
    }

    private func takeContinuation() -> CheckedContinuation<CGImage, Error>? {
        lock.lock()
        defer { lock.unlock() }
        let continuation = continuation
        self.continuation = nil
        return continuation
    }
}

@MainActor
private func screenshotImage(
    filter: SCContentFilter, configuration: SCStreamConfiguration
) async throws -> CGImage {
    try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<CGImage, Error>) in
        let completion = ScreenshotCompletion(continuation)
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            completion.resume(
                throwing: SpikeError.actionFailed("ScreenCaptureKit screenshot timed out"))
        }
        SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration,
            completionHandler: { image, error in
                if let image {
                    completion.resume(returning: image)
                } else {
                    completion.resume(
                        throwing: error
                            ?? SpikeError.actionFailed("ScreenCaptureKit returned no image"))
                }
            })
    }
}

private enum CaptureFormat: String {
    case png
    case jpeg

    var fileExtension: String { rawValue == "jpeg" ? "jpg" : "png" }
    var mimeType: String { rawValue == "jpeg" ? "image/jpeg" : "image/png" }
    var typeIdentifier: CFString {
        rawValue == "jpeg" ? "public.jpeg" as CFString : "public.png" as CFString
    }
}

private enum CaptureScale {
    case logical
    case native
    case multiplier(CGFloat)
}

private func encodeImage(_ image: CGImage, format: CaptureFormat, to outputURL: URL) throws {
    guard
        let destination = CGImageDestinationCreateWithURL(
            outputURL as CFURL, format.typeIdentifier, 1, nil)
    else {
        throw SpikeError.actionFailed("Could not create image destination")
    }

    let options: CFDictionary? =
        format == .jpeg
        ? [kCGImageDestinationLossyCompressionQuality as String: 0.9] as CFDictionary
        : nil
    CGImageDestinationAddImage(destination, image, options)
    guard CGImageDestinationFinalize(destination) else {
        throw SpikeError.actionFailed("Could not finalize capture artifact")
    }
}

private func constrainedScale(
    requested: CGFloat, bounds: CGRect, maxWidth: Int?, maxHeight: Int?
) throws -> CGFloat {
    guard requested > 0, requested.isFinite, bounds.width > 0, bounds.height > 0 else {
        throw SpikeError.invalidArguments("Capture scale and bounds must be positive and finite")
    }

    var scale = requested
    if let maxWidth {
        scale = min(scale, CGFloat(maxWidth) / bounds.width)
    }
    if let maxHeight {
        scale = min(scale, CGFloat(maxHeight) / bounds.height)
    }
    guard scale > 0, scale.isFinite else {
        throw SpikeError.invalidArguments("Capture dimensions resolve to an invalid scale")
    }
    return scale
}

private func pixelDimensions(
    bounds: CGRect, scale: CGFloat, maxWidth: Int? = nil, maxHeight: Int? = nil
) -> (width: Int, height: Int) {
    let roundedWidth = max(1, Int((bounds.width * scale).rounded()))
    let roundedHeight = max(1, Int((bounds.height * scale).rounded()))
    return (
        width: min(roundedWidth, maxWidth ?? roundedWidth),
        height: min(roundedHeight, maxHeight ?? roundedHeight)
    )
}

private func displayScale(_ display: SCDisplay) throws -> CGFloat {
    guard display.frame.width > 0, display.frame.height > 0, display.width > 0, display.height > 0
    else {
        throw SpikeError.actionFailed("Display \(display.displayID) has invalid geometry")
    }
    let x = CGFloat(display.width) / display.frame.width
    let y = CGFloat(display.height) / display.frame.height
    guard abs(x - y) < 0.01 else {
        throw SpikeError.unsupported("Display \(display.displayID) has non-uniform pixel scale")
    }
    return x
}

private func requestedScale(
    _ scale: CaptureScale, display: SCDisplay?, bounds: CGRect, maxWidth: Int?, maxHeight: Int?
) throws -> CGFloat {
    let base: CGFloat
    switch scale {
    case .logical:
        base = 1
    case .native:
        guard let display else {
            throw SpikeError.unsupported(
                "Native capture requires the target to fit entirely within one display")
        }
        base = try displayScale(display)
    case .multiplier(let multiplier):
        base = multiplier
    }
    return try constrainedScale(
        requested: base, bounds: bounds, maxWidth: maxWidth, maxHeight: maxHeight)
}

private func containingDisplay(for bounds: CGRect, in displays: [SCDisplay]) -> SCDisplay? {
    displays.first { display in
        display.frame.minX <= bounds.minX && display.frame.minY <= bounds.minY
            && display.frame.maxX >= bounds.maxX && display.frame.maxY >= bounds.maxY
    }
}

@MainActor
private func captureResult(
    image: CGImage,
    target: [String: Any],
    screenBounds: CGRect,
    nativePixelSize: (width: Int, height: Int)?,
    format: CaptureFormat
) throws -> [String: Any] {
    guard let artifactStore else {
        throw SpikeError.actionFailed("Capture artifact store is unavailable")
    }

    let captureId = UUID().uuidString
    let outputURL = artifactStore.newArtifactURL(extension: format.fileExtension)
    do {
        try encodeImage(image, format: format, to: outputURL)
        try artifactStore.secure(outputURL)

        let data = try Data(contentsOf: outputURL, options: [.mappedIfSafe])
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let pixelsPerPointX = CGFloat(image.width) / screenBounds.width
        let pixelsPerPointY = CGFloat(image.height) / screenBounds.height
        guard pixelsPerPointX > 0, pixelsPerPointY > 0,
            pixelsPerPointX.isFinite, pixelsPerPointY.isFinite
        else {
            throw SpikeError.actionFailed("Capture produced an invalid pixel mapping")
        }

        return [
            "captureId": captureId,
            "artifactRoot": artifactStore.rootURL.path,
            "artifactPath": outputURL.path,
            "byteLength": data.count,
            "target": target,
            "mimeType": format.mimeType,
            "nativePixelSize": nativePixelSize.map {
                ["width": $0.width, "height": $0.height]
            } ?? NSNull(),
            "outputPixelSize": ["width": image.width, "height": image.height],
            "mapping": [
                "kind": "linear",
                "imageContentBounds": [
                    "x": 0,
                    "y": 0,
                    "width": image.width,
                    "height": image.height,
                ],
                "screenBounds": rectJSON(screenBounds),
                "pixelsPerPoint": ["x": pixelsPerPointX, "y": pixelsPerPointY],
            ],
            "sha256": digest,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
        ]
    } catch {
        try? FileManager.default.removeItem(at: outputURL)
        throw error
    }
}

@MainActor
private func captureDisplayArtifact(
    displayId: CGDirectDisplayID,
    format: CaptureFormat,
    scale: CaptureScale,
    maxWidth: Int?,
    maxHeight: Int?,
    includeCursor: Bool
) async throws -> [String: Any] {
    let content = try await captureShareableContent()
    let excludedApplications = try helperApplications(in: content)
    guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
        throw SpikeError.targetNotFound("Display \(displayId) was not found")
    }

    let targetScale = try requestedScale(
        scale, display: display, bounds: display.frame, maxWidth: maxWidth, maxHeight: maxHeight)
    let size = pixelDimensions(
        bounds: display.frame, scale: targetScale,
        maxWidth: maxWidth, maxHeight: maxHeight)
    let configuration = SCStreamConfiguration()
    configuration.width = size.width
    configuration.height = size.height
    configuration.showsCursor = includeCursor
    configuration.capturesAudio = false
    let filter = SCContentFilter(
        display: display,
        excludingApplications: excludedApplications,
        exceptingWindows: [])
    let image = try await screenshotImage(filter: filter, configuration: configuration)

    return try captureResult(
        image: image,
        target: ["kind": "display", "displayId": String(display.displayID)],
        screenBounds: display.frame,
        nativePixelSize: (display.width, display.height),
        format: format)
}

@MainActor
private func captureWindowArtifact(
    windowId: CGWindowID,
    format: CaptureFormat,
    scale: CaptureScale,
    maxWidth: Int?,
    maxHeight: Int?,
    includeCursor: Bool
) async throws -> [String: Any] {
    let content = try await shareableContent()
    guard let window = content.windows.first(where: { $0.windowID == windowId }),
        !isHelperWindow(window)
    else {
        throw SpikeError.targetNotFound("Window \(windowId) was not found")
    }
    guard window.frame.width > 0, window.frame.height > 0 else {
        throw SpikeError.actionFailed("Window \(windowId) has invalid zero-sized geometry")
    }

    let display = containingDisplay(for: window.frame, in: content.displays)
    let targetScale = try requestedScale(
        scale, display: display, bounds: window.frame, maxWidth: maxWidth, maxHeight: maxHeight)
    let size = pixelDimensions(
        bounds: window.frame, scale: targetScale,
        maxWidth: maxWidth, maxHeight: maxHeight)
    let configuration = SCStreamConfiguration()
    configuration.width = size.width
    configuration.height = size.height
    configuration.showsCursor = includeCursor
    configuration.capturesAudio = false
    configuration.ignoreShadowsSingleWindow = true
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let image = try await screenshotImage(filter: filter, configuration: configuration)
    let nativeSize = try display.map { display in
        pixelDimensions(bounds: window.frame, scale: try displayScale(display))
    }

    return try captureResult(
        image: image,
        target: ["kind": "window", "windowId": String(window.windowID)],
        screenBounds: window.frame,
        nativePixelSize: nativeSize,
        format: format)
}

@MainActor
private func captureRegionArtifact(
    bounds: CGRect,
    format: CaptureFormat,
    scale: CaptureScale,
    maxWidth: Int?,
    maxHeight: Int?,
    includeCursor: Bool
) async throws -> [String: Any] {
    guard bounds.width > 0, bounds.height > 0,
        bounds.origin.x.isFinite, bounds.origin.y.isFinite,
        bounds.width.isFinite, bounds.height.isFinite
    else {
        throw SpikeError.invalidArguments("Region bounds must be positive and finite")
    }

    let content = try await captureShareableContent()
    let excludedApplications = try helperApplications(in: content)
    guard let display = containingDisplay(for: bounds, in: content.displays) else {
        throw SpikeError.unsupported("Region capture must fit entirely within one display")
    }
    let targetScale = try requestedScale(
        scale, display: display, bounds: bounds, maxWidth: maxWidth, maxHeight: maxHeight)
    let size = pixelDimensions(
        bounds: bounds, scale: targetScale,
        maxWidth: maxWidth, maxHeight: maxHeight)
    let configuration = SCStreamConfiguration()
    configuration.sourceRect = CGRect(
        x: bounds.minX - display.frame.minX,
        y: bounds.minY - display.frame.minY,
        width: bounds.width,
        height: bounds.height)
    configuration.width = size.width
    configuration.height = size.height
    configuration.showsCursor = includeCursor
    configuration.capturesAudio = false
    let filter = SCContentFilter(
        display: display,
        excludingApplications: excludedApplications,
        exceptingWindows: [])
    let image = try await screenshotImage(filter: filter, configuration: configuration)
    let nativeSize = pixelDimensions(bounds: bounds, scale: try displayScale(display))

    return try captureResult(
        image: image,
        target: ["kind": "region", "bounds": rectJSON(bounds)],
        screenBounds: bounds,
        nativePixelSize: nativeSize,
        format: format)
}

private func captureFormat(_ parameters: [String: Any]) throws -> CaptureFormat {
    let value = try optionalString(parameters, key: "format") ?? "png"
    guard let format = CaptureFormat(rawValue: value) else {
        throw SpikeError.invalidArguments("Parameter 'format' must be 'png' or 'jpeg'")
    }
    return format
}

private func captureScale(_ parameters: [String: Any]) throws -> CaptureScale {
    guard let value = parameters["scale"] else {
        return .logical
    }
    if let string = value as? String {
        switch string {
        case "logical": return .logical
        case "native": return .native
        default:
            throw SpikeError.invalidArguments(
                "Parameter 'scale' must be 'logical', 'native', or a positive number")
        }
    }
    guard CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID(), let number = value as? NSNumber,
        number.doubleValue.isFinite, number.doubleValue > 0, number.doubleValue <= 4
    else {
        throw SpikeError.invalidArguments(
            "Numeric parameter 'scale' must be greater than 0 and no greater than 4")
    }
    return .multiplier(CGFloat(number.doubleValue))
}

@MainActor
func captureArtifact(_ parameters: [String: Any]) async throws -> [String: Any] {
    guard let target = parameters["target"] as? [String: Any],
        let kind = target["kind"] as? String
    else {
        throw SpikeError.invalidArguments("Parameter 'target' must be a capture target object")
    }

    let format = try captureFormat(parameters)
    let scale = try captureScale(parameters)
    let maxWidth = try optionalPositiveInt(parameters, key: "maxWidth")
    let maxHeight = try optionalPositiveInt(parameters, key: "maxHeight")
    let includeCursor = try optionalBool(parameters, key: "includeCursor", default: false)

    switch kind {
    case "display":
        guard let displayIdValue = try optionalString(target, key: "displayId"),
            let displayId = CGDirectDisplayID(displayIdValue)
        else {
            throw SpikeError.invalidArguments("Display target requires a numeric 'displayId'")
        }
        return try await captureDisplayArtifact(
            displayId: displayId, format: format, scale: scale,
            maxWidth: maxWidth, maxHeight: maxHeight, includeCursor: includeCursor)
    case "window":
        return try await captureWindowArtifact(
            windowId: requiredWindowId(target), format: format, scale: scale,
            maxWidth: maxWidth, maxHeight: maxHeight, includeCursor: includeCursor)
    case "region":
        return try await captureRegionArtifact(
            bounds: requiredRect(target, key: "bounds"), format: format, scale: scale,
            maxWidth: maxWidth, maxHeight: maxHeight, includeCursor: includeCursor)
    default:
        throw SpikeError.invalidArguments("Unknown capture target kind '\(kind)'")
    }
}
