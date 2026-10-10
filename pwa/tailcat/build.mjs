import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function buildStatic(wasmDir, output, {mock = false} = {}) {
  await mkdir(output, {recursive: true});
  const shell = ['app.js', 'recovery.js', 'styles.css', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];
  const bridge = ['entry.mjs', 'transport.mjs', 'worker.mjs', 'identity.mjs', 'protocol.mjs', 'diagnostics.mjs'];
  const wasm = ['wasm_exec.js', 'main.wasm.gz', 'TAILCAT-LICENSE'];
  for (const file of shell) await cp(path.join(root, '../public', file), path.join(output, file));
  for (const file of bridge) await cp(path.join(root, file), path.join(output, file));
  for (const file of wasm) await cp(path.join(wasmDir, file), path.join(output, file));
  let html = await readFile(path.join(root, '../public/index.html'), 'utf8');
  if (mock) html = html.replace('<title>Pi Remote</title>', '<title>Pi Remote · Phase A Mock</title>')
    .replace('<h1>Pi Remote</h1>', '<h1>Phase A · Mock Pi</h1>')
    .replace('连接你自己的 Pi Agent。所有模型、文件和工具都留在 Host。', '隔离测试：只有 Mock Pi，没有真实模型、生产会话或 Shell 工具。')
    .replace('Pi 运行在电脑上，手机只负责交互。', 'Phase A · Mock Pi 隔离测试');
  html = html.replace('src="/app.js"', 'src="/entry.mjs"').replace('PWA 登录密钥', '一次性设备配对码').replace('<input id="token" type="password" autocomplete="off" required placeholder="输入 Host 显示的登录密钥">', '<textarea id="token" rows="4" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required placeholder="粘贴 Host 私下提供的一次性配对码"></textarea>');
  html = html.replace('请通过可信的 HTTPS / Tailnet 地址访问。PWA 不需要 iOS 侧载签名。', '请核对 HTTPS 地址与 Host 配对码一致。配对码只粘贴在页面内，不放进网址；无须开启 Tailscale。');
  html = html.replace('<button id="refreshSessions"', '<button id="newSession" class="soft" hidden>＋ 新会话</button>\n      <button id="refreshSessions"');
  html = html.replace('<button id="syncButton"', '<button id="renameSession" class="ghost" hidden>改名</button><button id="chooseModel" class="ghost" hidden>模型</button>\n        <button id="syncButton"');
  html = html.replace('<div id="connection"', '<div class="model-controls"><select id="modelPicker" aria-label="模型" hidden></select><button id="applyModel" type="button" hidden>使用模型</button></div>\n      <div id="connection"');
  await writeFile(path.join(output, 'index.html'), html);
  const files = ['index.html', ...shell, ...bridge, ...wasm];
  const manifest = {};
  for (const name of files) manifest[name] = createHash('sha256').update(await readFile(path.join(output, name))).digest('hex');
  const version = createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
  const sw = `const CACHE = 'pi-remote-tailcat-shell-${version}';
const FILES = ${JSON.stringify(['/', ...files.filter(f => f !== 'index.html').map(f => '/' + f)])};
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('pi-remote-tailcat-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || e.request.method !== 'GET' || u.search || !FILES.includes(u.pathname)) return;
  e.respondWith(caches.open(CACHE).then(c => c.match(u.pathname)).then(cached => cached || fetch(e.request)).catch(() => new Response('暂时离线，请恢复网络后重新加载', {status:503, headers:{'Content-Type':'text/plain;charset=utf-8'}})));
});
`;
  await writeFile(path.join(output, 'sw.js'), sw);
  manifest['sw.js'] = createHash('sha256').update(sw).digest('hex');
  await writeFile(path.join(output, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return {version, files: [...files, 'sw.js']};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [wasm, output, mode] = process.argv.slice(2);
  if (!wasm || !output) throw new Error('Usage: build.mjs PINNED_WASM_DIRECTORY STATIC_OUTPUT_DIRECTORY');
  if (mode && mode !== '--mock') throw new Error('Optional build flag: --mock');
  console.log(JSON.stringify(await buildStatic(wasm, output, {mock: mode === '--mock'})));
}
