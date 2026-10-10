import { marked, DOMPurify, hljs } from './vendor/rich.js';
const MAX_HIGHLIGHT = 32000;
const OUTPUT_PAGE = 8000;
const allowedTags = ['p','br','strong','em','del','blockquote','h1','h2','h3','h4','h5','h6','ul','ol','li','pre','code','a','table','thead','tbody','tr','th','td','hr','span'];
export function safeLink(value) {
  try { const u = new URL(value); return ['https:','http:','mailto:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}
export function markdownHTML(text) {
  // Raw HTML is escaped before parsing, then the resulting HTML is sanitized.
  const renderer = new marked.Renderer();
  renderer.html = ({text}) => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return DOMPurify.sanitize(marked.parse(String(text), {renderer,gfm:true,async:false}), {
    ALLOWED_TAGS:allowedTags, ALLOWED_ATTR:['href','title','class'], ALLOW_DATA_ATTR:false
  });
}
function button(label, fn) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'copy-action'; b.textContent = label; b.addEventListener('click',fn); return b;
}
export function richText(node, text, copy) {
  node.innerHTML = markdownHTML(text);
  for (const a of node.querySelectorAll('a')) {
    const href = safeLink(a.getAttribute('href')); if (!href) a.removeAttribute('href');
    else {a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';}
  }
  for (const pre of node.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); if (!code) continue;
    const raw = code.textContent;
    const language = [...code.classList].find(c=>c.startsWith('language-'))?.slice(9);
    if (raw.length <= MAX_HIGHLIGHT && language && hljs.getLanguage(language)) {
      code.innerHTML = DOMPurify.sanitize(hljs.highlight(raw,{language,ignoreIllegals:true}).value,{ALLOWED_TAGS:['span'],ALLOWED_ATTR:['class']});
    }
    pre.prepend(button('复制代码',()=>copy(raw)));
  }
  // Math is loaded only when needed; never interpret code fences or raw HTML as math.
  const walker = document.createTreeWalker(node, 4); const targets = [];
  while (walker.nextNode()) {const t=walker.currentNode; if (!t.parentElement.closest('pre,code') && /\$\$[^$]+\$\$|\\\([^]+?\\\)/.test(t.textContent)) targets.push(t);}
  if (targets.length) void import('./vendor/math.js').then(({default:katex})=>{
    for (const target of targets) {
      if (!node.contains(target)) continue;
      const fragment = document.createDocumentFragment(); let offset=0;
      const pattern=/\$\$([^]+?)\$\$|\\\(([^]+?)\\\)/g; let match;
      while ((match=pattern.exec(target.textContent))) {
        fragment.append(document.createTextNode(target.textContent.slice(offset,match.index)));
        const span=document.createElement('span');span.className='math';
        span.innerHTML=DOMPurify.sanitize(katex.renderToString(match[1]||match[2],{displayMode:!!match[1],throwOnError:false,trust:false,maxExpand:1000,maxSize:20}),{USE_PROFILES:{html:true,mathMl:true,svg:true}});
        fragment.append(span);offset=pattern.lastIndex;
      }
      fragment.append(document.createTextNode(target.textContent.slice(offset)));target.replaceWith(fragment);
    }
  }).catch(()=>{});
}
function details(label, raw, key, copy) {
  const d = document.createElement('details'); d.dataset.detailKey = key;
  const summary = document.createElement('summary'); summary.textContent = label;
  const pre = document.createElement('pre'); pre.className = 'raw-output'; let shown=OUTPUT_PAGE;
  const more = button('显示更多',()=>{shown+=OUTPUT_PAGE;refresh();});
  const refresh=()=>{pre.textContent=raw.slice(0,shown);more.hidden=shown>=raw.length;};refresh();
  d.append(summary,button('复制完整内容',()=>copy(raw)),pre,more); return d;
}
function raw(value) {return typeof value==='string'?value:JSON.stringify(value??{},null,2);}
export function renderContent(node, message, copy, tools = {}) {
  node.replaceChildren();
  const content = typeof message.content==='string'?[{type:'text',text:message.content}]:message.content||[];
  if (message.role==='toolResult' || message.role==='tool' || message.role==='bashExecution') {
    const text=message.role==='bashExecution'?String(message.output||''):content.filter(c=>c?.type==='text').map(c=>c.text).join('\n');
    node.append(details(`${message.isError?'失败':message.cancelled?'已停止':'完成'} · ${message.toolName||message.name||'bash'}`,text,'result:'+message.toolCallId,copy));
  } else for (const [i,c] of content.entries()) {
    if (!c) continue;
    if (c.type==='text') {const div=document.createElement('div');div.className='rich-text'; if(message.role==='assistant') richText(div,c.text||'',copy);else div.textContent=c.text||'';node.append(div);}
    else if(c.type==='thinking') node.append(details('Thinking',c.thinking||'','thinking:'+i,copy));
    else if(c.type==='toolCall') {
      const state=tools[c.id]; const d=details(`${state?.status||'等待执行'} · ${c.name||'tool'}`,raw(c.arguments),'call:'+c.id,copy);d.className='tool-activity';node.append(d);
    } else if(c.type==='image' && ['image/png','image/jpeg','image/webp','image/gif'].includes(c.mimeType) && typeof c.data==='string' && c.data.length<=2800000 && /^[A-Za-z0-9+/=]+$/.test(c.data)) {
      const img=document.createElement('img');img.alt='附加图片';img.loading='lazy';img.src=`data:${c.mimeType};base64,${c.data}`;node.append(img);
    } else node.append(details('原始内容 · '+String(c.type||'unknown'),raw(c),'raw:'+i,copy));
  }
  if(message.errorMessage) {const e=document.createElement('p');e.className='error';e.textContent=message.stopReason==='aborted'?'已停止':message.errorMessage;node.append(e);}
}
export function contentForCopy(message) {
  if(typeof message.content==='string') return message.content;
  return (message.content||[]).filter(Boolean).map(c=>c.type==='text'?c.text:c.type==='thinking'?c.thinking:c.type==='toolCall'?raw(c.arguments):'').filter(Boolean).join('\n');
}
