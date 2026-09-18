import Foundation

public struct ParsedCollabLink: Equatable, Sendable {
    public let webSocketURL: URL
    public let roomId: String
    public let roomKey: Data
    public let writeToken: Data?

    public init(
        webSocketURL: URL,
        roomId: String,
        roomKey: Data,
        writeToken: Data?
    ) {
        self.webSocketURL = webSocketURL
        self.roomId = roomId
        self.roomKey = roomKey
        self.writeToken = writeToken
    }

    public var isReadOnly: Bool {
        writeToken == nil
    }
}

public enum CollabLinkError: LocalizedError, Equatable {
    case invalidLink
    case unsupportedRelayScheme(String)
    case insecureRemoteRelay
    case missingRoomPath
    case missingSecret
    case invalidSecretLength(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidLink:
            return "Invalid Pi Collab link."
        case let .unsupportedRelayScheme(scheme):
            return "Unsupported Pi Collab relay URL scheme: \(scheme)"
        case .insecureRemoteRelay:
            return "Plain ws/http Pi Collab relay links are allowed only for localhost."
        case .missingRoomPath:
            return "Pi Collab link must contain a /r/<roomId> path."
        case .missingSecret:
            return "Pi Collab link is missing its room secret."
        case let .invalidSecretLength(length):
            return "Pi Collab room secret must be 32 or 48 bytes, got \(length)."
        }
    }
}

public enum CollabLinkParser {
    public static let defaultRelayOrigin = "wss://my.omp.sh"
    public static let roomKeyBytes = 32
    public static let writeTokenBytes = 16

    public static func parse(_ link: String) throws -> ParsedCollabLink {
        try parse(link, depth: 0)
    }

    private static func parse(
        _ link: String,
        depth: Int
    ) throws -> ParsedCollabLink {
        guard depth < 4 else {
            throw CollabLinkError.invalidLink
        }

        var text = link
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(
                of: "%23",
                with: "#",
                options: .caseInsensitive
            )

        if let bare = parseBare(text) {
            text = defaultRelayOrigin + "/r/" + bare.roomId + "." + bare.secret
        } else if !text.contains("://") {
            text = "wss://" + text
        }

        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased()
        else {
            throw CollabLinkError.invalidLink
        }

        if (scheme == "http" || scheme == "https"),
           let fragment = url.fragment,
           !fragment.isEmpty
        {
            if let nested = try? parse(fragment, depth: depth + 1) {
                return nested
            }
        }

        let origin = try normalizedRelayOrigin(url)
        guard let room = parseRoomPath(url.path) else {
            if scheme != "http",
               scheme != "https",
               let fragment = url.fragment,
               !fragment.isEmpty
            {
                return try parse(fragment, depth: depth + 1)
            }
            throw CollabLinkError.missingRoomPath
        }

        let secretText = room.secret ?? url.fragment
        guard let secretText, !secretText.isEmpty else {
            throw CollabLinkError.missingSecret
        }
        guard let secret = Data(base64URLEncoded: secretText) else {
            throw CollabLinkError.invalidLink
        }
        guard secret.count == roomKeyBytes
                || secret.count == roomKeyBytes + writeTokenBytes
        else {
            throw CollabLinkError.invalidSecretLength(secret.count)
        }

        let roomKey = secret.prefix(roomKeyBytes)
        let token: Data? = secret.count > roomKeyBytes
            ? Data(secret.dropFirst(roomKeyBytes))
            : nil

        guard let webSocketURL = URL(
            string: origin + "/r/" + room.roomId
        ) else {
            throw CollabLinkError.invalidLink
        }

        return ParsedCollabLink(
            webSocketURL: webSocketURL,
            roomId: room.roomId,
            roomKey: Data(roomKey),
            writeToken: token
        )
    }

    private static func parseBare(
        _ text: String
    ) -> (roomId: String, secret: String)? {
        for separator in [".", "#"] {
            guard let index = text.firstIndex(of: Character(separator)) else {
                continue
            }
            let room = String(text[..<index])
            let secret = String(text[text.index(after: index)...])
            guard isRoomId(room),
                  isBase64URL(secret),
                  !secret.isEmpty
            else {
                continue
            }
            return (room, secret)
        }
        return nil
    }

    private static func parseRoomPath(
        _ path: String
    ) -> (roomId: String, secret: String?)? {
        guard path.hasPrefix("/r/") else {
            return nil
        }

        let tail = String(path.dropFirst(3))
        guard !tail.contains("/") else {
            return nil
        }

        if let dot = tail.firstIndex(of: ".") {
            let room = String(tail[..<dot])
            let secret = String(tail[tail.index(after: dot)...])
            guard isRoomId(room),
                  isBase64URL(secret),
                  !secret.isEmpty
            else {
                return nil
            }
            return (room, secret)
        }

        guard isRoomId(tail) else {
            return nil
        }
        return (tail, nil)
    }

    private static func normalizedRelayOrigin(_ url: URL) throws -> String {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host,
              !host.isEmpty
        else {
            throw CollabLinkError.invalidLink
        }

        let normalizedScheme: String
        switch scheme {
        case "wss", "https":
            normalizedScheme = "wss"
        case "ws", "http":
            normalizedScheme = "ws"
        default:
            throw CollabLinkError.unsupportedRelayScheme(scheme)
        }

        if normalizedScheme == "ws", !isLocalHost(host) {
            throw CollabLinkError.insecureRemoteRelay
        }

        var renderedHost = host
        if host.contains(":"), !host.hasPrefix("[") {
            renderedHost = "[" + host + "]"
        }

        let port = url.port.map { ":\($0)" } ?? ""
        return normalizedScheme + "://" + renderedHost + port
    }

    private static func isLocalHost(_ host: String) -> Bool {
        let value = host.lowercased()
        return value == "localhost"
            || value == "127.0.0.1"
            || value == "::1"
            || value == "[::1]"
    }

    private static func isRoomId(_ value: String) -> Bool {
        guard (10...64).contains(value.count) else {
            return false
        }
        return value.unicodeScalars.allSatisfy(isBase64URLScalar)
    }

    private static func isBase64URL(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy(isBase64URLScalar)
    }

    private static func isBase64URLScalar(
        _ scalar: UnicodeScalar
    ) -> Bool {
        switch scalar.value {
        case 45, 95:
            return true
        case 48...57, 65...90, 97...122:
            return true
        default:
            return false
        }
    }
}
