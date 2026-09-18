import CryptoKit
import Foundation
import Testing
@testable import PiRemoteCore

@Test
func pairingBootstrapParsesRoundTripPayload() throws {
    let bootstrap = PairingBootstrap(
        relayUrl: "wss://remote.example/v0/client",
        invitation: PairingInvitation(
            pairingId: "pair_test",
            machine: PairingMachineIdentity(
                id: "machine_test",
                name: "omarchy",
                platform: "linux",
                signingPublicKey: "signing",
                keyAgreementPublicKey: "agreement",
                fingerprint: "fingerprint"
            ),
            expiresAt: "2026-09-18T00:02:00.000Z",
            secret: Data(repeating: 7, count: 32)
                .base64URLEncodedString()
        )
    )

    let encodedData = try JSONEncoder().encode(bootstrap)
    let payload = PairingBootstrap.prefix
        + encodedData.base64URLEncodedString()

    #expect(try PairingBootstrap.parse(payload) == bootstrap)
}

@Test
func pairingAcceptanceRequiresHostAndGrantSignatures() throws {
    let hostSigning = Curve25519.Signing.PrivateKey()
    let hostAgreement = Curve25519.KeyAgreement.PrivateKey()
    let deviceSigning = Curve25519.Signing.PrivateKey()
    let deviceAgreement = Curve25519.KeyAgreement.PrivateKey()

    let device = DevicePublicIdentity(
        id: "device_test",
        name: "iPhone",
        signingPublicKey: deviceSigning.publicKey.rawRepresentation
            .base64URLEncodedString(),
        keyAgreementPublicKey: deviceAgreement.publicKey.rawRepresentation
            .base64URLEncodedString()
    )
    let machine = PairingMachineIdentity(
        id: "machine_test",
        name: "omarchy",
        platform: "linux",
        signingPublicKey: hostSigning.publicKey.rawRepresentation
            .base64URLEncodedString(),
        keyAgreementPublicKey: hostAgreement.publicKey.rawRepresentation
            .base64URLEncodedString(),
        fingerprint: "test-fingerprint"
    )
    let invitation = PairingInvitation(
        pairingId: "pair_test",
        machine: machine,
        expiresAt: "2026-09-18T00:02:00.000Z",
        secret: Data(repeating: 9, count: 32)
            .base64URLEncodedString()
    )

    var unsignedGrant = MachineGrant(
        grantId: "grant_test",
        machine: .init(
            id: machine.id,
            signingPublicKey: machine.signingPublicKey,
            keyAgreementPublicKey: machine.keyAgreementPublicKey
        ),
        device: .init(
            id: device.id,
            signingPublicKey: device.signingPublicKey,
            keyAgreementPublicKey: device.keyAgreementPublicKey
        ),
        issuedAt: "2026-09-18T00:00:00.000Z",
        signature: ""
    )
    let grantSignature = try hostSigning.signature(
        for: MachineGrantCrypto.message(for: unsignedGrant)
    ).base64URLEncodedString()
    unsignedGrant = MachineGrant(
        grantId: unsignedGrant.grantId,
        machine: unsignedGrant.machine,
        device: unsignedGrant.device,
        role: unsignedGrant.role,
        issuedAt: unsignedGrant.issuedAt,
        signature: grantSignature
    )

    let acceptedAt = "2026-09-18T00:00:00.000Z"
    let hostSignature = try hostSigning.signature(
        for: PairingAcceptanceCrypto.message(
            pairingId: invitation.pairingId,
            machineId: machine.id,
            device: device,
            acceptedAt: acceptedAt
        )
    ).base64URLEncodedString()

    let acceptance = PairingAcceptance(
        pairingId: invitation.pairingId,
        machine: machine,
        deviceId: device.id,
        acceptedAt: acceptedAt,
        hostSignature: hostSignature,
        grant: unsignedGrant
    )

    #expect(
        PairingAcceptanceCrypto.verify(
            acceptance,
            invitation: invitation,
            device: device
        )
    )

    let wrongMachine = PairingInvitation(
        pairingId: invitation.pairingId,
        machine: PairingMachineIdentity(
            id: machine.id,
            name: machine.name,
            platform: machine.platform,
            signingPublicKey: Curve25519.Signing.PrivateKey()
                .publicKey.rawRepresentation
                .base64URLEncodedString(),
            keyAgreementPublicKey: machine.keyAgreementPublicKey,
            fingerprint: machine.fingerprint
        ),
        expiresAt: invitation.expiresAt,
        secret: invitation.secret
    )

    #expect(
        !PairingAcceptanceCrypto.verify(
            acceptance,
            invitation: wrongMachine,
            device: device
        )
    )
}
