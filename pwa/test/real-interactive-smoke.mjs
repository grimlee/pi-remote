import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {createPwaServer} from '../server.mjs';
const executable=process.env.PI_REAL_EXECUTABLE;if(!executable)throw new Error('Set PI_REAL_EXECUTABLE');
const dir=await mkdtemp(path.join(os.tmpdir(),'pi-parity-ui-'));const cwd=path.join(dir,'workspace');await mkdir(cwd);
const app=createPwaServer({stateDir:path.join(dir,'state'),sessionDir:path.join(dir,'sessions'),workspaces:[cwd],executable,piArgs:['--no-extensions','--no-mcp','-e',fileURLToPath(new URL('./interactive-extension.ts',import.meta.url))]});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;const headers={Cookie:app.auth.cookie({headers:{host:'localhost'}}).split(';')[0],'Content-Type':'application/json'};
async function api(url,body){const r=await fetch(base+url,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,'HTTP '+r.status+' '+v.error);return v;}
try{
 const w=(await api('/api/workspaces')).workspaces[0];const s=(await api('/api/sessions',{workspaceId:w.id,commandId:'ui-create-command-0001'})).session;const url='/api/sessions/'+s.id;
 const command={type:'prompt',message:'/core-parity-dialog',commandId:'real-ui-prompt-command-0001',generation:s.generation};
 const submitted=api(url+'/commands',command);let answered=[];
 for(const method of ['confirm','input','select','editor']) {
  const deadline=Date.now()+15000;let req;
  while(Date.now()<deadline){req=(await api(url+'/state')).uiRequests.find(r=>r.method===method);if(req)break;await new Promise(r=>setTimeout(r,50));}assert.ok(req,'missing dialog '+method);
  const values=method==='confirm'?{confirmed:false}:method==='input'?{cancelled:true}:method==='select'?{value:'Beta'}:{value:'edited line'};
  const response={type:'extension_ui_response',requestId:req.id,generation:s.generation,commandId:'real-ui-answer-'+method+'-0001',...values};
  await api(url+'/commands',response);assert.equal((await api(url+'/commands',response)).deduplicated,true);answered.push(method);
 }
 await submitted;const final=await api(url+'/state');const result=final.messages.find(m=>m.customType==='core-parity-dialog-result');assert.ok(result);const value=JSON.parse(result.content);assert.equal(value.confirmed,false);assert.equal(value.value,undefined);assert.equal(value.selected,'Beta');assert.equal(value.edited,'edited line');
 await api(url+'/commands',{type:'prompt',message:'/core-parity-timeout',commandId:'real-ui-timeout-command-0001',generation:s.generation});await new Promise(r=>setTimeout(r,300));assert.equal((await api(url+'/state')).uiRequests.length,0);
 const report={passed:true,methods:answered,rejection:true,cancellation:true,duplicateAnswers:true,timeout:true,workspace:dir};console.log(JSON.stringify(report));if(process.env.PI_REAL_REPORT)await writeFile(process.env.PI_REAL_REPORT,JSON.stringify(report,null,2));
}finally{await app.close();}
