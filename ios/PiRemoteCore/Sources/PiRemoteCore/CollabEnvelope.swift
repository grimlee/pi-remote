import Foundation

public enum CollabEnvelopeError: LocalizedError, Equatable {
    case truncated

    public var errorDescription: String? {
        switch self {
        case .truncated:
            return "Pi Collab envelope is shorter than the 4-byte peer header."
        }
    }
}

public struct CollabEnvelope: Equatable, Sendable {
    public static let headerBytes = 4

    public let peerId: UInt32
    public let payload: Data

    public init(peerId: UInt32, payload: Data) {
        self.peerId = peerId
        self.payload = payload
    }

    public func encoded() -> Data {
        var result = Data(capacity: Self.headerBytes + payload.count)
        var value = peerId.bigEndian
        withUnsafeBytes(of: &value) { bytes in
            result.append(contentsOf: bytes)
        }
        result.append(payload)
        return result
    }

    public static func decode(_ data: Data) throws -> CollabEnvelope {
        guard data.count >= headerBytes else {
            throw CollabEnvelopeError.truncated
        }

        let peerId = data.prefix(headerBytes).reduce(UInt32.zero) { value, byte in
            (value << 8) | UInt32(byte)
        }

        return CollabEnvelope(
            peerId: peerId,
            payload: Data(data.dropFirst(headerBytes))
        )
    }
}
