import Foundation

struct RemoteMachine: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let name: String
    let platform: String
    let capabilities: [String]
    var online: Bool
}
