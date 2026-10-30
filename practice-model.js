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


  /** v16 #9: retries (requeued copies) allowed per kanji in one session. */
  const MAX_RETRIES_PER_SESSION = 2;
  /** v16 #9: other items between a missed item and its retry, when the queue is long enough. */
  const MIN_REQUEUE_GAP = 5;

  /**
   * v16 #9: after a missed item, put one retry of it later in the session instead of straight away.
   * The retry goes after at least MIN_REQUEUE_GAP other items (or at the end of a shorter queue), moved later
   * past any item of the same kanji so it is never twice in a row unless the queue ends; at most
   * MAX_RETRIES_PER_SESSION retries per kanji (counted from the queue itself, so no extra state).
   * A retry is practice only: it carries `retry: n` and `scored: false`, and the caller applies no rank event
   * (no pass, no clear failure) and no record finish for it — the miss was already scored once, so v15 rank
   * rules (near-miss retry inside a box, clear failures, demotion) and the #2 learning steps see exactly what they
   * saw without requeueing. The in-box near-miss retry is unchanged and is not a requeue.
   * @param {object[]} queue the session queue (not mutated)
   * @param {number} index index of the missed item
   * @param {object} [item] the missed item (default queue[index])
   * @returns {{queue: object[], requeued: boolean, at: number}} at = retry index, or -1 when capped
   */
  function requeue(queue, index, item = queue[index]) {
    const used = item ? queue.filter((x) => x.kanji === item.kanji && x.retry).length : 0;
    if (!item || used >= MAX_RETRIES_PER_SESSION) return { queue: queue.slice(), requeued: false, at: -1 };
    const copy = Object.assign({}, item, { retry: used + 1, scored: false });
    delete copy.repeat;
    let at = Math.min(index + 1 + MIN_REQUEUE_GAP, queue.length);
    while (at < queue.length && (queue[at - 1].kanji === item.kanji || (queue[at] && queue[at].kanji === item.kanji))) at += 1;
    const out = queue.slice(0, at).concat([copy], queue.slice(at)).map((x) => {
      if (!x.repeat) return x;
      const y = Object.assign({}, x);
      delete y.repeat;
      return y;
    });
    return { queue: markRepeats(out), requeued: true, at };
  }

  /** v16 #9: true when an item's outcome should reach the rank model / records (false only for retries). */
  function isScored(item) {
    return !(item && item.scored === false);
  }

  /** v16 #6: target share of items that belong to a confusable pair in a mixed review set (reported, not forced). */
  const MIN_PAIR_SHARE = 0.3;

  /**
   * v16 #6: confusable partner per kanji from confusables.js `pairs` only (never invented). Each kanji is used in at
   * most one pair (first eligible pair in data order), like the practice-sets confusable sets.
   * @param {string[]} kanjiList the due kanji, most overdue first
   * @param {{chars: string[]}[]} pairs CONFUSABLES.pairs
   * @param {(k: string) => boolean} canPartner whether a not-due kanji may join as an unscored contrast item
   * @returns {Map<string, {partner: string, due: boolean}>} both directions
   */
  function confusablePartners(kanjiList, pairs, canPartner) {
    const due = new Set(kanjiList);
    const out = new Map();
    for (const k of kanjiList) {
      if (out.has(k)) continue;
      for (const p of pairs || []) {
        const chars = (p && Array.isArray(p.chars)) ? p.chars : [];
        if (chars.length !== 2 || !chars.includes(k) || chars[0] === chars[1]) continue;
        const other = chars[0] === k ? chars[1] : chars[0];
        if (out.has(other)) continue;
        if (!due.has(other) && !canPartner(other)) continue;
        out.set(k, { partner: other, due: true });
        out.set(other, { partner: k, due: due.has(other) });
        break;
      }
    }
    return out;
  }

  /**
   * v16 #6: a review set that mixes in look-alikes. Scored items are built only for the due kanji (itemsFor, as
   * buildQueue), so the #2 due logic decides what is reviewed. A confusable partner that is not due joins as ONE
   * unscored contrast item (`scored: false`, #9 isScored → no rank event, no recFinish, no due change); reading
   * unless its writing is unlocked. Pair members are placed next to each other where possible, the same kanji is
   * never twice in a row unless nothing else is left (then `repeat: true`), items carry `pair: <other>|null`.
   * #9 requeue works on the result as on any queue (retries stay unscored).
   * @param {object} rankState
   * @param {string[]} dueKanji
   * @param {{pairs?: object[], canPartner?: (k: string) => boolean, seed?: number, maxItems?: number}} [opts]
   * @returns {{queue: object[], pairShare: number, pairShareMet: boolean, pairs: string[][]}}
   */
  function mixedReview(rankState, dueKanji, { pairs = [], canPartner = () => false, seed = 1, maxItems = DEFAULT_MAX_ITEMS } = {}) {
    const list = Array.from(new Set(dueKanji));
    const partners = confusablePartners(list, pairs, canPartner);
    const random = rng(seed);
    const pool = [];
    for (const k of list) {
      const pair = partners.has(k) ? partners.get(k).partner : null;
      itemsFor(k, RankModel.getKanji(rankState, k)).forEach((x) => pool.push(Object.assign(x, { pair })));
    }
    for (const [k, info] of partners) {
      if (info.due) continue;
      const record = RankModel.getKanji(rankState, k);
      pool.push({ kanji: k, kind: RankModel.writingUnlocked(record) ? 'writing' : 'reading', rank: record.rank,
        pair: info.partner, scored: false, contrast: true });
    }
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const left = {};
    pool.forEach((x) => { left[x.kanji] = (left[x.kanji] || 0) + 1; });
    const queue = [];
    while (pool.length) {
      const prev = queue[queue.length - 1];
      let pick = 0;
      let best = null;
      pool.forEach((x, i) => {
        // Prefer: not the last kanji, the last item's look-alike (contrast right after), most items left, other kind.
        const key = [prev && x.kanji === prev.kanji ? 1 : 0, prev && prev.pair === x.kanji ? 0 : 1, -left[x.kanji],
          prev && x.kind === prev.kind ? 1 : 0, i];
        if (!best || lexLess(key, best)) { best = key; pick = i; }
      });
      const item = pool.splice(pick, 1)[0];
      left[item.kanji] -= 1;
      queue.push(item);
    }
    const out = markRepeats(queue.slice(0, Math.max(0, maxItems)));
    const inPair = out.filter((x) => x.pair).length;
    const pairShare = out.length ? inPair / out.length : 0;
    const used = [];
    for (const [k, info] of partners) if (k < info.partner) used.push([k, info.partner]);
    return { queue: out, pairShare, pairShareMet: pairShare >= MIN_PAIR_SHARE, pairs: used };
  }

  return { MIN_PAIR_SHARE, confusablePartners, mixedReview, MAX_RETRIES_PER_SESSION, MIN_REQUEUE_GAP, requeue, isScored, DEFAULT_SIZE, DEFAULT_MAX_ITEMS, LOW_RANK, MIX, filterKanji, weakReasons, selectWeak, rng, itemsFor, buildQueue, markRepeats, attachWords, checkAnswer };
});
