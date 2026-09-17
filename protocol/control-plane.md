# Pi Remote Control Plane v0

This protocol is intentionally narrow. It discovers and authorizes access to Pi sessions; it does not carry transcript content.

## Transport

MVP: HTTPS JSON over an authenticated private ingress. A future long-lived outbound relay may replace this without changing the resource model.

## Versioning

Every response includes:

```json
{ "protocolVersion": 0 }
```

Breaking changes increment the version.

## Resources

### GET /v0/host

Returns host identity and capability flags.

```json
{
  "protocolVersion": 0,
  "host": {
    "id": "stable-device-id",
    "name": "omarchy-desktop",
    "platform": "linux",
    "online": true,
    "capabilities": ["sessions.list", "sessions.link"]
  }
}
```

### GET /v0/sessions

Returns the active local Collab hosts visible through Pi's local registry.

```json
{
  "protocolVersion": 0,
  "sessions": [
    {
      "instanceId": "...",
      "generation": 3,
      "sessionId": "...",
      "name": "Fix ComfyUI",
      "cwd": "/home/user/project",
      "model": "provider/model",
      "startedAt": "2026-09-17T12:00:00Z",
      "participantCount": 0,
      "relayConnected": true,
      "inputRequired": false,
      "access": "control"
    }
  ]
}
```

Unknown upstream fields are ignored. Missing optional fields are represented as null or omitted according to the concrete implementation, but clients must not infer defaults for security-sensitive fields.

### POST /v0/sessions/{instanceId}/link

Request body:

```json
{
  "generation": 3,
  "access": "control"
}
```

The generation is mandatory. The host must refuse the request if the process has already replaced that Collab room.

Successful response:

```json
{
  "protocolVersion": 0,
  "instanceId": "...",
  "generation": 3,
  "access": "control",
  "collabUrl": "https://.../#..."
}
```

`collabUrl` is secret material. Clients must not log it or send it to telemetry.

## Errors

Errors use a stable machine code plus human-safe message:

```json
{
  "protocolVersion": 0,
  "error": {
    "code": "stale_generation",
    "message": "The selected session changed. Refresh and try again."
  }
}
```

Initial codes:

- `unauthorized`
- `forbidden`
- `not_found`
- `stale_generation`
- `host_registry_unavailable`
- `pi_command_failed`
- `unsupported_access`
- `internal_error`

## Authentication

Authentication is deliberately specified separately from resource semantics. MVP implementation must satisfy `docs/security.md` and bind authorization to a paired device identity. Resource handlers must never accept unauthenticated requests merely because the service is behind a private tunnel.

## Non-goals

This protocol does not define:

- chat/transcript frames
- tool-call frames
- subagent frames
- raw shell execution
- filesystem operations

Those belong to Pi Collab or future narrowly scoped host resources.
