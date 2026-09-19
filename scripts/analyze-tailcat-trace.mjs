#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error(
    "usage: node scripts/analyze-tailcat-trace.mjs <trace.log> [trace.log ...]",
  );
  process.exit(2);
}

const records = [];
for (const file of paths) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    console.error(`could not read ${file}: ${error.message}`);
    process.exitCode = 2;
    continue;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") {
        records.push({ ...value, _file: file });
      }
    } catch {
      // npm and process output may contain non-JSON lines; ignore them.
    }
  }
}

const count = (predicate) => records.filter(predicate).length;
const byKey = (values, keyFor) => {
  const map = new Map();
  for (const value of values) {
    const key = keyFor(value);
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }
  return map;
};

const relayRpc = records.filter(
  r => r.component === "relay-router" && r.event === "rpc.forward",
);
const hostToClient = relayRpc.filter(r => r.direction === "host->client");
const clientToHost = relayRpc.filter(r => r.direction === "client->host");
const clientReplacements = records.filter(
  r => r.component === "relay-router" && r.event === "client.replaced",
);
const piAccepted = records.filter(
  r => r.component === "pi-registry" && r.event === "rpc.client.accept",
);
const piWrites = records.filter(
  r => r.component === "pi-registry" && r.event === "rpc.stdin.write",
);
const piCommandDuplicates = records.filter(
  r => r.component === "pi-registry" && r.event === "rpc.command.duplicate",
);
const piHostEmits = records.filter(
  r => r.component === "pi-registry" && r.event === "rpc.host.emit",
);
const resumeBegins = records.filter(
  r => r.component === "pi-registry" && r.event === "rpc.resume.begin",
);
const resumeReleases = records.filter(
  r => r.component === "pi-registry" && r.event === "rpc.resume.release",
);
const tailcatLogs = records.filter(r => r.component === "tailcat-sidecar");

const relayDuplicates = [];
for (const [key, values] of byKey(relayRpc, r =>
  `${r.direction}|${r.channelId}|${r.seq}|${r.deviceId}`
)) {
  if (values.length > 1) relayDuplicates.push({ key, count: values.length });
}

const stdinDuplicates = [];
for (const [key, values] of byKey(
  piWrites.filter(r => typeof r.commandId === "string" && r.commandId),
  r => `${r.channelId}|${r.commandId}`,
)) {
  if (values.length > 1) stdinDuplicates.push({ key, count: values.length });
}

const hostEmitDuplicates = [];
for (const [key, values] of byKey(piHostEmits, r =>
  `${r.channelId}|${r.seq}`
)) {
  if (values.length > 1) hostEmitDuplicates.push({ key, count: values.length });
}

const multiTarget = hostToClient.filter(
  r => typeof r.targetCount === "number" && r.targetCount !== 1,
);

console.log("Pi Remote Tailcat trace summary");
console.log("==============================");
console.log(`records:                 ${records.length}`);
console.log(`relay client->host RPC:  ${clientToHost.length}`);
console.log(`relay host->client RPC:  ${hostToClient.length}`);
console.log(`device replacements:      ${clientReplacements.length}`);
console.log(`Pi client frames accepted:${piAccepted.length}`);
console.log(`Pi stdin writes:           ${piWrites.length}`);
console.log(`command-id dedupe hits:    ${piCommandDuplicates.length}`);
console.log(`Pi host frames emitted:    ${piHostEmits.length}`);
console.log(`resume begin/release:      ${resumeBegins.length}/${resumeReleases.length}`);
console.log(`Tailcat verbose records:   ${tailcatLogs.length}`);
console.log("");

let suspicious = false;

if (multiTarget.length > 0) {
  suspicious = true;
  console.log("SUSPICIOUS: host RPC frame had targetCount != 1");
  for (const r of multiTarget.slice(0, 20)) {
    console.log(
      `  ${r.ts ?? "?"} channel=${r.channelId} seq=${r.seq} targetCount=${r.targetCount}`,
    );
  }
}

if (relayDuplicates.length > 0) {
  suspicious = true;
  console.log("SUSPICIOUS: same Relay RPC key forwarded multiple times");
  for (const item of relayDuplicates.slice(0, 20)) {
    console.log(`  ${item.key} x${item.count}`);
  }
}

if (stdinDuplicates.length > 0) {
  suspicious = true;
  console.log("SUSPICIOUS: same commandId written to Pi stdin multiple times");
  for (const item of stdinDuplicates.slice(0, 20)) {
    console.log(`  ${item.key} x${item.count}`);
  }
}

if (hostEmitDuplicates.length > 0) {
  suspicious = true;
  console.log("SUSPICIOUS: same Host RPC sequence emitted multiple times");
  for (const item of hostEmitDuplicates.slice(0, 20)) {
    console.log(`  ${item.key} x${item.count}`);
  }
}

if (piCommandDuplicates.length > 0) {
  console.log("INFO: Host commandId guard suppressed retries");
  for (const r of piCommandDuplicates.slice(0, 20)) {
    console.log(
      `  ${r.ts ?? "?"} channel=${r.channelId} seq=${r.clientSeq} commandId=${r.commandId}`,
    );
  }
}

if (clientReplacements.length > 0) {
  console.log("INFO: overlapping iPhone Relay connections were replaced");
  for (const r of clientReplacements.slice(0, 20)) {
    console.log(
      `  ${r.ts ?? "?"} device=${r.deviceId} old=${r.oldConnectionId} new=${r.newConnectionId}`,
    );
  }
}

if (!suspicious) {
  console.log(
    "No transport/RPC duplication signature found in the supplied trace logs.",
  );
  console.log(
    "If the UI still shows duplicates, inspect iOS Tailcat Diagnostics and message reconciliation next.",
  );
}
