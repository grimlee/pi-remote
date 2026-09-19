import Compression
import CryptoKit
import Foundation

public struct PairingMachineIdentity: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let signingPublicKey: String
    public let keyAgreementPublicKey: String
    public let fingerprint: String

    public init(
        id: String,
        name: String,
        platform: String,
        signingPublicKey: String,
        keyAgreementPublicKey: String,
        fingerprint: String
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.signingPublicKey = signingPublicKey
        self.keyAgreementPublicKey = keyAgreementPublicKey
        self.fingerprint = fingerprint
    }
}

public struct PairingInvitation: Codable, Hashable, Sendable {
    public let version: Int
    public let pairingId: String
    public let machine: PairingMachineIdentity
    public let expiresAt: String
    public let secret: String

    public init(
        version: Int = 1,
        pairingId: String,
        machine: PairingMachineIdentity,
        expiresAt: String,
        secret: String
    ) {
        self.version = version
        self.pairingId = pairingId
        self.machine = machine
        self.expiresAt = expiresAt
        self.secret = secret
    }
}

public enum PairingTransportKind: String, Codable, Hashable, Sendable {
    case relay
    case tailcat
}

public struct PairingTransport: Codable, Hashable, Sendable {
    public let kind: PairingTransportKind
    public let address: String?
    public let remotePort: Int?

    public init(
        kind: PairingTransportKind,
        address: String? = nil,
        remotePort: Int? = nil
    ) {
        self.kind = kind
        self.address = address
        self.remotePort = remotePort
    }

    public static let relay = PairingTransport(kind: .relay)

    public static func tailcat(
        address: String,
        remotePort: Int
    ) -> PairingTransport {
        PairingTransport(
            kind: .tailcat,
            address: address,
            remotePort: remotePort
        )
    }
}

public struct PairingBootstrap: Codable, Hashable, Sendable {
    public static let prefix = "piremote-pair-v1."
    public static let compressedPrefix = "piremote-pair-v1z."
    private static let maxDecodedBytes = 64 * 1024

    public let version: Int
    public let relayUrl: String
    public let transport: PairingTransport?
    public let invitation: PairingInvitation

    public init(
        version: Int = 1,
        relayUrl: String,
        transport: PairingTransport? = nil,
        invitation: PairingInvitation
    ) {
        self.version = version
        self.relayUrl = relayUrl
        self.transport = transport
        self.invitation = invitation
    }

    public static func parse(_ text: String) throws -> PairingBootstrap {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        let data: Data
        if trimmed.hasPrefix(compressedPrefix) {
            let encoded = String(
                trimmed.dropFirst(compressedPrefix.count)
            )
            guard let compressed = Data(
                base64URLEncoded: encoded
            ) else {
                throw PairingBootstrapError.invalidEncoding
            }
            data = try decompressZlib(compressed)
        } else if trimmed.hasPrefix(prefix) {
            let encoded = String(trimmed.dropFirst(prefix.count))
            guard let decoded = Data(
                base64URLEncoded: encoded
            ) else {
                throw PairingBootstrapError.invalidEncoding
            }
            data = decoded
        } else {
            throw PairingBootstrapError.invalidPrefix
        }

        guard !data.isEmpty,
              data.count <= maxDecodedBytes
        else {
            throw PairingBootstrapError.invalidEncoding
        }

        let value = try JSONDecoder().decode(
            PairingBootstrap.self,
            from: data
        )
        guard value.version == 1,
              value.invitation.version == 1,
              value.invitation.pairingId.hasPrefix("pair_"),
              value.invitation.machine.id.hasPrefix("machine_"),
              let relayURL = URL(string: value.relayUrl),
              relayURL.host != nil
        else {
            throw PairingBootstrapError.invalidPayload
        }

        switch value.transport?.kind ?? .relay {
        case .relay:
            guard relayURL.scheme?.lowercased() == "wss" else {
                throw PairingBootstrapError.invalidPayload
            }

        case .tailcat:
            guard let transport = value.transport,
                  let address = transport.address,
                  address.hasPrefix("tc"),
                  address.count >= 20,
                  let remotePort = transport.remotePort,
                  (1...65_535).contains(remotePort),
                  relayURL.scheme?.lowercased() == "ws",
                  let host = relayURL.host?.lowercased(),
                  ["127.0.0.1", "localhost", "::1"].contains(host),
                  relayURL.port == remotePort,
                  relayURL.path == "/v0/client"
            else {
                throw PairingBootstrapError.invalidPayload
            }
        }

        return value
    }

