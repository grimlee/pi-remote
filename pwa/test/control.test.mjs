import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPwaServer} from '../server.mjs';
async function fixture(t) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'pwa-parity-'));const cwd=path.join(dir,'workspace');await mkdir(cwd);
 const app=createPwaServer({stateDir:path.join(dir,'state'),sessionDir:path.join(dir,'sessions'),workspaces:[cwd],executable:fileURLToPath(new URL('./fake-pi',import.meta.url))});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
 const base='http://127.0.0.1:'+app.server.address().port;
 const headers={Cookie:app.auth.cookie({headers:{host:'localhost'}}).split(';')[0],'Content-Type':'application/json'};
 const request=async (url,body)=>{const res=await fetch(base+url,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
 const workspace=(await request('/api/workspaces')).body.workspaces[0];
 const created=await request('/api/sessions',{workspaceId:workspace.id,commandId:'create-session-command-0001'});assert.equal(created.status,201);
 return {app,dir,request,workspace,created,session:created.body.session};
}
test('session creation is allowlisted, durable for empty Pi sessions and deduplicated',async t=>{
 const f=await fixture(t);const {request,session,workspace}=f;
 const again=await request('/api/sessions',{workspaceId:workspace.id,commandId:'create-session-command-0001'});assert.equal(again.body.session.id,session.id);assert.equal(again.body.deduplicated,true);
 for(const workspaceId of ['../../tmp','/tmp',workspace.id+'x'])assert.equal((await request('/api/sessions',{workspaceId,commandId:'bad-create-command-0001'})).status,400);
 assert.equal((await request('/api/sessions')).body.sessions.length,1);assert.equal(session.file,undefined);
 const manifest=JSON.parse(await readFile(path.join(f.dir,'state','owned-sessions.json')));assert.equal(manifest[0].id,session.id);
 assert.equal((await request('/api/commands/create-session-command-0001')).body.result.id,session.id);
});
test('rename/model/thinking expose only public metadata and reject stale or unsupported controls',async t=>{
 const {request,session}=await fixture(t);const url='/api/sessions/'+session.id;
 const controls=await request(url+'/controls');assert.equal(controls.status,200);assert.equal(controls.body.models.length,2);assert.doesNotMatch(JSON.stringify(controls),/SECRET|private.invalid|sourceInfo|sessionFile/);
 const state=await request(url+'/state');assert.doesNotMatch(JSON.stringify(state),/SECRET|private.invalid|sessionFile/);
 let command={type:'set_session_name',name:'Renamed',generation:session.generation,commandId:'rename-control-command-0001'};
 const results=await Promise.all([request(url+'/commands',command),request(url+'/commands',command)]);assert.ok(results.some(r=>r.body.deduplicated));
 assert.equal((await request('/api/sessions')).body.sessions[0].name,'Renamed');
 assert.equal((await request(url+'/commands',{...command,name:'conflict'})).status,409);
 assert.equal((await request(url+'/commands',{...command,commandId:'stale-control-command-0001',generation:1})).status,409);
 assert.equal((await request(url+'/commands',{...command,type:'set_model',provider:'mock',modelId:'bad',commandId:'bad-model-command-0001'})).body.error,'unsupported_model');
 for(const [type,values] of [['set_model',{provider:'mock',modelId:'other'}],['set_thinking_level',{level:'high'}]])assert.equal((await request(url+'/commands',{type,...values,generation:session.generation,commandId:type+'-control-command-0001'})).status,202);
 const changed=(await request(url+'/state')).body;assert.equal(changed.state.model.id,'other');assert.equal(changed.state.thinkingLevel,'high');
 assert.equal((await request(url+'/commands',{type:'prompt',message:'/settings',commandId:'slash-command-unsupported-0001'})).body.error,'unsupported_slash_command');
 assert.equal((await request(url+'/commands',{type:'prompt',message:'/test-command',commandId:'slash-command-supported-0001'})).status,202);
});
