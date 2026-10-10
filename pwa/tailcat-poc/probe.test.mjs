import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { createProbeServer } from "./probe-server.mjs";

function exchange(port, input) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const fragments = [];
    socket.on("connect", () => socket.end(input));
    socket.on("data", data => fragments.push(data));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(fragments).toString("utf8")));
  });
}

test("isolated loopback echo only accepts one PING nonce", async t => {
  const server = createProbeServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, "127.0.0.1");
  const port = server.address().port;
  const nonce = "a3".repeat(16);
  assert.equal(await exchange(port, "PING " + nonce + "\n"), "PONG " + nonce + "\n");
  assert.equal(await exchange(port, "GET / HTTP/1.1\r\n\r\n"), "ERROR invalid_request\n");
  assert.equal(await exchange(port, "PING " + "abcdef".repeat(60) + "\n"), "ERROR invalid_request\n");
  assert.equal(await exchange(port, "PING " + nonce + "\nMORE\n"), "PONG " + nonce + "\n");
});
