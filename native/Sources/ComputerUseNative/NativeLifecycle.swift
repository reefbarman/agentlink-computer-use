import Darwin
import Dispatch
import Foundation

@MainActor var terminationSignalSources: [DispatchSourceSignal] = []

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
func installTerminationSignalHandlers() {
    terminationSignalSources = [SIGTERM, SIGINT].map { signalNumber in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            Task { @MainActor in
                cleanupNativeState()
                Foundation.exit(128 + signalNumber)
            }
        }
        source.resume()
        return source
    }
}
