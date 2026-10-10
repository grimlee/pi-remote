// Local, bounded measurements only: never record keys, addresses, messages or IDs.
const transport = window.piRemoteTransport;
const details = document.createElement('details');
details.className = 'tailcat-diagnostics';
const summary = document.createElement('summary');
const output = document.createElement('pre');
const reconnect = document.createElement('button');
reconnect.type = 'button'; reconnect.textContent = '断开并重连';
reconnect.onclick = () => { reconnect.disabled = true; void transport.reconnect().catch(() => {}).finally(() => { reconnect.disabled = false; }); };
const download = document.createElement('button');
download.type = 'button'; download.textContent = '保存本机测量 JSON';
function measurements() {
  const value = transport.diagnostics();
  for (const name of ['handshakesMs', 'recoveriesMs', 'readRequestMs']) {
    const sorted = [...value[name]].sort((a,b) => a-b);
    value[name + 'Summary'] = {count:sorted.length,p50:sorted[Math.max(0,Math.ceil(sorted.length*.5)-1)] ?? null,p95:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)] ?? null};
  }
  value.observedAt = new Date().toISOString();
  value.browserMemory = performance.memory ? {usedJSHeapSize:performance.memory.usedJSHeapSize, note:'JS heap only; excludes Worker/WASM/process memory'} : {note:'此浏览器不提供内存接口；无法测量 Worker/WASM 总内存'};
  return value;
}
function render() {
  const value = measurements();
  const states = {initializing:'初始化',unpaired:'等待配对',offline:'离线',connecting:'连接中',connected:'已连接',background:'后台暂停',failed:'初始化失败'};
  summary.textContent = 'Tailcat · ' + states[value.state] + ' · 测量';
  output.textContent = JSON.stringify(value,null,2);
}
download.onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(measurements(),null,2)],{type:'application/json'}));
  const link = document.createElement('a'); link.href=url; link.download='tailcat-measurements.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
};
details.append(summary, reconnect, download, output);
document.body.prepend(details);
transport.onDiagnostics = render;
render();
