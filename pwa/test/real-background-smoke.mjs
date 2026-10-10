import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createPwaServer} from '../server.mjs';
const executable=process.env.PI_REAL_EXECUTABLE;if(!executable)throw new Error('Set PI_REAL_EXECUTABLE');
const dir=await mkdtemp(path.join(os.tmpdir(),'pi-parity-background-'));const cwd=path.join(dir,'workspace');await mkdir(cwd);const app=createPwaServer({stateDir:path.join(dir,'state'),sessionDir:path.join(dir,'sessions'),workspaces:[cwd],executable,piArgs:['--no-extensions','--no-mcp']});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;const headers={Cookie:app.auth.cookie({headers:{host:'localhost'}}).split(';')[0],'Content-Type':'application/json'};
async function api(url,body){const r=await fetch(base+url,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,'HTTP '+r.status);return v;}
try{
 const w=(await api('/api/workspaces')).workspaces[0];const s=(await api('/api/sessions',{workspaceId:w.id,commandId:'background-create-command-0001'})).session;const url='/api/sessions/'+s.id;
 const body={type:'prompt',message:'Use bash to run: sleep 5; printf BACKGROUND_CORE_PARITY_OK. Then reply done. Do not modify files.',generation:s.generation,commandId:'background-prompt-command-0001'};await api(url+'/commands',body);
 // No browser, SSE, or state requests during this interval. Only the own gateway's
 // Pi child remains active. This verifies host-side detachment, not iOS suspension.
 await new Promise(r=>setTimeout(r,20000));let state=await api(url+'/state');const deadline=Date.now()+120000;while(state.busy&&Date.now()<deadline){await new Promise(r=>setTimeout(r,500));state=await api(url+'/state');}
 assert.ok(!state.busy);assert.ok(state.messages.some(m=>m.role==='toolResult'&&m.content?.some(c=>c.text?.includes('BACKGROUND_CORE_PARITY_OK'))));assert.equal((await api(url+'/commands',body)).deduplicated,true);assert.equal(state.messages.filter(m=>m.role==='user').length,1);
 const report={passed:true,detachedSeconds:20,toolCompleted:true,duplicateProtected:true,sessionIdle:true};console.log(JSON.stringify(report));if(process.env.PI_REAL_REPORT)await writeFile(process.env.PI_REAL_REPORT,JSON.stringify(report,null,2));
}finally{await app.close();}
