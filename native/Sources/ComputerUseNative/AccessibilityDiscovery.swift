import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation

struct AccessibilityLimits {
    let deadlineMs: Int
    let messageTimeoutMs: Int
    let maxDepth: Int
    let maxNodes: Int
    let maxChildren: Int
    let maxStringLength: Int
    let maxResultBytes: Int

    static func parse(_ parameters: [String: Any]) throws -> AccessibilityLimits {
        let values = parameters["limits"] as? [String: Any] ?? [:]
        return AccessibilityLimits(
            deadlineMs: try optionalBoundedInt(
                values, key: "deadlineMs", default: 1_500, minimum: 100, maximum: 3_000),
            messageTimeoutMs: try optionalBoundedInt(
                values, key: "messageTimeoutMs", default: 100, minimum: 10, maximum: 250),
            maxDepth: try optionalBoundedInt(
                values, key: "maxDepth", default: 12, minimum: 1, maximum: 20),
            maxNodes: try optionalBoundedInt(
                values, key: "maxNodes", default: 1_000, minimum: 1, maximum: 2_500),
            maxChildren: try optionalBoundedInt(
                values, key: "maxChildren", default: 100, minimum: 1, maximum: 250),
            maxStringLength: try optionalBoundedInt(
                values, key: "maxStringLength", default: 512, minimum: 1, maximum: 2_048),
            maxResultBytes: try optionalBoundedInt(
                values, key: "maxResultBytes", default: 1_048_576, minimum: 16_384,
                maximum: 2_097_152))
    }
}

enum AccessibilityContentPolicy: String {
    case fixture
    case matched
    case redacted

    static func parse(_ parameters: [String: Any]) throws -> AccessibilityContentPolicy {
        let value = try optionalString(parameters, key: "contentPolicy") ?? "redacted"
        guard let policy = AccessibilityContentPolicy(rawValue: value) else {
            throw SpikeError.invalidArguments(
                "Parameter 'contentPolicy' must be 'fixture', 'matched', or 'redacted'")
        }
        return policy
    }
}

struct AccessibilityNode {
    let id: String
    let parentId: String?
    let depth: Int
    let childIndex: Int
    let role: String?
    let subrole: String?
    let title: String?
    let names: [String]
    let frame: CGRect?
    let actions: [String]
    let enabled: Bool?
    let focused: Bool?
    let selected: Bool?
    let expanded: Bool?
    let visible: Bool?
    let valueType: String?
    let attributeStatus: [String: String]

    fileprivate func json(policy: AccessibilityContentPolicy) -> [String: Any] {
        var value: [String: Any] = [
            "id": id,
            "parentId": parentId ?? NSNull(),
            "depth": depth,
            "childIndex": childIndex,
            "role": role ?? NSNull(),
            "subrole": subrole ?? NSNull(),
            "names": names.map { exposedText($0, policy: policy) },
            "frame": frame.map(rectJSON) ?? NSNull(),
            "actions": actions,
            "enabled": enabled ?? NSNull(),
            "focused": focused ?? NSNull(),
            "selected": selected ?? NSNull(),
            "expanded": expanded ?? NSNull(),
            "visible": visible ?? NSNull(),
            "valueType": valueType ?? NSNull(),
        ]
        if !attributeStatus.isEmpty {
            value["attributeStatus"] = attributeStatus
        }
        return value
    }
}

struct AccessibilityObservation {
    let observationId: String
    let observedAtStart: String
    let observedAtEnd: String
    let durationMs: Double
    let processId: pid_t
    let processInstanceId: String
    let bundleIdentifier: String
    let launchDate: String?
    let nodes: [AccessibilityNode]
    let elementsById: [String: AXUIElement]
    let complete: Bool
    let reasons: [String]
    let nodesVisited: Int
    let axCalls: Int
    let errorsByCategory: [String: Int]
    let limits: AccessibilityLimits
}

private struct PendingAccessibilityNode {
    let element: AXUIElement
    let parentId: String?
    let depth: Int
    let childIndex: Int
}

private final class AccessibilityTraversalState {
    let limits: AccessibilityLimits
    let policy: AccessibilityContentPolicy
    let startedNanoseconds: UInt64
    var nodes: [AccessibilityNode] = []
    var elementsById: [String: AXUIElement] = [:]
    var nodesVisited = 0
    var axCalls = 0
    var reasons = Set<String>()
    var errorsByCategory: [String: Int] = [:]
    private var visitedByHash: [CFHashCode: [AXUIElement]] = [:]

