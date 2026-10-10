import { realpath, stat, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function invalid(code,status=400) {return Object.assign(new Error(code),{status,code});}
export function publicModel(model) {
  if (!model) return null;
  return Object.fromEntries(['id','provider','name','reasoning','input','contextWindow','maxTokens'].filter(k=>model[k]!==undefined).map(k=>[k,model[k]]));
}
export function publicState(state) {
  return {...Object.fromEntries(['sessionId','sessionName','thinkingLevel','isStreaming','isCompacting','isRetrying','messageCount','pendingMessageCount','autoCompactionEnabled','steeringMode','followUpMode'].filter(k=>state[k]!==undefined).map(k=>[k,state[k]])),model:publicModel(state.model)};
}
export class OwnedSessions {
  constructor(dir,root,workspaces) {this.dir=dir;this.root=path.resolve(root);this.paths=workspaces;this.items=new Map();this.file=path.join(dir,'owned-sessions.json');this.ready=this.init();}
  async init() {
    await mkdir(this.root,{recursive:true,mode:0o700});this.root=await realpath(this.root);
    if(!this.paths) {const cwd=path.join(this.dir,'workspace');await mkdir(cwd,{recursive:true,mode:0o700});this.paths=[cwd];}
    this.workspaces=[];
    for(const cwd of this.paths) {const p=await realpath(cwd);if(!(await stat(p)).isDirectory()) throw invalid('invalid_workspace');this.workspaces.push({id:createHash('sha256').update(p).digest('hex').slice(0,16),name:path.basename(p),cwd:p});}
    try {for(const s of JSON.parse(await readFile(this.file,'utf8'))) if(this.contains(s.file) && this.workspaces.some(w=>w.cwd===s.cwd)) this.items.set(s.id,s);}
    catch(e) {if(e.code!=='ENOENT') throw e;}
  }
  contains(file) {return typeof file==='string' && path.resolve(file).startsWith(this.root+path.sep);}
  async save(session) {
    if(!this.contains(session.file)) throw invalid('session_outside_owned_root',403);
    this.items.set(session.id,session);await this.persist();
  }
  async persist() {this.writes=(this.writes||Promise.resolve()).catch(()=>{}).then(async()=>{await writeFile(this.file+'.tmp',JSON.stringify([...this.items.values()]),{mode:0o600});await rename(this.file+'.tmp',this.file);});return this.writes;}
}
export function validateControl(body) {
  if(!body || !/^[\w-]{10,100}$/.test(body.commandId||'')) throw invalid('invalid_command_id');
  if(body.type==='set_session_name') {if(typeof body.name!=='string' || !body.name.trim() || body.name.length>120 || /[\x00-\x1f]/.test(body.name)) throw invalid('invalid_name');return {name:body.name.trim()};}
  if(body.type==='set_model') {if(typeof body.provider!=='string'||typeof body.modelId!=='string'||body.provider.length>100||body.modelId.length>200)throw invalid('invalid_model');return {provider:body.provider,modelId:body.modelId};}
  if(body.type==='set_thinking_level') {if(!['off','minimal','low','medium','high','xhigh','max'].includes(body.level))throw invalid('invalid_thinking_level');return {level:body.level};}
  throw invalid('unsupported_command');
}
