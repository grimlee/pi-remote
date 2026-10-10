import test from 'node:test';
import assert from 'node:assert/strict';
import {PiRunner} from '../registry.mjs';
import {validateImages,MAX_IMAGE_BYTES} from '../images.mjs';
import {checkFiles} from '../public/attachments.js';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createPwaServer} from '../server.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9t8AAAAASUVORK5CYII=';
test('image MIME/magic/count/base64 and byte limits are bounded on both sides',()=>{
 assert.equal(validateImages([{type:'image',mimeType:'image/png',data:png}]).length,1);
 for(const value of [[{type:'image',mimeType:'text/html',data:png}],[{type:'image',mimeType:'image/jpeg',data:png}],[{type:'image',mimeType:'image/png',data:'!!!!'}],Array(4).fill({type:'image',mimeType:'image/png',data:png}),[{type:'image',mimeType:'image/png',data:'A'.repeat(Math.ceil((MAX_IMAGE_BYTES+10)/3)*4)}]])assert.throws(()=>validateImages(value));
 assert.throws(()=>checkFiles([{type:'image/heic',size:100}]));assert.throws(()=>checkFiles([{type:'image/png',size:MAX_IMAGE_BYTES+1}]));assert.throws(()=>checkFiles([{type:'image/png',size:1}],3));
});
test('interactive requests remain pending until explicit matching answers; timeouts expire',async()=>{
 const runner=new PiRunner({});let writes=[];runner.child={stdin:{write(s,fn){writes.push(JSON.parse(s));fn();}}};
 const send=event=>runner.consume(Buffer.from(JSON.stringify(event)+'\n'));
 send({type:'extension_ui_request',id:'request-confirm-01',method:'confirm',title:'Dangerous?'});
 assert.equal(writes.length,0);assert.equal(runner.uiRequests.size,1);
 await assert.rejects(()=>runner.answerUI({id:'request-confirm-01',value:'yes'}));assert.equal(writes.length,0);
 await runner.answerUI({id:'request-confirm-01',confirmed:false});assert.deepEqual(writes[0],{type:'extension_ui_response',id:'request-confirm-01',confirmed:false});
 await assert.rejects(()=>runner.answerUI({id:'request-confirm-01',confirmed:true}));
 send({type:'extension_ui_request',id:'request-select-01',method:'select',options:['Alpha','Beta']});
 await assert.rejects(()=>runner.answerUI({id:'request-select-01',value:'Unknown'}));await runner.answerUI({id:'request-select-01',cancelled:true});assert.equal(writes.at(-1).cancelled,true);
 send({type:'extension_ui_request',id:'request-timeout-01',method:'confirm',timeout:10});await new Promise(r=>setTimeout(r,30));assert.equal(runner.uiRequests.size,0);await assert.rejects(()=>runner.answerUI({id:'request-timeout-01',confirmed:true}));runner.stopWithError(new Error('test complete'));
});
test('image prompts deduplicate the entire image payload and reject malformed content',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pi-image-api-'));const app=createPwaServer({stateDir:dir,executable:fileURLToPath(new URL('./fake-pi',import.meta.url))});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
 const base='http://127.0.0.1:'+app.server.address().port;const headers={Cookie:app.auth.cookie({headers:{host:'localhost'}}).split(';')[0],'Content-Type':'application/json'};
 const request=async(url,body)=>{const r=await fetch(base+url,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json()};};
 const workspace=(await request('/api/workspaces')).value.workspaces[0];const session=(await request('/api/sessions',{workspaceId:workspace.id,commandId:'image-create-command-0001'})).value.session;
 const url='/api/sessions/'+session.id+'/commands';const body={type:'prompt',message:'Inspect image',images:[{type:'image',mimeType:'image/png',data:png}],commandId:'image-prompt-command-0001',generation:session.generation};
 const results=await Promise.all([request(url,body),request(url,body)]);assert.ok(results.some(r=>r.value.deduplicated));
 assert.equal((await request(url,{...body,message:'changed'})).status,409);
 assert.equal((await request(url,{...body,commandId:'bad-image-command-0001',images:[{type:'image',mimeType:'image/jpeg',data:png}]})).value.error,'image_mime_mismatch');
 await new Promise(r=>setTimeout(r,60));const state=(await request('/api/sessions/'+session.id+'/state')).value;assert.equal(state.messages.filter(m=>m.role==='user'&&m.content?.some(c=>c.type==='image')).length,1);
});
