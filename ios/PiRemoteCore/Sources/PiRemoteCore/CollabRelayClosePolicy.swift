import Foundation

enum CollabRelayCloseDecision: Equatable {
    case retry(retryMissingRoom: Bool)
    case fatal(String)
}

enum CollabRelayClosePolicy {
    static let fatalReasons: [Int: String] = [
        4001: "room closed",
        4004: "no such room",
        4009: "a host is already connected for this room",
        4029: "room is full",
    ]

    static func decide(
        code: Int,
        reason: String?,
        retryMissingRoom: Bool
    ) -> CollabRelayCloseDecision {
        let resolved = reason.flatMap { $0.isEmpty ? nil : $0 }
            ?? fatalReasons[code]
            ?? "connection lost (code \(code))"

        if code == 4001 {
            return .retry(retryMissingRoom: true)
        }

        if code == 4004, retryMissingRoom {
            return .retry(retryMissingRoom: true)
        }

        if fatalReasons[code] != nil {
            return .fatal(resolved)
        }

        return .retry(retryMissingRoom: retryMissingRoom)
    }
}
