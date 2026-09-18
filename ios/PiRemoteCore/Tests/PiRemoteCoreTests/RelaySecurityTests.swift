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


@Test
func controlRequestCanonicalBytesMatchHost() {
    #expect(
        ControlRequestCrypto.sessionsListMessage(
            requestId: "req_testvector",
            machineId: "machine_testvector",
            deviceId: "device_testvector",
            issuedAtMs: 1_800_000_000_000
        ).base64URLEncodedString()
        == "cGlyZW1vdGUtY29udHJvbC1yZXF1ZXN0LXYxAHJlcV90ZXN0dmVjdG9yAG1hY2hpbmVfdGVzdHZlY3RvcgBkZXZpY2VfdGVzdHZlY3RvcgAxODAwMDAwMDAwMDAwAHNlc3Npb25zLmxpc3Q"
    )

    #expect(
        ControlRequestCrypto.sessionsLinkMessage(
            requestId: "req_testvector",
            machineId: "machine_testvector",
            deviceId: "device_testvector",
            issuedAtMs: 1_800_000_000_000,
            instanceId: "instance_test",
            generation: 7,
            access: "control"
        ).base64URLEncodedString()
        == "cGlyZW1vdGUtY29udHJvbC1yZXF1ZXN0LXYxAHJlcV90ZXN0dmVjdG9yAG1hY2hpbmVfdGVzdHZlY3RvcgBkZXZpY2VfdGVzdHZlY3RvcgAxODAwMDAwMDAwMDAwAHNlc3Npb25zLmxpbmsAaW5zdGFuY2VfdGVzdAA3AGNvbnRyb2w"
    )
}


@Test
func collabCapabilityCryptoVectorMatchesNode() throws {
    let envelope = EncryptedCollabCapability(
        machineId: "machine_testvector",
        deviceId: "device_testvector",
        requestId: "req_capability_vector",
        instanceId: "instance_test",
        generation: 7,
        access: "control",
        salt: "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU",
        nonce: "ZmZmZmZmZmZmZmZm",
        ciphertext:
            "IaWBOyFwTzHCbf_zFagdR6D1xa64RVPT2Ux01tnryZ-AyuIpEjKlQiZbHsKqUQ",
        tag: "IAqDQdP0DV6fJOZ7OGSxqQ"
    )

    #expect(
        CollabCapabilityCrypto.contextMessage(envelope: envelope)
            .base64URLEncodedString()
        == "cGlyZW1vdGUtY29sbGFiLWNhcGFiaWxpdHktdjEAbWFjaGluZV90ZXN0dmVjdG9yAGRldmljZV90ZXN0dmVjdG9yAHJlcV9jYXBhYmlsaXR5X3ZlY3RvcgBpbnN0YW5jZV90ZXN0ADcAY29udHJvbA"
    )

    let sharedSecret = Data(repeating: 0x44, count: 32)
    let plaintext = try CollabCapabilityCrypto.decryptWithSharedSecretForTest(
        envelope,
        sharedSecretRaw: sharedSecret
    )

    #expect(
        plaintext == "https://collab.example/#opaque-test-capability"
    )
}

@Test
func collabCapabilityRejectsAuthenticatedContextTampering() throws {
    let original = EncryptedCollabCapability(
        machineId: "machine_testvector",
        deviceId: "device_testvector",
        requestId: "req_capability_vector",
        instanceId: "instance_test",
        generation: 7,
        access: "control",
        salt: "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU",
        nonce: "ZmZmZmZmZmZmZmZm",
        ciphertext:
            "IaWBOyFwTzHCbf_zFagdR6D1xa64RVPT2Ux01tnryZ-AyuIpEjKlQiZbHsKqUQ",
        tag: "IAqDQdP0DV6fJOZ7OGSxqQ"
    )

    let tampered = EncryptedCollabCapability(
        machineId: original.machineId,
        deviceId: original.deviceId,
        requestId: original.requestId,
        instanceId: original.instanceId,
        generation: 8,
        access: original.access,
        salt: original.salt,
        nonce: original.nonce,
        ciphertext: original.ciphertext,
        tag: original.tag
    )

    #expect(throws: (any Error).self) {
        try CollabCapabilityCrypto.decryptWithSharedSecretForTest(
            tampered,
            sharedSecretRaw: Data(repeating: 0x44, count: 32)
        )
    }
}
