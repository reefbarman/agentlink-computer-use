import AppKit
import Darwin
import Foundation

enum ComputerUseActivity: String {
    case idle
    case capture
    case control
    case paused
}

private final class PauseStore {
    private let directoryURL: URL
    private let stateURL: URL
    private let lockURL: URL

    init() throws {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true)
        directoryURL = base.appendingPathComponent("AgentLink Computer Use", isDirectory: true)
        stateURL = directoryURL.appendingPathComponent("control-paused-v1")
        lockURL = directoryURL.appendingPathComponent("control-paused.lock")
        try ensurePrivateDirectory()
    }

    func isPaused() throws -> Bool {
        try ensurePrivateDirectory()
        guard FileManager.default.fileExists(atPath: stateURL.path) else {
            return false
        }
        try validateRegularFile(stateURL, expectedMode: 0o600)
        return true
    }

    func setPaused(_ paused: Bool) throws {
        try ensurePrivateDirectory()
        let descriptor = open(lockURL.path, O_RDWR | O_CREAT | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw SpikeError.actionFailed("Could not open the computer-use safety lock")
        }
        defer { close(descriptor) }
        guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0, flock(descriptor, LOCK_EX) == 0 else {
            throw SpikeError.actionFailed("Could not lock the computer-use safety state")
        }
        defer { flock(descriptor, LOCK_UN) }

        try validateRegularFile(lockURL, expectedMode: 0o600)
        if paused {
            let temporaryURL = directoryURL.appendingPathComponent(
                ".control-paused-\(UUID().uuidString)")
            let data = Data("1\n".utf8)
            guard
                FileManager.default.createFile(
                    atPath: temporaryURL.path,
                    contents: data,
                    attributes: [.posixPermissions: 0o600])
            else {
                throw SpikeError.actionFailed("Could not persist the computer-use safety state")
            }
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            try validateRegularFile(temporaryURL, expectedMode: 0o600)
            guard rename(temporaryURL.path, stateURL.path) == 0 else {
                throw SpikeError.actionFailed(
                    "Could not atomically persist the computer-use safety state")
            }
            try validateRegularFile(stateURL, expectedMode: 0o600)
        } else if FileManager.default.fileExists(atPath: stateURL.path) {
            try validateRegularFile(stateURL, expectedMode: 0o600)
            try FileManager.default.removeItem(at: stateURL)
        }
    }

    private func ensurePrivateDirectory() throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directoryURL.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw SpikeError.actionFailed("Computer-use safety state path is not a directory")
            }
        } else {
            try FileManager.default.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        }

        try validatePath(directoryURL, expectedType: S_IFDIR, expectedMode: 0o700)
    }

    private func validateRegularFile(_ url: URL, expectedMode: Int) throws {
        try validatePath(url, expectedType: S_IFREG, expectedMode: expectedMode)
    }

    private func validatePath(_ url: URL, expectedType: mode_t, expectedMode: Int) throws {
        var status = stat()
        guard lstat(url.path, &status) == 0,
            status.st_uid == getuid(),
            status.st_mode & S_IFMT == expectedType,
            status.st_mode & 0o777 == expectedMode
        else {
            throw SpikeError.actionFailed("Computer-use safety state path is unsafe")
        }
    }
}

@MainActor
final class ControlSafetyController {
    private static let distributedNotification = Notification.Name(
        "dev.agentlink.computer-use.control-state-changed")

    private let pauseStore: PauseStore
    private let presenter: ActivityIndicatorPresenter
    private var captureCount = 0
    private var controlCount = 0
    private var minimumVisibleUntil: ContinuousClock.Instant?
    private var hideTask: Task<Void, Never>?
    private var distributedObserver: NSObjectProtocol?
    private var interruptionGeneration: UInt64 = 0
    private var activeControlGeneration: UInt64?
    private var lastActiveState: ComputerUseActivity = .capture
    private(set) var inputEnabled: Bool

    var indicatorAvailable: Bool { presenter.isAvailable }

