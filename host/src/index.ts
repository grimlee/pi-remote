import { AuthorizedDeviceStore } from "./authorizedDevices.js";
import { loadOrCreateMachineIdentity } from "./machineIdentity.js";
import { RelayHostClient } from "./relayClient.js";

const relayUrl = process.env.PI_REMOTE_RELAY_URL ?? "ws://127.0.0.1:8780/v0/host";

const machine = await loadOrCreateMachineIdentity();
const devices = new AuthorizedDeviceStore();
const client = new RelayHostClient({
  url: relayUrl,
  machine,
  devices,
});

client.start();

function shutdown(): void {
  client.stop();
  setTimeout(() => process.exit(0), 50).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
