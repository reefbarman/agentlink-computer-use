import ApplicationServices
import CryptoKit
import Foundation

private enum SemanticAction: String {
    case press
    case toggle
    case focus
    case increment
    case decrement
    case showMenu = "show_menu"

    /// Focus is an attribute mutation rather than an AX action.
    var axAction: String? {
        switch self {
        case .press, .toggle: return kAXPressAction
        case .increment: return kAXIncrementAction
        case .decrement: return kAXDecrementAction
        case .showMenu: return kAXShowMenuAction
        case .focus: return nil
        }
    }
}

enum TransactionPhase: String {
    case preDispatch = "pre_dispatch"
    case dispatchAttempted = "dispatch_attempted"
    case verifying
    case complete
}

enum TransactionOutcome: String {
    case notDispatched = "not_dispatched"
    case verified
    case indeterminate
}

struct TransactionJournal {
    private(set) var entries: [[String: Any]] = []

    mutating func record(_ phase: TransactionPhase, _ detail: String) {
        guard entries.count < 16 else { return }
        entries.append([
            "phase": phase.rawValue,
            "detail": detail,
            "at": ISO8601DateFormatter().string(from: Date()),
        ])
    }
}

func accessibilityNodeFingerprint(
    _ node: AccessibilityNode, observation: AccessibilityObservation
) -> String {
    var path: [String] = []
    var parentId = node.parentId
    let nodesById = Dictionary(uniqueKeysWithValues: observation.nodes.map { ($0.id, $0) })
    while let id = parentId, let parent = nodesById[id], path.count < 32 {
        path.append("\(parent.role ?? "?"):\(parent.childIndex)")
        parentId = parent.parentId
    }
    let normalizedNames = node.names.map(normalizedAccessibilityName).sorted().joined(
        separator: "\u{1F}")
    let frame =
        node.frame.map {
            // Frames tolerate sub-point jitter without invalidating the fingerprint.
            "\(Int($0.origin.x.rounded()))x\(Int($0.origin.y.rounded()))"
                + ":\(Int($0.size.width.rounded()))x\(Int($0.size.height.rounded()))"
        } ?? "none"
    let identity = [
        observation.processInstanceId,
        node.role ?? "?",
        node.subrole ?? "?",
        normalizedNames,
        node.actions.sorted().joined(separator: ","),
        path.reversed().joined(separator: "/"),
        frame,
    ].joined(separator: "\u{1E}")
    let digest = SHA256.hash(data: Data(identity.utf8))
        .map { String(format: "%02x", $0) }
        .joined()
    return "sha256:\(digest)"
}

private func targetJSON(
    _ node: AccessibilityNode, fingerprint: String, policy: AccessibilityContentPolicy
) -> [String: Any] {
    [
        "id": node.id,
        "fingerprint": fingerprint,
        "role": node.role ?? NSNull(),
        "subrole": node.subrole ?? NSNull(),
        "names": node.names.map { exposedActionText($0, policy: policy) },
        "frame": node.frame.map(rectJSON) ?? NSNull(),
        "actions": node.actions,
        "enabled": node.enabled ?? NSNull(),
        "focused": node.focused ?? NSNull(),
    ]
}

