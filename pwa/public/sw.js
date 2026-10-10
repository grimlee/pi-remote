const CACHE_PREFIX = "pi-remote-shell-";
const CACHE = CACHE_PREFIX + "v8.2";
const SHELL = ["/", "/app.js", "/recovery.js", "/transcript.js", "/attachments.js", "/vendor/rich.js", "/vendor/highlight.css", "/vendor/katex.css", "/styles.css", "/icon.svg", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
    .map(key => caches.delete(key))))
    .catch(() => {}).then(() => self.clients.claim()));
});

function unavailable(navigation) {
  // respondWith must always resolve to a Response, even if storage is empty or denied.
  return new Response(navigation
    ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Remote 暂时离线</title><h1>暂时无法连接 Pi Remote</h1><p>请检查 Tailscale 连接，然后重新加载。</p><p><a href="/recover">恢复页面缓存</a></p></html>'
    : "Pi Remote resource unavailable", {
    status: 503,
    headers: { "Content-Type": navigation ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function shellResponse(request, key, navigation) {
  // Shell contents are versioned together by CACHE. A warm launch needs no network.
  // Bump the cache version whenever shell assets change; APIs always bypass this worker.
  try {
    const cached = await (await caches.open(CACHE)).match(key);
    if (cached) return cached;
  } catch {}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let networkResponse;
  try {
    networkResponse = await fetch(request, { signal: controller.signal });
    if (networkResponse.ok) return networkResponse;
  } catch {} finally { clearTimeout(timer); }
  return networkResponse || unavailable(navigation);
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  // Normalize shell URLs: query parameters select transport, not different HTML.
  const key = url.pathname === "/index.html" ? "/" : url.pathname;
  if (!SHELL.includes(key)) return;
  const navigation = key === "/";
  const response = shellResponse(event.request, key, navigation);
  event.waitUntil(response.then(async result => {
    if (!result.ok) return;
    const clone = result.clone();
    await (await caches.open(CACHE)).put(key, clone);
  }).catch(() => {}));
  event.respondWith(response);
});
