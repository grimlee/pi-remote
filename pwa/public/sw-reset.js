(async () => {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
        if (registration.scope === new URL("/", location.href).href && workers.some(worker => {
          const url = new URL(worker.scriptURL);
          return url.origin === location.origin && url.pathname === "/sw.js";
        })) await registration.unregister();
      }
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith("pi-remote-shell-")).map(key => caches.delete(key)));
    }
    // Cookie and localStorage contain authentication/session/command recovery state.
    // Leave them intact and navigate outside the obsolete worker's lifetime.
    location.replace("/?transport=poll&v=8.0");
  } catch {
    document.getElementById("status").textContent = "页面缓存恢复未完成，请检查 Tailscale 连接后点击重试恢复。登录和会话信息仍保留。";
  }
})();
