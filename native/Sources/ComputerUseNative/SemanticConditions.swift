import Foundation

private enum SemanticConditionKind: String {
    case element
    case window
}

private enum SemanticConditionState: String {
    case appears
    case disappears
    case enabled
    case focused
    case selected
    case expanded
}

private enum SemanticConditionComposition {
    case all
    case any
}

private struct SemanticAtomicCondition {
    let kind: SemanticConditionKind
    let state: SemanticConditionState
    let predicate: AccessibilityPredicate?
    let expectedValue: Bool?
    let windowTitle: String?
    let windowTitleMatch: AccessibilityNameMatch

    static func parse(_ value: [String: Any]) throws -> SemanticAtomicCondition {
        guard let kindValue = try optionalString(value, key: "kind"),
            let kind = SemanticConditionKind(rawValue: kindValue),
            let stateValue = try optionalString(value, key: "state"),
            let state = SemanticConditionState(rawValue: stateValue)
        else {
            throw SpikeError.invalidArguments("Condition kind or state is invalid")
        }

        switch kind {
        case .element:
            let allowedKeys: Set<String> = ["kind", "state", "target", "equals"]
            guard Set(value.keys).isSubset(of: allowedKeys) else {
                throw SpikeError.invalidArguments("Element condition contains unknown fields")
            }
            guard let target = value["target"] as? [String: Any] else {
                throw SpikeError.invalidArguments("Element conditions require a target")
            }
            let predicate = try AccessibilityPredicate.parse(["predicate": target])
            switch state {
            case .appears, .disappears:
                guard value["equals"] == nil else {
                    throw SpikeError.invalidArguments(
                        "Element appearance conditions must not include equals")
                }
                return SemanticAtomicCondition(
                    kind: kind, state: state, predicate: predicate, expectedValue: nil,
                    windowTitle: nil, windowTitleMatch: .normalized)
            case .enabled, .focused, .selected, .expanded:
                guard value["equals"] != nil else {
                    throw SpikeError.invalidArguments(
                        "Element state conditions require equals")
                }
                return SemanticAtomicCondition(
                    kind: kind, state: state, predicate: predicate,
                    expectedValue: try optionalBool(value, key: "equals", default: false),
                    windowTitle: nil, windowTitleMatch: .normalized)
            }

        case .window:
            let allowedKeys: Set<String> = ["kind", "state", "title", "titleMatch"]
            guard Set(value.keys).isSubset(of: allowedKeys) else {
                throw SpikeError.invalidArguments("Window condition contains unknown fields")
            }
            guard state == .appears || state == .disappears else {
                throw SpikeError.invalidArguments(
                    "Window conditions support only appears or disappears")
            }
            let matchValue = try optionalString(value, key: "titleMatch") ?? "normalized"
            guard let titleMatch = AccessibilityNameMatch(rawValue: matchValue) else {
                throw SpikeError.invalidArguments(
                    "Window titleMatch must be exact or normalized")
            }
            return SemanticAtomicCondition(
                kind: kind, state: state, predicate: nil, expectedValue: nil,
                windowTitle: try optionalString(value, key: "title"),
                windowTitleMatch: titleMatch)
        }
    }
}

struct SemanticConditionSet {
    private let composition: SemanticConditionComposition
    private let conditions: [SemanticAtomicCondition]

    static func parse(
        _ parameters: [String: Any], key: String = "condition"
    ) throws -> SemanticConditionSet {
        guard let value = parameters[key] as? [String: Any] else {
            throw SpikeError.invalidArguments("Missing \(key) object")
        }
        if let values = value["allOf"] as? [[String: Any]] {
            guard value.count == 1, !values.isEmpty, values.count <= 8 else {
                throw SpikeError.invalidArguments("allOf must contain between 1 and 8 conditions")
            }
            return SemanticConditionSet(
                composition: .all, conditions: try values.map(SemanticAtomicCondition.parse))
        }
        if let values = value["anyOf"] as? [[String: Any]] {
            guard value.count == 1, !values.isEmpty, values.count <= 8 else {
                throw SpikeError.invalidArguments("anyOf must contain between 1 and 8 conditions")
            }
            return SemanticConditionSet(
                composition: .any, conditions: try values.map(SemanticAtomicCondition.parse))
        }
        return SemanticConditionSet(
            composition: .all, conditions: [try SemanticAtomicCondition.parse(value)])
    }
}

private enum SemanticEvaluationStatus: String {
    case satisfied
    case unsatisfied
    case uncertain
}

private struct SemanticConditionEvaluation {
    let index: Int
    let kind: SemanticConditionKind
    let state: SemanticConditionState
    let status: SemanticEvaluationStatus
    let matchCount: Int
    let observedValue: Bool?
    let reason: String?

    var json: [String: Any] {
        [
            "index": index,
            "kind": kind.rawValue,
            "state": state.rawValue,
            "status": status.rawValue,
            "matchCount": matchCount,
            "observedValue": observedValue.map { $0 as Any } ?? NSNull(),
            "reason": reason.map { $0 as Any } ?? NSNull(),
        ]
    }
}

