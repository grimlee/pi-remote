import CryptoKit
import Foundation

public struct EncryptedCollabCapability: Codable, Hashable, Sendable {
    public let version: Int
    public let algorithm: String
    public let machineId: String
    public let deviceId: String
    public let requestId: String
    public let instanceId: String
    public let generation: Int
    public let access: String
    public let salt: String
    public let nonce: String
    public let ciphertext: String
    public let tag: String

    public init(
        version: Int = 1,
        algorithm: String = "X25519-HKDF-SHA256-AES-256-GCM",
        machineId: String,
        deviceId: String,
        requestId: String,
        instanceId: String,
        generation: Int,
        access: String,
        salt: String,
        nonce: String,
        ciphertext: String,
        tag: String
    ) {
        self.version = version
        self.algorithm = algorithm
        self.machineId = machineId
        self.deviceId = deviceId
        self.requestId = requestId
        self.instanceId = instanceId
        self.generation = generation
        self.access = access
        self.salt = salt
        self.nonce = nonce
        self.ciphertext = ciphertext
        self.tag = tag
    }
}

public enum CollabCapabilityCryptoError: LocalizedError {
    case unsupportedEnvelope
    case invalidEncoding
    case invalidPlaintext

    public var errorDescription: String? {
        switch self {
        case .unsupportedEnvelope:
            return "The Collab capability envelope is unsupported."
        case .invalidEncoding:
            return "The Collab capability envelope is malformed."
        case .invalidPlaintext:
            return "The decrypted Collab capability is invalid."
        }
    }
}

public enum CollabCapabilityCrypto {
    public static func contextMessage(
        envelope: EncryptedCollabCapability
    ) -> Data {
        var message = Data("piremote-collab-capability-v1\0".utf8)
        append(envelope.machineId, to: &message)
        append(envelope.deviceId, to: &message)
        append(envelope.requestId, to: &message)
        append(envelope.instanceId, to: &message)
        append(String(envelope.generation), to: &message)
        message.append(Data(envelope.access.utf8))
        return message
    }

    public static func decrypt(
        _ envelope: EncryptedCollabCapability,
        devicePrivateKeyRaw: Data,
        machinePublicKeyBase64URL: String
    ) throws -> String {
        guard envelope.version == 1,
              envelope.algorithm == "X25519-HKDF-SHA256-AES-256-GCM",
              envelope.generation >= 1,
              envelope.access == "view" || envelope.access == "control"
        else {
            throw CollabCapabilityCryptoError.unsupportedEnvelope
        }

        guard let machinePublicKeyRaw = Data(
                base64URLEncoded: machinePublicKeyBase64URL
              ),
              let salt = Data(base64URLEncoded: envelope.salt),
              let nonceData = Data(base64URLEncoded: envelope.nonce),
              let ciphertext = Data(base64URLEncoded: envelope.ciphertext),
              let tag = Data(base64URLEncoded: envelope.tag),
              machinePublicKeyRaw.count == 32,
              devicePrivateKeyRaw.count == 32,
              salt.count == 32,
              nonceData.count == 12,
              tag.count == 16
        else {
            throw CollabCapabilityCryptoError.invalidEncoding
        }

        let privateKey = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: devicePrivateKeyRaw
        )
        let publicKey = try Curve25519.KeyAgreement.PublicKey(
            rawRepresentation: machinePublicKeyRaw
        )
        let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(
            with: publicKey
        )
        let sharedSecretRaw = sharedSecret.withUnsafeBytes { Data($0) }

        return try decryptWithSharedSecret(
            envelope,
            sharedSecretRaw: sharedSecretRaw,
            salt: salt,
            nonceData: nonceData,
            ciphertext: ciphertext,
            tag: tag
        )
    }

    static func decryptWithSharedSecretForTest(
        _ envelope: EncryptedCollabCapability,
        sharedSecretRaw: Data
    ) throws -> String {
        guard let salt = Data(base64URLEncoded: envelope.salt),
              let nonceData = Data(base64URLEncoded: envelope.nonce),
              let ciphertext = Data(base64URLEncoded: envelope.ciphertext),
              let tag = Data(base64URLEncoded: envelope.tag)
        else {
            throw CollabCapabilityCryptoError.invalidEncoding
        }

        return try decryptWithSharedSecret(
            envelope,
            sharedSecretRaw: sharedSecretRaw,
            salt: salt,
            nonceData: nonceData,
            ciphertext: ciphertext,
            tag: tag
        )
    }

    private static func decryptWithSharedSecret(
        _ envelope: EncryptedCollabCapability,
        sharedSecretRaw: Data,
        salt: Data,
        nonceData: Data,
        ciphertext: Data,
        tag: Data
    ) throws -> String {
        guard sharedSecretRaw.count == 32,
              salt.count == 32,
              nonceData.count == 12,
              tag.count == 16
        else {
            throw CollabCapabilityCryptoError.invalidEncoding
        }

        let aad = contextMessage(envelope: envelope)
        let symmetricKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: sharedSecretRaw),
            salt: salt,
            info: aad,
            outputByteCount: 32
        )

        let nonce = try AES.GCM.Nonce(data: nonceData)
        let sealedBox = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: ciphertext,
            tag: tag
        )
        let plaintext = try AES.GCM.open(
            sealedBox,
            using: symmetricKey,
            authenticating: aad
        )

        guard let value = String(data: plaintext, encoding: .utf8),
              !value.isEmpty
        else {
            throw CollabCapabilityCryptoError.invalidPlaintext
        }
        return value
    }

    private static func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
        data.append(0)
    }
}
