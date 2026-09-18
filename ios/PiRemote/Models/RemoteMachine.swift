import Foundation

struct RemoteMachine: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let name: String
    let platform: String
    let capabilities: [String]
    let signingPublicKey: String
    let keyAgreementPublicKey: String
    let fingerprint: String
    var online: Bool
}
