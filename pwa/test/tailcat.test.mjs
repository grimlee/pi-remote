import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Framer, frame, proof, MAX_FRAME, MAX_RESULT, publicKey } from '../tailcat/protocol.mjs';
import { DeviceAuthority, signed, validSignature } from '../tailcat/authorization.mjs';
import { deviceIdentity, signValue, verifySigned } from '../tailcat/identity.mjs';
import { createTailcatGateway, prepareAdminSocket } from '../tailcat/gateway.mjs';
import { PiService } from '../service.mjs';
import { buildStatic } from '../tailcat/build.mjs';
import { staticServer } from '../tailcat/static.mjs';

const origin = 'https://browser.example';
const fakePi = fileURLToPath(new URL('./fake-pi', import.meta.url));
function keypair() {
  const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const key = privateKey.export({format:'jwk'}); const {d, ...pub} = key;
  return {private: key, public: publicKey(pub), id:'device_' + randomUUID()};
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tailcat-security-'));
  const sessions = path.join(root, 'sessions'), state = path.join(root, 'state');
  await mkdir(sessions);
  await writeFile(path.join(sessions, 'session.jsonl'), JSON.stringify({type:'session', id:'session_test_12345', timestamp:'2026-10-10T00:00:00Z', cwd:root})+'\n');
  const app = createTailcatGateway({stateDir:state, sessionDir:sessions, executable:fakePi, workspaces:[root]});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(root, {recursive:true,force:true}); });
  return {root,sessions,state,app,port:app.server.address().port};
}
class Client {
  constructor(port) {
    this.socket = connect(port, '127.0.0.1'); this.socket.on('error', () => {});
    this.reader = new Framer(); this.messages = []; this.waiters = []; this.seq = 0;
    this.socket.on('data', bytes => {
      for (const value of this.reader.push(bytes)) {
        if (this.waiters.length) this.waiters.shift()(value); else this.messages.push(value);
      }
    });
  }
  read() { return this.messages.length ? Promise.resolve(this.messages.shift()) : new Promise(resolve => this.waiters.push(resolve)); }
  send(value) { this.socket.write(frame(value)); }
  async greet() { this.hello = await this.read(); return this.hello; }
  async login(key, invitation) {
    this.key = key;
    const value = invitation ? {v:1,type:'pair',invitationId:invitation.id,secret:invitation.secret,origin,deviceId:key.id,key:key.public,name:'Test device'} : {v:1,type:'auth',deviceId:key.id,origin};
    const signature = signed(proof(invitation?'pair':'auth',this.hello,key.id,value),key.private).signature;
    this.send({...value,signature});
    return this.read();
  }
  request(op,args={},id=randomUUID()) {
    const value={v:1,type:'request',id,seq:++this.seq,op,args};
    const signature=signed(proof('request',this.hello,this.key.id,value),this.key.private).signature;
    this.send({...value,signature}); return id;
  }
  async result(id) {
    const parts=[];
    for (;;) {
      const msg=await this.read();
      if (msg.id!==id) continue;
      if(msg.type==='result.error') throw Object.assign(new Error(msg.error),{status:msg.status});
      if(msg.type==='result.chunk') parts.push(Buffer.from(msg.data,'base64url'));
      if(msg.type==='result.end') return JSON.parse(Buffer.concat(parts).toString());
    }
  }
  async call(op,args) { return this.result(this.request(op,args)); }
  close(){this.socket.destroy();}
}
async function paired(t,f) {
  const client=new Client(f.port); t.after(()=>client.close());
  await client.greet(); const key=keypair();
  const bundle=f.app.authority.mint({address:'tc'+'a'.repeat(100),port:f.port,origin});
  const ready=await client.login(key,bundle.invitation);
  assert.equal(ready.type,'ready');
  const {signature,...grant}=ready.grant; assert.ok(validSignature(grant,signature,f.app.authority.key));
  return {client,key,bundle};
}
test('framing accepts split Unicode and rejects malformed, oversized and versionless data',()=>{
  const bytes=frame({v:1,value:'长🙂\u2028text'}); const r=new Framer(); const messages=[];
  for(const byte of bytes) messages.push(...r.push(Uint8Array.of(byte)));
  assert.equal(messages[0].value,'长🙂\u2028text');
  assert.throws(()=>new Framer().push(new Uint8Array(MAX_FRAME+1)),/frame_too_large/);
  assert.throws(()=>new Framer().push(Buffer.from('{"v":2}\n')),/invalid_frame/);
  assert.throws(()=>new Framer().push(Uint8Array.of(255,10)));
});
test('nonextractable WebCrypto P-256 signatures interoperate with Host and tampering fails',async()=>{
  const identity=await deviceIdentity(); const value={v:1,test:'真实浏览器签名'};
  const envelope=await signValue(identity,value);
  assert.equal(identity.privateKey.extractable,false);
  await assert.rejects(crypto.subtle.exportKey('jwk',identity.privateKey));
  assert.ok(validSignature(value,envelope.signature,identity.key));
  assert.ok(await verifySigned(envelope,identity.key));
  assert.equal(await verifySigned({...envelope,test:'changed'},identity.key),false);
});
test('one-time pairing is origin bound, expires, survives restart and does not store the invitation secret',async t=>{
  const f=await fixture(t); const key=keypair(); let now=Date.now();
  const authority=new DeviceAuthority(path.join(f.root,'other-state'),()=>now);
  const bundle=authority.mint({address:'tc'+'a'.repeat(100),port:f.port,origin,ttl:30000});
  const fields={deviceId:key.id,key:key.public,name:'device',origin,invitationId:bundle.invitation.id,secret:bundle.invitation.secret};
  assert.throws(()=>authority.pair({...fields,origin:'https://evil.example'}),/invalid_invitation/);
  assert.throws(()=>authority.pair({...fields,secret:'wrong'}),/invalid_invitation/);
  authority.pair(fields); assert.throws(()=>authority.pair({...fields,deviceId:'device_'+randomUUID()}),/invalid_invitation/);
  const loaded=new DeviceAuthority(authority.dir); assert.ok(loaded.active(key.id,origin)); loaded.revoke(key.id);
  assert.equal(new DeviceAuthority(authority.dir).active(key.id,origin),undefined);
  assert.doesNotMatch(await readFile(authority.file,'utf8'),new RegExp(bundle.invitation.secret));
  assert.equal((await stat(authority.file)).mode&0o777,0o600);
  const later=authority.mint({address:'tc'+'b'.repeat(100),port:f.port,origin,ttl:30000}); now+=30001;
  assert.throws(()=>authority.pair({...fields,invitationId:later.invitation.id,secret:later.invitation.secret}),/invalid_invitation/);
});
test('unauthenticated and replayed frames cannot invoke Agent operations',async t=>{
  const f=await fixture(t); const bad=new Client(f.port); await bad.greet();
  const closed=once(bad.socket,'close'); bad.send({v:1,type:'request',id:randomUUID(),seq:1,op:'sessions.list',args:{}}); await closed;
  const {client}=await paired(t,f); const id=client.request('sessions.list'); assert.equal((await client.result(id)).sessions.length,1);
  const value={v:1,type:'request',id,seq:1,op:'sessions.list',args:{}};
  const replay=signed(proof('request',client.hello,client.key.id,value),client.key.private).signature;
  const gone=once(client.socket,'close'); client.send({...value,signature:replay}); await gone;
  assert.equal(f.app.service.runners.size,0);
});
test('connection challenge blocks cross-connection replay and revoked devices fail before RPC',async t=>{
  const f=await fixture(t); const {client,key}=await paired(t,f);
  const other=new Client(f.port); await other.greet();
  const value={v:1,type:'auth',deviceId:key.id,origin};
  const signature=signed(proof('auth',client.hello,key.id,value),key.private).signature;
  const closed=once(other.socket,'close'); other.send({...value,signature}); await closed;
  f.app.authority.revoke(key.id);
  const ended=once(client.socket,'close'); client.request('session.state',{sessionId:'session_test_12345'}); await ended;
  assert.equal(f.app.service.runners.size,0);
});
test('authorized requests reuse RPC, pagination and durable command receipts across disconnect',async t=>{
  const f=await fixture(t); const {client,key}=await paired(t,f);
  assert.equal((await client.call('sessions.list',{offset:0,limit:1})).sessions.length,1);
  const command={type:'prompt',commandId:randomUUID(),message:'only_once'};
  const args={sessionId:'session_test_12345',command};
  const accepted=await client.call('command.dispatch',args); assert.equal(accepted.status,'accepted');
  assert.equal((await client.call('command.dispatch',args)).deduplicated,true);
  await assert.rejects(client.call('command.dispatch',{...args,command:{...command,message:'different'}}),/command_id_conflict/);
  client.close(); const reconnected=new Client(f.port); t.after(()=>reconnected.close()); await reconnected.greet(); await reconnected.login(key);
  assert.equal((await reconnected.call('command.receipt',{commandId:command.commandId})).status,'accepted');
  const snapshot=await reconnected.call('session.state',{sessionId:'session_test_12345'});
  assert.equal(snapshot.messages.filter(m=>m.content?.[0]?.text==='only_once').length,1);
  assert.equal(snapshot.state.sessionFile,undefined);
  await assert.rejects(reconnected.call('session.state',{sessionId:'session_test_12345',limit:161}),/invalid_page/);
  await assert.rejects(reconnected.call('rpc',{type:'bash',command:'anything'}),/unsupported_operation/);
});
test('large UTF-8 snapshots and stream events cross multiple bounded frames intact',async t=>{
  const f=await fixture(t); const {client}=await paired(t,f);
  const sessionId='session_test_12345';
  const sub=await client.call('session.subscribe',{sessionId,since:0}); assert.ok(sub.subscription);
  await client.call('command.dispatch',{sessionId,command:{type:'prompt',commandId:randomUUID(),message:'long_test'}});
  await new Promise(resolve=>setTimeout(resolve,100));
  const snapshot=await client.call('session.state',{sessionId});
  const text=snapshot.messages.find(m=>m.role==='assistant').content[0].text;
  assert.equal(text,'word '.repeat(10000)+'长🙂'.repeat(20000));
  assert.ok(Buffer.byteLength(text)>MAX_FRAME);
  assert.equal((await client.call('session.unsubscribe',{subscription:sub.subscription})).ok,true);
});
test('create, rename, models and abort have deduplicated mutation receipts',async t=>{
  const f=await fixture(t); const {client}=await paired(t,f); const sessionId='session_test_12345';
  const mutate=command=>client.call('command.dispatch',{sessionId,command:{commandId:randomUUID(),...command}});
  assert.equal((await mutate({type:'rename',name:'renamed'})).status,'accepted');
  assert.equal((await client.call('sessions.list')).sessions[0].name,'renamed');
  assert.equal((await client.call('models.list',{sessionId})).models[0].provider,'mock');
  assert.equal((await mutate({type:'set_model',provider:'mock',modelId:'changed'})).status,'accepted');
  assert.equal((await mutate({type:'abort'})).status,'accepted');
  const cmd={type:'create',commandId:randomUUID(),cwd:f.root,name:'new session'};
  const args={sessionId:'new_session',command:cmd};
  assert.equal((await client.call('command.dispatch',args)).status,'accepted');
  assert.equal((await client.call('command.dispatch',args)).deduplicated,true);
  assert.equal((await client.call('sessions.list')).sessions.length,2);
  await assert.rejects(client.call('command.dispatch',{...args,command:{...cmd,commandId:randomUUID(),cwd:'/'}}),/workspace_not_allowed/);
});
test('parallel command IDs reserve once and ambiguous receipts are never re-dispatched',async t=>{
  const f=await fixture(t);
  const cmd={type:'prompt',commandId:randomUUID(),message:'parallel'};
  const [a,b]=await Promise.all([f.app.service.command('session_test_12345',cmd),f.app.service.command('session_test_12345',cmd)]);
  assert.ok(a.deduplicated||b.deduplicated);
  assert.equal((await f.app.service.snapshot('session_test_12345')).messages.filter(m=>m.content?.[0]?.text==='parallel').length,1);
  const before=f.app.service.ledger.get(cmd.commandId); f.app.service.ledger.save({...before,status:'unknown'});
  assert.equal((await f.app.service.command('session_test_12345',cmd)).status,'unknown');
});
test('authenticated retirement of a missing receipt durably rejects late dispatch without starting Pi',async t=>{
  const f=await fixture(t);const {client}=await paired(t,f);const commandId=randomUUID();
  await assert.rejects(client.call('command.receipt',{commandId}),/command_not_found/);
  assert.equal((await client.call('command.retire',{commandId})).status,'not_dispatched');
  const command={type:'create',commandId,cwd:f.root,name:'late request'};
  await assert.rejects(client.call('command.dispatch',{sessionId:'new_session',command}),/command_retired/);
  assert.equal((await client.call('sessions.list')).sessions.length,1);
  assert.equal(f.app.service.runners.size,0);
  const restarted=new PiService({stateDir:f.state,sessionDir:f.sessions,executable:fakePi,workspaces:[f.root],strictWorkspaces:true});
  t.after(()=>restarted.close());
  assert.equal(restarted.receipt(commandId).status,'not_dispatched');
  await assert.rejects(restarted.command('new_session',command),/command_retired/);
});
test('retirement fences an already-arrived create awaiting discovery before reservation',async t=>{
  const f=await fixture(t);const service=f.app.service,commandId=randomUUID();
  const refresh=service.refreshSessions.bind(service);let release,entered;
  const reached=new Promise(resolve=>{entered=resolve;});
  service.refreshSessions=async(...args)=>{entered();await new Promise(resolve=>{release=resolve;});return refresh(...args);};
  const creating=service.command('new_session',{type:'create',commandId,cwd:f.root,name:'must not execute'});
  const rejected=assert.rejects(creating,/command_retired/);await reached;
  assert.equal(service.retireMissing(commandId).status,'not_dispatched');release();await rejected;
  assert.equal(service.temporaryRunners.size,0);assert.equal(service.runners.size,0);
  assert.equal((await refresh()).length,1);
});
test('retirement preserves accepted and unknown receipts and rejects unauthenticated callers',async t=>{
  const f=await fixture(t);const {client}=await paired(t,f);
  const commandId=randomUUID();await client.call('command.dispatch',{sessionId:'session_test_12345',command:{type:'prompt',commandId,message:'only once'}});
  assert.equal((await client.call('command.retire',{commandId})).status,'accepted');
  const existing=f.app.service.ledger.get(commandId);f.app.service.ledger.save({...existing,status:'unknown'});
  assert.equal((await client.call('command.retire',{commandId})).status,'unknown');
  assert.equal((await f.app.service.snapshot('session_test_12345')).messages.filter(m=>m.content?.[0]?.text==='only once').length,1);
  const anonymous=new Client(f.port);t.after(()=>anonymous.close());await anonymous.greet();anonymous.key=keypair();
  const neverAuthorized=randomUUID(),closed=once(anonymous.socket,'close');
  anonymous.request('command.retire',{commandId:neverAuthorized});await closed;
  assert.equal(f.app.service.ledger.get(neverAuthorized),undefined);
});
test('local admin socket revokes an active connection immediately',async t=>{
  const f=await fixture(t); const {client,key}=await paired(t,f);
  const file=f.app.listenAdmin(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await stat(file)).mode&0o777,0o600);
  const admin=new Client(file); const closed=once(client.socket,'close');
  admin.send({v:1,op:'device.revoke',args:{deviceId:key.id}});
  assert.equal((await admin.read()).value.ok,true); admin.close(); await closed;
});
test('cancellation discards a slow read while a live signed connection remains usable',async t=>{
  const f=await fixture(t); const {client}=await paired(t,f);
  let release; f.app.service.snapshot=()=>new Promise(resolve=>{release=resolve;});
  const id=client.request('session.state',{sessionId:'session_test_12345'});
  await client.call('request.cancel',{id});
  release({state:{},messages:[],cursor:0}); await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(client.messages.some(m=>m.id===id),false);
  assert.equal((await client.call('ping')).ok,true);
});
test('oversized state is rejected before transmission without breaking authorization',async t=>{
  const f=await fixture(t); const {client}=await paired(t,f);
  f.app.service.snapshot=async()=>({state:{},cursor:0,messages:[{role:'assistant',content:'x'.repeat(MAX_RESULT+1)}]});
  await assert.rejects(client.call('session.state',{sessionId:'session_test_12345'}),/result_too_large/);
  assert.equal((await client.call('ping')).ok,true);
});
test('built static host serves only hashed program assets and rejects Agent, keys, queries and mutations',async t=>{
  const f=await fixture(t); const wasm=path.join(f.root,'wasm'); await mkdir(wasm);
  await writeFile(path.join(wasm,'wasm_exec.js'),'// mock static routing fixture');
  await writeFile(path.join(wasm,'main.wasm.gz'),Buffer.from('mock'));
  await writeFile(path.join(wasm,'TAILCAT-LICENSE'),'test fixture license');
  await writeFile(path.join(wasm,'private-key'),'must never copy');
  const out=path.join(f.root,'static'); await buildStatic(wasm,out);
  await assert.rejects(readFile(path.join(out,'private-key')),{code:'ENOENT'});
  const web=await staticServer(out); await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>web.close(resolve)));
  const base='http://127.0.0.1:'+web.address().port;
  const home=await fetch(base); assert.match(await home.text(),/一次性设备配对码/);
  assert.match(home.headers.get('content-security-policy'),/worker-src 'self'/);
  assert.equal((await fetch(base+'/recover.html')).status,200);
  assert.match(await (await fetch(base+'/recover.mjs')).text(),/pi-remote-tailcat-shell-/);
  for(const target of ['/api/sessions','/browser-authority.json','/admin.sock','/?token=secret']) assert.equal((await fetch(base+target)).status,404);
  assert.equal((await fetch(base,{method:'POST',body:'secret'})).status,405);
  assert.equal((await fetch(base+'/main.wasm.gz')).headers.get('content-encoding'),null);
  await writeFile(path.join(out,'worker.mjs'),'tampered');
  await assert.rejects(staticServer(out),/hash mismatch/);
});
test('shutdown during pending discovery cannot start a new Pi process or reserve a new command',async t=>{
  const f=await fixture(t);
  const creating=f.app.service.command('new_session',{type:'create',commandId:randomUUID(),cwd:f.root,name:'must not start'});
  f.app.service.close();
  await assert.rejects(creating,/service_closed/);
  assert.equal(f.app.service.runners.size,0);
  assert.equal(f.app.service.temporaryRunners.size,0);
  await assert.rejects(f.app.service.runnerFor('session_test_12345'),/service_closed/);
});