    init(limits: AccessibilityLimits, policy: AccessibilityContentPolicy) {
        self.limits = limits
        self.policy = policy
        startedNanoseconds = DispatchTime.now().uptimeNanoseconds
    }

    var elapsedMs: Double {
        Double(DispatchTime.now().uptimeNanoseconds - startedNanoseconds) / 1_000_000
    }

    var deadlineExceeded: Bool { elapsedMs >= Double(limits.deadlineMs) }

    func markVisited(_ element: AXUIElement) -> Bool {
        let hash = CFHash(element)
        if visitedByHash[hash]?.contains(where: { CFEqual($0, element) }) == true {
            return false
        }
        visitedByHash[hash, default: []].append(element)
        return true
    }

    func record(_ error: AXError, traversalCritical: Bool = false) {
        let category = accessibilityErrorCategory(error)
        errorsByCategory[category, default: 0] += 1
        if traversalCritical, error != .attributeUnsupported, error != .noValue {
            reasons.insert("ax_error")
        }
    }
}

private func accessibilityErrorCategory(_ error: AXError) -> String {
    switch error {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegal_argument"
    case .invalidUIElement: return "invalid_element"
    case .invalidUIElementObserver: return "invalid_observer"
    case .cannotComplete: return "cannot_complete"
    case .attributeUnsupported: return "attribute_unsupported"
    case .actionUnsupported: return "action_unsupported"
    case .notificationUnsupported: return "notification_unsupported"
    case .notImplemented: return "not_implemented"
    case .notificationAlreadyRegistered: return "notification_already_registered"
    case .notificationNotRegistered: return "notification_not_registered"
    case .apiDisabled: return "api_disabled"
    case .noValue: return "no_value"
    case .parameterizedAttributeUnsupported: return "parameterized_attribute_unsupported"
    case .notEnoughPrecision: return "not_enough_precision"
    @unknown default: return "unknown_\(error.rawValue)"
    }
}

private func requiredAccessibilityProcessId(_ parameters: [String: Any]) throws -> pid_t {
    guard let processId = try optionalProcessId(parameters, key: "processId") else {
        throw SpikeError.invalidArguments("Missing processId")
    }
    return processId
}

private func accessibilityProcessInstanceId(_ processId: pid_t) throws -> String {
    var info = proc_bsdinfo()
    let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    let bytesRead = withUnsafeMutablePointer(to: &info) { pointer in
        proc_pidinfo(processId, PROC_PIDTBSDINFO, 0, pointer, expectedSize)
    }
    guard bytesRead == expectedSize, info.pbi_start_tvsec > 0 else {
        throw SpikeError.targetNotFound(
            "Could not establish process-start identity for application process \(processId)")
    }
    let identity = "\(processId):\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
    let digest = SHA256.hash(data: Data(identity.utf8))
        .map { String(format: "%02x", $0) }
        .joined()
    return "sha256:\(digest)"
}

private func optionalStringArray(
    _ parameters: [String: Any], key: String, maximumCount: Int
) throws -> [String]? {
    guard parameters[key] != nil else { return nil }
    return try requiredStringArray(
        parameters, key: key, minimumCount: 1, maximumCount: maximumCount)
}

private func boundedString(_ value: CFTypeRef?, limit: Int) -> String? {
    guard let string = value as? String else { return nil }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return String(trimmed.prefix(limit))
}

func exposedText(_ value: String, policy: AccessibilityContentPolicy) -> String {
    guard policy == .redacted else { return value }
    return
        "sha256:\(SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined())"
}

private func copyAttribute(
    _ element: AXUIElement, _ attribute: String, state: AccessibilityTraversalState,
    traversalCritical: Bool = false
) -> (CFTypeRef?, String?) {
    state.axCalls += 1
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else {
        state.record(result, traversalCritical: traversalCritical)
        return (nil, accessibilityErrorCategory(result))
    }
    return (value, nil)
}

