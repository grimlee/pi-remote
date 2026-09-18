import CryptoKit
import Foundation

public enum CollabCodecError: LocalizedError, Equatable {
    case invalidRoomKeyLength(Int)
    case sealedFrameTooShort(Int)
    case invalidNonceLength(Int)
    case invalidPlaintext

    public var errorDescription: String? {
        switch self {
        case let .invalidRoomKeyLength(length):
            return "Pi Collab room key must be 32 bytes, got \(length)."
        case let .sealedFrameTooShort(length):
            return "Pi Collab sealed frame is too short: \(length) bytes."
        case let .invalidNonceLength(length):
            return "Pi Collab AES-GCM nonce must be 12 bytes, got \(length)."
        case .invalidPlaintext:
            return "Pi Collab decrypted payload is not valid JSON data."
        }
    }
}

public enum CollabCodec {
    public static let roomKeyBytes = 32
    public static let nonceBytes = 12
    public static let tagBytes = 16

    public static func sealGuestFrame(
        _ frame: CollabGuestFrame,
        roomKey: Data
    ) throws -> Data {
        let plaintext = try CollabFrameJSON.encodeGuest(frame)
        return try seal(plaintext, roomKey: roomKey)
    }

    public static func seal(
        _ plaintext: Data,
        roomKey: Data
    ) throws -> Data {
        try seal(
            plaintext,
            roomKey: roomKey,
            nonceData: nil
        )
    }

    static func sealForTest(
        _ plaintext: Data,
        roomKey: Data,
        nonceData: Data
    ) throws -> Data {
        try seal(
            plaintext,
            roomKey: roomKey,
            nonceData: nonceData
        )
    }

    public static func openHostFrame(
        _ sealed: Data,
        roomKey: Data
    ) throws -> CollabHostFrame {
        let plaintext = try open(sealed, roomKey: roomKey)
        return try CollabFrameJSON.decodeHost(plaintext)
    }

    public static func open(
        _ sealed: Data,
        roomKey: Data
    ) throws -> Data {
        guard roomKey.count == roomKeyBytes else {
            throw CollabCodecError.invalidRoomKeyLength(roomKey.count)
        }
        guard sealed.count >= nonceBytes + tagBytes else {
            throw CollabCodecError.sealedFrameTooShort(sealed.count)
        }

        let nonceData = Data(sealed.prefix(nonceBytes))
        let tag = Data(sealed.suffix(tagBytes))
        let ciphertext = Data(
            sealed.dropFirst(nonceBytes).dropLast(tagBytes)
        )

        let nonce = try AES.GCM.Nonce(data: nonceData)
        let box = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: ciphertext,
            tag: tag
        )

        return try AES.GCM.open(
            box,
            using: SymmetricKey(data: roomKey)
        )
    }

    private static func seal(
        _ plaintext: Data,
        roomKey: Data,
        nonceData: Data?
    ) throws -> Data {
        guard roomKey.count == roomKeyBytes else {
            throw CollabCodecError.invalidRoomKeyLength(roomKey.count)
        }

        let nonce: AES.GCM.Nonce
        if let nonceData {
            guard nonceData.count == nonceBytes else {
                throw CollabCodecError.invalidNonceLength(nonceData.count)
            }
            nonce = try AES.GCM.Nonce(data: nonceData)
        } else {
            nonce = AES.GCM.Nonce()
        }

        let box = try AES.GCM.seal(
            plaintext,
            using: SymmetricKey(data: roomKey),
            nonce: nonce
        )

        var output = Data()
        output.reserveCapacity(
            nonceBytes + box.ciphertext.count + tagBytes
        )
        output.append(contentsOf: nonce)
        output.append(box.ciphertext)
        output.append(box.tag)
        return output
    }
}
