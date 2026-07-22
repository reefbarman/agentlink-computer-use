import CoreFoundation
import CoreGraphics
import Darwin
import Foundation

func requestParameters(_ request: [String: Any]) throws -> [String: Any] {
    guard let parameters = request["params"] as? [String: Any] else {
        throw SpikeError.invalidArguments("Missing or invalid params object")
    }
    return parameters
}

func optionalString(_ parameters: [String: Any], key: String) throws -> String? {
    guard let value = parameters[key] else {
        return nil
    }
    guard let string = value as? String, !string.isEmpty else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be a non-empty string")
    }
    return string
}

func optionalProcessId(_ parameters: [String: Any], key: String) throws -> pid_t? {
    guard let value = parameters[key] else {
        return nil
    }
    guard CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID(), let number = value as? NSNumber
    else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be an integer")
    }
    let processId = number.int32Value
    guard processId > 0, NSNumber(value: processId) == number else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be a positive 32-bit integer")
    }
    return processId
}

func optionalBool(_ parameters: [String: Any], key: String, default defaultValue: Bool)
    throws -> Bool
{
    guard let value = parameters[key] else {
        return defaultValue
    }
    guard CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID(), let boolean = value as? Bool
    else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be a boolean")
    }
    return boolean
}

func optionalPositiveInt(_ parameters: [String: Any], key: String) throws -> Int? {
    guard let value = parameters[key] else {
        return nil
    }
    guard CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID(), let number = value as? NSNumber
    else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be an integer")
    }
    let integer = number.intValue
    guard integer > 0, NSNumber(value: integer) == number, integer <= 16_384 else {
        throw SpikeError.invalidArguments(
            "Parameter '\(key)' must be a positive integer no greater than 16384")
    }
    return integer
}

func requiredFiniteDouble(_ object: [String: Any], key: String) throws -> Double {
    guard let value = object[key], CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID(),
        let number = value as? NSNumber
    else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be a number")
    }
    let result = number.doubleValue
    guard result.isFinite else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be finite")
    }
    return result
}

func optionalBoundedInt(
    _ parameters: [String: Any], key: String, default defaultValue: Int,
    minimum: Int, maximum: Int
) throws -> Int {
    guard let value = parameters[key] else {
        return defaultValue
    }
    guard CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID(), let number = value as? NSNumber
    else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be an integer")
    }
    let integer = number.intValue
    guard NSNumber(value: integer) == number, integer >= minimum, integer <= maximum else {
        throw SpikeError.invalidArguments(
            "Parameter '\(key)' must be between \(minimum) and \(maximum)")
    }
    return integer
}

func requiredSignedInt32(_ parameters: [String: Any], key: String) throws -> Int32 {
    let value = parameters[key] ?? 0
    guard CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID(), let number = value as? NSNumber
    else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be an integer")
    }
    let integer = number.int64Value
    guard NSNumber(value: integer) == number, integer >= Int64(Int32.min),
        integer <= Int64(Int32.max)
    else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be a signed 32-bit integer")
    }
    return Int32(integer)
}

func optionalPoint(_ parameters: [String: Any], key: String) throws -> CGPoint? {
    guard let value = parameters[key] else {
        return nil
    }
    guard let point = value as? [String: Any] else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be a point object")
    }
    return CGPoint(
        x: try requiredFiniteDouble(point, key: "x"),
        y: try requiredFiniteDouble(point, key: "y"))
}

func requiredPoint(_ parameters: [String: Any], key: String) throws -> CGPoint {
    guard let point = try optionalPoint(parameters, key: key) else {
        throw SpikeError.invalidArguments("Missing point parameter '\(key)'")
    }
    return point
}

func requiredRect(_ object: [String: Any], key: String) throws -> CGRect {
    guard let value = object[key] as? [String: Any] else {
        throw SpikeError.invalidArguments("Parameter '\(key)' must be a rectangle object")
    }
    return CGRect(
        x: try requiredFiniteDouble(value, key: "x"),
        y: try requiredFiniteDouble(value, key: "y"),
        width: try requiredFiniteDouble(value, key: "width"),
        height: try requiredFiniteDouble(value, key: "height"))
}

func requiredStringArray(
    _ parameters: [String: Any], key: String, minimumCount: Int, maximumCount: Int
) throws -> [String] {
    guard let values = parameters[key] as? [Any],
        values.count >= minimumCount, values.count <= maximumCount
    else {
        throw SpikeError.invalidArguments(
            "Parameter '\(key)' must contain between \(minimumCount) and \(maximumCount) strings")
    }
    return try values.map { value in
        guard let string = value as? String, !string.isEmpty else {
            throw SpikeError.invalidArguments("Parameter '\(key)' must contain non-empty strings")
        }
        return string
    }
}

func requiredWindowId(_ parameters: [String: Any]) throws -> CGWindowID {
    guard let value = try optionalString(parameters, key: "windowId"),
        let windowId = CGWindowID(value)
    else {
        throw SpikeError.invalidArguments("Parameter 'windowId' must be a numeric string")
    }
    return windowId
}
