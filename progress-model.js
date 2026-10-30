/*
 * progress-model.js — v16 #4: one source of truth for a kanji's progress (spec: /workspace/kanji-team/V16_API.md).
 *
 * Combines the rank state (rank-model.js, `ranks`) and the old per-kanji record (`rec:<k>`) into one view that
 * every screen reads: chip tint (tier), scaffold fading (fade), component skipping (known) and review (due).
 * v16 #4 keeps the v15 rules exactly (fadeLevel / partKnown in index.html); later items change only the inputs.
 *
 * Pure functions only: no DOM, no localStorage, no clock. Loads as window.ProgressModel or a CommonJS module.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./rank-model.js') : root.RankModel);
  if (isNode) module.exports = api;
  else root.ProgressModel = api;
})(typeof self !== 'undefined' ? self : this, function (RM) {
  'use strict';

  /** Clean completions in a row for each fade level (v15 fadeLevel: 1 → short review, 2 → recall box only). */
  const FADE_STREAK = { short: 1, recallOnly: 2 };
  /** Clean completions in a row after which a kanji (and so its components) counts as known (v15 partKnown). */
  const KNOWN_STREAK = 1;

  /**
   * The old record's clean streak as a number: anything that is not a number-like value gives 0 (v15:
   * `Number(r.streak) || 0`).
   * @param {object|null} rec
   * @returns {number}
   */
  function streakOf(rec) {
    return rec ? Number(rec.streak) || 0 : 0;
  }

  /**
   * Scaffold fading level: 0 = full flow (new, or the last practice needed hints), 1 = short review,
   * 2 = recall box only.
   * @param {object|null} rec the `rec:<k>` record (null when missing or corrupt)
   * @returns {0|1|2}
   */
  function fadeOf(rec) {
    if (!rec || !rec.lastPracticed) return 0;
    const streak = streakOf(rec);
    return streak >= FADE_STREAK.recallOnly ? 2 : streak >= FADE_STREAK.short ? 1 : 0;
  }

  /**
   * True once the kanji was finished cleanly at least once in a row (its components then skip their part boxes).
   * @param {object|null} rec
   * @returns {boolean}
   */
  function knownOf(rec) {
    return streakOf(rec) >= KNOWN_STREAK;
  }

  /**
   * True when the record has a valid next-review time at or before now.
   * @param {object|null} rec
   * @param {number} now ms since the epoch
   * @returns {boolean}
   */
  function dueOf(rec, now) {
    if (!rec || !rec.nextReview) return false;
    const at = Date.parse(rec.nextReview);
    return Number.isFinite(at) && at <= now;
  }

  /**
   * The progress of one kanji.
   * @param {object|null} rankRecord its record in the rank state (RankModel.getKanji), or null for none
   * @param {object|null} rec its `rec:<k>` record, or null
   * @param {number} now ms since the epoch
   * @returns {{rank: number, tier: string, fade: number, known: boolean, due: boolean}}
   */
  function view(rankRecord, rec, now) {
    const rank = RM.sanitizeRank(rankRecord ? rankRecord.rank : 0);
    return { rank, tier: RM.TIERS[rank], fade: fadeOf(rec), known: knownOf(rec), due: dueOf(rec, now) };
  }

  /**
   * True when a component counts as known: the component itself, or any kanji that contains it, is known.
   * @param {string} glyph component glyph (DATA.kanji[k].parts[i].g)
   * @param {Array<{k: string, parts: Array<{g: string}>}>} kanjiList every kanji entry (Object.values(DATA.kanji))
   * @param {(kanji: string) => {known: boolean}} progressOf progress lookup
   * @returns {boolean}
   */
  function partKnown(glyph, kanjiList, progressOf) {
    return kanjiList.some((K) => (K.k === glyph || K.parts.some((p) => p.g === glyph)) && progressOf(K.k).known);
  }

  return { FADE_STREAK, KNOWN_STREAK, streakOf, fadeOf, knownOf, dueOf, view, partKnown };
});
