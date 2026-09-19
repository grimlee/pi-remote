import Compression
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
func compressedPairingBootstrapParsesRoundTripPayload() throws {
    let bootstrap = PairingBootstrap(
        relayUrl: "ws://127.0.0.1:8791/v0/client",
        transport: .tailcat(
            address: "tcomFwWCCcjS5nKNqAod034nWoJZW0LZqDhhC8U_dKdnDRYQ8uNGFpGQEu",
            remotePort: 8791
        ),
        invitation: PairingInvitation(
            pairingId: "pair_compressed",
            machine: PairingMachineIdentity(
                id: "machine_compressed",
                name: "omarchy",
                platform: "linux",
                signingPublicKey: "signing",
                keyAgreementPublicKey: "agreement",
                fingerprint: "fingerprint"
            ),
            expiresAt: "2026-09-19T10:20:00.000Z",
            secret: Data(repeating: 3, count: 32)
                .base64URLEncodedString()
        )
    )

    let encoded = try JSONEncoder().encode(bootstrap)
    let compressed = try zlibCompress(encoded)
    let payload = PairingBootstrap.compressedPrefix
        + compressed.base64URLEncodedString()

    #expect(try PairingBootstrap.parse(payload) == bootstrap)
}

private func zlibCompress(_ data: Data) throws -> Data {
    let capacity = data.count + 256
    var output = Data(count: capacity)
    let encodedSize = output.withUnsafeMutableBytes { destination in
        data.withUnsafeBytes { source in
            guard let destinationBase = destination
                .bindMemory(to: UInt8.self)
                .baseAddress,
                  let sourceBase = source
                    .bindMemory(to: UInt8.self)
                    .baseAddress
            else {
                return 0
            }

            return compression_encode_buffer(
                destinationBase,
                capacity,
                sourceBase,
                data.count,
                nil,
                COMPRESSION_ZLIB
            )
        }
    }

    guard encodedSize > 0 else {
        throw PairingBootstrapError.invalidEncoding
    }
    output.count = encodedSize
    return output
}

@Test
func compressedPairingBootstrapParsesNodeRawDeflateFixture() throws {
    let payload = PairingBootstrap.compressedPrefix
        + "jY5Nb8IwDIb_i8-hpN0HkBuCgTY2BNsQGheUtaZ4tE5JUwpC_PcpaEhw28GS3w_LzxF2aEsyDCoUYDHTh5nNQEFdqmYzjFqBDGQQqnarEzZ3shlnhOxAgLOay8JYB-oIG-IEFDhNWax9qpPEYll6Lzb5oJ73evHPxwOPxtuuSeTdPc_Ny2IuXxfb_nrda8-WySjh_vvXtF2Nh4NiOH2qwPPkxuHk_MUTnAQQ78hpdyY-3sAXmixx-uxJ_L5kk-DS6hoE5DpeE6M_IZ__6esK6xxBgcm1jdcHEFBk2q2MzUFBRlztQUBJKROnk-o7o3iEB1AXCwRs8NBNLWKO7K4b-mKCgBVxirawxA7UjToJwH1BFsuujyIZPTZkpxF2PkOpIqmkDKSUCw-BsUXf6dZv_X8OnE6_"

    let parsed = try PairingBootstrap.parse(payload)

    #expect(parsed.version == 1)
    #expect(parsed.relayUrl == "ws://127.0.0.1:8791/v0/client")
    #expect(parsed.transport?.kind == .tailcat)
    #expect(parsed.transport?.remotePort == 8791)
    #expect(parsed.invitation.pairingId == "pair_node_raw")
    #expect(parsed.invitation.machine.id == "machine_node_raw")
}

@Test
func pairingBootstrapAcceptsTailcatLoopbackTransport() throws {
    let bootstrap = PairingBootstrap(
        relayUrl: "ws://127.0.0.1:8780/v0/client",
        transport: .tailcat(
            address: "tcomFwWCCcjS5nKNqAod034nWoJZW0LZqDhhC8U_dKdnDRYQ8uNGFpGQEu",
            remotePort: 8780
        ),
        invitation: PairingInvitation(
            pairingId: "pair_tailcat",
            machine: PairingMachineIdentity(
                id: "machine_tailcat",
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

    let payload = PairingBootstrap.prefix
        + (try JSONEncoder().encode(bootstrap))
            .base64URLEncodedString()
    let parsed = try PairingBootstrap.parse(payload)

    #expect(parsed == bootstrap)
    #expect(parsed.transport?.kind == .tailcat)
    #expect(parsed.transport?.remotePort == 8780)
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

@Test
func pairingBootstrapRejectsInsecureRelayURL() throws {
    let bootstrap = PairingBootstrap(
        relayUrl: "ws://relay.example/v0/client",
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

    let encoded = PairingBootstrap.prefix
        + (try JSONEncoder().encode(bootstrap))
            .base64URLEncodedString()

    #expect(throws: (any Error).self) {
        try PairingBootstrap.parse(encoded)
    }
}

@Test
func pairingBootstrapRejectsTailcatWithNonLoopbackRelayURL() throws {
    let bootstrap = PairingBootstrap(
        relayUrl: "ws://relay.example:8780/v0/client",
        transport: .tailcat(
            address: "tcomFwWCCcjS5nKNqAod034nWoJZW0LZqDhhC8U_dKdnDRYQ8uNGFpGQEu",
            remotePort: 8780
        ),
        invitation: PairingInvitation(
            pairingId: "pair_tailcat",
            machine: PairingMachineIdentity(
                id: "machine_tailcat",
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

    let encoded = PairingBootstrap.prefix
        + (try JSONEncoder().encode(bootstrap))
            .base64URLEncodedString()

    #expect(throws: (any Error).self) {
        try PairingBootstrap.parse(encoded)
    }
}
