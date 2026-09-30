import AppKit
import Foundation

private func printUsage() {
    let usage = """
        ComputerUseNative commands:
          serve
        """
    FileHandle.standardError.write(Data(usage.utf8))
}

@main
private struct ComputerUseNative {
    @MainActor
    static func main() {
        _ = NSApplication.shared
        installTerminationSignalHandlers()

        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let command = arguments.first, command == "serve", arguments.count == 1 else {
                printUsage()
                throw SpikeError.invalidArguments("The only supported command is 'serve'")
            }

            artifactStore = try ArtifactStore()
            controlSafetyController = try ControlSafetyController()
            installParentExitHandler()
            Task { @MainActor in
                do {
                    try await serve()
                    terminateNativeHelper()
                } catch {
                    JSONOutput.writeError(error)
                    terminateNativeHelper(exitCode: 1)
                }
            }
            NSApplication.shared.run()
        } catch {
            JSONOutput.writeError(error)
            terminateNativeHelper(exitCode: 1)
        }
    }
}
