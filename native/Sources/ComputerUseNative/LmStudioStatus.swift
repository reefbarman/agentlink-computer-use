import CoreFoundation
import Foundation

enum LMStudioState: String {
    case checking
    case disabled
    case offline
    case notLoaded = "not_loaded"
    case unsupported
    case ambiguous
    case ready
    case error

    var title: String {
        switch self {
        case .checking: "Checking"
        case .disabled: "Disabled"
        case .offline: "Offline"
        case .notLoaded: "Model not loaded"
        case .unsupported: "Unsupported model"
        case .ambiguous: "Choose a model"
        case .ready: "Ready"
        case .error: "Error"
        }
    }
}

struct LMStudioLastUsed {
    let at: String
    let model: String
    let durationMs: Double
}

struct LMStudioLastFailure {
    let at: String
    let reason: String
    let model: String?
}

struct LMStudioStatus {
    let state: LMStudioState
    let model: String?
    let checkedAt: String?
    let detail: String?
    let lastUsed: LMStudioLastUsed?
    let lastFailure: LMStudioLastFailure?

    static let checking = LMStudioStatus(
        state: .checking,
        model: nil,
        checkedAt: nil,
        detail: nil,
        lastUsed: nil,
        lastFailure: nil)

    static func parse(_ value: [String: Any]) throws -> LMStudioStatus {
        guard
            let rawState = value["state"] as? String,
            let state = LMStudioState(rawValue: rawState),
            value.keys.count == 6,
            ["state", "model", "checkedAt", "detail", "lastUsed", "lastFailure"]
                .allSatisfy({ value.keys.contains($0) })
        else {
            throw SpikeError.invalidArguments("Invalid LM Studio status object")
        }

        let model = try nullableString(value["model"], key: "model", maximumLength: 256)
        let checkedAt = try nullableTimestamp(value["checkedAt"], key: "checkedAt")
        let detail = try nullableString(value["detail"], key: "detail", maximumLength: 512)
        let lastUsed = try parseLastUsed(value["lastUsed"])
        let lastFailure = try parseLastFailure(value["lastFailure"])
        return LMStudioStatus(
            state: state,
            model: model,
            checkedAt: checkedAt,
            detail: detail,
            lastUsed: lastUsed,
            lastFailure: lastFailure)
    }

    var json: [String: Any] {
        [
            "state": state.rawValue,
            "model": model ?? NSNull() as Any,
            "checkedAt": checkedAt ?? NSNull() as Any,
            "detail": detail ?? NSNull() as Any,
            "lastUsed": lastUsed.map {
                ["at": $0.at, "model": $0.model, "durationMs": $0.durationMs] as [String: Any]
            } ?? NSNull() as Any,
            "lastFailure": lastFailure.map {
                [
                    "at": $0.at,
                    "reason": $0.reason,
                    "model": $0.model ?? NSNull() as Any,
                ] as [String: Any]
            } ?? NSNull() as Any,
        ]
    }

    var menuRows: [(String, String)] {
        [
            ("Readiness", state.title),
            ("Model", model ?? "Not reported"),
            ("Checked", checkedAt ?? "Not checked"),
            ("Detail", detail ?? "None"),
            (
                "Last use",
                lastUsed.map { "\($0.model) at \($0.at), \(formatDuration($0.durationMs)) ms" }
                    ?? "None"
            ),
            (
                "Last failure",
                lastFailure.map {
                    "\($0.reason) (\($0.model ?? "unknown model")) at \($0.at)"
                } ?? "None"
            ),
        ]
    }

    private static func parseLastUsed(_ value: Any?) throws -> LMStudioLastUsed? {
        guard let value else { throw invalid("lastUsed") }
        if value is NSNull { return nil }
        guard let object = value as? [String: Any], object.keys.count == 3,
            let at = try nullableTimestamp(object["at"], key: "lastUsed.at"),
            let model = try nullableString(
                object["model"], key: "lastUsed.model", maximumLength: 256),
            let duration = object["durationMs"] as? NSNumber,
            CFGetTypeID(duration) != CFBooleanGetTypeID(),
            duration.doubleValue.isFinite,
            duration.doubleValue >= 0,
            object.keys.contains("at"), object.keys.contains("model"),
            object.keys.contains("durationMs")
        else {
            throw invalid("lastUsed")
        }
        return LMStudioLastUsed(at: at, model: model, durationMs: duration.doubleValue)
    }

    private static func parseLastFailure(_ value: Any?) throws -> LMStudioLastFailure? {
        guard let value else { throw invalid("lastFailure") }
        if value is NSNull { return nil }
        guard let object = value as? [String: Any], object.keys.count == 3,
            object.keys.contains("at"), object.keys.contains("reason"),
            object.keys.contains("model")
        else {
            throw invalid("lastFailure")
        }
        guard let at = try nullableTimestamp(object["at"], key: "lastFailure.at"),
            let reason = try nullableString(
                object["reason"], key: "lastFailure.reason", maximumLength: 256)
        else {
            throw invalid("lastFailure")
        }
        let model = try nullableString(
            object["model"], key: "lastFailure.model", maximumLength: 256)
        return LMStudioLastFailure(at: at, reason: reason, model: model)
    }

    private static func nullableString(
        _ value: Any?, key: String, maximumLength: Int
    ) throws -> String? {
        guard let value else { throw invalid(key) }
        if value is NSNull { return nil }
        guard let string = value as? String, !string.isEmpty, string.utf16.count <= maximumLength
        else {
            throw invalid(key)
        }
        return string
    }

    private static func nullableTimestamp(_ value: Any?, key: String) throws -> String? {
        guard let string = try nullableString(value, key: key, maximumLength: 64) else {
            return nil
        }
        let formatters = [
            ISO8601DateFormatter(),
            ISO8601DateFormatter(),
        ]
        formatters[0].formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatters[1].formatOptions = [.withInternetDateTime]
        guard formatters.contains(where: { $0.date(from: string) != nil }) else {
            throw invalid(key)
        }
        return string
    }

    private static func invalid(_ key: String) -> SpikeError {
        .invalidArguments("Invalid LM Studio status field '\(key)'")
    }

    private func formatDuration(_ value: Double) -> String {
        value.rounded() == value ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }
}