private func elementBooleanValue(
    _ node: AccessibilityNode, state: SemanticConditionState
) -> Bool? {
    switch state {
    case .enabled: return node.enabled
    case .focused: return node.focused
    case .selected: return node.selected
    case .expanded: return node.expanded
    case .appears, .disappears: return nil
    }
}

private func evaluateCondition(
    _ condition: SemanticAtomicCondition, index: Int,
    observation: AccessibilityObservation
) -> SemanticConditionEvaluation {
    switch condition.kind {
    case .element:
        guard let predicate = condition.predicate else {
            return SemanticConditionEvaluation(
                index: index, kind: condition.kind, state: condition.state,
                status: .uncertain, matchCount: 0, observedValue: nil,
                reason: "invalid_condition")
        }
        let matches = matchingAccessibilityNodes(
            observation: observation, predicate: predicate)
        if condition.state == .appears || condition.state == .disappears {
            let exists = !matches.isEmpty
            let satisfied = condition.state == .appears ? exists : !exists
            return SemanticConditionEvaluation(
                index: index, kind: condition.kind, state: condition.state,
                status: satisfied ? .satisfied : .unsatisfied,
                matchCount: matches.count, observedValue: exists, reason: nil)
        }
        guard matches.count <= 1 else {
            return SemanticConditionEvaluation(
                index: index, kind: condition.kind, state: condition.state,
                status: .uncertain, matchCount: matches.count, observedValue: nil,
                reason: "element_ambiguous")
        }
        guard let match = matches.first else {
            return SemanticConditionEvaluation(
                index: index, kind: condition.kind, state: condition.state,
                status: .unsatisfied, matchCount: 0, observedValue: nil, reason: nil)
        }
        guard let observed = elementBooleanValue(match, state: condition.state),
            let expected = condition.expectedValue
        else {
            return SemanticConditionEvaluation(
                index: index, kind: condition.kind, state: condition.state,
                status: .uncertain, matchCount: 1, observedValue: nil,
                reason: "attribute_unavailable")
        }
        return SemanticConditionEvaluation(
            index: index, kind: condition.kind, state: condition.state,
            status: observed == expected ? .satisfied : .unsatisfied,
            matchCount: 1, observedValue: observed, reason: nil)

    case .window:
        let matches = observation.nodes.filter { node in
            guard node.role == "AXWindow" else { return false }
            guard let expectedTitle = condition.windowTitle else { return true }
            guard let observedTitle = node.title else { return false }
            return accessibilityNamesMatch(
                [observedTitle], expected: expectedTitle, match: condition.windowTitleMatch)
        }
        let exists = !matches.isEmpty
        let satisfied = condition.state == .appears ? exists : !exists
        return SemanticConditionEvaluation(
            index: index, kind: condition.kind, state: condition.state,
            status: satisfied ? .satisfied : .unsatisfied,
            matchCount: matches.count, observedValue: exists, reason: nil)
    }
}

extension SemanticConditionSet {
    fileprivate func satisfied(_ evaluations: [SemanticConditionEvaluation]) -> Bool {
        switch composition {
        case .all:
            return evaluations.allSatisfy { $0.status == .satisfied }
        case .any:
            return evaluations.contains { $0.status == .satisfied }
        }
    }

    fileprivate func satisfiedFromPartialObservation(
        _ evaluations: [SemanticConditionEvaluation]
    ) -> Bool {
        let positiveAppearances = zip(conditions, evaluations).map { condition, evaluation in
            condition.state == .appears && evaluation.status == .satisfied
                && evaluation.observedValue == true
        }
        switch composition {
        case .all:
            return positiveAppearances.allSatisfy { $0 }
        case .any:
            return positiveAppearances.contains(true)
        }
    }

    fileprivate func uncertain(_ evaluations: [SemanticConditionEvaluation]) -> Bool {
        switch composition {
        case .all:
            return !evaluations.contains { $0.status == .unsatisfied }
                && evaluations.contains { $0.status == .uncertain }
        case .any:
            return !evaluations.contains { $0.status == .satisfied }
                && evaluations.contains { $0.status == .uncertain }
        }
    }

    fileprivate var atomicConditions: [SemanticAtomicCondition] { conditions }
}

struct SemanticConditionOutcome {
    let satisfied: Bool
    let satisfiedFromPartial: Bool
    let uncertain: Bool
    let evaluations: [[String: Any]]
    let reasons: [String]

    static var notEvaluated: SemanticConditionOutcome {
        SemanticConditionOutcome(
            satisfied: false, satisfiedFromPartial: false, uncertain: false,
            evaluations: [], reasons: [])
    }
}

extension SemanticConditionSet {
    func evaluate(observation: AccessibilityObservation) -> SemanticConditionOutcome {
        let evaluations = atomicConditions.enumerated().map { index, condition in
            evaluateCondition(condition, index: index, observation: observation)
        }
        return SemanticConditionOutcome(
            satisfied: satisfied(evaluations),
            satisfiedFromPartial: satisfiedFromPartialObservation(evaluations),
            uncertain: uncertain(evaluations),
            evaluations: evaluations.map(\.json),
            reasons: Array(Set(evaluations.compactMap(\.reason))).sorted())
    }
}

