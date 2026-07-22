import AppKit
import CoreGraphics
import Darwin
import Foundation
@preconcurrency import ScreenCaptureKit

@MainActor var cachedShareableContent: SCShareableContent?

@MainActor
private func loadShareableContent() async throws -> SCShareableContent {
    guard CGPreflightScreenCaptureAccess() else {
        throw SpikeError.permissionDenied(
            "Screen & System Audio Recording permission is required for ScreenCaptureKit discovery")
    }
    return try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<SCShareableContent, Error>) in
        SCShareableContent.getExcludingDesktopWindows(
            false, onScreenWindowsOnly: false
        ) { content, error in
            if let content {
                continuation.resume(returning: content)
            } else {
                continuation.resume(
                    throwing: error
                        ?? SpikeError.actionFailed("ScreenCaptureKit returned no shareable content")
                )
            }
        }
    }
}

@MainActor
func shareableContent() async throws -> SCShareableContent {
    if let cachedShareableContent {
        return cachedShareableContent
    }
    let content = try await loadShareableContent()
    cachedShareableContent = content
    return content
}

@MainActor
func prepareCaptureContent() async throws {
    _ = try await captureShareableContent()
}

@MainActor
func captureShareableContent() async throws -> SCShareableContent {
    let content = try await shareableContent()
    let runningHelperPids = Set(
        NSWorkspace.shared.runningApplications.compactMap { application in
            isCurrentHelperProcess(application.processIdentifier)
                ? application.processIdentifier : nil
        })
    let cachedHelperPids = Set(
        content.applications.compactMap { application in
            isCurrentHelperProcess(application.processID) ? application.processID : nil
        })
    guard runningHelperPids != cachedHelperPids else {
        return content
    }
    let refreshed = try await loadShareableContent()
    cachedShareableContent = refreshed
    return refreshed
}

func isCurrentHelperProcess(_ processId: pid_t) -> Bool {
    guard let application = NSRunningApplication(processIdentifier: processId),
        let executableURL = application.executableURL,
        let currentExecutableURL = Bundle.main.executableURL
    else {
        return false
    }
    return executableURL.resolvingSymlinksInPath().standardizedFileURL
        == currentExecutableURL.resolvingSymlinksInPath().standardizedFileURL
}

@MainActor
func helperApplications(in content: SCShareableContent) throws -> [SCRunningApplication] {
    let applications = content.applications.filter { isCurrentHelperProcess($0.processID) }
    guard applications.contains(where: { $0.processID == getpid() }) else {
        throw SpikeError.actionFailed(
            "ScreenCaptureKit could not resolve the activity indicator application")
    }
    return applications
}

func isHelperWindow(_ window: SCWindow) -> Bool {
    guard let application = window.owningApplication else { return false }
    return isCurrentHelperProcess(application.processID)
}
