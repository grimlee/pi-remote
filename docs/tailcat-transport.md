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

The experimental branch now has a one-command launcher:

```bash
cd pi-remote
npm run tailcat
```

The launcher:

- installs missing Host/Relay Node dependencies;
- uses a repo-local pinned Tailcat v0.6.0 binary, downloading and SHA-256
  verifying it when Tailcat is not already available;
- creates or reuses the persistent `piremote-test` Tailcat key;
- starts the Relay on both IPv4 and IPv6 loopback at port 8791;
- starts the Host against that local Relay;
- enables PC-side transport/RPC tracing by default;
- writes Relay and Host logs to `.runtime/relay-trace.log` and
  `.runtime/host-trace.log`;
- waits until the Relay and Host pairing socket are ready;
- renders a 10-minute pairing QR using a compressed bootstrap;
- renders the default QR directly in the terminal with a compact Braille
  2x4-module renderer, reducing both width and height without opening another
  window;
- keeps the previous half-block terminal QR available as compatibility mode;
- keeps verbose Host/Relay/Tailcat output in the trace files instead of
  continuously scrolling the interactive terminal.

The QR payload is intentionally not copied into the trace log files. The Tailcat
address remains redacted from routine Host logs.

While the launcher is running:

```text
p           create a fresh compact pairing QR
s           show the larger compatibility QR
q           stop Host and Relay
Ctrl+C      stop Host and Relay
```

On an interactive TTY, `p`, `s`, and `q` are single-key controls and do
not require Enter. Re-rendering a QR clears the launcher screen first, so the
active QR and status remain visible while background logs continue to be
recorded on disk.

Advanced overrides remain available through environment variables:

- `PI_REMOTE_TAILCAT_RELAY_PORT`: local Relay/Tailcat port; defaults to 8791.
- `PI_REMOTE_TAILCAT_KEY`: saved Tailcat key name; defaults to
  `piremote-test` on this experimental branch.
- `PI_REMOTE_PAIR_TTL_SECONDS`: QR pairing lifetime; defaults to 600.
- `PI_REMOTE_TRACE`: defaults to `1`; set to `0` to disable verbose PC
  tracing.

The underlying architecture is unchanged: the Host still uses a local WebSocket
Relay, while Tailcat is only the userspace transport underlay.

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

Pairing is camera-first on iOS. The PC launcher renders a compressed
`piremote-pair-v1z` QR bootstrap; Pi Remote scans it with AVFoundation and
starts pairing immediately. The parser remains backwards-compatible with the
original `piremote-pair-v1` payload, and manual paste remains available as a
fallback.

Tailcat diagnostics are intentionally no longer shown in the normal iOS UI.
Experiment diagnostics stay on the PC in the Relay/Host trace logs so transport
debugging does not complicate the mobile experience.

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
