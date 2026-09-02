import ApplicationServices
import Foundation

private struct SemanticFillField {
    let predicate: AccessibilityPredicate
    let expectedFingerprint: String?
    let value: String
}

private func fillTargetJSON(
    _ node: AccessibilityNode, fingerprint: String, policy: AccessibilityContentPolicy
) -> [String: Any] {
    [
        "id": node.id,
        "fingerprint": fingerprint,
        "role": node.role ?? NSNull(),
        "subrole": node.subrole ?? NSNull(),
        "names": node.names.map { exposedText($0, policy: policy) },
        "frame": node.frame.map(rectJSON) ?? NSNull(),
        "actions": node.actions,
        "enabled": node.enabled ?? NSNull(),
        "focused": node.focused ?? NSNull(),
    ]
}

private func parseSemanticFillFields(_ parameters: [String: Any]) throws -> [SemanticFillField] {
    guard let values = parameters["fields"] as? [[String: Any]], !values.isEmpty, values.count <= 8
    else {
        throw SpikeError.invalidArguments("ui_fill requires between 1 and 8 fields")
    }
    var totalLength = 0
    return try values.map { value in
        let allowedKeys: Set<String> = ["target", "expectedTargetFingerprint", "value"]
        guard Set(value.keys).isSubset(of: allowedKeys),
            let target = value["target"] as? [String: Any],
            let string = value["value"] as? String, string.utf16.count <= 4_096
        else {
            throw SpikeError.invalidArguments("ui_fill field is invalid")
        }
        totalLength += string.count
        guard totalLength <= 8_192 else {
            throw SpikeError.invalidArguments(
                "ui_fill values may not exceed 8192 characters in total")
        }
        return SemanticFillField(
            predicate: try AccessibilityPredicate.parse(["predicate": target]),
            expectedFingerprint: try optionalString(value, key: "expectedTargetFingerprint"),
            value: string)
    }
}