    private static func decompressZlib(
        _ compressed: Data
    ) throws -> Data {
        guard !compressed.isEmpty else {
            throw PairingBootstrapError.invalidEncoding
        }

        var capacity = max(4_096, compressed.count * 4)
        while capacity <= maxDecodedBytes {
            var output = Data(count: capacity)
            let decodedSize = output.withUnsafeMutableBytes {
                destination in
                compressed.withUnsafeBytes { source in
                    guard let destinationBase = destination
                        .bindMemory(to: UInt8.self)
                        .baseAddress,
                          let sourceBase = source
                            .bindMemory(to: UInt8.self)
                            .baseAddress
                    else {
                        return 0
                    }

                    return compression_decode_buffer(
                        destinationBase,
                        capacity,
                        sourceBase,
                        compressed.count,
                        nil,
                        COMPRESSION_ZLIB
                    )
                }
            }

            if decodedSize > 0 {
                output.count = decodedSize
                return output
            }

            capacity *= 2
        }

        throw PairingBootstrapError.invalidEncoding
    }
}

public enum PairingBootstrapError: LocalizedError {
    case invalidPrefix
    case invalidEncoding
    case invalidPayload

    public var errorDescription: String? {
        switch self {
        case .invalidPrefix:
            return "This is not a Pi Remote pairing payload."
        case .invalidEncoding:
            return "The Pi Remote pairing payload is not valid base64url."
        case .invalidPayload:
            return "The Pi Remote pairing payload is malformed."
        }
    }
}

public struct PairingAcceptance: Codable, Hashable, Sendable {
    public let version: Int
    public let pairingId: String
    public let machine: PairingMachineIdentity
    public let deviceId: String
    public let acceptedAt: String
    public let hostSignature: String
    public let grant: MachineGrant

    public init(
        version: Int = 1,
        pairingId: String,
        machine: PairingMachineIdentity,
        deviceId: String,
        acceptedAt: String,
        hostSignature: String,
        grant: MachineGrant
    ) {
        self.version = version
        self.pairingId = pairingId
        self.machine = machine
        self.deviceId = deviceId
        self.acceptedAt = acceptedAt
        self.hostSignature = hostSignature
        self.grant = grant
    }
}

public enum PairingAcceptanceCrypto {
    public static func message(
        pairingId: String,
        machineId: String,
        device: DevicePublicIdentity,
        acceptedAt: String
    ) -> Data {
        var message = Data("piremote-pair-accept-v1\0".utf8)
        append(pairingId, to: &message)
        append(machineId, to: &message)
        append(device.id, to: &message)
        append(device.signingPublicKey, to: &message)
        append(device.keyAgreementPublicKey, to: &message)
        message.append(Data(acceptedAt.utf8))
        return message
    }

    public static func verify(
        _ acceptance: PairingAcceptance,
        invitation: PairingInvitation,
        device: DevicePublicIdentity
    ) -> Bool {
        guard acceptance.version == 1,
              acceptance.pairingId == invitation.pairingId,
              acceptance.machine == invitation.machine,
              acceptance.deviceId == device.id,
              acceptance.grant.machine.id == invitation.machine.id,
              acceptance.grant.machine.signingPublicKey
                == invitation.machine.signingPublicKey,
              acceptance.grant.machine.keyAgreementPublicKey
                == invitation.machine.keyAgreementPublicKey,
              acceptance.grant.device.id == device.id,
              acceptance.grant.device.signingPublicKey
                == device.signingPublicKey,
              acceptance.grant.device.keyAgreementPublicKey
                == device.keyAgreementPublicKey,
              MachineGrantCrypto.isValid(acceptance.grant),
              let publicKeyRaw = Data(
                base64URLEncoded: invitation.machine.signingPublicKey
              ),
              let signature = Data(
                base64URLEncoded: acceptance.hostSignature
              ),
              let publicKey = try? Curve25519.Signing.PublicKey(
                rawRepresentation: publicKeyRaw
              )
        else {
            return false
        }

        let signed = message(
            pairingId: acceptance.pairingId,
            machineId: acceptance.machine.id,
            device: device,
            acceptedAt: acceptance.acceptedAt
        )
        return publicKey.isValidSignature(signature, for: signed)
    }

    private static func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
        data.append(0)
    }
}
