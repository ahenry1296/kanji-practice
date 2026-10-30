/**
 * leech-model.js — v16 R8: leech detection + targeted component re-study (pure, no DOM/storage).
 *
 * A "leech" is a card that keeps lapsing: repeating the same review does not fix it, it just costs time
 * (Anki/SuperMemo leech handling; Wozniak's "20 rules": leeches need re-encoding, not more drilling).
 * For kanji the usual cause is a weak or confused component, so the fix is targeted re-study in
 * component-first order: each component (deepest first), then the kanji itself — the same radical-first logic
 * as first study (Gating #3), now aimed at the one kanji that is failing.
 *
 * Rules:
 *  - Flag when FSRS `lapses` ≥ 4 (LEECH_LAPSES).
 *  - After a re-study, flag again only after 2 more lapses (REPEAT_LAPSES, like Anki's half-threshold repeat).
 *  - Re-study does NOT reset the FSRS card (stability/lapses stay); it adds unscored study steps and one scored
 *    recall of the kanji at the end.
 *
 * API (window.LeechModel / require):
 *   isLeech(card, flag?) → boolean
 *   update(state, kanji, card, now) → {state, newlyFlagged}     call after every graded review of `kanji`
 *   restudyPlan(kanji, componentsOf, {isKnown}) → [{kanji, kind:'component'|'kanji', scored}]
 *       components deepest-first, deduped; components with isKnown(g) true are shown once as a quick refresher
 *       (kind 'component', refresher: true) — never skipped, since the leech suggests a part is shaky.
 *   pending(state) → [{kanji, flaggedAt, lapses, times}] flagged and not yet re-studied (oldest first)
 *   completeRestudy(state, kanji, card, now) → state'
 *   sanitizeState(x) / emptyState()
 *
 * Integration:
 *  - Botty (glue, v16int): storage key `leech`. After each FSRS grade (gradeKey/onReviewDone) call update with
 *    the new card; on newlyFlagged dispatch `v16:leech` {kanji, lapses}. Build the re-study queue with
 *    restudyPlan(k, k2 => GatingModel.componentsOf(k2, DATA.kanji)); call completeRestudy when its last
 *    (scored) step is done.
 *  - Botfour (UI): a "Needs a fresh look" card on home listing pending(state); toast on `v16:leech`
 *    ("休 keeps slipping — let's rebuild it from its parts"). Component steps reuse the part-writing box.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeechModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEECH_LAPSES = 4;
  const REPEAT_LAPSES = 2;
  /** Guard against cyclic/deep component data. */
  const MAX_DEPTH = 4;

  const emptyState = () => ({ version: 1, flags: {} });
  function sanitizeState(s) {
    const out = emptyState();
    if (!s || typeof s.flags !== 'object' || !s.flags) return out;
    for (const [k, f] of Object.entries(s.flags)) {
      if (!f || !Number.isFinite(f.flaggedAt) || !Number.isFinite(f.lapses)) continue;
      out.flags[k] = { flaggedAt: f.flaggedAt, lapses: f.lapses, times: Math.max(1, Math.trunc(f.times) || 1),
                       restudiedAt: Number.isFinite(f.restudiedAt) ? f.restudiedAt : null,
                       lapsesAtRestudy: Number.isFinite(f.lapsesAtRestudy) ? f.lapsesAtRestudy : null };
    }
    return out;
  }
  const lapsesOf = (card) => Math.max(0, Math.trunc(Number(card && card.lapses)) || 0);

  /** Leech now? With an earlier re-study, only after REPEAT_LAPSES new lapses since then. */
  function isLeech(card, flag) {
    const n = lapsesOf(card);
    if (flag && flag.restudiedAt !== null && flag.lapsesAtRestudy !== null) return n >= flag.lapsesAtRestudy + REPEAT_LAPSES;
    return n >= LEECH_LAPSES;
  }

  function update(state, kanji, card, now = Date.now()) {
    const s = sanitizeState(state);
    const f = s.flags[kanji];
    const open = f && f.restudiedAt === null;   // already flagged, re-study still pending
    if (open || !isLeech(card, f)) {
      if (open) f.lapses = lapsesOf(card);
      return { state: s, newlyFlagged: false };
    }
    s.flags[kanji] = { flaggedAt: now, lapses: lapsesOf(card), times: f ? f.times + 1 : 1, restudiedAt: null, lapsesAtRestudy: null };
    return { state: s, newlyFlagged: true };
  }

  function restudyPlan(kanji, componentsOf = () => [], { isKnown = () => false } = {}) {
    const steps = [], seen = new Set([kanji]);
    // Post-order walk: a component's own parts come before it (deepest first).
    const walk = (k, depth) => {
      if (depth > MAX_DEPTH) return;
      for (const g of componentsOf(k) || []) {
        if (seen.has(g)) continue;
        seen.add(g);
        walk(g, depth + 1);
        steps.push(Object.assign({ kanji: g, kind: 'component', scored: false, for: kanji }, isKnown(g) ? { refresher: true } : {}));
      }
    };
    walk(kanji, 0);
    steps.push({ kanji, kind: 'kanji', scored: true, for: kanji });
    return steps;
  }

  function pending(state) {
    const s = sanitizeState(state);
    return Object.entries(s.flags).filter(([, f]) => f.restudiedAt === null)
      .map(([kanji, f]) => ({ kanji, flaggedAt: f.flaggedAt, lapses: f.lapses, times: f.times }))
      .sort((a, b) => a.flaggedAt - b.flaggedAt || (a.kanji < b.kanji ? -1 : 1));
  }

  function completeRestudy(state, kanji, card, now = Date.now()) {
    const s = sanitizeState(state);
    const f = s.flags[kanji];
    if (f && f.restudiedAt === null) { f.restudiedAt = now; f.lapsesAtRestudy = lapsesOf(card); }
    return s;
  }

  return { LEECH_LAPSES, REPEAT_LAPSES, emptyState, sanitizeState, isLeech, update, restudyPlan, pending, completeRestudy };
});
