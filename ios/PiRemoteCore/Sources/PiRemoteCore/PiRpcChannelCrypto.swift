import CryptoKit
import Foundation

public enum PiRpcDirection: String, Codable, Hashable, Sendable {
    case client
    case host
}

public struct PiRpcRelayFrame: Codable, Hashable, Sendable {
    public let protocolVersion: Int
    public let type: String
    public let machineId: String
    public let deviceId: String
    public let channelId: String
    public let direction: PiRpcDirection
    public let seq: Int64
    public let nonce: String
    public let ciphertext: String
    public let tag: String

    public init(
        protocolVersion: Int = 0,
        type: String = "rpc.frame",
        machineId: String,
        deviceId: String,
        channelId: String,
        direction: PiRpcDirection,
        seq: Int64,
        nonce: String,
        ciphertext: String,
        tag: String
    ) {
        self.protocolVersion = protocolVersion
        self.type = type
        self.machineId = machineId
        self.deviceId = deviceId
        self.channelId = channelId
        self.direction = direction
        self.seq = seq
        self.nonce = nonce
        self.ciphertext = ciphertext
        self.tag = tag
    }
}

public struct PiRpcCapability: Codable, Hashable, Sendable {
    public let version: Int
    public let wireProtocol: String
    public let channelId: String
    public let key: String
    public let nextClientSeq: Int64?
    public let lastHostSeq: Int64?
    public let resumeToken: String?
    public let resumeFromHostSeq: Int64?
    public let resumeTargetHostSeq: Int64?
    public let replayAvailable: Bool?

    private enum CodingKeys: String, CodingKey {
        case version
        case wireProtocol = "protocol"
        case channelId
        case key
        case nextClientSeq
        case lastHostSeq
        case resumeToken
        case resumeFromHostSeq
        case resumeTargetHostSeq
        case replayAvailable
    }

    public init(
        version: Int,
        wireProtocol: String,
        channelId: String,
        key: String,
        nextClientSeq: Int64? = nil,
        lastHostSeq: Int64? = nil,
        resumeToken: String? = nil,
        resumeFromHostSeq: Int64? = nil,
        resumeTargetHostSeq: Int64? = nil,
        replayAvailable: Bool? = nil
    ) {
        self.version = version
        self.wireProtocol = wireProtocol
        self.channelId = channelId
        self.key = key
        self.nextClientSeq = nextClientSeq
        self.lastHostSeq = lastHostSeq
        self.resumeToken = resumeToken
        self.resumeFromHostSeq = resumeFromHostSeq
        self.resumeTargetHostSeq = resumeTargetHostSeq
        self.replayAvailable = replayAvailable
    }

    public static func parse(_ value: String) throws -> PiRpcCapability {
        guard let data = value.data(using: .utf8) else {
            throw PiRpcCryptoError.invalidCapability
        }
        let capability = try JSONDecoder().decode(PiRpcCapability.self, from: data)
        guard capability.version == 1,
              capability.wireProtocol == "piremote-pi-rpc-v1",
              capability.channelId.hasPrefix("rpc_"),
              let key = Data(piRpcBase64URL: capability.key),
              key.count == 32,
              capability.nextClientSeq.map({ $0 >= 1 }) ?? true,
              capability.lastHostSeq.map({ $0 >= 0 }) ?? true,
              capability.resumeFromHostSeq.map({ $0 >= 0 }) ?? true,
              capability.resumeTargetHostSeq.map({ $0 >= 0 }) ?? true
        else {
            throw PiRpcCryptoError.invalidCapability
        }
        let resumeFields = [
            capability.resumeToken != nil,
            capability.resumeFromHostSeq != nil,
            capability.resumeTargetHostSeq != nil,
            capability.replayAvailable != nil
        ]
        if resumeFields.contains(true)
            && !resumeFields.allSatisfy({ $0 }) {
            throw PiRpcCryptoError.invalidCapability
        }
        if let token = capability.resumeToken,
           !token.hasPrefix("resume_") {
            throw PiRpcCryptoError.invalidCapability
        }
        if let from = capability.resumeFromHostSeq,
           let target = capability.resumeTargetHostSeq {
            guard from <= target,
                  capability.lastHostSeq == target,
                  capability.nextClientSeq != nil
            else {
                throw PiRpcCryptoError.invalidCapability
            }
        }
        return capability
    }
}