test('Tailcat refuses executable fallback and unconfigured workspaces',async t=>{
  const f=await fixture(t);
  assert.throws(()=>createTailcatGateway({stateDir:f.state,sessionDir:f.sessions,workspaces:[f.root]}),/Explicit absolute Pi executable/);
  assert.throws(()=>createTailcatGateway({stateDir:f.state,sessionDir:f.sessions,executable:fakePi,workspaces:[]}),/workspace allowlist/);
});
test('Tailcat rejects session-header workspace escalation, traversal and symlink replacement',async t=>{
  const f=await fixture(t); const {client}=await paired(t,f);
  await writeFile(path.join(f.sessions,'escape.jsonl'),JSON.stringify({type:'session',id:'session_escape_12345',timestamp:new Date().toISOString(),cwd:'/'})+'\n');
  const listed=await client.call('sessions.list');
  assert.deepEqual(listed.workspaces,[f.root]); assert.equal(listed.sessions.length,1);
  await assert.rejects(client.call('session.state',{sessionId:'session_escape_12345'}),/session_not_found/);
  await assert.rejects(client.call('session.state',{sessionId:'../session.jsonl'}),/invalid_session/);
  await assert.rejects(client.call('command.dispatch',{sessionId:'new_session',command:{type:'create',commandId:randomUUID(),cwd:'/',name:'escape'}}),/workspace_not_allowed/);
  assert.equal(f.app.service.runners.size,0);
  const outside=path.join(f.root,'outside.jsonl');
  await writeFile(outside,JSON.stringify({type:'session',id:'session_test_12345',timestamp:new Date().toISOString(),cwd:f.root})+'\n');
  await rm(path.join(f.sessions,'session.jsonl')); await symlink(outside,path.join(f.sessions,'session.jsonl'));
  await assert.rejects(client.call('session.state',{sessionId:'session_test_12345'}),/workspace_not_allowed/);
  assert.equal(f.app.service.runners.size,0);
});
test('invalid device signature cannot consume an invite or start RPC',async t=>{
  const f=await fixture(t); const key=keypair(); const bad=new Client(f.port); await bad.greet();
  const bundle=f.app.authority.mint({address:'tc'+'a'.repeat(100),port:f.port,origin});
  const closed=once(bad.socket,'close');
  bad.send({v:1,type:'pair',deviceId:key.id,key:key.public,origin,name:'bad',invitationId:bundle.invitation.id,secret:bundle.invitation.secret,signature:'x'.repeat(86)});
  await closed; assert.equal(f.app.authority.state.devices.length,0); assert.equal(f.app.authority.state.invites[0].used,false);
  assert.equal(f.app.service.runners.size,0);
});
test('restart removes only a stale owned admin socket and preserves active or non-socket files',async t=>{
  const f=await fixture(t); const file=f.app.listenAdmin();await new Promise(r=>setImmediate(r));
  await assert.rejects(prepareAdminSocket(f.state),/already active/);
  const other=path.join(f.root,'restart-state');await mkdir(other);
  const stale=path.join(other,'admin.sock');
  execFileSync(process.execPath,['--input-type=module','-e',"import {createServer} from 'node:net';createServer().listen(process.argv[1],()=>process.exit(0));",stale],{env:{}});
  await prepareAdminSocket(other);await assert.rejects(stat(stale),{code:'ENOENT'});
  await writeFile(stale,'must preserve');await assert.rejects(prepareAdminSocket(other),/non-owned admin socket/);
  assert.equal(await readFile(stale,'utf8'),'must preserve');assert.ok((await stat(file)).isSocket());
});
