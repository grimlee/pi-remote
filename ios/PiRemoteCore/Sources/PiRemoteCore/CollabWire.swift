import Foundation

public let collabProtocolVersion = 3

public indirect enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case integer(Int64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .integer(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }

    public var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    public var arrayValue: [JSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    public var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    public var integerValue: Int64? {
        switch self {
        case let .integer(value):
            return value
        case let .number(value) where value.rounded() == value:
            return Int64(exactly: value)
        default:
            return nil
        }
    }

    public var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }
}

public enum CollabAgentCommand: String, Codable, Sendable {
    case chat
    case kill
    case revive
}

public enum CollabGuestFrame: Encodable, Sendable {
    case hello(
        proto: Int = collabProtocolVersion,
        name: String,
        writeToken: String?
    )
    case prompt(text: String, images: [JSONValue]?)
    case uiResponse(reqId: Int, value: String?)
    case abort
    case agentCommand(
        command: CollabAgentCommand,
        agentId: String,
        text: String?
    )
    case fetchTranscript(
        reqId: Int,
        agentId: String,
        fromByte: Int
    )

    private enum CodingKeys: String, CodingKey {
        case t
        case proto
        case name
        case writeToken
        case text
        case images
        case reqId
        case value
        case cmd
        case agentId
        case fromByte
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case let .hello(proto, name, writeToken):
            try container.encode("hello", forKey: .t)
            try container.encode(proto, forKey: .proto)
            try container.encode(name, forKey: .name)
            try container.encodeIfPresent(writeToken, forKey: .writeToken)

        case let .prompt(text, images):
            try container.encode("prompt", forKey: .t)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(images, forKey: .images)

        case let .uiResponse(reqId, value):
            try container.encode("ui-response", forKey: .t)
            try container.encode(reqId, forKey: .reqId)
            try container.encodeIfPresent(value, forKey: .value)

        case .abort:
            try container.encode("abort", forKey: .t)

        case let .agentCommand(command, agentId, text):
            try container.encode("agent-cmd", forKey: .t)
            try container.encode(command, forKey: .cmd)
            try container.encode(agentId, forKey: .agentId)
            try container.encodeIfPresent(text, forKey: .text)

        case let .fetchTranscript(reqId, agentId, fromByte):
            try container.encode("fetch-transcript", forKey: .t)
            try container.encode(reqId, forKey: .reqId)
            try container.encode(agentId, forKey: .agentId)
            try container.encode(fromByte, forKey: .fromByte)
        }
    }
}

public enum CollabHostFrame: Equatable, Sendable {
    case welcome(
        proto: Int,
        header: JSONValue,
        state: JSONValue,
        agents: [JSONValue],
        entryCount: Int,
        readOnly: Bool
    )
    case snapshotChunk(entries: [JSONValue], final: Bool)
    case entry(JSONValue)
    case event(JSONValue)
    case state(JSONValue)
    case bus(channel: String, data: JSONValue)
    case agents([JSONValue])
    case uiRequest(JSONValue)
    case uiRequestEnd(reqId: Int)
    case transcript(
        reqId: Int,
        text: String,
        newSize: Int,
        error: String?
    )
    case bye(reason: String)
    case error(message: String)
    case unknown(type: String, raw: JSONValue)
}

public enum CollabWireError: LocalizedError, Equatable {
    case invalidJSON
    case missingType
    case malformedFrame(String)

    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "Pi Collab frame is not a JSON object."
        case .missingType:
            return "Pi Collab frame is missing its type discriminator."
        case let .malformedFrame(type):
            return "Pi Collab \(type) frame is malformed."
        }
    }
}

public enum CollabFrameJSON {
    public static func encodeGuest(_ frame: CollabGuestFrame) throws -> Data {
        try JSONEncoder().encode(frame)
    }

    public static func decodeHost(_ data: Data) throws -> CollabHostFrame {
        let raw = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let object = raw.objectValue else {
            throw CollabWireError.invalidJSON
        }
        guard let type = object["t"]?.stringValue else {
            throw CollabWireError.missingType
        }

        func required(_ key: String) throws -> JSONValue {
            guard let value = object[key] else {
                throw CollabWireError.malformedFrame(type)
            }
            return value
        }

        func requiredString(_ key: String) throws -> String {
            guard let value = try required(key).stringValue else {
                throw CollabWireError.malformedFrame(type)
            }
            return value
        }

        func requiredInt(_ key: String) throws -> Int {
            guard let rawValue = try required(key).integerValue,
                  let value = Int(exactly: rawValue)
            else {
                throw CollabWireError.malformedFrame(type)
            }
            return value
        }

        func requiredBool(_ key: String) throws -> Bool {
            guard let value = try required(key).boolValue else {
                throw CollabWireError.malformedFrame(type)
            }
            return value
        }

        func requiredArray(_ key: String) throws -> [JSONValue] {
            guard let value = try required(key).arrayValue else {
                throw CollabWireError.malformedFrame(type)
            }
            return value
        }

        switch type {
        case "welcome":
            return .welcome(
                proto: try requiredInt("proto"),
                header: try required("header"),
                state: try required("state"),
                agents: try requiredArray("agents"),
                entryCount: try requiredInt("entryCount"),
                readOnly: object["readOnly"]?.boolValue ?? false
            )

        case "snapshot-chunk":
            return .snapshotChunk(
                entries: try requiredArray("entries"),
                final: try requiredBool("final")
            )

        case "entry":
            return .entry(try required("entry"))

        case "event":
            return .event(try required("event"))

        case "state":
            return .state(try required("state"))

        case "bus":
            return .bus(
                channel: try requiredString("channel"),
                data: try required("data")
            )

        case "agents":
            return .agents(try requiredArray("agents"))

        case "ui-request":
            return .uiRequest(try required("request"))

        case "ui-request-end":
            return .uiRequestEnd(reqId: try requiredInt("reqId"))

        case "transcript":
            return .transcript(
                reqId: try requiredInt("reqId"),
                text: try requiredString("text"),
                newSize: try requiredInt("newSize"),
                error: object["error"]?.stringValue
            )

        case "bye":
            return .bye(reason: try requiredString("reason"))

        case "error":
            return .error(message: try requiredString("message"))

        default:
            return .unknown(type: type, raw: raw)
        }
    }
}
