/* Pocket Print service worker — exists so the app works installed, with the network OFF.
 *
 * The whole point of this project is that printing never touches the network, so the app
 * has to survive having no network at all. This worker is the only piece of the app that
 * uses fetch, and it only ever talks to this same origin.
 *
 * Strategy: NETWORK FIRST, cache as fallback.
 *   - Online, you always get the deployed build, which matters because a stale bundle reads
 *     exactly like a broken bug fix.
 *   - Offline, you get the last cached copy, and if a request for a hash-stamped asset
 *     (funnyprint.js?v=…) misses, it retries without the query string.
 *
 * __BUILD__ is replaced by deploy.sh with the bundle hash, so every deploy is a fresh cache
 * and the old ones get deleted on activate.
 */
const CACHE = 'pocketprint-__BUILD__';

const SHELL = [
  './',
  './index.html',
  './funnyprint.js',
  './codes.js',
  './label.js',
  './vendor/qrcode.js',
  './vendor/code128-table.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (e) { sameOrigin = false; }
  if (!sameOrigin) return;                       // never touch anything off-origin

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      let hit = await caches.match(req);
      if (!hit) {
        /* a deploy changed the ?v= stamp; the file itself is still cached under its bare name */
        const bare = new URL(req.url);
        bare.search = '';
        hit = await caches.match(bare.toString());
      }
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
