/*
 * v16-weakspot.js — v16 R24 weak-spot glue (Botfive). Browser only; the logic is in weakspot-model.js.
 * Loaded by v16-loader.js (group 'weakspot', first in DEFERRED, after the first paint). Design: kanji-team/R24-weakspot.md;
 * UI hook spec for Botfour: kanji-team/R24-weakspot-hooks.md.
 *
 * GRADING IS NOT CHANGED. We wrap the page's global checkStroke (index.html) with an observer that calls the original
 * with the same arguments, returns its verdict object untouched (same reference), and only then records the stroke.
 * A recording error is caught and logged, never thrown into grading. Calls made inside the batch checkStrokes()
 * (used by re-checks / tools, not by a learner's pen) are not recorded.
 *
 * Per stroke we record: kanji, stroke index in that kanji, its component (top-level part + B3's nested group when
 * nested-groups.js is loaded; read-only), stroke type (HOOK_CATEGORIES, KanjiVG-derived) and, for a miss, the reason.
 * box.k forms handled (index.html partObj / wordObj):
 *   plain kanji entry   k.k = char, stroke i
 *   part-alone box      k.isPart, k.src = kanji entry, k.pi → kanji stroke = src.parts[pi].from + i
 *   word box            k.isWord, k.parts[{g: char, from, to}] → char = the part holding i, stroke = i − from
 *
 * Storage: 'v16:weakspot' (JSON, capped by the model; exported by export-model.js like every v16: key), written at most
 * every SAVE_MS and on pagehide. Event: 'v16:diagnosis' on window when a NEW weak spot appears, detail =
 *   {source:'weakspot', kanji, stroke, weak:[id…], message, spots:[WeakSpot…]}   (kanji/stroke: the miss that tipped it)
 * tips-model.js already listens for it and shows the 'weak-spot' tip once.
 * API: window.V16WeakSpot = {spots(), practiceSet(opts), history(n), state(), reset(), KEY}.
 */
(function (root) {
  'use strict';
  const KEY = 'v16:weakspot';
  const SAVE_MS = 2000;
  const M = root.WeakSpotModel;
  if (!M || typeof root.checkStroke !== 'function' || root.checkStroke.__weakspot) return;

  const store = root.localStorage;
  const read = () => { try { return M.sanitize(store.getItem(KEY)); } catch (_) { return M.empty(); } };
  let state = read();
  let lastRaw = rawNow();   // what we last read/wrote: if the stored value changes under us (import, reset), reload it
  let timer = null;
  function rawNow() { try { return store.getItem(KEY); } catch (_) { return null; } }
  function save() {
    timer = null;
    const copy = Object.assign({}, state); delete copy.lastMiss;
    const raw = JSON.stringify(copy);
    lastRaw = raw;
    try { if (root.DataSafety) root.DataSafety.safeSet(store, KEY, raw); else store.setItem(KEY, raw); } catch (e) { console.warn('weakspot save', e); }
  }
  const saveSoon = () => { if (!timer) timer = root.setTimeout(save, SAVE_MS); };
  root.addEventListener('pagehide', () => { if (timer) { root.clearTimeout(timer); save(); } });

  const kanjiMap = () => (root.KANJI_DATA && root.KANJI_DATA.kanji) || {};

  /** box.k + stroke index → {kanji, stroke, entry} in kanji terms, or null if it cannot be mapped. */
  function locate(k, i) {
    if (!k || !Number.isInteger(i)) return null;
    if (k.isPart && k.src && k.src.parts && k.src.parts[k.pi]) {
      return { kanji: k.src.k, stroke: k.src.parts[k.pi].from + i, entry: k.src };
    }
    if (k.isWord && Array.isArray(k.parts)) {
      const p = k.parts.find((x) => i >= x.from && i <= x.to);
      return p ? { kanji: p.g, stroke: i - p.from, entry: kanjiMap()[p.g] || null } : null;
    }
    return typeof k.k === 'string' ? { kanji: k.k, stroke: i, entry: k } : null;
  }

  function observe(k, i, verdict) {
    const at = locate(k, i);
    if (!at || !verdict || typeof verdict !== 'object') return;
    if (!timer && rawNow() !== lastRaw) { state = read(); lastRaw = rawNow(); }   // e.g. a backup was imported
    const groups = root.KANJI_GROUPS ? root.KANJI_GROUPS[at.kanji] : null;
    M.record(state, Object.assign({}, at, { groups, types: root.HOOK_CATEGORIES || null, verdict, now: Date.now() }));
    const miss = state.lastMiss;
    if (miss) {
      const fresh = M.newlyWeak(state);
      if (fresh.length && typeof CustomEvent === 'function') {
        const spots = M.weakSpots(state);
        root.dispatchEvent(new CustomEvent('v16:diagnosis', { detail: {
          source: 'weakspot', kanji: at.kanji, stroke: at.stroke, weak: spots.map(M.spotId), message: M.message(fresh[0]), spots } }));
      }
    }
    saveSoon();
  }

  // ---- the observer wrappers (same arguments in, same verdict out) ----
  let batch = 0;   // > 0 while the batch checkStrokes runs
  const original = root.checkStroke;
  function checkStrokeObserved(k, i, stroke, level, prev) {
    const verdict = original.apply(this, arguments);
    if (!batch) { try { observe(k, i, verdict); } catch (e) { console.warn('weakspot observe', e); } }
    return verdict;
  }
  checkStrokeObserved.__weakspot = true;
  root.checkStroke = checkStrokeObserved;
  if (typeof root.checkStrokes === 'function') {
    const originalBatch = root.checkStrokes;
    root.checkStrokes = function checkStrokesUnobserved() {
      batch += 1;
      try { return originalBatch.apply(this, arguments); } finally { batch -= 1; }
    };
  }

  // ---- read API for Botfour's UI (R24-weakspot-hooks.md) ----
  /** Practice-set data: families from ComponentModel when the 'components' group is loaded, else none. */
  function practiceData() {
    const V = root.V15, store2 = store;
    const family = (g) => { try { return V && V.componentFamily ? V.componentFamily(store2, g).kanji : []; } catch (_) { return []; } };
    const known = isStudied;
    const practisable = (kanji, g) => { const e = kanjiMap()[kanji]; return !!(e && Array.isArray(e.parts) && e.parts.some((p) => p.g === g)); };
    return { family, known, practisable };
  }
  /** A kanji the learner studies already: it has a rec: record (never study unseen kanji in a review set). */
  function isStudied(k) { try { return store.getItem('rec:' + k) !== null; } catch (_) { return false; } }

  root.V16WeakSpot = {
    KEY,
    spots: (opts) => M.weakSpots(state, Date.now(), opts),
    practiceSet: (opts) => M.practiceSet(state, practiceData(), opts),
    history: (n = 20) => state.hist.slice(-n).reverse(),
    state: () => M.sanitize(JSON.parse(JSON.stringify(state))),
    reset: () => { state = M.empty(); save(); },
  };
})(typeof self !== 'undefined' ? self : this);
