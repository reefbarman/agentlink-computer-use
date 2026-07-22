import Darwin
import Foundation

final class ArtifactStore {
    let rootURL: URL

    init() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("computer-use-mcp", isDirectory: true)
        try FileManager.default.createDirectory(
            at: base, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        guard chmod(base.path, mode_t(0o700)) == 0 else {
            throw SpikeError.actionFailed("Could not secure capture artifact base directory")
        }

        var baseStat = stat()
        guard lstat(base.path, &baseStat) == 0,
            (baseStat.st_mode & S_IFMT) == S_IFDIR,
            baseStat.st_uid == geteuid(),
            (baseStat.st_mode & mode_t(0o077)) == 0
        else {
            throw SpikeError.actionFailed(
                "Capture artifact base directory is not private and owned")
        }

        let root = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        guard chmod(root.path, mode_t(0o700)) == 0 else {
            throw SpikeError.actionFailed("Could not secure capture artifact session directory")
        }
        rootURL = root.resolvingSymlinksInPath().standardizedFileURL
    }

    func newArtifactURL(extension fileExtension: String) -> URL {
        rootURL.appendingPathComponent("\(UUID().uuidString).\(fileExtension)", isDirectory: false)
    }

    func secure(_ url: URL) throws {
        guard chmod(url.path, mode_t(0o600)) == 0 else {
            throw SpikeError.actionFailed("Could not secure capture artifact permissions")
        }
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: rootURL)
    }
}

@MainActor var artifactStore: ArtifactStore?
