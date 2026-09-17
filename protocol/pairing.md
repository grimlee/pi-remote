# Pairing and Device Identity v1

Pi Remote trust is based on cryptographic device identities, not network location.

## Long-lived identities

Each host keeps:

- a stable opaque `machineId`
- an Ed25519 signing keypair
- an X25519 key-agreement keypair

Each iOS device keeps:

- a stable opaque `deviceId`
- an Ed25519 signing keypair
- an X25519 key-agreement keypair

Private keys never enter Pi Remote Relay.

The host stores paired-device public keys plus authorization/revocation metadata.

## Why two keypairs

Ed25519 answers:

> Did this exact trusted device sign this control message?

X25519 answers:

> Can host and device derive an encryption key that the relay cannot derive?

Keeping signing and key agreement separate makes key use explicit and lets us later encrypt Collab capabilities host-to-device without reusing signing keys.

## Pairing invitation

Pairing is initiated locally on the host.

The host creates a short-lived, single-use invitation:

```json
{
  "version": 1,
  "pairingId": "pair_...",
  "machine": {
    "id": "machine_...",
    "name": "omarchy",
    "platform": "linux",
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "...",
    "fingerprint": "..."
  },
  "expiresAt": "2026-09-18T00:02:00.000Z",
  "secret": "32-byte-random-secret"
}
```

The invitation is intended to be encoded into a QR code shown on the trusted host.

The secret is random, short-lived and single-use. It is not a permanent bearer credential.

## Pair request

The phone already has its own long-lived device keypairs.

It sends:

```json
{
  "version": 1,
  "pairingId": "pair_...",
  "machineId": "machine_...",
  "device": {
    "id": "device_...",
    "name": "iPhone",
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "..."
  },
  "proof": "HMAC-SHA256(...)",
  "deviceSignature": "Ed25519(...)"
}
```

The HMAC is keyed by the one-time QR secret and covers a domain-separated canonical representation of the pairing request.

The Ed25519 signature covers the same canonical request.

The host therefore verifies both:

1. the requester possessed the one-time local pairing secret;
2. the requester possesses the private key corresponding to the public device identity it wants authorized.

## Host acceptance

After successful verification the host:

1. writes the device public identity to its authorization store;
2. consumes the pairing challenge so it cannot be replayed;
3. returns an acceptance signed by the host Ed25519 key.

The acceptance binds:

- pairing ID
- machine ID
- device ID
- device signing public key
- device key-agreement public key
- acceptance timestamp

The phone verifies that host signature against the host public signing key obtained in the QR invitation.

That prevents the relay from silently replacing the host identity during pairing.

## Revocation

Revoking a device marks its authorization record revoked while retaining an audit record.

Revocation does not require changing:

- Pi provider credentials
- machine identity
- other paired devices
- network configuration

Revoked devices must not receive future relay authorization or new Collab capabilities.

## Relay role

The final relay may route pairing frames, but it is not the trust anchor.

Long-term authorization is anchored in:

```text
host private key <-> stored device public key
device private key <-> stored host public identity
```

The current bootstrap bearer token remains a development transport credential until relay challenge-response authentication is implemented.

## Storage

Host identity and authorized-device records are stored owner-readable only.

iOS private key material is stored in Keychain, not `UserDefaults`.

## Next security layer

After pairing is established, X25519 device/host keys will be used to derive per-message encryption keys for sensitive capability delivery, especially Pi Collab control links.

That work is intentionally separate from pairing so each primitive can be tested independently.
