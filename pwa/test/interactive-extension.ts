// Explicitly loaded only in isolated RPC tests; never installed globally.
export default function (pi: any) {
 pi.registerCommand('core-parity-dialog', {
  description:'Exercise safe RPC UI responses',
  handler:async(_args: string,ctx: any)=>{
   const confirmed=await ctx.ui.confirm('Test confirmation','Allow this harmless test?',{timeout:15000});
   const value=await ctx.ui.input('Test input','Enter test text');
   const selected=await ctx.ui.select('Test selection',['Alpha','Beta']);
   const edited=await ctx.ui.editor('Test editor','line one');
   pi.sendMessage({customType:'core-parity-dialog-result',content:JSON.stringify({confirmed,value,selected,edited}),display:true});
  }
 });
 pi.registerCommand('core-parity-timeout', {
  description:'Exercise RPC UI timeout',
  handler:async(_args: string,ctx: any)=>{
   const answer=await ctx.ui.confirm('Timed confirmation','Must expire safely',{timeout:200});
   pi.sendMessage({customType:'core-parity-timeout-result',content:String(answer),display:true});
  }
 });
}
