import {createHash} from 'node:crypto';
import {invalid} from './control.mjs';
export function historyPage(messages, {limit=160,before,revision}={}) {
 if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw invalid('invalid_history_limit');
 if(before!==undefined&&(!Number.isSafeInteger(before)||before<0||before>messages.length))throw invalid('invalid_history_cursor');
 const version=createHash('sha256').update(JSON.stringify(messages)).digest('hex');
 if(revision && revision!==version)throw invalid('history_changed',409);
 const end=before ?? messages.length;let start=end;let bytes=0;
 while(start>0 && end-start<limit) {
  const size=Buffer.byteLength(JSON.stringify(messages[start-1]));
  if(size>2*1024*1024)throw invalid('history_message_too_large',413);
  if(bytes+size>1024*1024 && start!==end)break;
  bytes+=size;start--;
 }
 return {messages:messages.slice(start,end),history:{start,end,total:messages.length,revision:version,hasOlder:start>0}};
}
