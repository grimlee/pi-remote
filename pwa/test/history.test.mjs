import test from 'node:test';import assert from 'node:assert/strict';import {historyPage} from '../history.mjs';
test('history pagination is complete, ordered, bounded and rejects stale cursors',()=>{
 const all=Array.from({length:501},(_,i)=>({role:'user',content:[{type:'text',text:'message '+i}]}));let collected=[];let before;let revision;
 do{const page=historyPage(all,{limit:80,before,revision});collected=[...page.messages,...collected];before=page.history.start;revision=page.history.revision;}while(before>0);
 assert.deepEqual(collected,all);assert.throws(()=>historyPage([...all,{role:'user',content:'new'}],{limit:80,before:10,revision}),/history_changed/);
 for(const options of [{limit:0},{limit:201},{limit:NaN},{before:-1},{before:502}])assert.throws(()=>historyPage(all,options));
});
test('pagination caps payload bytes without altering persisted raw message content',()=>{
 const all=Array.from({length:20},()=>({role:'assistant',content:'x'.repeat(100000)}));const p=historyPage(all);assert.ok(Buffer.byteLength(JSON.stringify(p))<1100000);assert.equal(p.messages[0].content,all[0].content);assert.ok(p.history.hasOlder);
 assert.throws(()=>historyPage([{role:'assistant',content:'x'.repeat(3*1024*1024)}]),/history_message_too_large/);
});
