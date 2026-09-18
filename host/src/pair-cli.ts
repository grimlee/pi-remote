import net from "node:net";
import { defaultPairingSocketPath } from "./pairingIpc.js";

const socketPath = defaultPairingSocketPath();
const ttlArgument = process.argv.find(argument => argument.startsWith("--ttl="));
const ttlMs = ttlArgument
  ? Number(ttlArgument.slice("--ttl=".length)) * 1000
  : undefined;

const response = await new Promise<string>((resolve, reject) => {
  const socket = net.createConnection(socketPath);
  let buffer = "";

  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(JSON.stringify({
      op: "pair.create",
      ...(ttlMs ? { ttlMs } : {}),
    }) + "\n");
  });
  socket.on("data", chunk => {
    buffer += chunk;
  });
  socket.on("end", () => resolve(buffer.trim()));
  socket.on("error", reject);
});

const decoded: unknown = JSON.parse(response);
if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
  throw new Error("invalid response from pi-remote-host");
}
const record = decoded as Record<string, unknown>;
if (record.ok !== true || typeof record.bootstrap !== "string") {
  throw new Error(
    typeof record.error === "string"
      ? record.error
      : "pi-remote-host could not create pairing invitation",
  );
}

console.log("Pi Remote pairing payload");
console.log("");
console.log(record.bootstrap);
console.log("");
console.log("Expires: " + String(record.expiresAt));
console.log("Paste this payload into Pi Remote on the iPhone.");