private func waitDurationMs(since startedNanoseconds: UInt64) -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - startedNanoseconds) / 1_000_000
}

private func waitResult(
    status: String, startedAt: String, startedNanoseconds: UInt64,
    pollCount: Int, application: AccessibilityObservation,
    observation: AccessibilityObservation?, evaluations: [[String: Any]],
    reasons: [String]
) throws -> [String: Any] {
    [
        "schemaVersion": 1,
        "status": status,
        "startedAt": startedAt,
        "finishedAt": ISO8601DateFormatter().string(from: Date()),
        "durationMs": waitDurationMs(since: startedNanoseconds),
        "pollCount": pollCount,
        "application": observationMetadata(application)["application"] as Any,
        "observation": try observation.map { try finalizedObservationMetadata($0) as Any }
            ?? NSNull(),
        "evaluations": evaluations,
        "reasons": reasons,
    ]
}

@MainActor
func accessibilityWait(_ parameters: [String: Any]) async throws -> [String: Any] {
    let allowedKeys: Set<String> = [
        "processId", "expectedBundleIdentifier", "contentPolicy", "limits", "condition",
        "timeoutMs", "pollIntervalMs",
    ]
    guard Set(parameters.keys).isSubset(of: allowedKeys) else {
        throw SpikeError.invalidArguments("Accessibility wait contains unknown fields")
    }
    let conditionSet = try SemanticConditionSet.parse(parameters)
    let timeoutMs = try optionalBoundedInt(
        parameters, key: "timeoutMs", default: 10_000, minimum: 0, maximum: 30_000)
    let pollIntervalMs = try optionalBoundedInt(
        parameters, key: "pollIntervalMs", default: 250, minimum: 50, maximum: 2_000)
    let startedNanoseconds = DispatchTime.now().uptimeNanoseconds
    let startedAt = ISO8601DateFormatter().string(from: Date())
    var pollCount = 0
    var initialObservation: AccessibilityObservation?
    var lastObservation: AccessibilityObservation?
    var lastOutcome = SemanticConditionOutcome.notEvaluated

    while true {
        do {
            let observation = try observeAccessibility(parameters)
            pollCount += 1
            if let initialObservation,
                initialObservation.processInstanceId != observation.processInstanceId
            {
                return try waitResult(
                    status: "uncertain", startedAt: startedAt,
                    startedNanoseconds: startedNanoseconds, pollCount: pollCount,
                    application: initialObservation, observation: nil,
                    evaluations: [], reasons: ["process_identity_changed"])
            }
            if initialObservation == nil { initialObservation = observation }
            lastObservation = observation

            let outcome = conditionSet.evaluate(observation: observation)
            lastOutcome = outcome
            // Positive existence is authoritative even when unrelated branches were
            // truncated. Absence and unique-state conditions still require a complete tree.
            if observation.complete ? outcome.satisfied : outcome.satisfiedFromPartial {
                return try waitResult(
                    status: "satisfied", startedAt: startedAt,
                    startedNanoseconds: startedNanoseconds, pollCount: pollCount,
                    application: initialObservation ?? observation, observation: observation,
                    evaluations: outcome.evaluations, reasons: [])
            }
            guard observation.complete else {
                return try waitResult(
                    status: "uncertain", startedAt: startedAt,
                    startedNanoseconds: startedNanoseconds, pollCount: pollCount,
                    application: initialObservation ?? observation, observation: observation,
                    evaluations: outcome.evaluations, reasons: observation.reasons)
            }

        } catch let targetError as SpikeError {
            guard case .targetNotFound = targetError else { throw targetError }
            guard let initialObservation else { throw targetError }
            return try waitResult(
                status: "uncertain", startedAt: startedAt,
                startedNanoseconds: startedNanoseconds, pollCount: pollCount,
                application: initialObservation, observation: nil,
                evaluations: [], reasons: ["process_identity_changed"])
        }

        let elapsedMs = waitDurationMs(since: startedNanoseconds)
        if elapsedMs >= Double(timeoutMs) {
            guard let initialObservation else {
                throw SpikeError.actionFailed("Wait completed without an AX observation")
            }
            if lastOutcome.uncertain {
                return try waitResult(
                    status: "uncertain", startedAt: startedAt,
                    startedNanoseconds: startedNanoseconds, pollCount: pollCount,
                    application: initialObservation, observation: lastObservation,
                    evaluations: lastOutcome.evaluations, reasons: lastOutcome.reasons)
            }
            return try waitResult(
                status: "timed_out", startedAt: startedAt,
                startedNanoseconds: startedNanoseconds, pollCount: pollCount,
                application: initialObservation, observation: lastObservation,
                evaluations: lastOutcome.evaluations, reasons: ["timeout"])
        }
        let remainingMs = max(1, timeoutMs - Int(elapsedMs))
        try await Task.sleep(for: .milliseconds(min(pollIntervalMs, remainingMs)))
    }
}