    init() throws {
        pauseStore = try PauseStore()
        inputEnabled = !(try pauseStore.isPaused())
        presenter = ActivityIndicatorPresenter()
        presenter.onEmergencyStop = { [weak self] in self?.emergencyStop() }
        presenter.onResumeControl = { [weak self] in self?.resumeControl() }
        distributedObserver = DistributedNotificationCenter.default().addObserver(
            forName: Self.distributedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reloadPersistedState() }
        }
        updatePresentation()
    }

    var state: ComputerUseActivity {
        if !inputEnabled { return .paused }
        if controlCount > 0 || hasHeldInput { return .control }
        if captureCount > 0 { return .capture }
        return .idle
    }

    func statusJSON() -> [String: Any] {
        [
            "inputEnabled": inputEnabled,
            "indicatorAvailable": indicatorAvailable,
            "state": state.rawValue,
        ]
    }

    func requireInputEnabled(generation: UInt64? = nil) throws {
        guard indicatorAvailable else {
            throw SpikeError.unsupported(
                "Computer control is unavailable because the activity indicator could not be created"
            )
        }
        do {
            if try pauseStore.isPaused() {
                let wasEnabled = inputEnabled
                inputEnabled = false
                if wasEnabled {
                    interruptionGeneration &+= 1
                    _ = releaseInputState()
                    minimumVisibleUntil = ContinuousClock.now.advanced(by: .milliseconds(1_500))
                    updatePresentation()
                    schedulePausedConfirmationHide()
                }
            }
        } catch {
            inputEnabled = false
            updatePresentation()
            throw SpikeError.controlDisabled(
                "Computer control is disabled because the safety state could not be verified")
        }
        guard inputEnabled, generation == nil || generation == interruptionGeneration else {
            throw SpikeError.controlDisabled(
                "Computer control is paused; use Resume Control from the local menu bar")
        }
    }

    func requireActiveControl() throws {
        guard let activeControlGeneration else {
            throw SpikeError.controlDisabled(
                "Computer control was attempted outside an authorized activity scope")
        }
        try requireInputEnabled(generation: activeControlGeneration)
    }

    func controlCheckpoint() async throws {
        await Task.yield()
        try await Task.sleep(for: .milliseconds(1))
        try requireActiveControl()
    }

    func withControlActivity<T>(_ operation: () async throws -> T) async throws -> T {
        try requireInputEnabled()
        precondition(activeControlGeneration == nil, "Control activity must not be nested")
        activeControlGeneration = interruptionGeneration
        controlCount += 1
        markMinimumDwell()
        updatePresentation()
        do {
            try await presentationBarrier()
            let result = try await operation()
            activeControlGeneration = nil
            controlCount -= 1
            synchronizeHeldInput()
            return result
        } catch {
            activeControlGeneration = nil
            controlCount -= 1
            synchronizeHeldInput()
            throw error
        }
    }

    func withCaptureActivity<T>(_ operation: () async throws -> T) async throws -> T {
        guard indicatorAvailable else {
            throw SpikeError.unsupported(
                "Screen capture is unavailable because the activity indicator could not be created")
        }
        captureCount += 1
        markMinimumDwell()
        updatePresentation()
        do {
            try await presentationBarrier()
            let result = try await operation()
            captureCount -= 1
            schedulePresentationUpdate()
            return result
        } catch {
            captureCount -= 1
            schedulePresentationUpdate()
            throw error
        }
    }

    func synchronizeHeldInput() {
        schedulePresentationUpdate()
    }

    func cleanup() {
        hideTask?.cancel()
        if let distributedObserver {
            DistributedNotificationCenter.default().removeObserver(distributedObserver)
            self.distributedObserver = nil
        }
        presenter.cleanup()
    }

    private var hasHeldInput: Bool {
        !mouseController.heldButtons.isEmpty
            || !keyboardController.heldKeys.isEmpty
            || !keyboardController.heldModifiers.isEmpty
    }

    private func markMinimumDwell() {
        minimumVisibleUntil = ContinuousClock.now.advanced(by: .milliseconds(1_500))
        hideTask?.cancel()
    }

    private func schedulePresentationUpdate() {
        hideTask?.cancel()
        guard state == .idle, let minimumVisibleUntil, minimumVisibleUntil > .now else {
            updatePresentation()
            return
        }
        hideTask = Task { [weak self] in
            try? await Task.sleep(until: minimumVisibleUntil)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.updatePresentation() }
        }
    }

    private func updatePresentation() {
        let visibleState: ComputerUseActivity
        if captureCount > 0 {
            visibleState = .capture
            lastActiveState = .capture
        } else if state == .paused {
            visibleState = minimumVisibleUntil.map { $0 > .now } == true ? .paused : .idle
        } else if state != .idle {
            visibleState = state
            if state == .capture || state == .control {
                lastActiveState = state
            }
        } else if let minimumVisibleUntil, minimumVisibleUntil > .now {
            visibleState = lastActiveState
        } else {
            visibleState = .idle
            self.minimumVisibleUntil = nil
        }
        presenter.update(state: visibleState, inputEnabled: inputEnabled)
    }

    private func presentationBarrier() async throws {
        await Task.yield()
        try await Task.sleep(for: .milliseconds(50))
        try presenter.verifyVisible()
    }

    private func emergencyStop() {
        do {
            try pauseStore.setPaused(true)
        } catch {
            inputEnabled = false
        }
        inputEnabled = false
        interruptionGeneration &+= 1
        _ = releaseInputState()
        minimumVisibleUntil = ContinuousClock.now.advanced(by: .milliseconds(1_500))
        updatePresentation()
        schedulePausedConfirmationHide()
        DistributedNotificationCenter.default().postNotificationName(
            Self.distributedNotification, object: nil)
    }

    private func schedulePausedConfirmationHide() {
        hideTask?.cancel()
        guard let minimumVisibleUntil else { return }
        hideTask = Task { [weak self] in
            try? await Task.sleep(until: minimumVisibleUntil)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.updatePresentation() }
        }
    }

    private func resumeControl() {
        do {
            try pauseStore.setPaused(false)
            inputEnabled = true
            interruptionGeneration &+= 1
        } catch {
            inputEnabled = false
        }
        updatePresentation()
        DistributedNotificationCenter.default().postNotificationName(
            Self.distributedNotification, object: nil)
    }

    private func reloadPersistedState() {
        let wasEnabled = inputEnabled
        do {
            inputEnabled = !(try pauseStore.isPaused())
        } catch {
            inputEnabled = false
        }
        if wasEnabled && !inputEnabled {
            interruptionGeneration &+= 1
            _ = releaseInputState()
        }
        updatePresentation()
    }
}

@MainActor var controlSafetyController: ControlSafetyController?

@MainActor
func requireControlSafetyController() throws -> ControlSafetyController {
    guard let controlSafetyController else {
        throw SpikeError.unsupported("Computer-use safety indicator is unavailable")
    }
    return controlSafetyController
}

@MainActor
func requireActiveControl() throws {
    try requireControlSafetyController().requireActiveControl()
}

@MainActor
func controlCheckpoint() async throws {
    try await requireControlSafetyController().controlCheckpoint()
}
