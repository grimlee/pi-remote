import http from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const port = Number(process.argv[2] ?? "18789");
const roomId = "AQIDBAUGBwgJCgsMDQ4PEA";
const roomKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const writeToken = Buffer.from(
  Array.from({ length: 16 }, (_, i) => i + 32),
).toString("base64url");

function seal(frame) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", roomKey, iv);
  const plaintext = Buffer.from(JSON.stringify(frame), "utf8");
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

function open(sealed) {
  if (sealed.length < 28) throw new Error("sealed frame too short");
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const ciphertext = sealed.subarray(12, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", roomKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function envelope(peerId, frame) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(peerId, 0);
  return Buffer.concat([header, seal(frame)]);
}

function websocketFrame(payload, opcode = 2) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendBinary(socket, peerId, frame) {
  socket.write(websocketFrame(envelope(peerId, frame), 2));
}

function sendClose(socket, code = 1000, reason = "") {
  const text = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  socket.write(websocketFrame(payload, 8));
}

function parseClientFrames(onFrame) {
  let buffered = Buffer.alloc(0);

  return chunk => {
    buffered = Buffer.concat([buffered, chunk]);

    while (buffered.length >= 2) {
      const first = buffered[0];
      const second = buffered[1];
      if (first === undefined || second === undefined) return;

      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("frame too large");
        }
        length = Number(big);
        offset = 10;
      }

      let mask;
      if (masked) {
        if (buffered.length < offset + 4) return;
        mask = buffered.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffered.length < offset + length) return;

      const payload = Buffer.from(
        buffered.subarray(offset, offset + length),
      );
      buffered = buffered.subarray(offset + length);

      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      onFrame(opcode, payload);
    }
  };
}

function unpackGuestEnvelope(data) {
  if (data.length < 4) throw new Error("truncated envelope");
  const peerId = data.readUInt32BE(0);
  if (peerId !== 0) {
    throw new Error("guest must send peerId 0");
  }
  return open(data.subarray(4));
}

const server = http.createServer();

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (
    url.pathname !== "/r/" + roomId
    || url.searchParams.get("role") !== "guest"
  ) {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Accept: "
      + accept
      + "\r\n\r\n",
  );

  let phase = "hello";

  const fail = message => {
    console.error(message);
    sendClose(socket, 1011, message);
    setTimeout(() => {
      socket.destroy();
      server.close(() => process.exit(1));
    }, 20);
  };

  const onFrame = (opcode, payload) => {
    try {
      if (opcode === 8) {
        socket.end();
        return;
      }
      if (opcode === 9) {
        socket.write(websocketFrame(payload, 10));
        return;
      }
      if (opcode !== 2) return;

      const frame = unpackGuestEnvelope(payload);

      if (phase === "hello") {
        if (
          frame.t !== "hello"
          || frame.proto !== 3
          || frame.name !== "Pi Remote Integration"
          || frame.writeToken !== writeToken
        ) {
          fail("unexpected hello");
          return;
        }

        sendBinary(socket, 1, {
          t: "welcome",
          proto: 3,
          header: {
            type: "session",
            id: "integration-session",
            timestamp: "2026-09-18T00:00:00Z",
            cwd: "/tmp/integration",
          },
          state: {
            isStreaming: false,
            queuedMessageCount: 0,
            cwd: "/tmp/integration",
            participants: [
              { name: "host", role: "host" },
              { name: "Pi Remote Integration", role: "guest" },
            ],
          },
          agents: [],
          entryCount: 1,
        });
        sendBinary(socket, 1, {
          t: "snapshot-chunk",
          entries: [
            {
              type: "message",
              id: "entry-1",
              parentId: null,
              timestamp: "2026-09-18T00:00:00Z",
              message: {
                role: "user",
                content: "existing host transcript",
                timestamp: 0,
              },
            },
          ],
          final: true,
        });
        phase = "prompt";
        return;
      }

      if (phase === "prompt") {
        if (frame.t !== "prompt" || frame.text !== "integration prompt") {
          fail("unexpected prompt");
          return;
        }

        sendBinary(socket, 1, {
          t: "ui-request",
          request: {
            kind: "select",
            title: "Approve integration?",
            options: ["yes", "no"],
            reqId: 41,
          },
        });
        phase = "ui-response";
        return;
      }

      if (phase === "ui-response") {
        if (
          frame.t !== "ui-response"
          || frame.reqId !== 41
          || frame.value !== "yes"
        ) {
          fail("unexpected ui-response");
          return;
        }

        sendBinary(socket, 1, {
          t: "state",
          state: {
            isStreaming: true,
            queuedMessageCount: 0,
            cwd: "/tmp/integration",
            participants: [],
          },
        });
        phase = "abort";
        return;
      }

      if (phase === "abort") {
        if (frame.t !== "abort") {
          fail("unexpected abort");
          return;
        }

        sendBinary(socket, 1, {
          t: "bye",
          reason: "integration complete",
        });
        phase = "done";
        setTimeout(() => {
          sendClose(socket, 1000, "done");
          socket.end();
          server.close(() => process.exit(0));
        }, 50);
      }
    } catch (error) {
      fail(String(error));
    }
  };

  const parse = parseClientFrames(onFrame);
  socket.on("data", parse);
  socket.on("error", error => {
    console.error(String(error));
  });

  if (head.length > 0) parse(head);
});

server.listen(port, "127.0.0.1", () => {
  console.log("READY " + port);
});
