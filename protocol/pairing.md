# Pairing and Device Identity v1

Pi Remote trust is based on cryptographic identities, not network location.

## Long-lived identities

Host:

- stable opaque `machineId`;
- Ed25519 signing keypair;
- X25519 key-agreement keypair.

iPhone:

- stable opaque `deviceId`;
- Ed25519 signing keypair;
- X25519 key-agreement keypair.

Private keys never enter Pi Remote Relay.

## Pairing invitation

Host creates a short-lived single-use invitation:

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
  "secret": "32-byte random secret"
}
```

The invitation is intended for a QR displayed locally on the trusted Host.

The secret is random, short-lived, single-use, and is not a long-term credential.

## Pair request

The phone sends its public identity plus:

- HMAC-SHA256 over the canonical pairing request using the QR secret;
- Ed25519 signature over the same canonical request.

The Host therefore verifies both physical/local challenge possession and device-key possession.

## Acceptance

After verification the Host:

1. writes the device public identity to its authorization store;
2. consumes the pairing challenge;
3. returns a Host-signed acceptance;
4. issues a Host-signed MachineGrant.

MachineGrant:

```json
{
  "version": 1,
  "grantId": "grant_...",
  "machine": {
    "id": "machine_...",
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "..."
  },
  "device": {
    "id": "device_...",
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "..."
  },
  "role": "owner",
  "issuedAt": "2026-09-18T00:00:00.000Z",
  "signature": "host Ed25519 signature"
}
```

The iPhone verifies and stores the MachineGrant in Keychain.

The grant proves that the machine key authorized this exact device key. It is not sufficient by itself after revocation: Relay routing also requires the device to appear in the currently connected Host's live authorization snapshot.

## Revocation

Host revocation is authoritative.

A revoked device disappears from the live authorization snapshot and its future per-request signatures are rejected by the Host's local authorization check.

Re-pairing can deliberately restore authorization.

## Relay role

Relay routes pairing/authentication data but is not the trust anchor.

Long-term trust remains cryptographic:

```text
Host private key <-> device stores signed Host grant
device private key <-> Host stores device public key
```

## Storage

Host identity and authorized-device records are owner-only.

iOS private keys and MachineGrants use Keychain.

## Capability delivery

The same paired X25519 identities are used to encrypt sensitive Host-to-device Pi RPC channel capabilities.

A session link is therefore delivered only to the exact paired iPhone identity and is cryptographically bound to the Host, device, request, session generation, and access context.
