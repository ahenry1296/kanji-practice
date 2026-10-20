/* Lazy-loaded data files (format: /workspace/kanji-data/SCHEMA.md).
   Uses `self` (not `window`) so sw.js can importScripts() this list to precache it. */

// Per-level kanji data, loaded when that level's tab is first opened.
self.KANJI_LEVEL_FILES = ['data-N4.js', 'data-N3.js', 'data-N2.js', 'data-N1.js'];

// Memory links per level, loaded right after that level's data (they merge into links.js).
self.KANJI_LINK_FILES = ['links-N4.js', 'links-N3.js', 'links-N2.js', 'links-N1.js'];
