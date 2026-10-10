import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom=new JSDOM('<!doctype html><body></body>',{url:'http://localhost'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
const {richText,renderContent,safeLink,contentForCopy}=await import('../public/transcript.js');
test('Markdown/code is sanitized, raw HTML escaped and links restricted',()=>{
  const node=document.createElement('div');let copied;
  richText(node,'# Heading\n\n| a | b |\n|---|---|\n|1|2|\n\n```js\nconst x = "<script>";\n```\n\n[bad](javascript:alert(1)) [good](https://example.com)\n\n<img src=x onerror=alert(1)>',t=>copied=t);
  assert.ok(node.querySelector('h1'));assert.ok(node.querySelector('table'));assert.ok(node.querySelector('code span'));
  assert.equal(node.querySelector('img,script'),null);assert.equal(node.querySelector('[onclick],[onerror]'),null);
  assert.equal(node.querySelector('a').getAttribute('href'),null);assert.equal(node.querySelectorAll('a')[1].rel,'noopener noreferrer');
  node.querySelector('pre button').click();assert.equal(copied,'const x = "<script>";\n');
  for(const u of ['data:text/html,x','file:///tmp/key','//evil.invalid','javascript:alert(1)']) assert.equal(safeLink(u),null);
});
test('Thinking/tool arguments/errors are collapsed safe and full raw output can be copied',()=>{
  const node=document.createElement('div');let copied;
  const message={role:'assistant',content:[{type:'thinking',thinking:'private reason <script>'},{type:'toolCall',id:'call1',name:'bash',arguments:{command:'echo <svg/onload=evil>'}},{type:'text',text:'Finished'}]};
  renderContent(node,message,t=>copied=t,{call1:{status:'成功'}});
  assert.equal(node.querySelectorAll('details').length,2);assert.equal(node.querySelector('details').open,false);
  assert.match(node.textContent,/成功 · bash/);assert.equal(node.querySelector('svg,script'),null);
  const raw='long output '.repeat(10000);renderContent(node,{role:'toolResult',toolCallId:'call1',isError:true,content:[{type:'text',text:raw}]},t=>copied=t);
  assert.equal(node.querySelector('pre').textContent.length,8000);node.querySelector('details button').click();assert.equal(copied,raw);
  assert.match(contentForCopy(message),/private reason/);
});
test('large rich text keeps the complete code but bounds expensive highlighting',()=>{
  const node=document.createElement('div');const text='const n = 1;\n'.repeat(5000);let copied;
  richText(node,'```js\n'+text+'```',t=>copied=t);assert.equal(node.querySelector('code').textContent,text);
  assert.equal(node.querySelector('code span'),null);node.querySelector('button').click();assert.equal(copied,text);
});

test('MathML math rendering remains inert and does not transform code literals',async()=>{
 const node=document.createElement('div');richText(node,'Math \\(x^2 + y^2\\)\n\n`\\(literal\\)`\n\n$$\\href{javascript:alert(1)}{click}$$',()=>{});
 for(let i=0;i<40&&!node.querySelector('math');i++)await new Promise(r=>setTimeout(r,10));
 assert.ok(node.querySelector('math'));assert.equal(node.querySelector('a[href^="javascript:"],script,iframe'),null);assert.match(node.querySelector('code').textContent,/literal/);
});
