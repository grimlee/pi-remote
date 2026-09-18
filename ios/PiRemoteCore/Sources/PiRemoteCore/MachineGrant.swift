import CryptoKit
import Foundation

public struct MachineGrant: Codable, Hashable, Sendable {
    public struct Machine: Codable, Hashable, Sendable {
        public let id: String
        public let signingPublicKey: String
        public let keyAgreementPublicKey: String

        public init(
            id: String,
            signingPublicKey: String,
            keyAgreementPublicKey: String
        ) {
            self.id = id
            self.signingPublicKey = signingPublicKey
            self.keyAgreementPublicKey = keyAgreementPublicKey
        }
    }

    public struct Device: Codable, Hashable, Sendable {
        public let id: String
        public let signingPublicKey: String
        public let keyAgreementPublicKey: String

        public init(
            id: String,
            signingPublicKey: String,
            keyAgreementPublicKey: String
        ) {
            self.id = id
            self.signingPublicKey = signingPublicKey
            self.keyAgreementPublicKey = keyAgreementPublicKey
        }
    }

    public let version: Int
    public let grantId: String
    public let machine: Machine
    public let device: Device
    public let role: String
    public let issuedAt: String
    public let signature: String

    public init(
        version: Int = 1,
        grantId: String,
        machine: Machine,
        device: Device,
        role: String = "owner",
        issuedAt: String,
        signature: String
    ) {
        self.version = version
        self.grantId = grantId
        self.machine = machine
        self.device = device
        self.role = role
        self.issuedAt = issuedAt
        self.signature = signature
    }
}

public enum MachineGrantCrypto {
    public static func message(for grant: MachineGrant) -> Data {
        var message = Data("piremote-machine-grant-v1\0".utf8)
        append(grant.grantId, to: &message)
        append(grant.machine.id, to: &message)
        append(grant.machine.signingPublicKey, to: &message)
        append(grant.machine.keyAgreementPublicKey, to: &message)
        append(grant.device.id, to: &message)
        append(grant.device.signingPublicKey, to: &message)
        append(grant.device.keyAgreementPublicKey, to: &message)
        append(grant.role, to: &message)
        message.append(Data(grant.issuedAt.utf8))
        return message
    }

    public static func isValid(_ grant: MachineGrant) -> Bool {
        guard grant.version == 1,
              grant.grantId.hasPrefix("grant_"),
              grant.machine.id.hasPrefix("machine_"),
              grant.device.id.hasPrefix("device_"),
              grant.role == "owner",
              let publicKeyRaw = Data(base64URLEncoded: grant.machine.signingPublicKey),
              let signature = Data(base64URLEncoded: grant.signature),
              let publicKey = try? Curve25519.Signing.PublicKey(
                rawRepresentation: publicKeyRaw
              )
        else {
            return false
        }

        return publicKey.isValidSignature(signature, for: message(for: grant))
    }

    private static func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
        data.append(0)
    }
}
