import { canonical, encoder, b64, unb64, publicKey } from './protocol.mjs';

export async function verifySigned(signed, key) {
  const {signature, ...value} = signed;
  try {
    const imported = await crypto.subtle.importKey('jwk', publicKey(key), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
    return await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, imported, unb64(signature), encoder.encode(canonical(value)));
  } catch { return false; }
}
export async function deviceIdentity() {
  const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
  if (pair.privateKey.extractable) throw new Error('extractable_device_key');
  const key = publicKey(await crypto.subtle.exportKey('jwk', pair.publicKey));
  const identity = {id: 'device_' + crypto.randomUUID(), privateKey: pair.privateKey, key,
    wrappingKey: await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])};
  const test = await signValue(identity, {test: 'pi-remote-browser-key-check'});
  if (!await verifySigned(test, key)) throw new Error('crypto_self_test_failed');
  return identity;
}
export async function signValue(identity, value) {
  const signature = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, identity.privateKey, encoder.encode(canonical(value)));
  return {...value, signature: b64(new Uint8Array(signature))};
}
async function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pi-remote-tailcat-device-v1', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('device');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('secure_key_storage_unavailable'));
  });
}
export async function storageOperation(mode, value) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('device', mode);
      const req = mode === 'readonly' ? tx.objectStore('device').get('current') : tx.objectStore('device').put(value, 'current');
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(new Error('secure_key_storage_unavailable'));
    });
  } finally { db.close(); }
}
export async function loadDevice() {
  let row = await storageOperation('readonly');
  if (!row) {
    row = {identity: await deviceIdentity(), sealed: null};
    await storageOperation('readwrite', row);
    row = await storageOperation('readonly');
  }
  if (!row.identity?.privateKey || row.identity.privateKey.extractable || row.identity.wrappingKey.extractable) throw new Error('secure_key_storage_unavailable');
  const config = row.sealed ? JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: row.sealed.iv}, row.identity.wrappingKey, row.sealed.bytes))) : null;
  return {identity: row.identity, config};
}
export async function saveDevice(identity, config) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, identity.wrappingKey, encoder.encode(JSON.stringify(config)));
  await storageOperation('readwrite', {identity, sealed: {iv, bytes}});
}
