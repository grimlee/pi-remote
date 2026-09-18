import CryptoKit
import Foundation
import Testing
@testable import PiRemoteCore

@Test
func relayAuthenticationVectorMatchesNode() throws {
    let challenge = RelayAuthChallenge(
        challengeId: "auth_testvector",
        role: .client,
        nonce: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI",
        expiresAt: "2026-09-18T00:00:30.000Z"
    )
    let principal = RelayAuthPrincipal(
        kind: .device,
        id: "device_testvector",
        signingPublicKey: "yM6EbQV4R3kp5yy_dnkBqsme8jA9ypGFMbhwAvc6hZc"
    )

    let message = RelayAuthCrypto.message(
        challenge: challenge,
        principal: principal
    )

    #expect(
        message.base64URLEncodedString()
        == "cGlyZW1vdGUtcmVsYXktYXV0aC12MQBjbGllbnQAYXV0aF90ZXN0dmVjdG9yAElpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUkAZGV2aWNlAGRldmljZV90ZXN0dmVjdG9yAHlNNkViUVY0UjNrcDV5eV9kbmtCcXNtZThqQTl5cEdGTWJod0F2YzZoWmM"
    )

    #expect(
        RelayAuthCrypto.verify(
            signatureBase64URL:
                "v0TufdJb_zg1dA3E6JjisWyuDNqW_AFPLxQAKfREOssZRJVoxkPz6F5ZHiZ3m17tqVd-iztXx04HT1mYnGfqBA",
            challenge: challenge,
            principal: principal
        )
    )
}

@Test
func machineGrantVectorMatchesNode() {
    let grant = MachineGrant(
        grantId: "grant_testvector",
        machine: .init(
            id: "machine_testvector",
            signingPublicKey: "ZuPCgpL12lNpVI89bigCIxa3d7xoXY1g6l5PU_p5N7Y",
            keyAgreementPublicKey: "9fR7Li99huaimb2kfn_CarEsBG-jQAfjRZLsoDoSY0Q"
        ),
        device: .init(
            id: "device_testvector",
            signingPublicKey: "yM6EbQV4R3kp5yy_dnkBqsme8jA9ypGFMbhwAvc6hZc",
            keyAgreementPublicKey: "OHWQojocMsWFkAFfLZ0XtemKwhoYP_h0kv3KIN8FM34"
        ),
        issuedAt: "2026-09-18T00:00:00.000Z",
        signature:
            "rcoeWH6bdn0dwmFd0aFp-QM95p1BVMdP5n24mQGhu99yuXibsR-NCKjANa1qY_-Se0tqzrgXkpcYMIhlrBbVCA"
    )

    #expect(
        MachineGrantCrypto.message(for: grant).base64URLEncodedString()
        == "cGlyZW1vdGUtbWFjaGluZS1ncmFudC12MQBncmFudF90ZXN0dmVjdG9yAG1hY2hpbmVfdGVzdHZlY3RvcgBadVBDZ3BMMTJsTnBWSTg5YmlnQ0l4YTNkN3hvWFkxZzZsNVBVX3A1TjdZADlmUjdMaTk5aHVhaW1iMmtmbl9DYXJFc0JHLWpRQWZqUlpMc29Eb1NZMFEAZGV2aWNlX3Rlc3R2ZWN0b3IAeU02RWJRVjRSM2twNXl5X2Rua0Jxc21lOGpBOXlwR0ZNYmh3QXZjNmhaYwBPSFdRb2pvY01zV0ZrQUZmTFowWHRlbUt3aG9ZUF9oMGt2M0tJTjhGTTM0AG93bmVyADIwMjYtMDktMThUMDA6MDA6MDAuMDAwWg"
    )
    #expect(MachineGrantCrypto.isValid(grant))
}
