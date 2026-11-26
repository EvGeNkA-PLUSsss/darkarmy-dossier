/* DarkArmy Dossier service worker: оболочка приложения + офлайн-просмотр.
   Обычные API/файлы кешируются только явно клиентом в da-offline-v1,
   когда пользователь включил офлайн-режим. SSE и POST не перехватываются. */
const VERSION = 'da-pwa-v4';
const OFFLINE_CACHE = 'da-offline-v1';
const CORE = [
  '/', '/index.html', '/app.js', '/design.css',
  '/manifest.webmanifest',
  '/icons/icon-64.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-1024.png',
  '/icons/icon-192-maskable.png', '/icons/icon-512-maskable.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(CORE.map(url => c.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys
      .filter(k => k !== VERSION && k !== OFFLINE_CACHE)
      .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/events') || url.pathname === '/api/events') return;
  if (url.pathname === '/api/health') return;

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) {
    event.respondWith(
      fetch(req).then(res => res).catch(async () => {
        const cache = await caches.open(OFFLINE_CACHE);
        const hit = await cache.match(req, { ignoreSearch: false });
        if (hit) return hit;
        if (url.pathname.startsWith('/api/')) {
          return new Response(JSON.stringify({ error: 'offline', offline: true }), {
            status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
        }
        return new Response('Файл не скачан для офлайн-режима', { status: 404 });
      })
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put('/index.html', copy)).catch(() => {});
        return res;
      }).catch(async () => (await caches.match('/index.html')) || (await caches.match('/')))
    );
    return;
  }
  const isCode = /\.(js|css|webmanifest)$/.test(url.pathname);
  if (isCode) {
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res.ok && /\.(png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname)) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
