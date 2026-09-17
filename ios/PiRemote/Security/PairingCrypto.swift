import CryptoKit
import Foundation

enum PairingCryptoError: LocalizedError {
    case invalidBase64URL
    case invalidSecretLength

    var errorDescription: String? {
        switch self {
        case .invalidBase64URL:
            return "Pairing data is not valid base64url."
        case .invalidSecretLength:
            return "Pairing secret must be 32 bytes."
        }
    }
}

enum PairingCrypto {
    static func requestMessage(
        pairingId: String,
        machineId: String,
        device: DevicePublicIdentity
    ) -> Data {
        var message = Data("piremote-pair-request-v1\0".utf8)
        append(pairingId, to: &message)
        append(machineId, to: &message)
        append(device.id, to: &message)
        append(device.name, to: &message)
        append(device.signingPublicKey, to: &message)
        message.append(Data(device.keyAgreementPublicKey.utf8))
        return message
    }

    static func proof(
        secretBase64URL: String,
        message: Data
    ) throws -> String {
        guard let secret = Data(base64URLEncoded: secretBase64URL) else {
            throw PairingCryptoError.invalidBase64URL
        }
        guard secret.count == 32 else {
            throw PairingCryptoError.invalidSecretLength
        }

        let key = SymmetricKey(data: secret)
        let authentication = HMAC<SHA256>.authenticationCode(
            for: message,
            using: key
        )
        return Data(authentication).base64URLEncodedString()
    }

    static func deviceSignature(
        signingPrivateKeyRaw: Data,
        message: Data
    ) throws -> String {
        let key = try Curve25519.Signing.PrivateKey(
            rawRepresentation: signingPrivateKeyRaw
        )
        return try key.signature(for: message).base64URLEncodedString()
    }

    private static func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
        data.append(0)
    }
}

extension Data {
    init?(base64URLEncoded value: String) {
        var encoded = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        let remainder = encoded.count % 4
        if remainder != 0 {
            encoded.append(String(repeating: "=", count: 4 - remainder))
        }

        self.init(base64Encoded: encoded)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
