import { AuthorizedDeviceStore } from "./authorizedDevices.js";
import { loadOrCreateMachineIdentity } from "./machineIdentity.js";
import { PairingService } from "./pairing.js";
import type { PairingTransport } from "./pairingBootstrap.js";
import { PairingIpcServer } from "./pairingIpc.js";
import { RelayHostClient } from "./relayClient.js";
import { TailcatSidecar } from "./tailcatSidecar.js";

const relayUrl = process.env.PI_REMOTE_RELAY_URL ?? "ws://127.0.0.1:8780/v0/host";
const transportMode = (process.env.PI_REMOTE_TRANSPORT ?? "relay")
  .trim()
  .toLowerCase();

if (transportMode !== "relay" && transportMode !== "tailcat") {
  throw new Error("PI_REMOTE_TRANSPORT must be either relay or tailcat");
}

function tailcatRelayPort(urlString: string): number {
  const url = new URL(urlString);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (url.protocol !== "ws:"
    || !loopbackHosts.has(url.hostname)
    || url.pathname !== "/v0/host") {
    throw new Error(
      "Tailcat mode requires PI_REMOTE_RELAY_URL to be a loopback ws://.../v0/host endpoint",
    );
  }

  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Tailcat mode requires a valid local relay port");
  }
  return port;
}

let tailcat: TailcatSidecar | null = null;
let pairingTransport: PairingTransport | undefined;

if (transportMode === "tailcat") {
  const relayPort = tailcatRelayPort(relayUrl);
  tailcat = new TailcatSidecar({
    relayPort,
    ...(process.env.PI_REMOTE_TAILCAT_BIN
      ? { binary: process.env.PI_REMOTE_TAILCAT_BIN }
      : {}),
    ...(process.env.PI_REMOTE_TAILCAT_KEY
      ? { key: process.env.PI_REMOTE_TAILCAT_KEY }
      : {}),
  });
  const address = await tailcat.start();
  pairingTransport = {
    kind: "tailcat",
    address,
    remotePort: relayPort,
  };
  console.log(
    `Pi Remote Tailcat underlay ready for local relay port ${relayPort}`,
  );
}

const machine = await loadOrCreateMachineIdentity();
const devices = new AuthorizedDeviceStore();
const pairing = new PairingService(machine, devices);
const pairingIpc = new PairingIpcServer(
  pairing,
  relayUrl,
  undefined,
  pairingTransport,
);
await pairingIpc.start();

const client = new RelayHostClient({
  url: relayUrl,
  machine,
  devices,
  pairing,
});

client.start();

let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;

  client.stop();
  await pairingIpc.stop().catch(() => undefined);
  await tailcat?.stop().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
