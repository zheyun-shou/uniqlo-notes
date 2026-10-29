// 只缓存应用外壳和商品图片（官网原图和 /media/ 存档图）；/api/* 一律走网络（记录的离线副本由 app.js 存在 localStorage）。
const VERSION = 'fitlog-v2';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'fitlog-images').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 商品图：缓存优先
  if (url.hostname === 'image.uniqlo.com' || (url.origin === location.origin && url.pathname.startsWith('/media/'))) {
    event.respondWith(cacheFirst(req));
    return;
  }

  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    // 外壳：网络优先，离线时用缓存
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/index.html'))),
    );
    return;
  }
});

async function cacheFirst(req) {
  const c = await caches.open('fitlog-images');
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone());
  return res;
}
