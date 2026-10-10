// Explicit opt-in smoke test: creates ONLY temporary sessions/workspaces.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPwaServer} from '../server.mjs';
const executable=process.env.PI_REAL_EXECUTABLE;if(!executable)throw new Error('Set PI_REAL_EXECUTABLE to the installed Pi CLI');
const dir=await mkdtemp(path.join(os.tmpdir(),'pi-core-parity-'));const cwd=path.join(dir,'workspace');await mkdir(cwd,{mode:0o700});
const options={stateDir:path.join(dir,'state'),sessionDir:path.join(dir,'sessions'),workspaces:[cwd],executable};
let app;let base;let headers;
async function open(){app=createPwaServer(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;headers={Cookie:app.auth.cookie({headers:{host:'localhost'}}).split(';')[0],'Content-Type':'application/json'};}
async function api(url,body){const r=await fetch(base+url,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,'RPC HTTP '+r.status+' '+v.error);return v;}
await open();let report={};
try {
 const w=(await api('/api/workspaces')).workspaces[0];const s=(await api('/api/sessions',{workspaceId:w.id,commandId:'real-create-command-0001'})).session;const url='/api/sessions/'+s.id;
 const state=await api(url+'/state');const control=await api(url+'/controls');assert.ok(control.models.length);assert.equal(state.state.sessionId,s.id);
 const original=state.state.model;const alternate=control.models.find(m=>m.provider===original.provider&&m.id!==original.id&&m.input.includes('text'));assert.ok(alternate);
 const command=async(type,values,n)=>api(url+'/commands',{type,...values,generation:s.generation,commandId:'real-'+type+'-command-'+n});
 await command('set_session_name',{name:'Core Parity RPC Smoke'},'0001');
 await command('set_model',{provider:alternate.provider,modelId:alternate.id},'0001');assert.equal((await api(url+'/state')).state.model.id,alternate.id);

 // Empty sessions aren't flushed by Pi until the first assistant; verify our
 // ownership manifest + --session-id path before prompting.
 await app.close();await open();assert.ok((await api('/api/sessions')).sessions.some(x=>x.id===s.id));const emptyRestored=(await api(url+'/state')).state;assert.equal(emptyRestored.sessionId,s.id);assert.equal(emptyRestored.sessionName,'Core Parity RPC Smoke');assert.equal(emptyRestored.model.id,alternate.id);
 await command('set_model',{provider:original.provider,modelId:original.id},'0002');assert.equal((await api(url+'/state')).state.model.id,original.id);
 await command('set_session_name',{name:'Core Parity RPC Smoke'},'0002');
 const prompt={type:'prompt',message:'Respond with a short Markdown heading, a two-row table and a fenced JavaScript block. Use the bash tool twice: first run printf CORE_PARITY_TOOL_OK; then run printf CORE_PARITY_SECOND_OK. Do not change any files.',generation:s.generation,commandId:'real-prompt-command-0001'};
 await api(url+'/commands',prompt);assert.equal((await api(url+'/commands',prompt)).deduplicated,true);
 const deadline=Date.now()+180000;let final;
 while(Date.now()<deadline){final=await api(url+'/state');if(!final.busy && final.messages.some(m=>m.role==='assistant'))break;await new Promise(r=>setTimeout(r,500));}
 assert.ok(!final.busy);assert.equal(final.messages.filter(m=>m.role==='user').length,1);assert.ok(final.messages.some(m=>m.role==='assistant'&&m.stopReason!=='error'));
 assert.ok(final.messages.filter(m=>m.role==='toolResult').length>=2);

 await app.close();await open();const reopened=await api(url+'/state');assert.equal(reopened.state.sessionId,s.id);assert.equal(reopened.messages.length,final.messages.length);
 report={passed:true,created:true,renamed:true,modelSwitchAndBack:true,emptySessionReopen:true,promptDeduplicated:true,historyReopen:true,models:control.models.length,messages:final.messages.length,toolResults:final.messages.filter(m=>m.role==='toolResult').length,thinking:final.messages.some(m=>m.content?.some?.(c=>c.type==='thinking')),workspace:dir};
 console.log(JSON.stringify(report));if(process.env.PI_REAL_REPORT)await writeFile(process.env.PI_REAL_REPORT,JSON.stringify(report,null,2));
}finally{await app.close();}
