import Foundation
import PiRemoteCore

struct PiSlashCommandOption: Identifiable, Hashable, Sendable {
    enum Source: String, Sendable {
        case builtin
        case extensionCommand = "extension"
        case prompt
        case skill

        var label: String {
            switch self {
            case .builtin:
                return "Pi Remote"
            case .extensionCommand:
                return "Extension"
            case .prompt:
                return "Prompt"
            case .skill:
                return "Skill"
            }
        }
    }

    let name: String
    let commandDescription: String
    let source: Source
    let location: String?

    var id: String {
        source.rawValue + ":" + name
    }

    var invocation: String {
        "/" + name
    }

    static func parse(_ value: JSONValue) -> PiSlashCommandOption? {
        guard let object = value.objectValue,
              let name = object["name"]?.stringValue,
              !name.isEmpty,
              let rawSource = object["source"]?.stringValue
        else {
            return nil
        }

        let source: Source
        switch rawSource {
        case "extension":
            source = .extensionCommand
        case "prompt":
            source = .prompt
        case "skill":
            source = .skill
        default:
            return nil
        }

        return PiSlashCommandOption(
            name: name,
            commandDescription: object["description"]?.stringValue ?? "",
            source: source,
            location: object["location"]?.stringValue
        )
    }

    static let remoteBuiltins: [PiSlashCommandOption] = [
        .init(
            name: "model",
            commandDescription: "Switch model",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "thinking",
            commandDescription: "Switch thinking level",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "compact",
            commandDescription: "Compact context, optionally with instructions",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "name",
            commandDescription: "Set the session display name",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "session",
            commandDescription: "Show session statistics",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "copy",
            commandDescription: "Copy the last assistant response",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "resume",
            commandDescription: "Return to the persisted session list",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "new",
            commandDescription: "Start a fresh Pi session in this project",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "commands",
            commandDescription: "Browse available slash commands",
            source: .builtin,
            location: nil
        ),
        .init(
            name: "help",
            commandDescription: "Browse available slash commands",
            source: .builtin,
            location: nil
        ),
    ]

    static let knownTUIBuiltins: Set<String> = [
        "login",
        "logout",
        "llama",
        "model",
        "thinking",
        "scoped-models",
        "settings",
        "resume",
        "new",
        "name",
        "session",
        "tree",
        "trust",
        "fork",
        "clone",
        "compact",
        "copy",
        "export",
        "import",
        "share",
        "reload",
        "hotkeys",
        "changelog",
        "quit",
        "commands",
        "help",
    ]

    static let adaptedBuiltinNames = Set(
        remoteBuiltins.map(\.name)
    )
}
