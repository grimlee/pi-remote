# Experimental Tailcat transport

This document applies to the `experimental/tailcat-transport` branch only.

## Goal

Remove Cloudflare Tunnel, DNS, public-IP, and inbound-port setup from the Pi Remote
first-run path while preserving the existing Pi Remote security model.

Tailcat is used only as a userspace network underlay. Pi Remote still owns:

- machine and device identity;
- pairing and revocation;
- control-request authorization;
- end-to-end encryption for Pi RPC traffic;
- session replay and reconciliation.

A Tailcat address is a secret bearer capability and must not be written to public
logs, committed to the repository, or published in DNS.

## Phase 1 architecture

```text
Host
  pi-remote-relay on 127.0.0.1:8780
          ^
          | local WebSocket
          |
  pi-remote-host
          |
          +-- tailcat serve 8780
                  |
                  | WireGuard / direct UDP when possible
                  | DERP fallback otherwise
                  |
               iPhone
```

The Relay protocol remains WebSocket-based. Tailcat transports the TCP connection
to the Host loopback Relay. This keeps Tailcat isolated from Pi RPC, pairing,
authorization, and replay logic.

## Host experiment

Prerequisites:

- `tailcat` is installed and on `PATH`;
- the Pi Remote Relay is running on loopback;
- the Host uses the same local Relay port.

Example:

```bash
# terminal 1
cd relay
npm install
npm run dev

# terminal 2
cd host
npm install
PI_REMOTE_TRANSPORT=tailcat \
PI_REMOTE_RELAY_URL=ws://127.0.0.1:8780/v0/host \
npm run dev
```

Optional environment variables:

- `PI_REMOTE_TAILCAT_BIN`: Tailcat executable path; defaults to `tailcat`.
- `PI_REMOTE_TAILCAT_KEY`: existing Tailcat saved key name. If omitted, Tailcat
  uses its normal key-selection behavior.

Create a pairing payload normally:

```bash
cd host
npm run pair:dev
```

In Tailcat mode the bootstrap contains an additional transport descriptor:

```json
{
  "transport": {
    "kind": "tailcat",
    "address": "tc...",
    "remotePort": 8780
  }
}
```

The `address` value is intentionally carried only inside the pairing bootstrap.
The Host sidecar captures Tailcat startup output instead of echoing the address to
normal application logs.

## iOS status

The experimental iOS data plane is implemented on this branch.

`native/tailcat-ios` pins Tailcat `v0.6.0` and builds a small Go/C bridge as a
static `PiRemoteTailcat.xcframework`. The bridge intentionally exposes only a
minimal API: start a Tailcat TCP forwarder, return its loopback port, stop it,
and report the latest native startup error.

`TailcatTransport.swift` presents that bridge to the existing app as a local
WebSocket endpoint:

```text
RelayClient
    |
ws://127.0.0.1:<ephemeral>/v0/client
    |
PiRemoteTailcat.xcframework
    |
tailcat.Client.DialTCPPort
    |
Tailcat direct UDP / DERP
    |
Host local Relay
```

The paired Tailcat address is stored with the host profile in the iOS Keychain.
Cold start and foreground resume recreate or reuse the native bridge without
changing Pi RPC identity. A failed pairing tears the bridge down.

Build the full device+simulator XCFramework with:

```bash
sh native/tailcat-ios/build-xcframework.sh
```

For the real-device PoC path only:

```bash
PI_REMOTE_TAILCAT_DEVICE_ONLY=1 \
  sh native/tailcat-ios/build-xcframework.sh
```

The dedicated `Tailcat iOS Experiment` GitHub Actions workflow verifies the
native framework, PiRemoteCore tests, Xcode project generation, unsigned
`iphoneos` build, and sideload IPA packaging.

## iOS experiment isolation

The Tailcat PoC intentionally uses a separate iOS identity from the main app:

- bundle identifier: `top.grimlee.piremote.tailcat`;
- display name: `Pi Remote Tailcat`;
- Keychain service: `top.grimlee.piremote.tailcat.identity`.

This lets the main Pi Remote app and the Tailcat PoC coexist on the same iPhone
without sharing paired-host profiles, device identity, or machine grants.

## Compatibility

`PI_REMOTE_TRANSPORT` defaults to `relay`. Existing WSS/Cloudflare behavior is
unchanged unless `PI_REMOTE_TRANSPORT=tailcat` is explicitly selected.

The pairing format remains version 1. The optional `transport` field is ignored
by older decoders, while this branch treats a missing field as the existing
public Relay transport.

## Exit criteria before considering merge to main

Tailcat should remain experimental until all of these are true:

- native iOS transport works on a real device;
- direct-path and DERP fallback are both verified;
- background/foreground reconnect does not recreate a healthy Pi RPC process;
- Tailcat address rotation and device revocation have a defined lifecycle;
- no Tailcat secret is emitted through routine logs or diagnostics;
- existing WSS Relay transport remains a tested fallback;
- Tailcat API/wire-format changes are pinned to a known-compatible version.