public enum PiRpcCryptoError: LocalizedError {
    case invalidCapability
    case invalidFrame
    case invalidSequence
    case authenticationFailed

    public var errorDescription: String? {
        switch self {
        case .invalidCapability:
            return "The Pi RPC channel capability is invalid."
        case .invalidFrame:
            return "The Pi RPC encrypted frame is malformed."
        case .invalidSequence:
            return "The Pi RPC frame sequence is invalid."
        case .authenticationFailed:
            return "The Pi RPC frame could not be authenticated."
        }
    }
}

public enum PiRpcChannelCrypto {
    public static func aad(
        machineId: String,
        deviceId: String,
        channelId: String,
        direction: PiRpcDirection,
        seq: Int64
    ) -> Data {
        var data = Data("piremote-pi-rpc-frame-v1\0".utf8)
        append(machineId, to: &data)
        append(deviceId, to: &data)
        append(channelId, to: &data)
        append(direction.rawValue, to: &data)
        data.append(Data(String(seq).utf8))
        return data
    }

    public static func seal(
        plaintext: Data,
        keyBase64URL: String,
        machineId: String,
        deviceId: String,
        channelId: String,
        direction: PiRpcDirection,
        seq: Int64
    ) throws -> PiRpcRelayFrame {
        guard seq > 0,
              let keyData = Data(piRpcBase64URL: keyBase64URL),
              keyData.count == 32
        else {
            throw PiRpcCryptoError.invalidSequence
        }

        let authenticatedData = aad(
            machineId: machineId,
            deviceId: deviceId,
            channelId: channelId,
            direction: direction,
            seq: seq
        )
        let sealed = try AES.GCM.seal(
            plaintext,
            using: SymmetricKey(data: keyData),
            authenticating: authenticatedData
        )
        let nonceData = sealed.nonce.withUnsafeBytes { Data($0) }

        return PiRpcRelayFrame(
            machineId: machineId,
            deviceId: deviceId,
            channelId: channelId,
            direction: direction,
            seq: seq,
            nonce: nonceData.piRpcBase64URLEncodedString(),
            ciphertext: sealed.ciphertext.piRpcBase64URLEncodedString(),
            tag: sealed.tag.piRpcBase64URLEncodedString()
        )
    }

    public static func open(
        _ frame: PiRpcRelayFrame,
        keyBase64URL: String
    ) throws -> Data {
        guard frame.protocolVersion == 0,
              frame.type == "rpc.frame",
              frame.seq > 0,
              let keyData = Data(piRpcBase64URL: keyBase64URL),
              let nonceData = Data(piRpcBase64URL: frame.nonce),
              let ciphertext = Data(piRpcBase64URL: frame.ciphertext),
              let tag = Data(piRpcBase64URL: frame.tag),
              keyData.count == 32,
              nonceData.count == 12,
              tag.count == 16
        else {
            throw PiRpcCryptoError.invalidFrame
        }

        let nonce = try AES.GCM.Nonce(data: nonceData)
        let box = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: ciphertext,
            tag: tag
        )
        do {
            return try AES.GCM.open(
                box,
                using: SymmetricKey(data: keyData),
                authenticating: aad(
                    machineId: frame.machineId,
                    deviceId: frame.deviceId,
                    channelId: frame.channelId,
                    direction: frame.direction,
                    seq: frame.seq
                )
            )
        } catch {
            throw PiRpcCryptoError.authenticationFailed
        }
    }

    private static func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
        data.append(0)
    }
}

private extension Data {
    init?(piRpcBase64URL value: String) {
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder != 0 {
            base64.append(String(repeating: "=", count: 4 - remainder))
        }
        self.init(base64Encoded: base64)
    }

    func piRpcBase64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
