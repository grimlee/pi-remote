# Tailcat Quick Connect transport

Pi Remote uses Tailcat as the preferred **Quick Connect** underlay.

Tailcat solves reachability. It does not replace Pi Remote's machine identity, pairing, authorization, encrypted Pi RPC transport, replay, or session semantics.

## Goal

The original Pi Remote prototype required a public Relay endpoint, typically behind Cloudflare Tunnel.

That worked reliably, but it raised the setup cost:

- domain/DNS configuration;
- tunnel configuration;
- a public WSS endpoint;
- more infrastructure concepts exposed to the user.

Quick Connect keeps the same Pi Remote trust model while reducing first-run setup to:

~~~text
Host: npm start
Phone: scan QR once
Later: npm start + open app
~~~

## Topology

~~~text
iPhone
  |
  | RelayClient -> loopback WebSocket
  v
PiRemoteTailcat.xcframework
  |
  | Tailcat direct path when possible
  | DERP fallback otherwise
  v
Host Tailcat sidecar
  |
  | loopback TCP
  v
Pi Remote Relay
  |
  v
pi-remote-host
  |
  v
Pi RPC
~~~

The Relay remains WebSocket-based. Tailcat transports the connection to the Host-local Relay.

## One-command launcher

From the repository root:

~~~bash
npm start
~~~

The root package also exposes equivalent aliases:

~~~bash
npm run quick-connect
npm run tailcat
~~~

The launcher:

- checks for Pi and Node/npm dependencies;
- installs missing Host/Relay Node dependencies;
- uses a pinned Tailcat v0.6.0 binary;
- downloads and SHA-256 verifies the Linux binary when necessary;
- creates/reuses a persistent Tailcat key;
- starts the local Relay;
- starts pi-remote-host in Tailcat mode;
- writes Host/Relay traces under \`.runtime/\`;
- waits for the pairing IPC socket;
- shows a QR automatically when no active paired device exists.

Automatic Tailcat download currently supports Linux x86_64 and arm64. On other Host platforms Tailcat must be supplied separately and the path is not yet part of the normal test matrix.

## Pairing UX

First use:

~~~text
npm start
    |
QR appears
    |
scan in Pi Remote
    |
paired
~~~

Later use:

~~~text
npm start
    |
existing paired device detected
    |
QR stays hidden
    |
open Pi Remote -> reconnect
~~~

Launcher controls:

~~~text
p   show a fresh pairing QR / pair another device
s   force the compatibility terminal QR
q   stop Host and Relay
~~~

On a compatible terminal the launcher may use Sixel to render a compact square QR. Otherwise it falls back to the text QR.

## Runtime files

Local experiment/runtime data is kept out of the repository:

~~~text
.runtime/   Host/Relay trace logs and pairing socket
.tools/     repo-local Tailcat binary/cache
~~~

Both paths are gitignored.

The launcher avoids copying the QR payload into routine trace logs.

## iOS bridge

The native bridge lives under:

~~~text
native/tailcat-ios/
~~~

It builds a static \`PiRemoteTailcat.xcframework\`.

The Swift side sees a local WebSocket endpoint:

~~~text
RelayClient
    |
ws://127.0.0.1:<ephemeral>/v0/client
    |
PiRemoteTailcat.xcframework
    |
Tailcat TCP dial
    |
Host-local Relay
~~~

The bridge intentionally exposes a small API: start the forwarder, return its local port, stop it, and expose limited diagnostics.

The app stores paired transport coordinates with the Host profile in Keychain.

## Identity continuity

Quick Connect uses the same Pi Remote identity as the backup public Relay path.

The app keeps:

~~~text
bundle id:   top.grimlee.piremote
display:     Pi Remote
~~~

Machine identity, iPhone device identity, and Host grants do not change when the underlying reachability path changes.

That means transport migration should not create a second logical Pi Remote device.

## Security boundary

A Tailcat address is sensitive reachability information, but it is not Pi Remote authorization.

Control still requires:

- authenticated device identity;
- Host-signed MachineGrant;
- live Host authorization;
- signed control requests;
- encrypted per-session Pi RPC capability.

Device revocation remains a Pi Remote Host operation.

Routine diagnostics must not print the Tailcat private key or full bearer address.

## Background/foreground

The Tailcat bridge lives inside the iOS process, so iOS suspension can pause the mobile side.

The Pi RPC process itself stays on the Host and is not owned by the Tailcat bridge.

For short background intervals the existing transport may remain healthy enough to reuse directly. If the transport is genuinely lost, Pi Remote's normal session resume/replay/reconciliation path applies.

Do not force a reconnect solely because a streaming turn was backgrounded; transport recovery should respond to real connectivity loss.

## Backup connection

An existing public WSS Relay/Cloudflare endpoint can be stored as a backup when migrating a paired Host to Quick Connect.

Quick Connect is preferred for normal first-run use because it removes the domain/tunnel requirement. The public path remains useful for testing and as an independent fallback.

## Build

Build the full device+simulator Tailcat XCFramework:

~~~bash
sh native/tailcat-ios/build-xcframework.sh
~~~

Device-only local build:

~~~bash
PI_REMOTE_TAILCAT_DEVICE_ONLY=1 \
  sh native/tailcat-ios/build-xcframework.sh
~~~

The normal iOS GitHub Actions workflow builds this framework before compiling Pi Remote and packaging the unsigned IPA.

## Current validation

The integrated transport has been exercised on a real iPhone across:

- repeated Host launcher restarts without rescanning;
- Wi-Fi/mobile network changes;
- proxy/VPN toggling;
- direct Quick Connect usage alongside the older Cloudflare path;
- iOS background/foreground cycles.

This is still an early project, so broader devices, Host platforms, NATs, and networks remain valuable community test coverage.
