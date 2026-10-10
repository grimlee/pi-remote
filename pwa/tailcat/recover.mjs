try {
  if ('serviceWorker' in navigator) {
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
      if (registration.scope === new URL('/', location.href).href && workers.some(worker => worker.scriptURL === new URL('/sw.js', location.href).href)) await registration.unregister();
    }
  }
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('pi-remote-tailcat-shell-')).map(name => caches.delete(name)));
  }
  // Never touch IndexedDB, localStorage, cookies or mutation receipts.
  location.replace('/index.html');
} catch {
  document.getElementById('status').textContent = '程序缓存恢复未完成，请确认网络正常后重试。设备密钥和待确认命令仍保留。';
}
