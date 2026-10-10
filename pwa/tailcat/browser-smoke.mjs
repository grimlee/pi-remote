// Optional end-to-end acceptance with official WASM, an ephemeral Tailcat sidecar
// and mock Pi only. Never opens production sessions or calls a provider.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createTailcatGateway } from './gateway.mjs';
import { buildStatic } from './build.mjs';
import { staticServer } from './static.mjs';
import { verifyStartup } from './startup-checks.mjs';

const [wasmDir, tailcatBin, kind='chromium', reconnects='2'] = process.argv.slice(2);
if (!wasmDir || !tailcatBin) throw new Error('Usage: browser-smoke.mjs WASM_DIR TAILCAT_BINARY [chromium|webkit] [RECONNECT_COUNT]');
const playwright = await import(process.env.PI_REMOTE_PLAYWRIGHT_MODULE || 'playwright');
const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-tailcat-browser-'));
let app, web, sidecar, browser;
try {
  const sessionDir = path.join(temp, 'sessions'); await mkdir(sessionDir);
  await writeFile(path.join(sessionDir, 'session.jsonl'), JSON.stringify({type:'session',id:'session_test_12345',timestamp:'2026-10-10T00:00:00Z',cwd:temp})+'\n');
  app = createTailcatGateway({stateDir:path.join(temp,'state'),sessionDir,workspaces:[temp],executable:fileURLToPath(new URL('../test/fake-pi',import.meta.url))});
  const sockets = new Set();
  app.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const port = app.server.address().port;
  const out=path.join(temp,'static'); await buildStatic(wasmDir,out);
  web=await staticServer(out); await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+web.address().port;
  const addressFile=path.join(temp,'address');
  sidecar=spawn(tailcatBin,['serve','--key=new',String(port)],{env:{...process.env,XDG_CONFIG_HOME:path.join(temp,'tailcat'),TAILCAT_ADDR_FILE:addressFile},stdio:['ignore','ignore','ignore']});
  let address;
  for(let i=0;i<60;i++) {
    try { address=(await readFile(addressFile,'utf8')).trim(); if(address) break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(address,'sidecar address ready');
  const launch={headless:true};
  if(kind==='chromium'&&process.env.PI_REMOTE_CHROMIUM) launch.executablePath=process.env.PI_REMOTE_CHROMIUM;
  if(kind==='webkit'&&process.env.PI_REMOTE_WEBKIT_ROOT) {
    const w=process.env.PI_REMOTE_WEBKIT_ROOT;
    launch.executablePath=w+'/bin/MiniBrowser';
    launch.env={...process.env,WEBKIT_EXEC_PATH:w+'/bin',WEBKIT_INJECTED_BUNDLE_PATH:w+'/lib',WEBKIT_INSPECTOR_RESOURCES_PATH:w+'/share',LD_LIBRARY_PATH:w+'/lib:'+w+'/sys/lib:'+process.env.PI_REMOTE_WEBKIT_COMPAT};
  }
  browser=await playwright[kind].launch(launch);
  await verifyStartup(browser,origin);
  const phoneContext=await browser.newContext({viewport:{width:390,height:844}});
  let page=await phoneContext.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message.replace(/tc[A-Za-z0-9_-]{20,}/g,'tc[REDACTED]')));
  const requests=[]; page.on('request',r=>requests.push(new URL(r.url()).pathname));
  await page.goto(origin);
  await page.locator('#loginView').waitFor({state:'visible',timeout:60000});
  const bundle=app.authority.mint({address,port,origin});
  await page.locator('#token').fill(JSON.stringify(bundle));
  await page.locator('#loginForm button').click();
  await page.locator('#appView').waitFor({state:'visible',timeout:90000});
  await page.waitForFunction(()=>document.getElementById('sessions').textContent.includes('Untitled session'),{timeout:30000});
  await page.evaluate(()=>document.querySelector('#sessions .session')?.click());
  await page.locator('#prompt').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('#prompt').disabled,{timeout:30000});
  const state=await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions/session_test_12345/state'));
  assert.equal(state.messages.length,1);
  // Verify structured-cloned keys and sealed configuration on this engine.
  const cryptoState=await page.evaluate(async()=>{
    const {loadDevice}=await import('/identity.mjs'); const {identity,config}=await loadDevice();
    return {privateExtractable:identity.privateKey.extractable,wrappingExtractable:identity.wrappingKey.extractable,grant:config.grant.role};
  });
  assert.deepEqual(cryptoState,{privateExtractable:false,wrappingExtractable:false,grant:'owner'});
  const diagnostics=await page.evaluate(()=>window.piRemoteTransport.diagnostics());
  assert.ok(diagnostics.wasmStartupMs>0); assert.equal(diagnostics.state,'connected'); assert.ok(diagnostics.handshakesMs[0]>0);
  const snapshot=app.service.snapshot.bind(app.service);
  app.service.snapshot=async id=>{await new Promise(resolve=>setTimeout(resolve,500));return snapshot(id);};
  const cancelled=await page.evaluate(async()=>{
    const controller=new AbortController(); setTimeout(()=>controller.abort(),100);
    try {await window.piRemoteTransport.api('/api/sessions/session_test_12345/state',{signal:controller.signal});return 0;}
    catch(error){return error.status;}
  });
  assert.equal(cancelled,499); app.service.snapshot=snapshot;
  await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions/session_test_12345/state'));
  const invalid = await page.evaluate(async () => {
    try {
      await window.piRemoteTransport.api('/api/sessions/session_test_12345/commands', {method:'POST',body:JSON.stringify({type:'prompt',commandId:crypto.randomUUID(),message:''})});
      return 0;
    } catch(error) { return error.status; }
  });
  assert.equal(invalid,400,'a definitively rejected request must not block later mutations');
  // Reproduce the phone's stale localStorage + sealed Worker ID, for which
  // the Host has no receipt. A terminal ledger reservation must unblock create.
  const staleId=await page.evaluate(async()=>{
    const id=crypto.randomUUID();const pending={id,sessionId:'new_session',type:'create'};
    localStorage.setItem('pi-remote-pending-mutation',JSON.stringify(pending));
    const {loadDevice,saveDevice}=await import('/identity.mjs');const {identity,config}=await loadDevice();
    config.pendingMutations=[pending];await saveDevice(identity,config);return id;
  });
  await page.reload();await page.locator('#appView').waitFor({state:'visible',timeout:90000});
  await page.locator('#openSidebar').click();
  await page.locator('#newSession').click();
  await page.locator('#newSessionName').fill('Phone created mock');
  await page.locator('#createSession').click();
  await page.waitForFunction(()=>document.getElementById('sessionTitle').textContent==='Phone created mock');
  const createdList=await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions'));
  const created=createdList.sessions.find(s=>s.name==='Phone created mock');
  assert.ok(created,'inline creation reaches Mock Pi');
  assert.equal(app.service.receipt(staleId).status,'not_dispatched');
  assert.equal(await page.evaluate(()=>localStorage.getItem('pi-remote-pending-mutation')),null);
  const late=await page.evaluate(async id=>{
    try {await window.piRemoteTransport.api('/api/sessions/session_test_12345/commands',{method:'POST',body:JSON.stringify({type:'prompt',commandId:id,message:'must not execute'})});return null;}
    catch(error){return error.message;}
  },staleId);
  assert.equal(late,'command_retired');
  await page.locator('#prompt').fill('created session prompt');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.getElementById('messages').textContent.includes('mock reply'));
  const createdState=await page.evaluate(id=>window.piRemoteTransport.api('/api/sessions/'+id+'/state'),created.id);
  assert.equal(createdState.messages.filter(m=>m.content?.[0]?.text==='created session prompt').length,1);
  await page.locator('#openSidebar').click();
  await page.locator('#sessions .session').filter({hasText:'Untitled session'}).click();
  await page.locator('#prompt').fill('long_test'); await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.getElementById('messages').textContent.includes('长🙂'),{timeout:30000});
  const transcript=await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions/session_test_12345/state'));
  assert.equal(transcript.messages.find(m=>m.role==='assistant').content[0].text,'word '.repeat(10000)+'长🙂'.repeat(20000));
  // Lose the reply AFTER durable acceptance, then terminate the browser worker
  // through reload. Sealed pending IDs must reconcile without resending a prompt.
  const command = app.service.command.bind(app.service);
  let dropped = false;
  app.service.command = async (id, body) => {
    const result = await command(id, body);
    if (body.message === 'uncertain_test' && !dropped) { dropped = true; for (const socket of sockets) socket.destroy(); }
    return result;
  };
  const ambiguous = await page.evaluate(async () => {
    try {
      await window.piRemoteTransport.api('/api/sessions/session_test_12345/commands', {method:'POST', body:JSON.stringify({type:'prompt',commandId:crypto.randomUUID(),message:'uncertain_test'})});
      return false;
    } catch { return true; }
  });
  assert.equal(ambiguous, true);
  await page.reload(); await page.locator('#appView').waitFor({state:'visible',timeout:90000});
  const recovered=await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions/session_test_12345/state'));
  assert.equal(recovered.messages.filter(m=>m.content?.[0]?.text==='uncertain_test').length,1);
  const timings=[];
  for(let i=0;i<Number(reconnects);i++) {
    const started=Date.now();
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('实时事件流已连接'),{timeout:90000});
    const snapshot=await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions/session_test_12345/state'));
    assert.equal(snapshot.messages.filter(m=>m.content?.[0]?.text==='long_test').length,1);
    timings.push(Date.now()-started); console.log(JSON.stringify({kind,reconnect:i+1,ms:timings.at(-1)}));
  }
  // Reload must recover the same device grant without consuming another invite.
  await page.reload(); await page.locator('#appView').waitFor({state:'visible',timeout:90000});
  assert.equal(app.authority.state.devices.length,1);
  const after=await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions/session_test_12345/state'));
  assert.equal(after.messages.filter(m=>m.content?.[0]?.text==='long_test').length,1);
  const storedIdentity = await page.evaluate(async()=>{
    const {loadDevice}=await import('/identity.mjs');
    localStorage.setItem('tailcat-regression-preserve','keep');
    await caches.open('unrelated-cache-regression');
    return (await loadDevice()).identity.id;
  });
  await page.goto(origin+'/recover.html');
  await page.waitForURL('**/index.html');
  await page.locator('#appView').waitFor({state:'visible',timeout:90000});
  const restored=await page.evaluate(async()=>{
    const {loadDevice}=await import('/identity.mjs');
    return {id:(await loadDevice()).identity.id,local:localStorage.getItem('tailcat-regression-preserve'),unrelated:(await caches.keys()).includes('unrelated-cache-regression')};
  });
  assert.deepEqual(restored,{id:storedIdentity,local:'keep',unrelated:true});
  assert.equal(app.authority.state.devices.length,1);
  // A killed Safari page gets a fresh Worker in the same browser data store.
  // It must restore its grant and selected session without manual reconnect.
  await page.close();page=await phoneContext.newPage();
  await page.goto(origin);await page.locator('#appView').waitFor({state:'visible',timeout:90000});
  await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('已连接'),null,{timeout:90000});
  assert.equal(await page.evaluate(async()=>{const {loadDevice}=await import('/identity.mjs');return (await loadDevice()).identity.id;}),storedIdentity);
  assert.equal((await page.evaluate(()=>window.piRemoteTransport.api('/api/sessions/session_test_12345/state'))).messages.filter(m=>m.content?.[0]?.text==='long_test').length,1);
  assert.equal(requests.some(p=>p.startsWith('/api/')),false,'no API request to static origin');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({kind,pairing:true,nonextractableKeys:true,workerWasm:true,diagnostics:true,startupFailureVisible:true,backgroundDuringStartup:true,cacheRecoveryPreservesIdentity:true,staleMissingReceiptRecovered:true,lateRetiredCommandRejected:true,inlineSessionCreation:true,createdSessionPrompt:true,pageCloseReopenAutoConnect:true,cancellation:true,longUnicodeReply:true,lostReplyReconciled:true,reload:true,duplicatePrompts:0,reconnects:timings.length,staticApiRequests:0}));
} finally {
  await browser?.close();
  if(sidecar&&!sidecar.killed){const closed=once(sidecar,'exit');sidecar.kill('SIGTERM');await closed;}
  if(web)await new Promise(resolve=>web.close(resolve));
  if(app)await app.close();
  await rm(temp,{recursive:true,force:true});
}
