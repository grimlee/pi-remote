import Foundation

struct RemoteSession: Identifiable, Codable, Hashable, Sendable {
    enum Access: String, Codable, Sendable {
        case view
        case control
    }

    var id: String { instanceId }

    let instanceId: String
    let generation: Int
    let sessionId: String
    let name: String?
    let cwd: String
    let model: String?
    let startedAt: Date
    let participantCount: Int
    let relayConnected: Bool
    let inputRequired: Bool
    let access: Access
}

struct SessionListResponse: Codable {
    let protocolVersion: Int
    let sessions: [RemoteSession]
}
