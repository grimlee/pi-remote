import Foundation

struct SessionLink: Codable, Hashable, Sendable {
    let instanceId: String
    let generation: Int
    let access: RemoteSession.Access
    let collabUrl: String
}
