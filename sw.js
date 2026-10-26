/* Offline cache (service worker). Bump VERSION whenever any cached file changes. */

// The lazy per-level data and link files are listed in levels.js and precached too.
importScripts('levels.js');

const VERSION = 'kanji-v15f';

const FILES = [
  './', 'index.html', 'favicon.ico', 'fonts/Caladea-Regular.ttf', 'fonts/Caladea-Bold.ttf', 'fonts/Caladea-Italic.ttf', 'data.js', 'links.js', 'kana.js', 'kana-links.js', 'confusables.js', 'proportion_metrics.js', 'levels.js',
  'proportion-rules-kana.js', 'proportion-rules-N5.js', 'proportion-rules-N4.js', 'proportion-rules-N3.js', 'proportion-rules-N2.js', 'proportion-rules-N1.js',
  ...(self.KANJI_LEVEL_FILES || []),
  ...(self.KANJI_LINK_FILES || []),
  ...(self.QUIZ_BANK_FILES || []),
  'stroke-topology-kana.js', 'stroke-topology-N5.js', 'hook_rules.js', 'hook-categories.js', 'hook-rules-data.js', 'prefix-lookalikes.js',
  ...(self.STROKE_TOPOLOGY_FILES || []),
  ...(self.PRACTICE_SET_FILE ? [self.PRACTICE_SET_FILE] : []),
  'sentences-N5.js',
  ...(self.KANJI_SENTENCE_FILES || []),
  ...(self.SEARCH_INDEX_FILES || []),
  'reading-words.js', 'reading-tests.js', 'placement-pools.js', 'practice-catalog.js', 'rank-model.js', 'reading-answer.js', 'placement-model.js', 'unit-test-model.js', 'level-check-model.js', 'practice-model.js', 'v15-integration.js', 'v15-ui.js', 'hook-curl.js', 'hook-straight.js', 'debug-strokes.js',
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
