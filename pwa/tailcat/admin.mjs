import { connect } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Framer, frame } from './protocol.mjs';

const [op, dir, ...input] = process.argv.slice(2);
if (!['pair', 'revoke', 'list'].includes(op) || !dir || !path.isAbsolute(dir)) throw new Error('Usage: admin.mjs pair STATE_DIR ADDRESS_FILE HTTPS_ORIGIN OUTPUT_FILE [PORT] | revoke STATE_DIR DEVICE_ID | list STATE_DIR');
const args = op === 'pair' ? {address: readFileSync(input[0], 'utf8').trim(), origin: input[1], port: Number(input[3] || 17987)} : {deviceId: input[0]};
if (op === 'pair' && (!input[2] || !path.isAbsolute(input[2]))) throw new Error('Pairing requires an absolute private output filename');
const socket = connect(path.join(dir, 'admin.sock'));
socket.setTimeout(5000, () => socket.destroy(new Error('admin_timeout')));
const reader = new Framer();
socket.on('connect', () => socket.write(frame({v: 1, op: {'pair': 'pair.mint', 'revoke': 'device.revoke', 'list': 'devices.list'}[op], args})));
socket.on('data', bytes => {
  for (const result of reader.push(bytes)) {
    if (result.error) throw new Error(result.error);
    if (op === 'pair') {
      writeFileSync(input[2], JSON.stringify(result.value), {mode: 0o600, flag: 'wx'});
      console.log('One-time pairing bundle written privately. Paste its contents inside the trusted HTTPS page; never put it in a URL.');
    } else console.log(JSON.stringify(result.value));
    socket.end();
  }
});
socket.on('error', () => { console.error('Local admin request failed'); process.exitCode = 1; });
