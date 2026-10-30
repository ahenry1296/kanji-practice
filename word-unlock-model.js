/*
 * word-unlock-model.js — v16 R28 "words you can read" (Botfive). Exposes window.WordUnlock (pure logic) and
 * window.V16WordUnlock (thin storage wrapper); CommonJS for tests. Design: kanji-team/R28-word-unlock.md;
 * UI hooks for Botfour: kanji-team/R28-word-unlock-hooks.md.
 *
 * Why (MARKET_RESEARCH.md pain #5 "vocab in context", backlog #10 "mini graded reading … only known kanji"; pain #1
 * motivation): every kanji the learner finishes should visibly pay off in words they can now read. R28 answers:
 *   - readable(): the common words whose kanji are ALL known ("You can read 128 words");
 *   - unlockedBy(k): the words that learning k just made readable ("休 unlocked 休む, 休日, 休み");
 *   - nextBest(): unknown kanji that would each unlock the most words right now ("Learn 本 next: +9 words").
 * Display only: it never changes grading, ranks, reviews or which kanji pickNewLesson introduces.
 *
 * Data: window.READING_WORDS (reading-words.js, already shipped and loaded by v15-ui.js; not loaded again here).
 * Words: every entry over all levels, deduplicated by written form w (the first reading is kept, the others go in
 * `alts`, so 一月 いちがつ/ひとつき is one word); only `common` words by default. A word that is a
 * single kanji on its own (一, 日) is not counted as "unlocked by" itself: it adds no reading beyond the kanji.
 * Known = rank > 0 in the rank state (V15.loadRanks), the same test R26 import and the sentences model use.
 *
 * Storage: 'v16:unlock' = { v: 1, seen } — the readable count the learner last saw, for "+N new words since".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.WordUnlock = api; root.V16WordUnlock = api.bind(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const KEY = 'v16:unlock';
  const HAN = /\p{Script=Han}/u;

  /** Unique kanji of a word, in order of appearance. */
  const kanjiOf = (w) => [...new Set([...String(w)].filter((c) => HAN.test(c)))];

  /**
   * Build the word index once per READING_WORDS object.
   * @returns {{words: {w, r, alts: string[], m, ks: string[]}[], byKanji: Map<string, number[]>}} word ids are array indexes,
   *   in data order (N5 first), so every list below is stable and level-ordered.
   */
  function buildIndex(readingWords, { commonOnly = true } = {}) {
    const words = [], byKanji = new Map(), seen = new Map();   // seen: w → word id
    const levels = (readingWords && readingWords.levels) || {};
    for (const lv of Object.keys(levels)) {
      for (const list of Object.values(levels[lv] || {})) {
        for (const e of list || []) {
          if (!e || !e.w || (commonOnly && !e.common)) continue;
          if (seen.has(e.w)) {   // same written word again: keep a new reading as an alternative
            const prev = words[seen.get(e.w)];
            if (e.r !== prev.r && !prev.alts.includes(e.r)) prev.alts.push(e.r);
            continue;
          }
          const ks = kanjiOf(e.w);
          if (!ks.length) continue;
          const i = words.push({ w: e.w, r: e.r, alts: [], m: e.m, ks }) - 1;
          seen.set(e.w, i);
          for (const k of ks) { if (!byKanji.has(k)) byKanji.set(k, []); byKanji.get(k).push(i); }
        }
      }
    }
    return { words, byKanji };
  }

  /** A word that is just one kanji by itself (一, 日): never reported as an unlock. */
  const isBare = (word) => word.w.length === 1;

  /** Ids of the words whose kanji are all known. */
  function readable(index, isKnown) {
    const out = [];
    index.words.forEach((word, i) => { if (word.ks.every(isKnown)) out.push(i); });
    return out;
  }

  /** Ids of the words k makes readable: they contain k and every OTHER kanji is known (k itself counts as known). */
  function unlockedBy(index, k, isKnown) {
    return (index.byKanji.get(k) || []).filter((i) => !isBare(index.words[i]) && index.words[i].ks.every((c) => c === k || isKnown(c)));
  }

  /**
   * Unknown kanji ranked by how many words each would unlock now (words where it is the ONLY unknown kanji).
   * candidates: optional list to choose from (e.g. the level's planned list); default every kanji in the index.
   * Ties keep candidate order (or data order). Returns [{k, count, sample: [ids, ≤3]}], at most `limit`.
   */
  function nextBest(index, isKnown, { limit = 5, candidates } = {}) {
    const pool = candidates ? [...candidates] : [...index.byKanji.keys()];
    const out = [];
    for (const k of pool) {
      if (isKnown(k)) continue;
      const ids = unlockedBy(index, k, isKnown);
      if (ids.length) out.push({ k, count: ids.length, sample: ids.slice(0, 3) });
    }
    return out.map((x, i) => [x, i]).sort((a, b) => b[0].count - a[0].count || a[1] - b[1]).slice(0, limit).map((p) => p[0]);
  }

  /** Stored setting → {v, seen}; anything malformed → seen 0. */
  function parse(raw) {
    let o = raw;
    if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    const seen = o && Number.isInteger(o.seen) && o.seen >= 0 ? o.seen : 0;
    return { v: VERSION, seen };
  }

  /** Browser wrapper: ranks through window.V15.loadRanks, words from window.READING_WORDS (null until loaded). */
  function bind(win) {
    const store = () => win.localStorage;
    const set = (key, v) => (win.DataSafety && win.DataSafety.safeSet ? win.DataSafety.safeSet(store(), key, v) : store().setItem(key, v));
    const fire = (detail) => { try { win.dispatchEvent(new win.CustomEvent('v16:unlock', { detail })); } catch (e) { /* tests */ } };
    let cache = null;   // {src, index}: rebuilt only if READING_WORDS is replaced
    function index() {
      const src = win.READING_WORDS;
      if (!src) return null;
      if (!cache || cache.src !== src) cache = { src, index: buildIndex(src) };
      return cache.index;
    }
    function knownFn() {
      const ranks = win.V15 && win.V15.loadRanks ? win.V15.loadRanks(store()) : { kanji: {} };
      const kanji = (ranks && ranks.kanji) || {};
      return (k) => !!(kanji[k] && kanji[k].rank > 0);
    }
    const view = (ix, ids) => ids.map((i) => { const w = ix.words[i]; return { w: w.w, r: w.r, alts: w.alts.slice(), m: w.m }; });
    const seen = () => { try { return parse(store().getItem(KEY)).seen; } catch (e) { return 0; } };
    return {
      KEY,
      /** True once reading-words.js has loaded (every other call returns null before that). */
      ready: () => !!win.READING_WORDS,
      /** {readable, total, newSinceSeen}: counts for "You can read N words (+M new)". */
      summary() {
        const ix = index(); if (!ix) return null;
        const n = readable(ix, knownFn()).length;
        return { readable: n, total: ix.words.length, newSinceSeen: Math.max(0, n - seen()) };
      },
      /** Words learning k made readable, [{w, r, alts, m}] (at most limit, level order), for the kanji result screen. */
      unlockedBy(k, limit = 20) { const ix = index(); return ix ? view(ix, unlockedBy(ix, k, knownFn()).slice(0, limit)) : null; },
      /** Readable words, [{w, r, alts, m}], N5 words first; offset/limit page through them for a word list view. */
      list(offset = 0, limit = 50) { const ix = index(); return ix ? view(ix, readable(ix, knownFn()).slice(offset, offset + limit)) : null; },
      /**
       * [{k, count, level, sample: [{w, r, alts, m}]}]: unknown kanji that unlock the most words now. With `candidates`
       * (e.g. the level's planned list) only those are ranked. Without, the learner's own level is used: the first
       * JLPT level (N5 → N1, READING_WORDS order) that still has an unknown kanji with an unlock, so a beginner is
       * never told to learn an N1 kanji next. `level` is that level (null with candidates).
       */
      nextBest(limit = 5, candidates) {
        const ix = index(); if (!ix) return null;
        const isKnown = knownFn();
        const out = (res, level) => res.map((x) => ({ k: x.k, count: x.count, level, sample: view(ix, x.sample) }));
        if (candidates) return out(nextBest(ix, isKnown, { limit, candidates }), null);
        const levels = win.READING_WORDS.levels || {};
        for (const lv of Object.keys(levels)) {
          const res = nextBest(ix, isKnown, { limit, candidates: Object.keys(levels[lv] || {}) });
          if (res.length) return out(res, lv);
        }
        return [];
      },
      /** Remember the current readable count (the learner saw it). Fires 'v16:unlock' {seen}. */
      markSeen() {
        const s = this.summary(); if (!s) return null;
        set(KEY, JSON.stringify({ v: VERSION, seen: s.readable }));
        fire({ seen: s.readable });
        return s.readable;
      },
    };
  }

  return { VERSION, KEY, kanjiOf, buildIndex, readable, unlockedBy, nextBest, parse, bind };
});
