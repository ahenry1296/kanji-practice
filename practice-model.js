/*
 * practice-model.js — choose kanji to practise and build a deterministic drill queue (spec: PRACTICE_MODEL.md).
 * Pure functions on plain data: the rank state (rank-model.js), PRACTICE_CATALOG (practice_catalog.json)
 * and PRACTICE_SETS (practice_sets.json). Browser: window.PracticeModel (load rank-model.js and reading-answer.js first).
 * Node: require('./practice-model.js').
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const RankModel = isNode ? require('./rank-model.js') : root.RankModel;
  const ReadingAnswer = isNode ? require('./reading-answer.js') : root.ReadingAnswer;
  const api = factory(RankModel, ReadingAnswer);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PracticeModel = api;
})(typeof self !== 'undefined' ? self : this, function (RankModel, ReadingAnswer) {
  'use strict';

  /** Default number of kanji picked by selectWeak. */
  const DEFAULT_SIZE = 20;
  /** Default cap on queue items (option maxItems). */
  const DEFAULT_MAX_ITEMS = 40;
  /** Ranks at or below this count as low (none and bronze). */
  const LOW_RANK = RankModel.RANK.bronze;
  /** Items per kanji by rank: reading only below silver, two writing to one reading from silver up. */
  const MIX = {
    0: { reading: 2, writing: 0 },
    1: { reading: 2, writing: 0 },
    2: { reading: 1, writing: 2 },
    3: { reading: 1, writing: 2 },
    4: { reading: 1, writing: 2 },
  };

  /**
   * Kanji of the catalog matching every given filter, in catalog order.
   * Filters: kanji (list), levels (list), setId (practice_sets.json id), radical (KANJIDIC2 classical number),
   * component (glyph listed in the catalog's components).
   */
  function filterKanji(catalog, sets, filters = {}) {
    const set = filters.setId ? ((sets && sets.sets) || []).find((s) => s.id === filters.setId) : null;
    const inSet = filters.setId ? new Set(set ? set.kanji : []) : null;
    const only = filters.kanji ? new Set(filters.kanji) : null;
    return Object.keys(catalog.kanji).filter((k) => {
      const entry = catalog.kanji[k];
      return (!only || only.has(k))
        && (!filters.levels || filters.levels.includes(entry.level))
        && (!inSet || inSet.has(k))
        && (filters.radical == null || entry.radical === filters.radical)
        && (!filters.component || entry.components.includes(filters.component));
    });
  }

  /** Why a record is weak: [] or any of 'clearFails', 'recentDrop', 'retry', 'lowRank'. */
  function weakReasons(record) {
    const reasons = [];
    if (record.clearFails > 0) reasons.push('clearFails');
    if (record.undo) reasons.push('recentDrop');
    if (record.retry) reasons.push('retry');
    if (record.rank <= LOW_RANK) reasons.push('lowRank');
    return reasons;
  }

  /**
   * Weak kanji among candidates: recent trouble first (drop, then clear fails, then retry), then by rank, then
   * candidate order. Unstudied kanji (rank 0) are left out unless includeUnstudied. At most size.
   */
  function selectWeak(rankState, candidates, { size = DEFAULT_SIZE, includeUnstudied = false } = {}) {
    const score = (r) => (r.undo ? 4 : 0) + (r.clearFails > 0 ? 2 : 0) + (r.retry ? 1 : 0);
    return candidates
      .map((kanji, order) => ({ kanji, order, record: RankModel.getKanji(rankState, kanji) }))
      .filter((x) => weakReasons(x.record).length && (includeUnstudied || x.record.rank > 0))
      .sort((a, b) => score(b.record) - score(a.record) || a.record.rank - b.record.rank || a.order - b.order)
      .slice(0, size)
      .map((x) => x.kanji);
  }

  /** Seeded PRNG (mulberry32) from a string or number seed; returns () => [0, 1). */
  function rng(seed) {
    let h = 2166136261;
    for (const ch of String(seed)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    let a = h >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** True when number array a sorts before b (lexicographic). */
  function lexLess(a, b) {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }

  /** Items of one kanji: MIX by rank, plus one extra (writing if unlocked, else reading) when it has recent trouble. */
  function itemsFor(kanji, record) {
    const mix = Object.assign({}, MIX[record.rank]);
    if (record.clearFails > 0 || record.undo || record.retry) {
      mix[RankModel.writingUnlocked(record) ? 'writing' : 'reading'] += 1;
    }
    const items = [];
    for (const kind of ['reading', 'writing']) {
      for (let i = 0; i < mix[kind]; i += 1) items.push({ kanji, kind, rank: record.rank });
    }
    return items;
  }

  /**
   * Drill queue for the given kanji: seeded shuffle, then interleave so the same kanji is never twice in a row
   * and reading/writing alternate where possible (items that must follow their own kanji get repeat: true), cut to
   * maxItems (default 40); with readingWords ({kanji: words}) reading items carry a word. Same inputs and seed → same queue.
   */
  function buildQueue(rankState, kanjiList, { seed = 1, maxItems = DEFAULT_MAX_ITEMS, readingWords = null } = {}) {
    const random = rng(seed);
    const pool = kanjiList.flatMap((k) => itemsFor(k, RankModel.getKanji(rankState, k)));
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const left = {};
    pool.forEach((x) => { left[x.kanji] = (left[x.kanji] || 0) + 1; });
    const queue = [];
    while (pool.length) {
      const prev = queue[queue.length - 1];
      // Prefer: a different kanji than the last item, the kanji with most items left (so none pile up at the end),
      // the other kind than the last item, then shuffled order.
      let pick = 0;
      let best = null;
      pool.forEach((x, i) => {
        const key = [prev && x.kanji === prev.kanji ? 1 : 0, -left[x.kanji], prev && x.kind === prev.kind ? 1 : 0, i];
        if (!best || lexLess(key, best)) { best = key; pick = i; }
      });
      const item = pool.splice(pick, 1)[0];
      left[item.kanji] -= 1;
      queue.push(item);
    }
    const out = markRepeats(queue.slice(0, Math.max(0, maxItems)));
    return readingWords ? attachWords(out, readingWords) : out;
  }

  /**
   * Flag every item whose kanji is the same as the item before it with repeat: true. The interleave above only
   * puts a kanji twice in a row when nothing else is left (one kanji, or one kanji with most of the items), so the
   * UI shows feedback between such reps instead of silently clearing the box.
   */
  function markRepeats(queue) {
    return queue.map((item, i) => (i > 0 && queue[i - 1].kanji === item.kanji ? Object.assign({}, item, { repeat: true }) : item));
  }

  /**
   * Give each reading item its word (ReadingAnswer.drillWord: irregular skipped, common first, fallback to the
   * full list); a kanji's 1st, 2nd … reading item gets its 1st, 2nd … drill word. readingWords = {kanji: words}.
   */
  function attachWords(queue, readingWords) {
    const seen = {};
    return queue.map((item) => {
      if (item.kind !== 'reading') return item;
      const n = seen[item.kanji] || 0;
      seen[item.kanji] = n + 1;
      return Object.assign({}, item, { word: ReadingAnswer.drillWord(readingWords[item.kanji] || [], n) });
    });
  }

  /** True when a reading item's answer matches its word (ReadingAnswer.readingMatches); false without a word. */
  function checkAnswer(item, answer) {
    return Boolean(item.word) && ReadingAnswer.readingMatches(answer, item.word);
  }

  return { DEFAULT_SIZE, DEFAULT_MAX_ITEMS, LOW_RANK, MIX, filterKanji, weakReasons, selectWeak, rng, itemsFor, buildQueue, markRepeats, attachWords, checkAnswer };
});
