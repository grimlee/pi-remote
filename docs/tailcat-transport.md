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

PiRemoteCore can parse and validate Tailcat pairing metadata on this branch.

The native Tailcat data-plane adapter is not implemented yet. Tailcat currently
does not expose a stable native iOS package in the same form as a normal Swift
dependency, so the next phase is a thin native bridge that:

1. accepts the paired Tailcat address;
2. establishes the Tailcat client in-process;
3. forwards the remote Relay port to an app-local loopback endpoint or exposes an
   equivalent byte-stream adapter;
4. hands that endpoint to the existing RelayClient;
5. survives app background/foreground reconnects without changing Pi session
   identity.

Until that bridge exists, scanning a Tailcat bootstrap proves the pairing schema
but does not provide a complete iPhone-to-Host data path.

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
