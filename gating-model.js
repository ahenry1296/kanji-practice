/*
 * gating-model.js — v16 #3: component gating (spec: /workspace/kanji-team/V16_API.md).
 *
 * Uses only the component data already in the app data (`DATA.kanji[k].parts[].g`, from data.js / data-N*.js);
 * it never adds components or meanings. A component that is itself a kanji in the data ("rankable") has a rank and
 * is gated on and ordered just in time: right before its first compound. A component that is not a kanji in the data
 * ("part-only", e.g. 亻 氵) has no rank or own drawing; it keeps being introduced by the existing part-alone step
 * of its first compound's lesson, which is already just in time, so it never blocks.
 *
 * Pure functions only: no DOM, no localStorage. Loads as window.GatingModel or a CommonJS module.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./rank-model.js') : root.RankModel);
  if (isNode) module.exports = api;
  else root.GatingModel = api;
})(typeof self !== 'undefined' ? self : this, function (RM) {
  'use strict';

  /** Default tier every rankable component must reach before its compounds are introduced. */
  const DEFAULT_GATE_TIER = 'bronze';

  /**
   * Distinct component glyphs of a kanji in data order, without the kanji itself.
   * @param {string} kanji
   * @param {{[k: string]: {parts?: {g: string}[]}}} kanjiMap DATA.kanji (all loaded levels)
   * @returns {string[]}
   */
  function componentsOf(kanji, kanjiMap) {
    const K = kanjiMap[kanji];
    const out = [];
    for (const p of (K && Array.isArray(K.parts) ? K.parts : [])) {
      if (p && typeof p.g === 'string' && p.g !== kanji && !out.includes(p.g)) out.push(p.g);
    }
    return out;
  }

  /** Components that are kanji in the data (have a rank) — the only ones gated on. */
  function gatedComponents(kanji, kanjiMap) {
    return componentsOf(kanji, kanjiMap).filter((g) => Object.prototype.hasOwnProperty.call(kanjiMap, g));
  }

  /**
   * Rankable components still below the gate: not at minTier and not known (streak/placement: progress.known).
   * @param {string} kanji
   * @param {object} kanjiMap
   * @param {(k: string) => {rank: number, known: boolean}} progressOf e.g. k => V15.progressOf(localStorage, k)
   * @param {{minTier?: string}} [opts] minTier 'none' disables gating
   * @returns {string[]}
   */
  function blockers(kanji, kanjiMap, progressOf, { minTier = DEFAULT_GATE_TIER } = {}) {
    const need = RM.RANK[minTier];
    if (!need) return [];
    return gatedComponents(kanji, kanjiMap).filter((g) => {
      const p = progressOf(g) || {};
      return !(p.known || (Number(p.rank) || 0) >= need);
    });
  }

  /** True when no rankable component blocks the kanji. */
  function isUnlocked(kanji, kanjiMap, progressOf, opts) {
    return blockers(kanji, kanjiMap, progressOf, opts).length === 0;
  }

  /**
   * Just-in-time order: each kanji in list order, with its not-yet-placed rankable components (recursively, from the
   * whole data, so a later-level component is pulled forward) right before it. Cycles in the data are cut (the
   * kanji already on the path is not re-entered). Each entry says which compound pulled it in.
   * @param {string[]} kanjiList the planned order (e.g. a level's frequency order)
   * @param {object} kanjiMap
   * @param {{skip?: (k: string) => boolean}} [opts] skip = already introduced (not placed, not recursed)
   * @returns {{kanji: string, introducedFor: string|null}[]}
   */
  function orderWithReasons(kanjiList, kanjiMap, { skip = () => false } = {}) {
    const placed = new Set();
    const onPath = new Set();
    const out = [];
    const visit = (k, forK) => {
      if (placed.has(k) || onPath.has(k) || skip(k)) return;
      onPath.add(k);
      for (const g of gatedComponents(k, kanjiMap)) visit(g, k);
      onPath.delete(k);
      placed.add(k);
      out.push({ kanji: k, introducedFor: forK });
    };
    kanjiList.forEach((k) => visit(k, null));
    return out;
  }

  /** orderWithReasons as a plain kanji list. */
  function order(kanjiList, kanjiMap, opts) {
    return orderWithReasons(kanjiList, kanjiMap, opts).map((e) => e.kanji);
  }

  /**
   * Data coverage report for the gaps: component glyphs that are not kanji in the data (part-only), and component
   * uses with no keyword/meaning in the data. Nothing is filled in.
   * @param {object} kanjiMap
   * @param {{componentKw?: {[g: string]: string}}} [opts] the levels' componentKw maps (merged) also count as a meaning
   * @returns {{kanji: number, componentUses: number, rankableUses: number, partOnlyUses: number,
   *   partOnlyGlyphs: string[], noMeaningUses: number, noMeaningGlyphs: string[], cycles: string[][]}}
   */
  function coverage(kanjiMap, { componentKw = {} } = {}) {
    const r = { kanji: 0, componentUses: 0, rankableUses: 0, partOnlyUses: 0, partOnlyGlyphs: [], noMeaningUses: 0, noMeaningGlyphs: [], cycles: [] };
    const partOnly = new Set();
    const noMeaning = new Set();
    for (const [k, K] of Object.entries(kanjiMap)) {
      r.kanji += 1;
      for (const p of (Array.isArray(K.parts) ? K.parts : [])) {
        if (!p || p.g === k) continue;
        r.componentUses += 1;
        if (Object.prototype.hasOwnProperty.call(kanjiMap, p.g)) r.rankableUses += 1;
        else { r.partOnlyUses += 1; partOnly.add(p.g); }
        if (!p.kw && !componentKw[p.g] && !(Array.isArray(p.meanings) && p.meanings.length)) { r.noMeaningUses += 1; noMeaning.add(p.g); }
      }
      for (const g of gatedComponents(k, kanjiMap)) {
        if (gatedComponents(g, kanjiMap).includes(k) && k < g) r.cycles.push([k, g]);
      }
    }
    r.partOnlyGlyphs = [...partOnly];
    r.noMeaningGlyphs = [...noMeaning];
    return r;
  }

  return { DEFAULT_GATE_TIER, componentsOf, gatedComponents, blockers, isUnlocked, orderWithReasons, order, coverage };
});
