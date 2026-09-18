import Foundation

public struct DevicePublicIdentity: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let signingPublicKey: String
    public let keyAgreementPublicKey: String

    public init(
        id: String,
        name: String,
        signingPublicKey: String,
        keyAgreementPublicKey: String
    ) {
        self.id = id
        self.name = name
        self.signingPublicKey = signingPublicKey
        self.keyAgreementPublicKey = keyAgreementPublicKey
    }
}
