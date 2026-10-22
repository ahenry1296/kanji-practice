/* Lazy-loaded data files (format: /workspace/kanji-data/SCHEMA.md).
   Uses `self` (not `window`) so sw.js can importScripts() this list to precache it. */

// Per-level kanji data, loaded when that level's tab is first opened.
self.KANJI_LEVEL_FILES = ['data-N4.js', 'data-N3.js', 'data-N2.js', 'data-N1.js'];

// Memory links per level, loaded right after that level's data (they merge into links.js).
self.KANJI_LINK_FILES = ['links-N4.js', 'links-N3.js', 'links-N2.js', 'links-N1.js'];

// Example sentences (Tatoeba, CC BY 2.0 FR) per level: N5 loads with the app, the others with their level.
self.KANJI_SENTENCE_FILES = ['sentences-N4.js', 'sentences-N3.js', 'sentences-N2.js', 'sentences-N1.js'];

// Search index (kanji-data/SEARCH_INDEX.md), one file per level: loaded the first time search opens.
self.SEARCH_INDEX_FILES = ['search-index-kana.js', 'search-index-N5.js', 'search-index-N4.js', 'search-index-N3.js', 'search-index-N2.js', 'search-index-N1.js'];

// Quiz item banks (kanji-data/QUIZ_BANKS.md): meaning/reading questions, distractors, segmented words.
// Loaded per level when a placement, level or unit test or a reading stage of the rank first needs them.
self.QUIZ_BANK_FILES = ['quiz-kana.js', 'quiz-N5.js', 'quiz-N4.js', 'quiz-N3.js', 'quiz-N2.js', 'quiz-N1.js'];

// Named practice sets (kanji-data/PRACTICE_SETS.md) for practice-mode quick picks; loaded when practice mode opens.
self.PRACTICE_SET_FILE = 'practice-sets.js';

// Stroke-contact topology (kanji-data/STROKE_TOPOLOGY.md): kana and N5 load with the app, the others with their level.
self.STROKE_TOPOLOGY_FILES = ['stroke-topology-N4.js', 'stroke-topology-N3.js', 'stroke-topology-N2.js', 'stroke-topology-N1.js'];
