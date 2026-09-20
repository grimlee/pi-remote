# Pi Collab Wire Map

> **Legacy reference:** Pi Remote no longer uses Pi/OMP Collab as its primary session data plane. The current product uses native Pi RPC through `pi --session <path> --mode rpc`. This document is retained only as historical protocol research for a possible future live-TUI attachment path. See [architecture.md](architecture.md) for the current design.

This document pins the native Pi Remote client to the upstream Pi Collab wire protocol observed at:

can1357/oh-my-pi commit 62a4aa98a4b52f829a3ae9a5247ca8db4e5f810c

Primary upstream sources:

- packages/wire/src/index.ts
- packages/coding-agent/src/collab/protocol.ts
- packages/coding-agent/src/collab/crypto.ts
- packages/coding-agent/src/collab/relay-client.ts
- packages/coding-agent/src/collab/host.ts
- packages/collab-web/src/lib/link.ts
- packages/collab-web/src/lib/codec.ts
- packages/collab-web/src/lib/socket.ts
- packages/collab-web/src/lib/client.ts

Pi Remote must treat those sources, not this document, as the ultimate compatibility authority when upgrading upstream.

## Protocol version

Current wire protocol: COLLAB_PROTO = 3.

History:

- v1: welcome carried the transcript inline.
- v2: transcript moved to snapshot-chunk frames.
- v3: ui-request / ui-request-end / ui-response were added.

A native guest sends proto: 3 in its first encrypted hello frame.

## Link format

Constants:

- default relay: wss://my.omp.sh
- room id: 16 random bytes, base64url
- room key: 32 bytes
- write token: 16 bytes

View links contain base64url(roomKey).

Control links contain base64url(roomKey || writeToken).

Accepted forms include:

~~~text
<roomId>.<secret>
<roomId>#<secret>
relay.example/r/<roomId>.<secret>
wss://relay.example/r/<roomId>.<secret>
https://web.example/#<nested-collab-link>
~~~

Legacy %23 is normalized back to #.

The parsed relay WebSocket URL never contains the room key:

~~~text
wss://<relay>/r/<roomId>
~~~

Plain ws/http relay transport is accepted only for localhost.

## Relay WebSocket connection

Guest connects to:

~~~text
<parsed wsUrl>?role=guest
~~~

Host uses role=host.

Text WebSocket messages are relay-control JSON and contain no encrypted session payload.

Guest-relevant control includes room-closed.

Session frames use binary WebSocket messages.

## Binary envelope

Every encrypted payload is wrapped as:

~~~text
[4-byte uint32 big-endian peerId][sealed payload]
~~~

Guest sends peerId = 0. The relay rewrites it to the sender peer ID before Host delivery.

Host uses peerId 0 for broadcast and non-zero peer IDs for targeted guest traffic.

## Room encryption

The 32-byte room key is used directly as an AES-256-GCM key.

There is no KDF and no AAD in upstream Collab frame encryption.

Sealed layout:

~~~text
[12-byte random IV][ciphertext][16-byte GCM tag]
~~~

Equivalent upstream operation:

~~~text
AES-GCM(key=roomKey, iv=random12, plaintext=UTF8(JSON.stringify(frame)))
~~~

A guest decryption failure is fatal and is not retried.

## First guest frame

On every guest connection or reconnection:

~~~json
{
  "t": "hello",
  "proto": 3,
  "name": "Pi Remote",
  "writeToken": "<base64url token>"
}
~~~

writeToken is omitted for view links.

Host verifies protocol version, normalizes the guest name, timing-safely checks the write token, and marks the peer writable only when the token is valid.

An invalid or missing write token produces a read-only guest rather than rejecting the connection.

## Initial authoritative snapshot

Host first sends a targeted welcome:

~~~json
{
  "t": "welcome",
  "proto": 3,
  "header": {},
  "state": {},
  "agents": [],
  "entryCount": 123,
  "readOnly": false
}
~~~

Transcript data follows in targeted snapshot-chunk frames:

~~~json
{
  "t": "snapshot-chunk",
  "entries": [],
  "final": false
}
~~~

The final chunk has final: true.

A fresh welcome supersedes any partially assembled snapshot from a previous connection.

## Host to guest frames

Known v3 Host frames:

- welcome
- snapshot-chunk
- entry
- event
- state
- bus
- agents
- ui-request
- ui-request-end
- transcript
- bye
- error

Pi Remote wire decoding must tolerate unknown future frame types.

Known live event variants include:

- agent_start
- agent_end
- turn_start
- turn_end
- message_start
- message_update
- message_end
- tool_execution_start
- tool_execution_update
- tool_execution_end
- notice
- auto_compaction_start
- auto_compaction_end
- auto_retry_start
- auto_retry_end
- thinking_level_changed

message_update carries the full accumulating partial message, not a token delta.

State is Host-authoritative and may contain isStreaming, queuedMessageCount, sessionName, cwd, model, thinkingLevel, contextUsage, participants, and isAborting.

Mirrored bus channels currently include:

- task:subagent:progress
- task:subagent:lifecycle

UI request kinds currently include select and editor.

## Guest to host frames

Known v3 Guest frames:

- hello
- prompt
- ui-response
- abort
- agent-cmd
- fetch-transcript

Agent commands are chat, kill, and revive.

## Read-only enforcement

Host stores canWrite per joined peer after validating the write token.

Read-only guests are rejected for prompt, abort, agent control, and UI responses.

Host enforcement remains authoritative even though Pi Remote also disables these operations locally after a read-only welcome.

## Join timeouts

Upstream browser/TUI semantics:

- first welcome: 30 seconds
- snapshot progress: 30 seconds between chunks
- transcript request: 10 to 20 seconds depending on client

The snapshot progress timeout resets on every chunk.

## Reconnect behavior

Known relay close codes:

- 4001 room closed
- 4004 no such room
- 4009 host already connected
- 4029 room full

Guest special behavior:

- 4001 is retryable because the Host may be recreating the room.
- After that recreation begins, 4004 remains retryable while the room is missing.
- Other known fatal close codes end the guest.
- Ordinary transport drops retry with exponential backoff.
- Backoff starts around one second, caps at 30 seconds, and uses jitter.
- Every reconnect sends a fresh hello.
- The next welcome replaces stale mobile replica state.

## Native implementation policy

Pi Remote separates the native implementation into:

- CollabLinkParser
- CollabEnvelope
- CollabCodec
- CollabFrameJSON
- CollabGuestReplica
- CollabGuestClient

Wire decoding is intentionally tolerant:

- discriminator and control fields are strongly validated;
- extensible entry/event/state/agent payloads are retained as JSONValue;
- unknown future Host frame variants do not crash the connection.

Typed product models should be projected from this wire layer rather than making the wire decoder brittle.
