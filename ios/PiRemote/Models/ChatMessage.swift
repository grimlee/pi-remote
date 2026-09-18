import Foundation
import PiRemoteCore

enum ChatMessageRole: Sendable {
    case user
    case assistant
    case tool
    case system
}

enum ChatMessageBlock: Sendable {
    case text(String)
    case thinking(String)
    case toolCall(name: String, arguments: String)
    case image(label: String)
    case raw(JSONValue)
}

struct ChatMessage: Sendable {
    let role: ChatMessageRole
    let timestamp: Date?
    let blocks: [ChatMessageBlock]
    let toolName: String?
    let isError: Bool
}

enum ChatMessageParser {
    static func parseAll(_ values: [JSONValue]) -> [ChatMessage] {
        values.compactMap(parse)
    }

    static func parse(_ value: JSONValue) -> ChatMessage? {
        guard let object = value.objectValue else {
            return ChatMessage(
                role: .system,
                timestamp: nil,
                blocks: [.raw(value)],
                toolName: nil,
                isError: false
            )
        }

        let role = object["role"]?.stringValue ?? ""
        let timestamp = timestampDate(object["timestamp"])

        switch role {
        case "user":
            return ChatMessage(
                role: .user,
                timestamp: timestamp,
                blocks: parseContent(object["content"]),
                toolName: nil,
                isError: false
            )

        case "assistant":
            return ChatMessage(
                role: .assistant,
                timestamp: timestamp,
                blocks: parseContent(object["content"]),
                toolName: nil,
                isError: object["stopReason"]?.stringValue == "error"
            )

        case "toolResult":
            return ChatMessage(
                role: .tool,
                timestamp: timestamp,
                blocks: parseContent(object["content"]),
                toolName: object["toolName"]?.stringValue ?? "Tool",
                isError: object["isError"]?.boolValue ?? false
            )

        case "bashExecution":
            let command = object["command"]?.stringValue ?? "bash"
            let output = object["output"]?.stringValue ?? ""
            var blocks: [ChatMessageBlock] = [
                .toolCall(name: "bash", arguments: command)
            ]
            if !output.isEmpty {
                blocks.append(.text(output))
            }
            return ChatMessage(
                role: .tool,
                timestamp: timestamp,
                blocks: blocks,
                toolName: "Bash",
                isError: (object["exitCode"]?.integerValue ?? 0) != 0
            )

        default:
            if let content = object["content"] {
                return ChatMessage(
                    role: .system,
                    timestamp: timestamp,
                    blocks: parseContent(content),
                    toolName: nil,
                    isError: false
                )
            }

            return ChatMessage(
                role: .system,
                timestamp: timestamp,
                blocks: [.raw(value)],
                toolName: nil,
                isError: false
            )
        }
    }

    static func prettyJSON(_ value: JSONValue) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys]
              ),
              let text = String(data: pretty, encoding: .utf8)
        else {
            return String(describing: value)
        }
        return text
    }

    private static func parseContent(_ value: JSONValue?) -> [ChatMessageBlock] {
        guard let value else { return [] }

        if let text = value.stringValue {
            return text.isEmpty ? [] : [.text(text)]
        }

        guard let values = value.arrayValue else {
            return [.raw(value)]
        }

        return values.compactMap { item in
            guard let object = item.objectValue else {
                if let text = item.stringValue {
                    return .text(text)
                }
                return .raw(item)
            }

            switch object["type"]?.stringValue {
            case "text":
                return .text(object["text"]?.stringValue ?? "")

            case "thinking":
                return .thinking(object["thinking"]?.stringValue ?? "")

            case "toolCall":
                let name = object["name"]?.stringValue ?? "Tool"
                let arguments = object["arguments"]
                    .map(prettyJSON)
                    ?? ""
                return .toolCall(name: name, arguments: arguments)

            case "image":
                let label = object["fileName"]?.stringValue
                    ?? object["mimeType"]?.stringValue
                    ?? "Image"
                return .image(label: label)

            default:
                return .raw(item)
            }
        }
    }

    private static func timestampDate(_ value: JSONValue?) -> Date? {
        guard let value else { return nil }

        switch value {
        case let .integer(milliseconds):
            return Date(
                timeIntervalSince1970: Double(milliseconds) / 1_000
            )

        case let .number(milliseconds):
            return Date(
                timeIntervalSince1970: milliseconds / 1_000
            )

        default:
            return nil
        }
    }
}
