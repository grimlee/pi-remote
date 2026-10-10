import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

// Exercise the production connection state machine with controlled WASM dials;
// no network, host credentials or provider are involved.
async function worker() {
  const source = (await readFile(new URL('../tailcat/worker.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace('const booted = boot();', 'const booted = Promise.resolve();');
  const timers = new Map(), posted = [];
  let next = 0;
  const context = vm.createContext({crypto:webcrypto,performance,Uint8Array,TextDecoder,
    self:{postMessage:value=>posted.push(value)},
    setTimeout:fn=>{const id=++next;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    clearInterval(){},setInterval(){},tailcatDial:()=>new Promise(()=>{})});
  vm.runInContext(source,context);
  vm.runInContext('config = {address:"isolated-mock"};',context);
  return {context,timers,posted,run:code=>vm.runInContext(code,context)};
}
const flush = () => new Promise(resolve=>setImmediate(resolve));

test('suspend retires a stalled dial and its settlement cannot clear a replacement attempt', async()=>{
  const w=await worker();
  w.run('handshake = () => new Promise(resolve => { (globalThis.dials ||= []).push(resolve); }); globalThis.first = connect();');
  await flush();
  w.run('drop(fail(503,"page_suspended"), false, false); globalThis.second = connect();');
  await flush();
  assert.equal(w.run('dials.length'),2);
  w.run('dials[0]();'); await w.run('first');
  assert.equal(w.run('connectPromise === null'),false);
  w.run('dials[1]();'); await w.run('second');
  assert.equal(w.run('connectPromise === null'),true);
});

test('dial deadline rejects a frozen WASM dial and closes its late candidate', async()=>{
  const w=await worker();
  w.run('tailcatDial = () => new Promise(resolve=>{globalThis.finishDial=resolve;}); globalThis.dial = dialWithDeadline({});');
  const rejected=assert.rejects(w.run('dial'),/dial_timeout/);
  await flush();
  [...w.timers.values()][0](); await rejected;
  w.run('globalThis.closed=0;finishDial({close(){closed++;}});');await flush();
  assert.equal(w.run('closed'),1);
});

test('foreground probes a stale ready socket and reconnects without dispatching commands',async()=>{
  const w=await worker();
  w.run('ready=true;globalThis.ops=[];request=async op=>{ops.push(op);throw fail(503,"stale_socket");};handshake=async()=>{ready=true;globalThis.dials=(globalThis.dials||0)+1;};');
  const result=await w.run('resumeConnection(false)');
  assert.equal(result.configured,true);
  assert.equal(w.run('dials'),1);
  assert.equal(w.run('ops.join(",")'),'ping');
});

test('manual or BFCache resume can replace an in-flight dial before its timeout',async()=>{
  const w=await worker();
  w.run('globalThis.dials=0;handshake=()=>{dials++;return dials===1?new Promise(()=>{}):Promise.resolve();};void connect();');
  await flush();
  assert.equal((await w.run('resumeConnection(true)')).configured,true);
  assert.equal(w.run('dials'),2);
});
