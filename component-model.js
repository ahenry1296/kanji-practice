/*
 * component-model.js — v16 R14 component / radical families. Pure: no DOM, no storage (glue: V15.componentFamily,
 * V15.componentFamilies, pickNewLesson mode 'family'). Exposes window.ComponentModel; CommonJS for tests.
 *
 * Sources (existing data only — nothing is invented; meaning is null when no source has one):
 *   - membership: PRACTICE_CATALOG.kanji[k].components (all 2,212 kanji, eager) ∪ kanjiMap[k].parts[].g (loaded levels)
 *                 ∪ data.groups[k][].g (v16 R22: B3's nested KanjiVG groups, window.KANJI_GROUPS from nested-groups.js,
 *                 e.g. 舌 inside 話; optional, lazy with the 'components' group). A kanji is listed once per family.
 *   - level:      PRACTICE_CATALOG.kanji[k].level, else kanjiMap[k].jlpt
 *   - meaning, first found: a part's own kw / meanings in kanjiMap parts → PRACTICE_CATALOG.componentNames (CDP codes)
 *                 → the component as a kanji (kanjiMap[g].keyword, else meanings[0]) → a radical's meaning
 *                 (kanjiMap[*].radical.glyph === g) → B3's drawing data (data.glyphs = COMPONENT_GLYPHS.glyphs, its
 *                 `kw`; R22). meaningSource names which one.
 *   - order:      JLPT level N5→N1, then frequency. The data has NO frequency rank, so "frequency" = opts.freqRank
 *                 ({kanji: rank}, lower = more frequent) when given, else the catalog/level order (the app's planned
 *                 order). Data request: kanji-team/REQUEST-R14-frequency.md.
 *   - status:     same definitions as StatsModel/scheduler: card phase review with stability ≥ 21 d → mature; any
 *                 other non-new card, or a studied rec (lastPracticed/nextReview) → learning; else unseen.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComponentModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MATURE_DAYS = 21;
  const LEVEL_ORDER = { N5: 0, N4: 1, N3: 2, N2: 3, N1: 4 };
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  // Memo: catalog → kanjiMap → freqRank → index. WeakMaps, so a new data object simply builds a new index.
  const memo = new WeakMap();
  const NONE = {};
  let builds = 0;   // for tests: how many times an index was actually built

  /** Index {byComp: Map(g → [k sorted]), meaning: Map(g → {text, source}), level: Map(k → 'N5'…)}, built once. */
  // R22: the memo is also keyed on `groups` (nested-groups.js) and `glyphs` (COMPONENT_GLYPHS.glyphs).
  function index(catalog, kanjiMap, freqRank, groups, glyphs) {
    let m = memo;
    for (const key of [catalog, kanjiMap, freqRank, groups]) {
      const k = key || NONE; let next = m.get(k); if (!next) m.set(k, (next = new WeakMap())); m = next;
    }
    const e = glyphs || NONE;
    let ix = m.get(e);
    if (!ix) { ix = build(catalog || {}, kanjiMap || {}, freqRank, groups || {}, glyphs || {}); m.set(e, ix); }
    return ix;
  }
  /** The index for one `data` object (every field optional). */
  const ixOf = (data) => index(data.catalog, data.kanjiMap, data.freqRank, data.groups, data.glyphs);

  function build(catalog, kanjiMap, freqRank, groups, glyphs) {
    builds++;
    const cat = catalog.kanji || {};
    const byComp = new Map(), level = new Map(), pos = new Map();
    const add = (g, k) => { if (!g || g === k) return; let s = byComp.get(g); if (!s) byComp.set(g, (s = new Set())); s.add(k); };
    let i = 0;
    for (const k in cat) {
      pos.set(k, i++);
      level.set(k, cat[k] && cat[k].level);
      for (const g of (cat[k] && cat[k].components) || []) add(g, k);
    }
    const meaning = new Map();
    const setM = (g, text, source) => { if (g && typeof text === 'string' && text && !meaning.has(g)) meaning.set(g, { text, source }); };
    for (const k in kanjiMap) {
      const K = kanjiMap[k] || {};
      if (!level.has(k) && K.jlpt) level.set(k, K.jlpt);
      if (!pos.has(k)) pos.set(k, i++);
      for (const p of Array.isArray(K.parts) ? K.parts : []) {
        if (!p) continue;
        add(p.g, k);
        setM(p.g, p.kw, 'part-keyword');
        if (Array.isArray(p.meanings)) setM(p.g, p.meanings[0], 'part-meaning');
      }
    }
    // R22: nested groups only add family membership (their stroke ranges are used by diagnosis-model.js).
    for (const k in groups) {
      if (!pos.has(k)) continue;   // a kanji the app does not know (no catalog or data entry) never joins a family
      for (const grp of Array.isArray(groups[k]) ? groups[k] : []) if (grp && typeof grp.g === 'string') add(grp.g, k);
    }
    for (const g in catalog.componentNames || {}) setM(g, catalog.componentNames[g], 'componentNames');
    for (const g of byComp.keys()) {
      const K = kanjiMap[g];
      if (K) { setM(g, K.keyword, 'kanji-keyword'); if (Array.isArray(K.meanings)) setM(g, K.meanings[0], 'kanji-meaning'); }
    }
    for (const k in kanjiMap) { const r = kanjiMap[k] && kanjiMap[k].radical; if (r) setM(r.glyph, r.meaning, 'radical'); }
    for (const g of byComp.keys()) if (glyphs[g]) setM(g, glyphs[g].kw, 'glyph-keyword');   // R22: last resort

    // opts.freqRank wins; else a future catalog `freq` field (see the data request); else no rank (catalog order)
    const rank = (k) => (freqRank && Number.isFinite(freqRank[k]) ? freqRank[k]
      : cat[k] && Number.isFinite(cat[k].freq) ? cat[k].freq : Infinity);
    const cmp = (x, y) => (LEVEL_ORDER[level.get(x)] ?? 9) - (LEVEL_ORDER[level.get(y)] ?? 9)
      || rank(x) - rank(y) || pos.get(x) - pos.get(y);
    const sorted = new Map();
    for (const [g, s] of byComp) sorted.set(g, [...s].sort(cmp));
    return { byComp: sorted, meaning, level, componentsOf: (k) => (cat[k] && cat[k].components) || [] };
  }

  /** 'unseen' | 'learning' | 'mature' for one kanji (scheduler definitions above). */
  function statusOf(card, rec) {
    if (card && card.phase && card.phase !== 'new') {
      return card.phase === 'review' && Number(card.stability) >= MATURE_DAYS ? 'mature' : 'learning';
    }
    return rec && (rec.lastPracticed || rec.nextReview) ? 'learning' : 'unseen';
  }

  /** One family: {component, meaning, meaningSource, kanji:[{k, level, status}], counts:{unseen,learning,mature}}. */
  function family(g, data = {}) {
    const ix = ixOf(data);
    const cards = data.cards || {}, recs = data.recs || {};
    const counts = { unseen: 0, learning: 0, mature: 0 };
    const kanji = (ix.byComp.get(g) || []).map((k) => {
      const status = statusOf(cards[k], recs[k]);
      counts[status]++;
      return { k, level: ix.level.get(k) || null, status };
    });
    const m = ix.meaning.get(g);
    return { component: g, meaning: m ? m.text : null, meaningSource: m ? m.source : null, kanji, counts };
  }

  /** All families, biggest first (ties: component glyph order). opts.minSize (1) drops tiny ones. */
  function families(data = {}, { minSize = 1 } = {}) {
    const ix = ixOf(data);
    const out = [];
    for (const g of ix.byComp.keys()) if (ix.byComp.get(g).length >= minSize) out.push(family(g, data));
    return out.sort((x, y) => y.kanji.length - x.kanji.length || (x.component < y.component ? -1 : 1));
  }

  /** Components of a kanji (catalog), e.g. to find the family of a just-learned kanji. */
  function componentsOf(k, data = {}) { return ixOf(data).componentsOf(k).slice(); }

  /**
   * Planned order for a family lesson: unseen kanji sharing any of `components`, family by family in the given
   * order, each family in index order (level, then frequency). The caller still applies gating, look-alike,
   * reading, leech and budget rules.
   */
  function familyPlan(components, data = {}) {
    const seen = new Set(), out = [];
    for (const g of components || []) {
      for (const e of family(g, data).kanji) if (e.status === 'unseen' && !seen.has(e.k)) { seen.add(e.k); out.push(e.k); }
    }
    return out;
  }

  return { MATURE_DAYS, index, statusOf, family, families, componentsOf, familyPlan, _builds: () => builds };
});
