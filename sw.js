/* Offline cache (service worker). Bump VERSION whenever any cached file changes. */

// The lazy per-level data and link files are listed in levels.js and precached too.
importScripts('levels.js');

const VERSION = 'kanji-v14';

const FILES = [
  './', 'index.html', 'data.js', 'links.js', 'kana.js', 'levels.js',
  ...(self.KANJI_LEVEL_FILES || []),
  ...(self.KANJI_LINK_FILES || []),
  'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

/** Install: fetch every file fresh ({cache:'reload'} bypasses the HTTP cache, so an upgrade never stores a stale index.html). */
self.addEventListener('install', (event) => {
  const fresh = FILES.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(fresh))
      .then(() => self.skipWaiting())
  );
});

/** Activate: delete every older cache, then take control of open pages. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/** Fetch: cache first; anything not cached is fetched and stored for next time. */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
