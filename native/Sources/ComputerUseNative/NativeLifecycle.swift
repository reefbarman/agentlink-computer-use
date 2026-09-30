import Darwin
import Dispatch
import Foundation

// Shared with NativeClient: a local Quit must not be treated as a recoverable crash.
let nativeUserQuitExitCode: Int32 = 64

@MainActor var terminationSignalSources: [DispatchSourceSignal] = []
@MainActor var parentExitSource: DispatchSourceProcess?

@MainActor
func cleanupNativeState() {
    keyboardController.releaseAll()
    mouseController.releaseAll()
    controlSafetyController?.cleanup()
    controlSafetyController = nil
    cachedShareableContent = nil
    artifactStore?.cleanup()
    artifactStore = nil
}

@MainActor
func terminateNativeHelper(exitCode: Int32 = 0) -> Never {
    cleanupNativeState()
    Foundation.exit(exitCode)
}

@MainActor
func installParentExitHandler() {
    let parentPid = getppid()
    guard parentPid > 1 else { terminateNativeHelper() }
    let source = DispatchSource.makeProcessSource(
        identifier: parentPid, eventMask: .exit, queue: .main)
    source.setEventHandler {
        MainActor.assumeIsolated { terminateNativeHelper() }
    }
    parentExitSource = source
    source.resume()
    if getppid() != parentPid { terminateNativeHelper() }
}

@MainActor
func installTerminationSignalHandlers() {
    signal(SIGPIPE, SIG_IGN)
    terminationSignalSources = [SIGTERM, SIGINT].map { signalNumber in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            MainActor.assumeIsolated {
                terminateNativeHelper(exitCode: 128 + signalNumber)
            }
        }
        source.resume()
        return source
    }
}
