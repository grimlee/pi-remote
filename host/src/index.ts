import { AuthorizedDeviceStore } from "./authorizedDevices.js";
import { loadOrCreateMachineIdentity } from "./machineIdentity.js";
import { PairingService } from "./pairing.js";
import { PairingIpcServer } from "./pairingIpc.js";
import { RelayHostClient } from "./relayClient.js";

const relayUrl = process.env.PI_REMOTE_RELAY_URL ?? "ws://127.0.0.1:8780/v0/host";

const machine = await loadOrCreateMachineIdentity();
const devices = new AuthorizedDeviceStore();
const pairing = new PairingService(machine, devices);
const pairingIpc = new PairingIpcServer(
  pairing,
  relayUrl,
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
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