@MainActor
private func performAccessibilityAction(
    _ action: SemanticAction, element: AXUIElement
) -> AXError {
    if let axAction = action.axAction {
        return AXUIElementPerformAction(element, axAction as CFString)
    }
    return AXUIElementSetAttributeValue(
        element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
}

private func exposedActionText(_ value: String, policy: AccessibilityContentPolicy) -> String {
    guard policy == .redacted else { return value }
    return
        "sha256:\(SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined())"
}

struct TransactionState {
    let startedAt: String
    let startedNanoseconds: UInt64
    var journal = TransactionJournal()
    var dispatchAttempted = false
    var dispatchAcknowledged = false
    var target: [String: Any]?
    var observation: AccessibilityObservation?
    var preconditionEvaluations: [[String: Any]] = []
    var postconditionEvaluations: [[String: Any]] = []
    var postconditionStatus = "not_evaluated"
    var postconditionPollCount = 0
}

private func transactionResult(
    outcome: TransactionOutcome, phase: TransactionPhase, action: SemanticAction,
    state: TransactionState, reasons: [String]
) throws -> [String: Any] {
    [
        "schemaVersion": 1,
        "outcome": outcome.rawValue,
        "phase": phase.rawValue,
        "action": action.rawValue,
        "dispatchAttempted": state.dispatchAttempted,
        "dispatchAcknowledged": state.dispatchAcknowledged,
        "startedAt": state.startedAt,
        "finishedAt": ISO8601DateFormatter().string(from: Date()),
        "durationMs": Double(
            DispatchTime.now().uptimeNanoseconds - state.startedNanoseconds) / 1_000_000,
        "application": state.observation.map {
            observationMetadata($0)["application"] as Any
        } ?? NSNull(),
        "observation": try state.observation.map { try finalizedObservationMetadata($0) as Any }
            ?? NSNull(),
        "target": state.target.map { $0 as Any } ?? NSNull(),
        "preconditionEvaluations": state.preconditionEvaluations,
        "postcondition": [
            "status": state.postconditionStatus,
            "pollCount": state.postconditionPollCount,
            "evaluations": state.postconditionEvaluations,
        ],
        "journal": state.journal.entries,
        "reasons": reasons,
    ]
}

@MainActor
func accessibilityAct(_ parameters: [String: Any]) async throws -> [String: Any] {
    let allowedKeys: Set<String> = [
        "processId", "expectedBundleIdentifier", "contentPolicy", "limits", "target", "action",
        "expectedTargetFingerprint", "precondition", "postcondition", "verificationTimeoutMs",
        "pollIntervalMs", "selectedTargetFingerprint",
    ]
    guard Set(parameters.keys).isSubset(of: allowedKeys) else {
        throw SpikeError.invalidArguments("Accessibility action contains unknown fields")
    }
    guard let actionValue = try optionalString(parameters, key: "action"),
        let action = SemanticAction(rawValue: actionValue)
    else {
        throw SpikeError.invalidArguments("Parameter 'action' is missing or unsupported")
    }
    guard let targetValue = parameters["target"] as? [String: Any] else {
        throw SpikeError.invalidArguments("Accessibility action requires a target object")
    }
    let predicate = try AccessibilityPredicate.parse(["predicate": targetValue])
    let postcondition = try SemanticConditionSet.parse(parameters, key: "postcondition")
    let precondition =
        parameters["precondition"] == nil
        ? nil : try SemanticConditionSet.parse(parameters, key: "precondition")
    let expectedFingerprint = try optionalString(parameters, key: "expectedTargetFingerprint")
    let selectedTargetFingerprint = try optionalString(parameters, key: "selectedTargetFingerprint")
    let verificationTimeoutMs = try optionalBoundedInt(
        parameters, key: "verificationTimeoutMs", default: 3_000, minimum: 0, maximum: 15_000)
    let pollIntervalMs = try optionalBoundedInt(
        parameters, key: "pollIntervalMs", default: 150, minimum: 50, maximum: 2_000)
    let policy = try AccessibilityContentPolicy.parse(parameters)

    var state = TransactionState(
        startedAt: ISO8601DateFormatter().string(from: Date()),
        startedNanoseconds: DispatchTime.now().uptimeNanoseconds)

    // Resolution and identity validation happen before any transaction state exists,
    // so a missing process still throws as a protocol-level error.
    let observation = try observeAccessibility(parameters)
    state.observation = observation
    state.journal.record(.preDispatch, "resolved_observation")

    guard observation.complete else {
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: observation.reasons)
    }

    let predicateMatches = matchingAccessibilityNodes(
        observation: observation, predicate: predicate)
    let matches: [AccessibilityNode]
    if let selectedTargetFingerprint {
        matches = predicateMatches.filter {
            accessibilityNodeFingerprint($0, observation: observation) == selectedTargetFingerprint
        }
    } else {
        matches = predicateMatches
    }
    guard matches.count == 1, let node = matches.first else {
        let reason: String
        if matches.isEmpty, selectedTargetFingerprint != nil {
            reason = "candidate_selection_changed"
        } else {
            reason = matches.isEmpty ? "target_not_found" : "target_ambiguous"
        }
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: [reason])
    }

    let fingerprint = accessibilityNodeFingerprint(node, observation: observation)
    state.target = targetJSON(node, fingerprint: fingerprint, policy: policy)
    if let expectedFingerprint, expectedFingerprint != fingerprint {
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: ["target_fingerprint_mismatch"])
    }
    if let selectedTargetFingerprint, selectedTargetFingerprint != fingerprint {
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: ["candidate_selection_changed"])
    }
    guard node.enabled != false else {
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: ["target_disabled"])
    }
    if let axAction = action.axAction, !node.actions.contains(axAction) {
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: ["action_unsupported"])
    }
    if let precondition {
        let outcome = precondition.evaluate(observation: observation)
        state.preconditionEvaluations = outcome.evaluations
        guard outcome.satisfied else {
            return try transactionResult(
                outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
                reasons: outcome.uncertain
                    ? outcome.reasons : ["precondition_unsatisfied"])
        }
    }
    guard let element = observation.elementsById[node.id] else {
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: ["target_element_unavailable"])
    }

    do {
        try requireControlSafetyController().requireInputEnabled()
    } catch {
        state.journal.record(.preDispatch, "control_unavailable")
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: ["control_disabled"])
    }

    let dispatchError: AXError
    do {
        dispatchError = try await requireControlSafetyController().withControlActivity {
            try requireActiveControl()
            state.dispatchAttempted = true
            state.journal.record(.dispatchAttempted, "dispatch_boundary")
            return performAccessibilityAction(action, element: element)
        }
    } catch {
        // Control safety refused before the action was posted.
        if state.dispatchAttempted {
            return try transactionResult(
                outcome: .indeterminate, phase: .dispatchAttempted, action: action, state: state,
                reasons: ["control_interrupted"])
        }
        return try transactionResult(
            outcome: .notDispatched, phase: .preDispatch, action: action, state: state,
            reasons: ["control_disabled"])
    }

    guard dispatchError == .success else {
        state.journal.record(.dispatchAttempted, "dispatch_failed")
        return try transactionResult(
            outcome: .indeterminate, phase: .dispatchAttempted, action: action, state: state,
            reasons: ["dispatch_failed"])
    }
    state.dispatchAcknowledged = true
    state.journal.record(.verifying, "dispatch_acknowledged")

    let verificationStart = DispatchTime.now().uptimeNanoseconds
    while true {
        let verifyObservation: AccessibilityObservation
        do {
            verifyObservation = try observeAccessibility(parameters)
        } catch {
            state.postconditionStatus = "uncertain"
            return try transactionResult(
                outcome: .indeterminate, phase: .verifying, action: action, state: state,
                reasons: ["verification_observation_failed"])
        }
        state.postconditionPollCount += 1
        guard verifyObservation.processInstanceId == observation.processInstanceId else {
            state.postconditionStatus = "uncertain"
            return try transactionResult(
                outcome: .indeterminate, phase: .verifying, action: action, state: state,
                reasons: ["process_identity_changed"])
        }
        state.observation = verifyObservation

        let outcome = postcondition.evaluate(observation: verifyObservation)
        state.postconditionEvaluations = outcome.evaluations
        if verifyObservation.complete ? outcome.satisfied : outcome.satisfiedFromPartial {
            state.postconditionStatus = "satisfied"
            state.journal.record(.complete, "postcondition_satisfied")
            return try transactionResult(
                outcome: .verified, phase: .complete, action: action, state: state, reasons: [])
        }

        let elapsedMs =
            Double(DispatchTime.now().uptimeNanoseconds - verificationStart) / 1_000_000
        if elapsedMs >= Double(verificationTimeoutMs) {
            state.postconditionStatus = outcome.uncertain ? "uncertain" : "unsatisfied"
            return try transactionResult(
                outcome: .indeterminate, phase: .verifying, action: action, state: state,
                reasons: outcome.uncertain
                    ? outcome.reasons : ["postcondition_unsatisfied"])
        }
        // Verification is read-only AX observation outside the control activity
        // scope, so it neither posts input nor requires active control.
        let remainingMs = max(1, verificationTimeoutMs - Int(elapsedMs))
        try await Task.sleep(for: .milliseconds(min(pollIntervalMs, remainingMs)))
    }
}
