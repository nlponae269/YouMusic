// Кэшируем только оболочку приложения; музыка и каталог всегда идут в сеть
const CACHE = 'youmusic-shell-v7';
const SHELL = ['./', 'styles.css', 'config.js', 'js/app.js', 'js/api.js', 'js/player.js', 'js/util.js', 'js/account.js', 'js/tags.js', 'js/create.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // музыку и каталог не кэшируем: аудио идёт с поддержкой Range, каталог должен быть свежим
  if (e.request.method !== 'GET' || url.origin !== location.origin
    || url.pathname.includes('/media/') || url.pathname.endsWith('catalog.json')) return;
  // сеть в приоритете, кэш — на случай офлайна
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./'))),
  );
});
