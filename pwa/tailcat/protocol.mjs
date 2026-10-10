export const VERSION = 1;
export const MAX_FRAME = 128 * 1024;
export const MAX_RESULT = 8 * 1024 * 1024;
export const CHUNK = 24 * 1024;
export const MAX_PENDING = 8;
export const encoder = new TextEncoder();
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new Error('invalid_canonical_value');
}
export function b64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unb64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid_base64');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export function publicKey(key) {
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || 'd' in key || ![key.x, key.y].every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x) && unb64(x).length === 32)) throw new Error('invalid_public_key');
  return {kty: 'EC', crv: 'P-256', x: key.x, y: key.y};
}
export function proof(context, hello, deviceId, value) {
  return {v: VERSION, context, connection: hello.connection, nonce: hello.nonce, hostId: hello.hostId, deviceId, value};
}
export function frame(value) {
  const bytes = encoder.encode(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_FRAME) throw new Error('frame_too_large');
  return bytes;
}
export class Framer {
  constructor() { this.parts = []; this.size = 0; }
  push(bytes) {
    const out = [];
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i !== bytes.length && bytes[i] !== 10) continue;
      const part = bytes.slice(start, i);
      if (this.size + part.length > MAX_FRAME) throw new Error('frame_too_large');
      if (part.length) { this.parts.push(part); this.size += part.length; }
      if (i < bytes.length) {
        const line = new Uint8Array(this.size);
        let offset = 0;
        for (const p of this.parts) { line.set(p, offset); offset += p.length; }
        this.parts = []; this.size = 0;
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(line));
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== VERSION) throw new Error('invalid_frame');
        out.push(value);
      }
      start = i + 1;
    }
    return out;
  }
}
