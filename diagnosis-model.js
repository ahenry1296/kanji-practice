/*
 * diagnosis-model.js — component-level writing diagnosis (v16 lane item R10, MARKET_RESEARCH.md gap #2 / row 9).
 * Pure: no DOM, no storage. Exposes window.DiagnosisModel; also CommonJS for tests.
 *
 * What it does: the stroke checker (index.html checkStroke / KanjiWriting.checkStrokes; Botthree's lane, NOT edited
 * here) judges each stroke. This module maps every stroke index onto the kanji's components using the data's
 * `parts[{g, from, to}]` (inclusive, 0-based stroke ranges from KanjiVG top-level components, SCHEMA.md), so a result
 * reads like "the 言 side is fine, the 寺 part fails stroke 4". It keeps decaying per-component error scores and
 * turns weak components into extra (unscored) component practice using LeechModel.restudyPlan.
 *
 * Stroke numbers shown to people are 1-based. `stroke` = position inside the component (寺's 4th stroke);
 * `kanjiStroke` = position in the whole kanji. A component split in the data (国: 囗 0-1, 玉 2-6, 囗 7) is merged
 * back into one component, so 囗's strokes are 1, 2, 3.
 *
 * ---- Integration (read side only) ----
 *   V15.weakComponents(storage, now) reads the 'diagnosis' key (old data and backups). R29-cleanup removed the write
 *   glue (V15.diagnoseWriting / diagnosisPractice / noteDiagnosisPractised): nothing called it, and R24 weak-spot
 *   (v16-weakspot.js) is the live record of weak parts. diagnose / record / practicePlan stay as tested pure functions.
 *
 * ---- UI hooks for Botfour ----
 *   diagnosis.highlight = [{g, kanjiStrokes:[0-based], status:'ok'|'fail'|'unwritten'}] → tint each component's
 *     strokes (e.g. fail = red outline) on the kanji just written.
 *   diagnosis.message   = 'Weak spot: 寺, stroke 4' (or null when every component was fine). Plain text, safe to show.
 *   diagnosis.summary   = [{g, status, failedStrokes:[1-based in component]}] for a per-component list.
 *   weakComponents(state, now) → [{g, score, worstStroke, kanji}] for a "weak spots" panel; message() for each.
 *   Event 'v16:diagnosis' {kanji, weak:[g…], message} fires from the glue after each diagnosis.
 *
 * ---- v16 R22: nested groups (B3's nested-groups.js, window.KANJI_GROUPS[k] = [{g, from, to, depth}]) ----
 *   diagnose(entry, results, groups) also judges each nested group (e.g. 舌 inside 話's 舌 part) the same way and
 *   returns them as diagnosis.nested = [{g, depth, status, failedStrokes, kinds, kanjiStrokes}] plus
 *   diagnosis.weakNested = [g…]. record() scores them like components, so a weak nested group shows up in
 *   weakComponents/practicePlan. summary, highlight, message, fine and weak are unchanged (top-level parts only).
 *   Groups with a bad range, or whose glyph is already a top-level part of this kanji, are ignored.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiagnosisModel = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const STATE_VERSION = 1;
  const HALF_LIFE_DAYS = 7;      // an error counts half after a week, so old trouble fades
  const FAIL_WEIGHT = 1;         // added per diagnosis in which the component had a failed stroke
  const CLEAN_CREDIT = 0.5;      // removed when the component was written cleanly (recovery)
  const WEAK_THRESHOLD = 2;      // decayed score at which a component counts as weak
  const MAX_WEAK = 3;            // at most this many extra components per session
  const MAX_TRACKED = 500;       // cap the stored components (lowest scores dropped first)
  const DAY_MS = 864e5;

  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  /**
   * Components of one kanji data entry: [{g, kanjiStrokes:[0-based…]}] in first-stroke order, plus strokeOwner
   * (stroke index → component index). Returns null when the data cannot be trusted (missing parts, a range out of
   * bounds, or strokes not covered exactly once) — the caller then skips diagnosis for that kanji.
   */
  function componentMap(entry) {
    if (!isObj(entry) || !Array.isArray(entry.parts) || !entry.parts.length) return null;
    const n = Number(entry.strokes);
    if (!Number.isInteger(n) || n < 1) return null;
    const owner = new Array(n).fill(-1);
    const comps = []; const byGlyph = new Map();
    for (const p of entry.parts) {
      const from = Number(p && p.from); const to = Number(p && p.to);
      if (!p || typeof p.g !== 'string' || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= n || from > to) return null;
      if (!byGlyph.has(p.g)) { byGlyph.set(p.g, comps.length); comps.push({ g: p.g, kanjiStrokes: [] }); }
      const ci = byGlyph.get(p.g);
      for (let i = from; i <= to; i += 1) {
        if (owner[i] !== -1) return null;   // overlapping ranges
        owner[i] = ci; comps[ci].kanjiStrokes.push(i);
      }
    }
    if (owner.includes(-1)) return null;    // a stroke belongs to no component
    comps.forEach((c) => c.kanjiStrokes.sort((a, b) => a - b));
    return { components: comps, strokeOwner: owner };
  }

  /** Normalise checker output to {index: verdict}. Accepts verdicts[] (index = stroke) or [{i, ok, …}]. */
  function byStroke(results) {
    const out = {};
    (Array.isArray(results) ? results : []).forEach((v, idx) => {
      if (!isObj(v)) return;
      const i = Number.isInteger(v.i) ? v.i : idx;
      // Several attempts at the same stroke: any failure counts.
      if (!out[i] || out[i].ok) out[i] = v;
    });
    return out;
  }

  /** Short reason code from a checker verdict (msg is internal: 'Shape', 'Wrong order', 'Redo first', …). */
  function kindOf(v) {
    if (v.msg === 'Wrong order') return 'order';
    if (v.redoFirst || v.msg === 'Redo first') return 'start';
    if (v.msg === 'Shape' || v.shape) return 'shape';
    return 'position';
  }

  /**
   * Diagnose one written kanji. entry = the kanji's data entry, results = checker verdicts.
   * Returns null when the kanji has no usable component data.
   */
  function diagnose(entry, results, groups) {
    const map = componentMap(entry);
    if (!map) return null;
    const v = byStroke(results);
    const judge = (c) => {
      const failedStrokes = []; const kinds = []; let written = 0;
      c.kanjiStrokes.forEach((ks, local) => {
        if (!v[ks]) return;
        written += 1;
        if (v[ks].ok === false) { failedStrokes.push(local + 1); kinds.push(kindOf(v[ks])); }
      });
      const status = failedStrokes.length ? 'fail' : written ? 'ok' : 'unwritten';
      return { g: c.g, status, failedStrokes, kinds, kanjiStrokes: c.kanjiStrokes.slice(),
        failedKanjiStrokes: failedStrokes.map((s) => c.kanjiStrokes[s - 1] + 1) };
    };
    const summary = map.components.map(judge);
    const nested = nestedGroups(groups, map).map((c) => Object.assign(judge(c), { depth: c.depth }));
    const failed = summary.filter((s) => s.status === 'fail');
    // Message names the first failing component (stroke order) and its first failed stroke.
    const message = failed.length ? 'Weak spot: ' + failed[0].g + ', stroke ' + failed[0].failedStrokes[0] : null;
    return {
      kanji: entry.k, summary, message,
      fine: summary.filter((s) => s.status === 'ok').map((s) => s.g),
      weak: failed.map((s) => s.g),
      highlight: summary.map((s) => ({ g: s.g, kanjiStrokes: s.kanjiStrokes, status: s.status })),
      nested, weakNested: nested.filter((s) => s.status === 'fail').map((s) => s.g),   // R22
    };
  }

  /**
   * R22: this kanji's nested groups as [{g, depth, kanjiStrokes}] (same shape componentMap uses). Skips bad ranges
   * and glyphs that are already top-level parts; a glyph listed twice (split group) is merged into one entry.
   */
  function nestedGroups(groups, map) {
    const n = map.strokeOwner.length;
    const top = new Set(map.components.map((c) => c.g));
    const out = []; const byGlyph = new Map();
    (Array.isArray(groups) ? groups : []).forEach((grp) => {
      const from = Number(grp && grp.from); const to = Number(grp && grp.to);
      if (!grp || typeof grp.g !== 'string' || top.has(grp.g)) return;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= n || from > to) return;
      if (!byGlyph.has(grp.g)) { byGlyph.set(grp.g, out.length); out.push({ g: grp.g, depth: Number(grp.depth) || 0, kanjiStrokes: [] }); }
      const c = out[byGlyph.get(grp.g)];
      for (let i = from; i <= to; i += 1) if (!c.kanjiStrokes.includes(i)) c.kanjiStrokes.push(i);
      c.kanjiStrokes.sort((a, b) => a - b);
    });
    return out;
  }

  /** Human phrase like "the 言 side is fine, the 寺 part fails stroke 4" (for logs, tests, a tooltip). */
  function describe(d) {
    if (!d) return '';
    return d.summary.filter((s) => s.status !== 'unwritten').map((s) => (s.status === 'ok'
      ? 'the ' + s.g + ' part is fine'
      : 'the ' + s.g + ' part fails stroke ' + s.failedStrokes.join(', '))).join(', ');
  }

  // ---- stored state: {version, comps:{g:{score, at, fails, cleans, strokes:{"kanji:local": count}, lastKanji}}} ----

  function emptyState() { return { version: STATE_VERSION, comps: {} }; }

  function sanitizeState(state) {
    const s = emptyState();
    if (!isObj(state) || !isObj(state.comps)) return s;
    Object.keys(state.comps).forEach((g) => {
      const c = state.comps[g];
      if (!isObj(c)) return;
      const strokes = {};
      if (isObj(c.strokes)) Object.keys(c.strokes).forEach((k) => { const n = num(c.strokes[k], 0); if (n > 0) strokes[k] = n; });
      s.comps[g] = { score: Math.max(0, num(c.score, 0)), at: num(c.at, 0), fails: Math.max(0, num(c.fails, 0)),
        cleans: Math.max(0, num(c.cleans, 0)), strokes, lastKanji: typeof c.lastKanji === 'string' ? c.lastKanji : null };
    });
    return s;
  }

  /** Score decayed to `now` (half-life HALF_LIFE_DAYS). */
  function decayed(c, now) {
    const dt = Math.max(0, (now - c.at) / DAY_MS);
    return c.score * Math.pow(0.5, dt / HALF_LIFE_DAYS);
  }

  /** Apply one diagnosis to the state (returns a new state). Unwritten components are left alone. */
  function record(state, d, now) {
    const s = sanitizeState(state);
    if (!d) return s;
    d.summary.concat(d.nested || []).forEach((x) => {   // R22: nested groups are scored like components
      if (x.status === 'unwritten') return;
      const c = s.comps[x.g] || { score: 0, at: now, fails: 0, cleans: 0, strokes: {}, lastKanji: null };
      const base = decayed(c, now);
      if (x.status === 'fail') {
        c.score = base + FAIL_WEIGHT; c.fails += 1; c.lastKanji = d.kanji;
        x.failedStrokes.forEach((st) => { const k = d.kanji + ':' + st; c.strokes[k] = (c.strokes[k] || 0) + 1; });
      } else {
        c.score = Math.max(0, base - CLEAN_CREDIT); c.cleans += 1;
      }
      c.at = now;
      s.comps[x.g] = c;
    });
    const names = Object.keys(s.comps);
    if (names.length > MAX_TRACKED) {   // drop the least troublesome
      names.sort((a, b) => decayed(s.comps[a], now) - decayed(s.comps[b], now))
        .slice(0, names.length - MAX_TRACKED).forEach((g) => { delete s.comps[g]; });
    }
    return s;
  }

  /** Weak components now: [{g, score, worstStroke:{kanji, stroke, count}, kanji}] highest score first. */
  function weakComponents(state, now, { threshold = WEAK_THRESHOLD, limit = MAX_WEAK } = {}) {
    const s = sanitizeState(state);
    return Object.keys(s.comps).map((g) => {
      const c = s.comps[g];
      let worst = null;
      Object.keys(c.strokes).forEach((k) => {
        const cut = k.lastIndexOf(':');
        const w = { kanji: k.slice(0, cut), stroke: Number(k.slice(cut + 1)), count: c.strokes[k] };
        if (!worst || w.count > worst.count || (w.count === worst.count && w.kanji === c.lastKanji)) worst = w;
      });
      return { g, score: Math.round(decayed(c, now) * 1000) / 1000, worstStroke: worst, kanji: c.lastKanji };
    }).filter((w) => w.score >= threshold)
      .sort((a, b) => b.score - a.score || (a.g < b.g ? -1 : 1))
      .slice(0, limit);
  }

  /** UI text for one weak component: 'Weak spot: 寺, stroke 4'. */
  function message(w) {
    return w ? 'Weak spot: ' + w.g + (w.worstStroke ? ', stroke ' + w.worstStroke.stroke : '') : null;
  }

  /**
   * Extra component practice for the weak components, reusing LeechModel.restudyPlan so a weak component's own
   * parts come first (deepest first). Every step is unscored and tagged reason:'diagnosis'; duplicates dropped.
   * leech = LeechModel (passed in so this file has no load-order dependency).
   */
  function practicePlan(state, now, leech, componentsOf, { isKnown = () => true, threshold, limit } = {}) {
    const steps = []; const seen = new Set();
    weakComponents(state, now, { threshold, limit }).forEach((w) => {
      leech.restudyPlan(w.g, componentsOf, { isKnown }).forEach((st) => {
        if (seen.has(st.kanji)) return;
        seen.add(st.kanji);
        steps.push(Object.assign({}, st, { kind: 'component', scored: false, reason: 'diagnosis', weak: w.g,
          message: st.kanji === w.g ? message(w) : null }));
      });
    });
    return steps;
  }

  /** Mark a component as practised: halves its score (one good practice session should not erase it fully). */
  function notePractised(state, g, now) {
    const s = sanitizeState(state);
    const c = s.comps[g];
    if (c) { c.score = decayed(c, now) / 2; c.at = now; }
    return s;
  }

  return { STATE_VERSION, HALF_LIFE_DAYS, WEAK_THRESHOLD, MAX_WEAK, componentMap, nestedGroups, diagnose, describe, emptyState,
    sanitizeState, decayed, record, weakComponents, message, practicePlan, notePractised };
});
