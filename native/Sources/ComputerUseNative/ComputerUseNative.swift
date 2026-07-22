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
    static func main() async {
        _ = NSApplication.shared

        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let command = arguments.first, command == "serve", arguments.count == 1 else {
                printUsage()
                throw SpikeError.invalidArguments("The only supported command is 'serve'")
            }

            artifactStore = try ArtifactStore()
            controlSafetyController = try ControlSafetyController()
            installTerminationSignalHandlers()
            defer { cleanupNativeState() }
            try await serve()
        } catch {
            JSONOutput.writeError(error)
            Foundation.exit(1)
        }
    }
}
