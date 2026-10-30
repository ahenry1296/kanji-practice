/**
 * contrast-model.js — v16 R7: look-alike contrast drills + lesson separation (pure, no DOM/storage).
 *
 * Why (MARKET_RESEARCH #8, §3):
 *  - Interleaving/discrimination: when two similar items are confused, practising them side by side with the
 *    distinguishing feature pointed out improves discrimination more than practising each alone
 *    (Kang & Pashler 2012; Birnbaum et al. 2013; similar-kanji studies PMC9125332, MDPI Languages 10/260).
 *  - Interference at encoding: learning look-alikes or same-reading kanji in the SAME first lesson causes
 *    cross-association (learners' "all with reading かん" complaint). So new-kanji lessons keep them apart and
 *    the contrast comes later, once each is known on its own (then contrast drills help, not hurt).
 *
 * Data: pairs come only from confusables.js (`CONFUSABLES.pairs`, Botthree's kanji-data; read-only here).
 * `acceptEither` pairs (ロ/口, ニ/二 …) are skipped: there is nothing to drill.
 *
 * API (window.ContrastModel / require):
 *   indexPairs(pairs) → Map<char, [{other, note, distinguish}]>
 *   detectConfusion({target, answerKanji, answerReading}, index, readingsOf) → {lookalike, kind} | null
 *       kind 'writing': the checker recognised the look-alike; kind 'reading': the typed kana is the
 *       look-alike's on/kun reading and no reading of the target.
 *   confusionOutcome(kind) → {weight, fsrsAgain}: writing 1/true; reading 0.5/false (no 'again' by itself).
 *   scheduleContrast(state, {target, lookalike, kind}, index, now) → state' (one drill per pair, weight adds up)
 *   foldIntoSession(queue, state, now, {at, max}) → {queue, state, folded}: put due drills into an open session.
 *   dueContrasts(state, now) → drills due; completeContrast(state, drill, now) → state' (removes it)
 *   drillItems(drill) → [{kanji, kind:'contrast', pair, scored, note}...]  target scored, look-alike unscored
 *   lessonFilter(orderedCandidates, size, {index, readingsOf, componentsOf, leechPending}) → {lesson, deferred}
 *       Greedy over a component-first order: skips a kanji whose look-alike or ANY reading (on or kun) is already in the
 *       lesson, a look-alike of a kanji with a pending leech re-study (leechPending(k), R8), and anything built on
 *       a skipped kanji (so component-first order still holds). deferred[].reason: 'component-deferred' |
 *       'leech-pause' | 'lookalike' | 'same-reading'.
 *       v16 R29: opts.recentReadings (Map reading -> kanji of the previous lesson) defers a kanji sharing a reading
 *       with a just-introduced one too: reason 'same-reading', with = that kanji, recent: true.
 *
 * Integration:
 *  - Botty (glue, v16int): index once from window.CONFUSABLES.pairs. On a failed writing/reading result call
 *    detectConfusion; if it returns a char, scheduleContrast into storage key `contrast` (JSON state). Feed
 *    foldIntoSession when a drill comes due while a review session is open (check on each answer); otherwise
 *    feed dueContrasts into the next review (PracticeModel.mixedReview already places pairs side by side; or prepend
 *    drillItems). Wrap the new-lesson picker with lessonFilter (candidates = GatingModel.order output).
 *  - Botfour (UI): a contrast item shows both kanji with the pair `note` ("未: top stroke longer…") after the
 *    answer; hook event suggestion `v16:contrast` {target, lookalike} for a "Mixed up with 末" chip.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContrastModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Contrast drill comes back after this delay (same session if it is still running; ~10 min like learning step 1). */
  const DRILL_DELAY_MS = 10 * 60e3;
  /** At most this many pending drills, oldest dropped first (keeps reviews from filling with drills). */
  const MAX_PENDING = 20;

  function indexPairs(pairs) {
    const idx = new Map();
    for (const p of pairs || []) {
      const c = p && Array.isArray(p.chars) ? p.chars : [];
      if (c.length !== 2 || c[0] === c[1] || p.acceptEither) continue;
      for (const [a, b] of [[c[0], c[1]], [c[1], c[0]]]) {
        if (!idx.has(a)) idx.set(a, []);
        if (!idx.get(a).some((x) => x.other === b)) idx.get(a).push({ other: b, note: p.note || '', distinguish: p.distinguish || [] });
      }
    }
    return idx;
  }
  const lookalikesOf = (index, k) => (index.get(k) || []).map((x) => x.other);

  /** Katakana → hiragana and drop okurigana dots, so on/kun readings compare with typed kana. */
  const kana = (s) => String(s || '').replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[.\-]/g, '');

  /**
   * Which look-alike the learner produced instead of `target`, or null.
   * Writing: the checker recognised a listed look-alike. Reading: the typed kana is ANY reading of the look-alike
   * (on'yomi or kun'yomi, okurigana dot removed) and no reading of the target.
   * @param readingsOf (k) => {on: [], kun: []}
   * @returns {{lookalike: string, kind: 'writing'|'reading'} | null}
   */
  function detectConfusion({ target, answerKanji, answerReading } = {}, index, readingsOf = () => ({})) {
    const alikes = lookalikesOf(index, target);
    if (answerKanji && alikes.includes(answerKanji)) return { lookalike: answerKanji, kind: 'writing' };
    if (answerReading) {
      const a = kana(answerReading);
      const t = readingsOf(target) || {};
      const own = new Set([...(t.on || []), ...(t.kun || [])].map(kana));
      if (a && !own.has(a)) {
        for (const o of alikes) {
          const r = readingsOf(o) || {};
          if ([...(r.on || []), ...(r.kun || [])].map(kana).includes(a)) return { lookalike: o, kind: 'reading' };
        }
      }
    }
    return null;
  }

  /**
   * What a confusion means for scheduling (Botty's rule): a writing mix-up counts fully (weight 1, and the
   * failed answer is an FSRS 'again' as usual); a reading mix-up counts half (weight 0.5) and does NOT by
   * itself make the answer an FSRS 'again' (the glue grades the reading by its normal/partial-credit rule).
   */
  function confusionOutcome(kind) {
    return kind === 'writing' ? { weight: 1, fsrsAgain: true } : { weight: 0.5, fsrsAgain: false };
  }

  const emptyState = () => ({ version: 1, pending: [] });
  function sanitizeState(s) {
    if (!s || !Array.isArray(s.pending)) return emptyState();
    return { version: 1, pending: s.pending.filter((d) => d && typeof d.target === 'string' && typeof d.lookalike === 'string' && Number.isFinite(d.due))
      .map((d) => Object.assign({}, d, { weight: Number.isFinite(d.weight) ? d.weight : 1, count: Number.isFinite(d.count) ? d.count : 1 })) };
  }
  const pairKey = (a, b) => [a, b].sort().join('|');

  /** confusion: {target, lookalike, kind} (detectConfusion result + target). Weight accumulates per pair, max 2. */
  function scheduleContrast(state, { target, lookalike, kind = 'writing' }, index, now = Date.now()) {
    const s = sanitizeState(state);
    if (!target || !lookalike || !lookalikesOf(index, target).includes(lookalike)) return s;
    const key = pairKey(target, lookalike);
    const note = (index.get(target).find((x) => x.other === lookalike) || {}).note || '';
    const existing = s.pending.find((d) => pairKey(d.target, d.lookalike) === key);
    // Same pair again: keep one drill, count the confusion, bring it forward if needed.
    const w = confusionOutcome(kind).weight;
    if (existing) {
      existing.count += 1; existing.weight = Math.min(2, existing.weight + w);
      existing.target = target; existing.lookalike = lookalike; existing.due = Math.min(existing.due, now + DRILL_DELAY_MS);
      return s;
    }
    s.pending.push({ target, lookalike, note, due: now + DRILL_DELAY_MS, created: now, count: 1, weight: w });
    while (s.pending.length > MAX_PENDING) s.pending.shift();
    return s;
  }
  /** Due drills, heaviest (most/strongest confusions) first, then oldest. */
  function dueContrasts(state, now = Date.now()) {
    return sanitizeState(state).pending.filter((d) => d.due <= now).sort((a, b) => b.weight - a.weight || a.due - b.due);
  }
  function completeContrast(state, drill) {
    const s = sanitizeState(state);
    s.pending = s.pending.filter((d) => pairKey(d.target, d.lookalike) !== pairKey(drill.target, drill.lookalike));
    return s;
  }

  /** The failed kanji is scored (counts for its schedule); the look-alike is shown for contrast only. */
  function drillItems(drill) {
    return [
      { kanji: drill.target, kind: 'contrast', pair: drill.lookalike, scored: true, note: drill.note },
      { kanji: drill.lookalike, kind: 'contrast', pair: drill.target, scored: false, contrast: true, note: drill.note },
    ];
  }

  /** Main reading (contrast-drill detection): first on'yomi, else first kun'yomi (hiragana). */
  function mainReading(readings) {
    const r = readings || {};
    const first = (r.on && r.on[0]) || (r.kun && r.kun[0]) || '';
    return kana(first);
  }

  /**
   * Readings for lesson separation: every on'yomi and every kun'yomi (okurigana dot removed); any shared one
   * separates two new kanji (畑/旗 はた). Same-reading kanji are only kept apart — no contrast drills for them.
   */
  function lessonReadings(readings) {
    const r = readings || {};
    return [...new Set([...(r.on || []), ...(r.kun || [])].map(kana).filter(Boolean))];
  }

  /**
   * Fold due drills into a review session that is already open (instead of waiting for the next one).
   * Drill items go in right after the current item (index `at`), heaviest drill first, at most `max` drills;
   * folded drills are removed from the pending state. Items carry `contrastDrill: true`.
   * @param {object[]} queue the open session queue (not mutated)
   * @param {number} at index of the item being answered now (-1 = before the first)
   * @returns {{queue: object[], state: object, folded: object[]}}
   */
  function foldIntoSession(queue, state, now = Date.now(), { at = -1, max = 2 } = {}) {
    let s = sanitizeState(state);
    const folded = dueContrasts(s, now).slice(0, Math.max(0, max));
    const items = [];
    for (const d of folded) { items.push(...drillItems(d).map((x) => Object.assign(x, { contrastDrill: true }))); s = completeContrast(s, d); }
    const q = (queue || []).slice();
    q.splice(Math.max(0, Math.min(q.length, at + 1)), 0, ...items);
    return { queue: q, state: s, folded };
  }

  /**
   * @param {string[]} ordered candidates in component-first order (e.g. GatingModel.order)
   * @param {number} size lesson size
   * @param {{index: Map, readingsOf?: (k)=>{on, kun}, componentsOf?: (k)=>string[]}} opts
   */
  function lessonFilter(ordered, size, { index = new Map(), readingsOf = () => ({}), componentsOf = () => [], leechPending = () => false,
                                          recentReadings = new Map() } = {}) {
    const lesson = [], deferred = [], skipped = new Set(), readingIn = new Map();
    for (const k of ordered || []) {
      if (lesson.length >= size) break;
      const blockedPart = componentsOf(k).find((p) => skipped.has(p));
      const alike = lookalikesOf(index, k).find((o) => lesson.includes(o));
      const rds = lessonReadings(readingsOf(k));
      const shared = rds.find((r) => readingIn.has(r));
      const sameReading = shared ? readingIn.get(shared) : null;
      // v16 R29: a reading shared with a kanji from the previous lesson(s) (recentReadings: reading -> kanji) also
      // waits, so homophones are not introduced back to back. Same reason as in-lesson, flagged recent: true.
      const recentHit = sameReading ? null : rds.find((r) => recentReadings.has(r));
      // A look-alike of a kanji in leech re-study (R8) waits until that re-study is done.
      const leechAlike = lookalikesOf(index, k).find((o) => leechPending(o));
      const reason = blockedPart ? ['component-deferred', blockedPart] : leechAlike ? ['leech-pause', leechAlike] : alike ? ['lookalike', alike] : sameReading ? ['same-reading', sameReading]
        : recentHit ? ['same-reading', recentReadings.get(recentHit), true] : null;
      if (reason) { skipped.add(k); deferred.push(reason[2] ? { k, reason: reason[0], with: reason[1], recent: true } : { k, reason: reason[0], with: reason[1] }); continue; }
      lesson.push(k);
      for (const r of rds) if (!readingIn.has(r)) readingIn.set(r, k);
    }
    return { lesson, deferred };
  }

  return { DRILL_DELAY_MS, MAX_PENDING, indexPairs, lookalikesOf, detectConfusion, emptyState, sanitizeState,
           scheduleContrast, dueContrasts, completeContrast, drillItems, mainReading, lessonReadings, lessonFilter,
           confusionOutcome, foldIntoSession };
});
