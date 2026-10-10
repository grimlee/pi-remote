import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createPwaServer} from '../server.mjs';
const executable=process.env.PI_REAL_EXECUTABLE;if(!executable||!process.env.PI_REAL_IMAGE)throw new Error('Set PI_REAL_EXECUTABLE and PI_REAL_IMAGE');
const dir=await mkdtemp(path.join(os.tmpdir(),'pi-parity-image-'));const cwd=path.join(dir,'workspace');await mkdir(cwd);
const app=createPwaServer({stateDir:path.join(dir,'state'),sessionDir:path.join(dir,'sessions'),workspaces:[cwd],executable,piArgs:['--no-extensions','--no-mcp']});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+app.server.address().port;const headers={Cookie:app.auth.cookie({headers:{host:'localhost'}}).split(';')[0],'Content-Type':'application/json'};
async function api(url,body){const r=await fetch(base+url,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,'HTTP '+r.status+' '+v.error);return v;}
try{
 const w=(await api('/api/workspaces')).workspaces[0];const s=(await api('/api/sessions',{workspaceId:w.id,commandId:'visual-create-command-0001'})).session;const url='/api/sessions/'+s.id;assert.ok((await api(url+'/state')).state.model.input.includes('image'));
 const body={type:'prompt',message:'What is the dominant color in the attached picture? Respond with just the color name in English. Do not use tools.',images:[{type:'image',mimeType:'image/png',data:(await readFile(process.env.PI_REAL_IMAGE)).toString('base64')}],generation:s.generation,commandId:'visual-prompt-command-0001'};
 await api(url+'/commands',body);assert.equal((await api(url+'/commands',body)).deduplicated,true);
 let final;const deadline=Date.now()+180000;while(Date.now()<deadline){final=await api(url+'/state');if(!final.busy&&final.messages.some(m=>m.role==='assistant'))break;await new Promise(r=>setTimeout(r,500));}
 const answer=final.messages.filter(m=>m.role==='assistant').flatMap(m=>m.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');assert.match(answer,/red/i);assert.equal(final.messages.filter(m=>m.role==='user').length,1);assert.ok(final.messages.find(m=>m.role==='user').content.some(c=>c.type==='image'));
 const report={passed:true,visualModelReceivedImage:true,colorCorrect:true,deduplicated:true,model:final.state.model.id};console.log(JSON.stringify(report));if(process.env.PI_REAL_REPORT)await writeFile(process.env.PI_REAL_REPORT,JSON.stringify(report,null,2));
}finally{await app.close();}
