// Local-only Tailcat browser reachability probe. Never exposes Pi or a shell.
import { createServer } from "node:net";

export function createProbeServer() {
  return createServer(socket => {
    socket.setTimeout(15000, () => socket.destroy());
    let pending = "";
    let responded = false;
    socket.on("data", chunk => {
      if (responded) return;
      pending += chunk.toString("utf8");
      if (pending.length > 128) {
        responded = true;
        socket.end("ERROR invalid_request\n");
        return;
      }
      const nl = pending.indexOf("\n");
      if (nl < 0) return;
      responded = true;
      const line = pending.slice(0, nl);
      const result = /^PING ([a-f0-9]{32})$/.exec(line);
      socket.end(result ? "PONG " + result[1] + "\n" : "ERROR invalid_request\n");
    });
    socket.on("error", () => {});
  });
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const port = Number(process.env.TAILCAT_POC_ECHO_PORT || "17984");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid isolated echo port");
  }
  const server = createProbeServer();
  server.listen(port, "127.0.0.1", () => {
    console.log("Tailcat WASM probe listening on 127.0.0.1:" + port);
    console.log("Expose ONLY this echo port via an isolated ephemeral Tailcat sidecar.");
    console.log("Never expose real Pi RPC or the PWA API until device authentication is implemented.");
  });
}
