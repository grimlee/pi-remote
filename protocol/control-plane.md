# Pi Remote Relay / Control Plane v0

This protocol controls machines and session discovery. It intentionally does **not** carry Pi transcript/tool streaming.

## Transport

Primary transport: authenticated WebSocket connections to Pi Remote Relay.

Both sides initiate outbound connections:

```text
pi-remote-host -> relay <- iOS
```

Development/fallback transports may map the same resource operations onto direct HTTPS, LAN, Tailscale, or Cloudflare, but those are not the canonical product topology.

## Versioning

Every frame carries:

```json
{ "protocolVersion": 0 }
```

Breaking changes increment the version.

## Common envelope

```json
{
  "protocolVersion": 0,
  "type": "control.request",
  "requestId": "0199...",
  "machineId": "machine_...",
  "payload": {}
}
```

`requestId` correlates exactly one response. Clients must treat duplicate responses idempotently.

## Connection roles

### Host hello

After authentication, a host announces its stable machine identity and capabilities:

```json
{
  "protocolVersion": 0,
  "type": "host.hello",
  "machine": {
    "id": "machine_...",
    "name": "omarchy",
    "platform": "linux",
    "capabilities": [
      "sessions.list",
      "sessions.link"
    ]
  }
}
```

### Client hello

A mobile client announces its authenticated device identity:

```json
{
  "protocolVersion": 0,
  "type": "client.hello",
  "device": {
    "id": "device_...",
    "name": "iPhone"
  }
}
```

Production authentication/pairing is specified separately. A development bootstrap token may be used before pairing is implemented.

## Presence

The relay emits machine presence changes to authorized clients:

```json
{
  "protocolVersion": 0,
  "type": "machine.presence",
  "machineId": "machine_...",
  "online": true
}
```

Online means the relay currently has an authenticated host connection. It does not imply a Pi session is running.

## Operations

### sessions.list

Client request:

```json
{
  "protocolVersion": 0,
  "type": "control.request",
  "requestId": "req_1",
  "machineId": "machine_...",
  "payload": {
    "op": "sessions.list"
  }
}
```

Host response payload:

```json
{
  "op": "sessions.list",
  "sessions": [
    {
      "instanceId": "...",
      "generation": 3,
      "sessionId": "...",
      "name": "Fix ComfyUI",
      "cwd": "/home/user/project",
      "model": "provider/model",
      "startedAt": "2026-09-17T12:00:00Z",
      "participantCount": 1,
      "relayConnected": true,
      "inputRequired": false,
      "access": "control"
    }
  ]
}
```

### sessions.link

Client request:

```json
{
  "protocolVersion": 0,
  "type": "control.request",
  "requestId": "req_2",
  "machineId": "machine_...",
  "payload": {
    "op": "sessions.link",
    "instanceId": "...",
    "generation": 3,
    "access": "control"
  }
}
```

The generation is mandatory.

Successful host payload:

```json
{
  "op": "sessions.link",
  "instanceId": "...",
  "generation": 3,
  "access": "control",
  "collabUrl": "https://.../#..."
}
```

`collabUrl` is capability-bearing secret material.

Development v0 may route it through a trusted relay process. The production pairing design must evolve this toward device-bound encrypted delivery so relay storage/logging never sees reusable plaintext capability material.

## Response envelope

Success:

```json
{
  "protocolVersion": 0,
  "type": "control.response",
  "requestId": "req_2",
  "machineId": "machine_...",
  "ok": true,
  "payload": {}
}
```

Failure:

```json
{
  "protocolVersion": 0,
  "type": "control.response",
  "requestId": "req_2",
  "machineId": "machine_...",
  "ok": false,
  "error": {
    "code": "stale_generation",
    "message": "The selected session changed. Refresh and try again."
  }
}
```

Initial error codes:

- `unauthorized`
- `forbidden`
- `machine_offline`
- `not_found`
- `stale_generation`
- `host_registry_unavailable`
- `pi_command_failed`
- `unsupported_access`
- `invalid_request`
- `timeout`
- `internal_error`

## Heartbeat

WebSocket ping/pong or an equivalent heartbeat keeps presence fresh. Presence must expire promptly when the authenticated host connection closes or misses its lease.

Pi work must continue regardless of relay connectivity.

## Security requirements

- Do not accept unauthenticated host or client connections.
- Do not log Collab URLs, room keys, write tokens, prompts, tool output, provider credentials, or environment variables.
- Authorize clients per machine identity.
- Bind link requests to the exact observed generation.
- Pairing/revocation must not require rotating Pi provider credentials.
- A compromised relay must not imply access to provider credentials or host filesystem contents.
- Production capability delivery should become end-to-end protected between host and paired device.

## Non-goals

This protocol does not define:

- transcript frames
- assistant token streaming
- tool-call/result frames
- subagent frames
- arbitrary shell execution
- generic filesystem operations

Those belong to Pi Collab or future narrowly scoped host operations.