@MainActor
private func valueIsSettable(_ element: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(
        element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

private func fillResult(
    outcome: TransactionOutcome,
    phase: TransactionPhase,
    state: TransactionState,
    fields: [[String: Any]],
    reasons: [String]
) throws -> [String: Any] {
    [
        "schemaVersion": 1,
        "outcome": outcome.rawValue,
        "phase": phase.rawValue,
        "dispatchAttempted": state.dispatchAttempted,
        "dispatchAcknowledged": state.dispatchAcknowledged,
        "startedAt": state.startedAt,
        "finishedAt": ISO8601DateFormatter().string(from: Date()),
        "durationMs": Double(
            DispatchTime.now().uptimeNanoseconds - state.startedNanoseconds) / 1_000_000,
        "application": state.observation.map { observationMetadata($0)["application"] as Any }
            ?? NSNull(),
        "observation": try state.observation.map { try finalizedObservationMetadata($0) as Any }
            ?? NSNull(),
        "fields": fields,
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
func accessibilityFill(_ parameters: [String: Any]) async throws -> [String: Any] {
    let allowedKeys: Set<String> = [
        "processId", "expectedBundleIdentifier", "contentPolicy", "limits", "fields",
        "postcondition",
        "verificationTimeoutMs", "pollIntervalMs",
    ]
    guard Set(parameters.keys).isSubset(of: allowedKeys) else {
        throw SpikeError.invalidArguments("Accessibility fill contains unknown fields")
    }
    let fields = try parseSemanticFillFields(parameters)
    let postcondition = try SemanticConditionSet.parse(parameters, key: "postcondition")
    let verificationTimeoutMs = try optionalBoundedInt(
        parameters, key: "verificationTimeoutMs", default: 3_000, minimum: 0, maximum: 15_000)
    let pollIntervalMs = try optionalBoundedInt(
        parameters, key: "pollIntervalMs", default: 150, minimum: 50, maximum: 2_000)
    let policy = try AccessibilityContentPolicy.parse(parameters)

    var state = TransactionState(
        startedAt: ISO8601DateFormatter().string(from: Date()),
        startedNanoseconds: DispatchTime.now().uptimeNanoseconds)
    let observation = try observeAccessibility(parameters)
    state.observation = observation
    state.journal.record(.preDispatch, "resolved_observation")
    var results = fields.indices.map {
        [
            "index": $0,
            "target": NSNull(),
            "valueStatus": "not_evaluated",
            "reason": NSNull(),
        ] as [String: Any]
    }
    guard observation.complete else {
        return try fillResult(
            outcome: .notDispatched, phase: .preDispatch, state: state, fields: results,
            reasons: observation.reasons)
    }

    var resolved: [(field: SemanticFillField, node: AccessibilityNode, element: AXUIElement)] = []
    for (index, field) in fields.enumerated() {
        let matches = matchingAccessibilityNodes(
            observation: observation, predicate: field.predicate)
        guard matches.count == 1, let node = matches.first else {
            return try fillResult(
                outcome: .notDispatched, phase: .preDispatch, state: state, fields: results,
                reasons: [matches.isEmpty ? "field_\(index)_not_found" : "field_\(index)_ambiguous"]
            )
        }
        let fingerprint = accessibilityNodeFingerprint(node, observation: observation)
        results[index]["target"] = fillTargetJSON(node, fingerprint: fingerprint, policy: policy)
        if let expected = field.expectedFingerprint, expected != fingerprint {
            return try fillResult(
                outcome: .notDispatched, phase: .preDispatch, state: state, fields: results,
                reasons: ["field_\(index)_fingerprint_mismatch"])
        }
        guard node.enabled != false else {
            return try fillResult(
                outcome: .notDispatched, phase: .preDispatch, state: state, fields: results,
                reasons: ["field_\(index)_disabled"])
        }
        guard node.role != "AXSecureTextField", node.subrole != "AXSecureTextField",
            node.valueType == "string", let element = observation.elementsById[node.id],
            valueIsSettable(element)
        else {
            return try fillResult(
                outcome: .notDispatched, phase: .preDispatch, state: state, fields: results,
                reasons: ["field_\(index)_value_unsupported"])
        }
        resolved.append((field, node, element))
    }

    let fingerprints = Set(
        resolved.map { accessibilityNodeFingerprint($0.node, observation: observation) })
    guard fingerprints.count == resolved.count else {
        return try fillResult(
            outcome: .notDispatched, phase: .preDispatch, state: state, fields: results,
            reasons: ["field_targets_not_distinct"])
    }
    do {
        try requireControlSafetyController().requireInputEnabled()
    } catch {
        return try fillResult(
            outcome: .notDispatched, phase: .preDispatch, state: state, fields: results,
            reasons: ["control_disabled"])
    }

    do {
        try await requireControlSafetyController().withControlActivity {
            try requireActiveControl()
            state.dispatchAttempted = true
            state.journal.record(.dispatchAttempted, "dispatch_boundary")
            for (index, item) in resolved.enumerated() {
                let result = AXUIElementSetAttributeValue(
                    item.element, kAXValueAttribute as CFString, item.field.value as CFTypeRef)
                guard result == .success else {
                    throw SpikeError.actionFailed("field_\(index)_write_failed")
                }
                try await controlCheckpoint()
            }
        }
    } catch {
        return try fillResult(
            outcome: .indeterminate, phase: .dispatchAttempted, state: state, fields: results,
            reasons: [state.dispatchAttempted ? "fill_dispatch_interrupted" : "control_disabled"])
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
            return try fillResult(
                outcome: .indeterminate, phase: .verifying, state: state, fields: results,
                reasons: ["verification_observation_failed"])
        }
        state.postconditionPollCount += 1
        guard verifyObservation.processInstanceId == observation.processInstanceId else {
            state.postconditionStatus = "uncertain"
            return try fillResult(
                outcome: .indeterminate, phase: .verifying, state: state, fields: results,
                reasons: ["process_identity_changed"])
        }
        state.observation = verifyObservation
        var allValuesVerified = true
        for (index, item) in resolved.enumerated() {
            let matches = matchingAccessibilityNodes(
                observation: verifyObservation, predicate: item.field.predicate)
            guard matches.count == 1, let node = matches.first,
                let element = verifyObservation.elementsById[node.id]
            else {
                results[index]["valueStatus"] = "uncertain"
                results[index]["reason"] = "field_changed"
                allValuesVerified = false
                continue
            }
            var actual: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(
                element, kAXValueAttribute as CFString, &actual)
            if result != .success || !(actual as? String == item.field.value) {
                results[index]["valueStatus"] = result == .success ? "mismatch" : "uncertain"
                results[index]["reason"] =
                    result == .success ? "value_mismatch" : "value_unavailable"
                allValuesVerified = false
            } else {
                results[index]["valueStatus"] = "verified"
                results[index]["reason"] = NSNull()
            }
        }
        let condition = postcondition.evaluate(observation: verifyObservation)
        state.postconditionEvaluations = condition.evaluations
        if allValuesVerified
            && (verifyObservation.complete ? condition.satisfied : condition.satisfiedFromPartial)
        {
            state.postconditionStatus = "satisfied"
            state.journal.record(.complete, "postcondition_satisfied")
            return try fillResult(
                outcome: .verified, phase: .complete, state: state, fields: results, reasons: [])
        }
        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - verificationStart) / 1_000_000
        if elapsedMs >= Double(verificationTimeoutMs) {
            state.postconditionStatus = condition.uncertain ? "uncertain" : "unsatisfied"
            let reason =
                allValuesVerified
                ? (condition.uncertain
                    ? condition.reasons.first ?? "postcondition_uncertain"
                    : "postcondition_unsatisfied")
                : "field_value_unverified"
            return try fillResult(
                outcome: .indeterminate, phase: .verifying, state: state, fields: results,
                reasons: [reason])
        }
        let remainingMs = max(1, verificationTimeoutMs - Int(elapsedMs))
        try await Task.sleep(for: .milliseconds(min(pollIntervalMs, remainingMs)))
    }
}
