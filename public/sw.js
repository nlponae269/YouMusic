// Старый YouMusic кэшировал сайт через service worker. Этот файл заменяет его:
// чистит все кэши, удаляет сам себя и перезагружает открытые вкладки.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
