import net from "node:net";
import qrcode from "qrcode-terminal";
import {
  colorizeCompactQr,
  renderCompactQr,
} from "./compactQr.js";
import {
  decodePairingBootstrap,
  encodeCompressedPairingBootstrap,
} from "./pairingBootstrap.js";
import { defaultPairingSocketPath } from "./pairingIpc.js";

const socketPath = defaultPairingSocketPath();
const ttlArgument = process.argv.find(argument => argument.startsWith("--ttl="));
const ttlMs = ttlArgument
  ? Number(ttlArgument.slice("--ttl=".length)) * 1000
  : undefined;
const renderQr = process.argv.includes("--qr");
const safeQr = process.argv.includes("--qr-safe");
const quiet = process.argv.includes("--quiet");
const showPayload = (!renderQr && !safeQr)
  || process.argv.includes("--show-payload");

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

const compactBootstrap = encodeCompressedPairingBootstrap(
  decodePairingBootstrap(record.bootstrap as string),
);

if (!quiet) {
  console.log("Pi Remote pairing");
  console.log("");
}

if (renderQr && !quiet) {
  console.log("Scan this QR code with Pi Remote:");
  console.log("");

  const qr = renderCompactQr(compactBootstrap);
  console.log(colorizeCompactQr(qr.text));
  console.log("");
  console.log(
    `Compact QR: ${qr.widthCharacters} columns × ${qr.heightLines} lines `
      + `(${qr.moduleCount} modules)`,
  );
}

if (safeQr && !quiet) {
  console.log("Scan this compatibility QR code with Pi Remote:");
  console.log("");
  await new Promise<void>(resolve => {
    qrcode.generate(compactBootstrap, { small: true }, code => {
      console.log(code);
      resolve();
    });
  });
}

if (showPayload && !quiet) {
  if (renderQr || safeQr) console.log("Pairing payload:");
  console.log(record.bootstrap);
  console.log("");
}

if (!quiet) {
  console.log("Expires: " + String(record.expiresAt));
  console.log(
    renderQr
      ? "If this compact QR does not scan, press s in the launcher for compatibility mode."
      : safeQr
        ? "Compatibility QR mode."
        : "Paste this payload into Pi Remote on the iPhone.",
  );
}
