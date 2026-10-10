// Keep the static pairing shell visible even if a module or WASM load stalls.
const status = document.getElementById('tailcatStartup');
const button = document.querySelector('#loginForm button');
let loaded = false, failed = false;
function render(value) {
  if (failed) return;
  button.disabled = !loaded || value.wasmStartupMs === null || value.state === 'failed';
  status.hidden = value.state === 'connected';
  status.textContent = value.state === 'failed' ? '连接引擎启动失败，请点击“恢复页面缓存”后重试。'
    : !loaded ? '正在加载界面…'
    : value.wasmStartupMs === null ? '正在初始化 WASM 和安全设备存储，请稍候…'
    : value.state === 'background' ? '已在后台暂停，返回前台后自动恢复。'
    : '界面已就绪，请粘贴一次性配对码。';
}
try {
  const {createTransport} = await import('./transport.mjs');
  const transport = window.piRemoteTransport = createTransport();
  transport.onDiagnostics = render;
  // Measurement UI is optional; its failure must not prevent the actual UI.
  await import('./diagnostics.mjs').catch(() => {});
  await import('./app.js');
  loaded = true;
  render(transport.diagnostics());
} catch {
  failed = true; button.disabled = true;
  document.getElementById('loginView').hidden = false;
  document.getElementById('appView').hidden = true;
  status.hidden = false;
  status.textContent = '界面资源加载失败，请点击“恢复页面缓存”后重试。设备密钥会保留。';
}
