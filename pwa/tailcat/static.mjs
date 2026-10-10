import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function staticServer(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'asset-manifest.json'), 'utf8'));
  const allowed = new Set(['index.html', 'app.js', 'recovery.js', 'styles.css', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest', 'entry.mjs', 'transport.mjs', 'worker.mjs', 'identity.mjs', 'protocol.mjs', 'diagnostics.mjs', 'recover.html', 'recover.mjs', 'wasm_exec.js', 'main.wasm.gz', 'TAILCAT-LICENSE', 'sw.js']);
  const assets = new Map();
  for (const [name, hash] of Object.entries(manifest)) {
    if (!allowed.has(name)) throw new Error('Unexpected static artifact entry');
    const bytes = await readFile(path.join(dir, name));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Static artifact hash mismatch');
    const ext = path.extname(name);
    const mime = {'.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json', '.gz':'application/gzip'}[ext] || 'text/plain; charset=utf-8';
    assets.set('/' + name, {bytes, mime});
  }
  assets.set('/', assets.get('/index.html'));
  return createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self' https://tailcat.dev https://*.ipn.dev wss://*.ipn.dev; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); req.resume(); return; }
    const item = assets.get(req.url);
    if (!item) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': item.mime, 'Content-Length': item.bytes.length, 'Cache-Control': 'no-cache'});
    res.end(req.method === 'HEAD' ? undefined : item.bytes);
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, rawPort = '17989'] = process.argv.slice(2);
  const port = Number(rawPort);
  if (!dir || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Usage: static.mjs STATIC_DIRECTORY [PORT]');
  (await staticServer(dir)).listen(port, '127.0.0.1', () => console.log('Static assets only on loopback port ' + port));
}
