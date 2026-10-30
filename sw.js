/* Offline cache (service worker). Bump VERSION whenever any cached file changes. */

// The lazy per-level data and link files are listed in levels.js and precached too.
importScripts('levels.js');

const VERSION = 'kanji-v16a';

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
  'reading-words.js', 'reading-tests.js', 'placement-pools.js', 'practice-catalog.js', 'rank-model.js', 'reading-answer.js', 'placement-model.js', 'unit-test-model.js', 'level-check-model.js', 'practice-model.js',
  // v15f hook/ink files (HOTFIX-v15d.1, INK-OVERLAY)
  'hook-curl.js', 'hook-straight.js', 'debug-strokes.js',
  // v16 models (V16-RC logic, R5–R8, R12–R14, R18), in index.html load order
  'progress-model.js', 'scheduler-model.js', 'gating-model.js', 'habit-model.js', 'load-model.js', 'export-model.js', 'diagnosis-model.js',
  'context-sentences-n5.js', 'sentences-model.js', 'partial-credit.js', 'fading-scaffolds.js', 'contrast-model.js', 'leech-model.js',
  'stats-model.js', 'session-timer.js', 'component-model.js', 'data-safety.js', 'v16-loader.js', 'v16-rules-loader.js', 'proportion-rules-index.js',
  // v16 views + tips (R15–R17, R19; mounted by B4)
  'stats-view.js', 'components-view.js', 'settings-view.js', 'study-cards-view.js', 'tips-data.js', 'tips-model.js', 'weakspot-model.js', 'v16-weakspot.js', 'notes-model.js', 'known-import-model.js', 'study-order-data.js', 'study-order-model.js', 'word-unlock-model.js',
  // glue + v15 UI
  'v15-integration.js', 'v15-ui.js',
  // B4's v16 theme + views: provided by B4's V16-RC2-ui.patch (listed here so that patch adds no precache lines)
  'v16-theme.css', 'v16-views.js',
  // B3's component drawings (~204 KB), lazy-loaded by B4's V16-glyphs-ui.patch; precached so drawings work offline
  'component-glyphs.js',
  // B3's nested KanjiVG groups (~283 KB, R22), lazy-loaded with the 'components' group; precached for offline
  'nested-groups.js',
  // The N4–N1 context-sentence files are deliberately NOT precached (R11b, large): runtime-cached on first use below.
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

/** Fetch: cache first; anything not cached is fetched and stored for next time.
 *  R11b: context-sentences-n4.js … -n1.js are NOT precached; they land here on first use (runtime cache). Offline
 *  and not cached yet → a 503 answer, so the page's <script> onerror fires and the app uses its fallback. */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      const lazySentences = /context-sentences-n[1-4]\.js$/.test(new URL(event.request.url).pathname);
      return fetch(event.request).then((response) => {
        if (lazySentences && !response.ok) return response;          // never cache an error page as data
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch((err) => {
        if (lazySentences) return new Response('/* offline */', { status: 503, headers: { 'Content-Type': 'text/javascript' } });
        throw err;
      });
    })
  );
});
