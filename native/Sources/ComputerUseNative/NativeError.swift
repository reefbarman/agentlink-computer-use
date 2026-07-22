import Foundation

enum SpikeError: LocalizedError {
    case invalidArguments(String)
    case permissionDenied(String)
    case targetNotFound(String)
    case actionFailed(String)
    case controlDisabled(String)
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message),
            .permissionDenied(let message),
            .targetNotFound(let message),
            .actionFailed(let message),
            .controlDisabled(let message),
            .unsupported(let message):
            message
        }
    }
}

func nativeErrorCode(_ error: Error) -> String {
    guard let spikeError = error as? SpikeError else {
        return "internal_error"
    }

    switch spikeError {
    case .invalidArguments:
        return "invalid_argument"
    case .permissionDenied:
        return "permission_denied"
    case .targetNotFound:
        return "target_not_found"
    case .actionFailed:
        return "action_failed"
    case .controlDisabled:
        return "control_disabled"
    case .unsupported:
        return "unsupported"
    }
}