private func copyStringAttribute(
    _ element: AXUIElement, _ attribute: String, state: AccessibilityTraversalState,
    statusKey: String, statuses: inout [String: String]
) -> String? {
    let (value, error) = copyAttribute(element, attribute, state: state)
    if let error { statuses[statusKey] = error }
    guard let value else { return nil }
    guard let string = boundedString(value, limit: state.limits.maxStringLength) else {
        statuses[statusKey] = "type_mismatch_or_empty"
        return nil
    }
    return string
}

private func copyBoolAttribute(
    _ element: AXUIElement, _ attribute: String, state: AccessibilityTraversalState,
    statusKey: String, statuses: inout [String: String]
) -> Bool? {
    let (value, error) = copyAttribute(element, attribute, state: state)
    if let error { statuses[statusKey] = error }
    guard let value else { return nil }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((value as! CFBoolean))
    }
    if let number = value as? NSNumber { return number.boolValue }
    statuses[statusKey] = "type_mismatch"
    return nil
}

private func copyPointAttribute(
    _ element: AXUIElement, _ attribute: String, state: AccessibilityTraversalState,
    statusKey: String, statuses: inout [String: String]
) -> CGPoint? {
    let (value, error) = copyAttribute(element, attribute, state: state)
    if let error { statuses[statusKey] = error }
    guard let value else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else {
        statuses[statusKey] = "type_mismatch"
        return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else {
        statuses[statusKey] = "type_mismatch"
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(axValue, .cgPoint, &point) else {
        statuses[statusKey] = "decode_failed"
        return nil
    }
    return point
}

private func copySizeAttribute(
    _ element: AXUIElement, _ attribute: String, state: AccessibilityTraversalState,
    statusKey: String, statuses: inout [String: String]
) -> CGSize? {
    let (value, error) = copyAttribute(element, attribute, state: state)
    if let error { statuses[statusKey] = error }
    guard let value else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else {
        statuses[statusKey] = "type_mismatch"
        return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else {
        statuses[statusKey] = "type_mismatch"
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(axValue, .cgSize, &size) else {
        statuses[statusKey] = "decode_failed"
        return nil
    }
    return size
}

private func copyActions(
    _ element: AXUIElement, state: AccessibilityTraversalState,
    statuses: inout [String: String]
) -> [String] {
    state.axCalls += 1
    var names: CFArray?
    let result = AXUIElementCopyActionNames(element, &names)
    guard result == .success else {
        state.record(result)
        statuses["actions"] = accessibilityErrorCategory(result)
        return []
    }
    return (names as? [String] ?? []).sorted()
}

private func valueType(
    _ element: AXUIElement, role: String?, subrole: String?, state: AccessibilityTraversalState,
    statuses: inout [String: String]
) -> String? {
    if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
        statuses["value"] = "secure_value_omitted"
        return "secure_text"
    }
    let (value, error) = copyAttribute(element, kAXValueAttribute, state: state)
    if let error { statuses["value"] = error }
    guard let value else { return nil }
    if value is String { return "string" }
    if CFGetTypeID(value) == CFBooleanGetTypeID() { return "boolean" }
    if value is NSNumber { return "number" }
    if value is [Any] { return "array" }
    if CFGetTypeID(value) == AXValueGetTypeID() { return "ax_value" }
    return "other"
}

private func inspectAccessibilityNode(
    _ pending: PendingAccessibilityNode, id: String, state: AccessibilityTraversalState
) -> AccessibilityNode {
    var statuses: [String: String] = [:]
    let role = copyStringAttribute(
        pending.element, kAXRoleAttribute, state: state, statusKey: "role", statuses: &statuses)
    let subrole = copyStringAttribute(
        pending.element, kAXSubroleAttribute, state: state, statusKey: "subrole",
        statuses: &statuses)
    let title = copyStringAttribute(
        pending.element, kAXTitleAttribute, state: state, statusKey: "title", statuses: &statuses)
    let description = copyStringAttribute(
        pending.element, kAXDescriptionAttribute, state: state, statusKey: "description",
        statuses: &statuses)
    let help = copyStringAttribute(
        pending.element, kAXHelpAttribute, state: state, statusKey: "help", statuses: &statuses)
    let placeholder = copyStringAttribute(
        pending.element, kAXPlaceholderValueAttribute, state: state, statusKey: "placeholder",
        statuses: &statuses)
    let identifier = copyStringAttribute(
        pending.element, kAXIdentifierAttribute, state: state, statusKey: "identifier",
        statuses: &statuses)
    let position = copyPointAttribute(
        pending.element, kAXPositionAttribute, state: state, statusKey: "position",
        statuses: &statuses)
    let size = copySizeAttribute(
        pending.element, kAXSizeAttribute, state: state, statusKey: "size", statuses: &statuses)
    let frame: CGRect?
    if let position, let size,
        position.x.isFinite, position.y.isFinite,
        size.width.isFinite, size.height.isFinite,
        size.width >= 0, size.height >= 0
    {
        frame = CGRect(origin: position, size: size)
    } else {
        if position != nil, size != nil { statuses["frame"] = "invalid_geometry" }
        frame = nil
    }
    let names = [title, description, help, placeholder, identifier].compactMap { $0 }
        .reduce(into: [String]()) { values, candidate in
            if !values.contains(candidate) { values.append(candidate) }
        }

    return AccessibilityNode(
        id: id,
        parentId: pending.parentId,
        depth: pending.depth,
        childIndex: pending.childIndex,
        role: role,
        subrole: subrole,
        title: title,
        names: names,
        frame: frame,
        actions: copyActions(pending.element, state: state, statuses: &statuses),
        enabled: copyBoolAttribute(
            pending.element, kAXEnabledAttribute, state: state, statusKey: "enabled",
            statuses: &statuses),
        focused: copyBoolAttribute(
            pending.element, kAXFocusedAttribute, state: state, statusKey: "focused",
            statuses: &statuses),
        selected: copyBoolAttribute(
            pending.element, kAXSelectedAttribute, state: state, statusKey: "selected",
            statuses: &statuses),
        expanded: copyBoolAttribute(
            pending.element, kAXExpandedAttribute, state: state, statusKey: "expanded",
            statuses: &statuses),
        visible: copyBoolAttribute(
            pending.element, "AXVisible", state: state, statusKey: "visible", statuses: &statuses),
        valueType: valueType(
            pending.element, role: role, subrole: subrole, state: state, statuses: &statuses),
        attributeStatus: statuses)
}

private func copyChildren(
    _ element: AXUIElement, state: AccessibilityTraversalState
) -> [AXUIElement] {
    state.axCalls += 1
    var count: CFIndex = 0
    let countResult = AXUIElementGetAttributeValueCount(
        element, kAXChildrenAttribute as CFString, &count)
    if countResult == .attributeUnsupported || countResult == .noValue { return [] }
    guard countResult == .success else {
        state.record(countResult, traversalCritical: true)
        return []
    }
    guard count > 0 else { return [] }
    let requested = min(Int(count), state.limits.maxChildren + 1)
    state.axCalls += 1
    var values: CFArray?
    let copyResult = AXUIElementCopyAttributeValues(
        element, kAXChildrenAttribute as CFString, 0, requested, &values)
    guard copyResult == .success else {
        state.record(copyResult, traversalCritical: true)
        return []
    }
    let children = values as? [AXUIElement] ?? []
    if count > state.limits.maxChildren || children.count > state.limits.maxChildren {
        state.reasons.insert("child_limit")
    }
    return Array(children.prefix(state.limits.maxChildren))
}

@MainActor
func observeAccessibility(_ parameters: [String: Any]) throws -> AccessibilityObservation {
    guard AXIsProcessTrusted() else {
        throw SpikeError.permissionDenied("Accessibility permission is required for AX discovery")
    }
    let processId = try requiredAccessibilityProcessId(parameters)
    guard let application = NSRunningApplication(processIdentifier: processId),
        !application.isTerminated
    else {
        throw SpikeError.targetNotFound("Application process \(processId) is not running")
    }
    if let expected = try optionalString(parameters, key: "expectedBundleIdentifier"),
        application.bundleIdentifier != expected
    {
        throw SpikeError.targetNotFound("Application bundle identifier changed")
    }
    let processInstanceId = try accessibilityProcessInstanceId(processId)
    let limits = try AccessibilityLimits.parse(parameters)
    let policy = try AccessibilityContentPolicy.parse(parameters)
    let state = AccessibilityTraversalState(limits: limits, policy: policy)
    let appElement = AXUIElementCreateApplication(processId)
    AXUIElementSetMessagingTimeout(appElement, Float(limits.messageTimeoutMs) / 1_000)
    defer { AXUIElementSetMessagingTimeout(appElement, 0) }

    let observedAtStart = ISO8601DateFormatter().string(from: Date())
    var queue = [
        PendingAccessibilityNode(
            element: appElement, parentId: nil, depth: 0, childIndex: 0)
    ]
    var queueIndex = 0

    while queueIndex < queue.count {
        let pending = queue[queueIndex]
        queueIndex += 1
        guard state.markVisited(pending.element) else { continue }
        if state.deadlineExceeded {
            state.reasons.insert("deadline")
            break
        }
        if state.nodesVisited >= limits.maxNodes {
            state.reasons.insert("node_limit")
            break
        }
        state.nodesVisited += 1
        let id = "n\(state.nodes.count)"
        state.nodes.append(inspectAccessibilityNode(pending, id: id, state: state))
        state.elementsById[id] = pending.element

        if pending.depth >= limits.maxDepth {
            let children = copyChildren(pending.element, state: state)
            if !children.isEmpty { state.reasons.insert("depth_limit") }
            continue
        }
        let children = copyChildren(pending.element, state: state)
        for (index, child) in children.enumerated() {
            queue.append(
                PendingAccessibilityNode(
                    element: child, parentId: id, depth: pending.depth + 1, childIndex: index))
        }
    }

    guard try accessibilityProcessInstanceId(processId) == processInstanceId else {
        throw SpikeError.targetNotFound("Application process identity changed during AX discovery")
    }
    let observedAtEnd = ISO8601DateFormatter().string(from: Date())
    return AccessibilityObservation(
        observationId: UUID().uuidString.lowercased(),
        observedAtStart: observedAtStart,
        observedAtEnd: observedAtEnd,
        durationMs: state.elapsedMs,
        processId: processId,
        processInstanceId: processInstanceId,
        bundleIdentifier: application.bundleIdentifier ?? "",
        launchDate: application.launchDate.map { ISO8601DateFormatter().string(from: $0) },
        nodes: state.nodes,
        elementsById: state.elementsById,
        complete: state.reasons.isEmpty,
        reasons: state.reasons.sorted(),
        nodesVisited: state.nodesVisited,
        axCalls: state.axCalls,
        errorsByCategory: state.errorsByCategory,
        limits: limits)
}

func observationMetadata(_ observation: AccessibilityObservation) -> [String: Any] {
    [
        "schemaVersion": 1,
        "observationId": observation.observationId,
        "source": "accessibility",
        "observedAtStart": observation.observedAtStart,
        "observedAtEnd": observation.observedAtEnd,
        "application": [
            "processId": observation.processId,
            "processInstanceId": observation.processInstanceId,
            "bundleIdentifier": observation.bundleIdentifier,
            "launchDate": observation.launchDate.map { $0 as Any } ?? NSNull(),
        ],
        "consistency": "best_effort",
        "completion": [
            "status": observation.complete ? "complete" : "partial",
            "reasons": observation.reasons,
        ],
        "metrics": [
            "durationMs": observation.durationMs,
            "nodesVisited": observation.nodesVisited,
            "nodesReturned": observation.nodes.count,
            "axCalls": observation.axCalls,
            "errorsByCategory": observation.errorsByCategory,
        ],
        "limits": [
            "deadlineMs": observation.limits.deadlineMs,
            "messageTimeoutMs": observation.limits.messageTimeoutMs,
            "maxDepth": observation.limits.maxDepth,
            "maxNodes": observation.limits.maxNodes,
            "maxChildren": observation.limits.maxChildren,
            "maxStringLength": observation.limits.maxStringLength,
            "maxResultBytes": observation.limits.maxResultBytes,
        ],
    ]
}

private func serializedSize(_ value: [String: Any]) throws -> Int {
    try JSONSerialization.data(withJSONObject: value).count
}

private func updateSerializedSize(_ value: inout [String: Any]) throws -> Int {
    guard var metrics = value["metrics"] as? [String: Any] else {
        return try serializedSize(value)
    }
    var candidate = 0
    for _ in 0..<8 {
        metrics["serializedBytes"] = candidate
        value["metrics"] = metrics
        let actual = try serializedSize(value)
        if actual == candidate { return actual }
        candidate = actual
    }
    throw SpikeError.actionFailed("Accessibility result size did not stabilize")
}

func finalizedObservationMetadata(_ observation: AccessibilityObservation) throws -> [String: Any] {
    var result = observationMetadata(observation)
    _ = try updateSerializedSize(&result)
    return result
}

@MainActor
func accessibilitySnapshot(_ parameters: [String: Any]) throws -> [String: Any] {
    let policy = try AccessibilityContentPolicy.parse(parameters)
    guard policy != .matched else {
        throw SpikeError.invalidArguments(
            "contentPolicy 'matched' is supported only by accessibility.query")
    }
    let observation = try observeAccessibility(parameters)
    var nodes = observation.nodes.map { $0.json(policy: policy) }
    var reasons = observation.reasons
    var complete = observation.complete
    var result = observationMetadata(observation)
    result["nodes"] = nodes

    while try updateSerializedSize(&result) > observation.limits.maxResultBytes {
        guard !nodes.isEmpty else {
            throw SpikeError.actionFailed("Accessibility result could not fit the byte limit")
        }
        nodes.removeLast()
        complete = false
        if !reasons.contains("byte_limit") { reasons.append("byte_limit") }
        result["nodes"] = nodes
        result["completion"] = ["status": "partial", "reasons": reasons.sorted()]
        if var metrics = result["metrics"] as? [String: Any] {
            metrics["nodesReturned"] = nodes.count
            result["metrics"] = metrics
        }
    }
    if !complete {
        result["completion"] = ["status": "partial", "reasons": reasons.sorted()]
        _ = try updateSerializedSize(&result)
    }
    return result
}

enum AccessibilityNameMatch: String {
    case exact
    case normalized
}

struct AccessibilityAncestorPredicate {
    let roles: Set<String>?
    let name: String?
    let nameMatch: AccessibilityNameMatch
}

struct AccessibilityPredicate {
    let roles: Set<String>?
    let name: String?
    let nameMatch: AccessibilityNameMatch
    let requiredActions: Set<String>
    let enabled: Bool?
    let ancestor: AccessibilityAncestorPredicate?

    static func parse(_ parameters: [String: Any]) throws -> AccessibilityPredicate {
        guard let value = parameters["predicate"] as? [String: Any] else {
            throw SpikeError.invalidArguments("Missing predicate object")
        }
        let allowedKeys: Set<String> = [
            "roles", "name", "nameMatch", "requiredActions", "enabled", "ancestor",
        ]
        guard Set(value.keys).isSubset(of: allowedKeys) else {
            throw SpikeError.invalidArguments("Predicate contains unknown fields")
        }
        let roles = try optionalStringArray(value, key: "roles", maximumCount: 16).map(Set.init)
        let name = try optionalString(value, key: "name")
        let matchValue = try optionalString(value, key: "nameMatch") ?? "normalized"
        guard let nameMatch = AccessibilityNameMatch(rawValue: matchValue) else {
            throw SpikeError.invalidArguments("nameMatch must be 'exact' or 'normalized'")
        }
        let requiredActions = Set(
            try optionalStringArray(value, key: "requiredActions", maximumCount: 16) ?? [])
        let enabled: Bool?
        if value["enabled"] == nil {
            enabled = nil
        } else {
            enabled = try optionalBool(value, key: "enabled", default: false)
        }
        let ancestor: AccessibilityAncestorPredicate?
        if value["ancestor"] != nil && value["ancestor"] as? [String: Any] == nil {
            throw SpikeError.invalidArguments("Ancestor predicate must be an object")
        }
        if let ancestorValue = value["ancestor"] as? [String: Any] {
            let allowedAncestorKeys: Set<String> = ["roles", "name", "nameMatch"]
            guard Set(ancestorValue.keys).isSubset(of: allowedAncestorKeys) else {
                throw SpikeError.invalidArguments("Ancestor predicate contains unknown fields")
            }
            let ancestorRoles = try optionalStringArray(
                ancestorValue, key: "roles", maximumCount: 16
            ).map(Set.init)
            let ancestorName = try optionalString(ancestorValue, key: "name")
            let ancestorMatchValue =
                try optionalString(
                    ancestorValue, key: "nameMatch") ?? "normalized"
            guard let ancestorMatch = AccessibilityNameMatch(rawValue: ancestorMatchValue) else {
                throw SpikeError.invalidArguments(
                    "ancestor.nameMatch must be 'exact' or 'normalized'")
            }
            guard ancestorRoles != nil || ancestorName != nil else {
                throw SpikeError.invalidArguments("ancestor predicate must constrain role or name")
            }
            ancestor = AccessibilityAncestorPredicate(
                roles: ancestorRoles, name: ancestorName, nameMatch: ancestorMatch)
        } else {
            ancestor = nil
        }
        guard roles != nil || name != nil || !requiredActions.isEmpty || enabled != nil else {
            throw SpikeError.invalidArguments("predicate must include at least one constraint")
        }
        return AccessibilityPredicate(
            roles: roles, name: name, nameMatch: nameMatch,
            requiredActions: requiredActions, enabled: enabled, ancestor: ancestor)
    }
}

func normalizedAccessibilityName(_ value: String) -> String {
    value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        .map(String.init)
        .joined(separator: " ")
        .lowercased()
}

func accessibilityNamesMatch(
    _ names: [String], expected: String, match: AccessibilityNameMatch
) -> Bool {
    switch match {
    case .exact:
        return names.contains(expected)
    case .normalized:
        let normalized = normalizedAccessibilityName(expected)
        return names.contains { normalizedAccessibilityName($0) == normalized }
    }
}

private func nodeMatchesBase(
    _ node: AccessibilityNode, roles: Set<String>?, name: String?,
    nameMatch: AccessibilityNameMatch
) -> Bool {
    if let roles, node.role.map({ roles.contains($0) }) != true { return false }
    if let name, !accessibilityNamesMatch(node.names, expected: name, match: nameMatch) {
        return false
    }
    return true
}

private func hasMatchingAncestor(
    _ node: AccessibilityNode, predicate: AccessibilityAncestorPredicate,
    nodesById: [String: AccessibilityNode]
) -> Bool {
    var parentId = node.parentId
    while let id = parentId, let parent = nodesById[id] {
        if nodeMatchesBase(
            parent, roles: predicate.roles, name: predicate.name,
            nameMatch: predicate.nameMatch)
        {
            return true
        }
        parentId = parent.parentId
    }
    return false
}

func matchingAccessibilityNodes(
    observation: AccessibilityObservation, predicate: AccessibilityPredicate
) -> [AccessibilityNode] {
    let nodesById = Dictionary(uniqueKeysWithValues: observation.nodes.map { ($0.id, $0) })
    return observation.nodes.filter { node in
        guard
            nodeMatchesBase(
                node, roles: predicate.roles, name: predicate.name,
                nameMatch: predicate.nameMatch)
        else {
            return false
        }
        if !predicate.requiredActions.isSubset(of: Set(node.actions)) { return false }
        if let enabled = predicate.enabled, node.enabled != enabled { return false }
        if let ancestor = predicate.ancestor,
            !hasMatchingAncestor(node, predicate: ancestor, nodesById: nodesById)
        {
            return false
        }
        return true
    }
}

@MainActor
func accessibilityQuery(_ parameters: [String: Any]) throws -> [String: Any] {
    let predicate = try AccessibilityPredicate.parse(parameters)
    let observation = try observeAccessibility(parameters)
    let policy = try AccessibilityContentPolicy.parse(parameters)
    let matches = matchingAccessibilityNodes(observation: observation, predicate: predicate)
    let status: String
    if !observation.complete {
        status = "incomplete"
    } else if matches.isEmpty {
        status = "not_found"
    } else if matches.count == 1 {
        status = "found"
    } else {
        status = "ambiguous"
    }
    let maxMatches = try optionalBoundedInt(
        parameters, key: "maxMatches", default: 32, minimum: 1, maximum: 32)
    let returnedMatches = Array(matches.prefix(maxMatches))
    var result = observationMetadata(observation)
    result["status"] = status
    result["matchCount"] = matches.count
    result["matches"] = returnedMatches.map { node in
        var json = node.json(policy: policy)
        json["fingerprint"] = accessibilityNodeFingerprint(node, observation: observation)
        return json
    }
    result["matchesTruncated"] = returnedMatches.count < matches.count
    let resultSize = try updateSerializedSize(&result)
    guard resultSize <= observation.limits.maxResultBytes else {
        throw SpikeError.actionFailed("Accessibility query result exceeded the byte limit")
    }
    return result
}
