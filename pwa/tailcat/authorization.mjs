import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { canonical, publicKey, b64, unb64 } from './protocol.mjs';
import { fault } from '../service.mjs';

export function signed(value, privateJwk) {
  const key = createPrivateKey({key: privateJwk, format: 'jwk'});
  return {...value, signature: sign('sha256', Buffer.from(canonical(value)), {key, dsaEncoding: 'ieee-p1363'}).toString('base64url')};
}
export function validSignature(value, signature, jwk) {
  try {
    const key = createPublicKey({key: publicKey(jwk), format: 'jwk'});
    return unb64(signature).length === 64 && verify('sha256', Buffer.from(canonical(value)), {key, dsaEncoding: 'ieee-p1363'}, Buffer.from(unb64(signature)));
  } catch { return false; }
}
export function originValue(origin) {
  const u = new URL(origin);
  if (u.origin !== origin || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw fault(400, 'invalid_origin');
  return origin;
}
const digest = secret => createHash('sha256').update(secret).digest();

export class DeviceAuthority {
  constructor(dir, now = Date.now) {
    if (!dir || !path.isAbsolute(dir)) throw new Error('Explicit isolated absolute state directory required');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    this.dir = dir; this.now = now; this.file = path.join(dir, 'browser-authority.json');
    try {
      this.state = JSON.parse(readFileSync(this.file, 'utf8'));
      if (this.state.v !== 1 || !this.state.hostId || !this.state.key?.d || !Array.isArray(this.state.devices) || !Array.isArray(this.state.invites)) throw new Error('Invalid authority state');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
      this.state = {v: 1, hostId: 'host_' + randomUUID(), key: privateKey.export({format: 'jwk'}), devices: [], invites: []};
      this.save();
    }
    const {d, ...pub} = this.state.key;
    this.key = publicKey(pub);
  }
  save() {
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const directory = openSync(this.dir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  sign(value) { return signed(value, this.state.key); }
  hello() {
    return this.sign({v: 1, type: 'hello', hostId: this.state.hostId, key: this.key, connection: randomUUID(), nonce: b64(randomBytes(32))});
  }
  mint({address, port, origin, ttl = 300000}) {
    if (!/^tc[A-Za-z0-9_-]{20,5000}$/.test(address) || !Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(ttl) || ttl < 30000 || ttl > 600000) throw fault(400, 'invalid_invitation');
    originValue(origin);
    this.state.invites = this.state.invites.filter(x => !x.used && x.expiresAt > this.now());
    if (this.state.invites.length >= 32) throw fault(429, 'too_many_invites');
    const invitation = {id: randomUUID(), secret: b64(randomBytes(32)), expiresAt: this.now() + ttl};
    this.state.invites.push({...invitation, secret: undefined, hash: digest(invitation.secret).toString('hex'), origin, used: false});
    this.save();
    return this.sign({v: 1, kind: 'pi-remote-tailcat', host: {id: this.state.hostId, key: this.key}, address, port, origin, invitation});
  }
  pair({invitationId, secret, origin, deviceId, key, name}) {
    const invite = this.state.invites.find(x => x.id === invitationId);
    if (!invite || invite.used || invite.expiresAt <= this.now() || invite.origin !== origin || typeof secret !== 'string' || secret.length > 100 || !timingSafeEqual(digest(secret), Buffer.from(invite.hash, 'hex'))) throw fault(401, 'invalid_invitation');
    if (typeof deviceId !== 'string' || !/^device_[\w-]{36}$/.test(deviceId) || this.state.devices.some(d => d.id === deviceId) || typeof name !== 'string' || !name.trim() || name.length > 80) throw fault(400, 'invalid_device');
    if (this.state.devices.length >= 128) throw fault(429, 'too_many_devices');
    key = publicKey(key);
    const grant = this.sign({v: 1, type: 'grant', id: randomUUID(), hostId: this.state.hostId, deviceId, key, origin, role: 'owner', issuedAt: this.now()});
    this.state.devices.push({id: deviceId, name, grant, revokedAt: null});
    invite.used = true;
    // Grant + one-time consumption are one durable atomic state replacement.
    this.save();
    return grant;
  }
  active(id, origin) { return this.state.devices.find(x => x.id === id && x.revokedAt === null && x.grant.origin === origin); }
  revoke(id) {
    const device = this.state.devices.find(d => d.id === id);
    if (!device) throw fault(404, 'device_not_found');
    device.revokedAt = this.now(); this.save();
  }
}
