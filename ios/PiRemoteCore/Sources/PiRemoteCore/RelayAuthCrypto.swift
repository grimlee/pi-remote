import CryptoKit
import Foundation

public enum RelayAuthRole: String, Codable, Sendable {
    case host
    case client
}

public struct RelayAuthChallenge: Codable, Hashable, Sendable {
    public let protocolVersion: Int
    public let type: String
    public let challengeId: String
    public let role: RelayAuthRole
    public let nonce: String
    public let expiresAt: String

    public init(
        protocolVersion: Int = 0,
        type: String = "auth.challenge",
        challengeId: String,
        role: RelayAuthRole,
        nonce: String,
        expiresAt: String
    ) {
        self.protocolVersion = protocolVersion
        self.type = type
        self.challengeId = challengeId
        self.role = role
        self.nonce = nonce
        self.expiresAt = expiresAt
    }
}

public struct RelayAuthPrincipal: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case machine
        case device
    }

    public let kind: Kind
    public let id: String
    public let signingPublicKey: String

    public init(
        kind: Kind,
        id: String,
        signingPublicKey: String
    ) {
        self.kind = kind
        self.id = id
        self.signingPublicKey = signingPublicKey
    }
}

public enum RelayAuthCrypto {
    public static func message(
        challenge: RelayAuthChallenge,
        principal: RelayAuthPrincipal
    ) -> Data {
        var message = Data("piremote-relay-auth-v1\0".utf8)
        append(challenge.role.rawValue, to: &message)
        append(challenge.challengeId, to: &message)
        append(challenge.nonce, to: &message)
        append(principal.kind.rawValue, to: &message)
        append(principal.id, to: &message)
        message.append(Data(principal.signingPublicKey.utf8))
        return message
    }

    public static func verify(
        signatureBase64URL: String,
        challenge: RelayAuthChallenge,
        principal: RelayAuthPrincipal
    ) -> Bool {
        guard let publicKeyRaw = Data(base64URLEncoded: principal.signingPublicKey),
              let signature = Data(base64URLEncoded: signatureBase64URL),
              let publicKey = try? Curve25519.Signing.PublicKey(
                rawRepresentation: publicKeyRaw
              )
        else {
            return false
        }

        return publicKey.isValidSignature(
            signature,
            for: message(challenge: challenge, principal: principal)
        )
    }

    private static func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
        data.append(0)
    }
}
