import { writeFile } from "node:fs/promises";
import net from "node:net";
import qrcode from "qrcode-terminal";
import * as QRCode from "qrcode";
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
const svgArgument = process.argv.find(argument =>
  argument.startsWith("--qr-svg=")
);
const svgPath = svgArgument
  ? svgArgument.slice("--qr-svg=".length)
  : undefined;
const quiet = process.argv.includes("--quiet");
const sizeArgument = process.argv.find(argument =>
  argument.startsWith("--qr-size=")
);
const requestedQrSize = sizeArgument
  ? Number(sizeArgument.slice("--qr-size=".length))
  : 240;
const qrSize = Number.isFinite(requestedQrSize)
  ? Math.min(512, Math.max(160, Math.round(requestedQrSize)))
  : 240;
const showPayload = (!renderQr && !svgPath)
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

if (renderQr) {
  if (!quiet) {
    console.log("Scan this QR code with Pi Remote:");
    console.log("");
  }
  await new Promise<void>(resolve => {
    qrcode.generate(compactBootstrap, { small: true }, code => {
      if (!quiet) console.log(code);
      resolve();
    });
  });
}

if (svgPath) {
  const svg = await QRCode.toString(compactBootstrap, {
    type: "svg",
    errorCorrectionLevel: "L",
    margin: 4,
    width: qrSize,
  });
  await writeFile(svgPath, svg, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (!quiet) {
    console.log("Pairing QR saved to: " + svgPath);
    console.log("");
  }
}

if (showPayload && !quiet) {
  if (renderQr || svgPath) console.log("Pairing payload:");
  console.log(record.bootstrap);
  console.log("");
}

if (!quiet) {
  console.log("Expires: " + String(record.expiresAt));
  console.log(
    renderQr || svgPath
      ? "Keep this pairing QR private."
      : "Paste this payload into Pi Remote on the iPhone.",
  );
}
