import CryptoKit
import Foundation
import Testing
@testable import PiRemoteCore

@Test
func pairingVectorMatchesHostImplementation() throws {
    let device = DevicePublicIdentity(
        id: "device_testvector",
        name: "iPhone",
        signingPublicKey: "yM6EbQV4R3kp5yy_dnkBqsme8jA9ypGFMbhwAvc6hZc",
        keyAgreementPublicKey: "OHWQojocMsWFkAFfLZ0XtemKwhoYP_h0kv3KIN8FM34"
    )

    let message = PairingCrypto.requestMessage(
        pairingId: "pair_testvector",
        machineId: "machine_testvector",
        device: device
    )

    #expect(
        message.base64URLEncodedString()
        == "cGlyZW1vdGUtcGFpci1yZXF1ZXN0LXYxAHBhaXJfdGVzdHZlY3RvcgBtYWNoaW5lX3Rlc3R2ZWN0b3IAZGV2aWNlX3Rlc3R2ZWN0b3IAaVBob25lAHlNNkViUVY0UjNrcDV5eV9kbmtCcXNtZThqQTl5cEdGTWJod0F2YzZoWmMAT0hXUW9qb2NNc1dGa0FGZkxaMFh0ZW1Ld2hvWVBfaDBrdjNLSU44Rk0zNA"
    )

    #expect(
        try PairingCrypto.proof(
            secretBase64URL: "ERERERERERERERERERERERERERERERERERERERERERE",
            message: message
        )
        == "dNuxN6BRlMe0IZ_Mx0vQrUeI9yYI7sPZIZlXIjvKFHE"
    )

    let raw = try #require(
        Data(base64URLEncoded: "ZROu6neDb7zKDoTNlziatRJ-rt9vudG1KuBsQ0Egizo")
    )
    let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)

    #expect(
        privateKey.publicKey.rawRepresentation.base64URLEncodedString()
        == device.signingPublicKey
    )

    let publicKeyRaw = try #require(
        Data(base64URLEncoded: device.signingPublicKey)
    )
    let publicKey = try Curve25519.Signing.PublicKey(
        rawRepresentation: publicKeyRaw
    )

    let nodeSignature = try #require(
        Data(
            base64URLEncoded:
                "PzsKk2gTlKX9WgUEv-fpIL169aPcnSHXo9AG9gJOas-6aURwpX9Gj3_h4W4Lr9FuRTZ6wrFWCmhK-hLhDpNTAw"
        )
    )
    #expect(publicKey.isValidSignature(nodeSignature, for: message))

    let swiftSignatureString = try PairingCrypto.deviceSignature(
        signingPrivateKeyRaw: raw,
        message: message
    )
    let swiftSignature = try #require(
        Data(base64URLEncoded: swiftSignatureString)
    )
    #expect(publicKey.isValidSignature(swiftSignature, for: message))
}
