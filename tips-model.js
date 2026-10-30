/**
 * tips-model.js — v16 R19: which one-time tips the learner has seen (tiny, no DOM).
 * Exposes window.TipsModel; also CommonJS for tests.
 *
 * Storage: ONE key, 'v16:tips' = {"v":1,"shown":{"<tipId>":<ms>}}. The 'v16:' prefix means ExportModel includes it
 * in exports. Writes go through DataSafety.safeSet when loaded (R18 quota queue), else storage.setItem in a try.
 * Only markShown() and reset() write; every other call is read-only.
 *
 * API (all take the Storage first):
 *   isShown(st, id) / has(st, id) → boolean       unknown ids → false
 *   markShown(st, id, now?) → boolean              false (and no write) for unknown ids or already-shown
 *   reset(st)                                      forget all shown tips
 *   nextTip(st, {event, includeUnshipped}) → tip | null   first unshown tip whose `when` has event (any if no event);
 *                                                  shipped:false tips are skipped unless includeUnshipped
 *   whatsNewList({includeUnshipped}) → items       shipped items only by default
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TipsModel = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const KEY = 'v16:tips';
  const data = () => root.TIPS_DATA || (typeof require === 'function' ? require('./tips-data.js') : { TIPS: [], WHATS_NEW: [] });
  // Browser: the R18 global. Node (tests): require it like v15-integration.js does; absent → plain setItem.
  let nodeSafety;
  const safety = () => {
    if (root && root.DataSafety) return root.DataSafety;
    if (nodeSafety === undefined) { try { nodeSafety = require('./data-safety.js'); } catch (_) { nodeSafety = null; } }
    return nodeSafety;
  };
  const tipById = (id) => data().TIPS.find((t) => t.id === id) || null;

  /** Parsed state; anything malformed reads as empty. Read-only. */
  function read(st) {
    let raw = null;
    try { raw = safety() ? safety().safeGet(st, KEY) : st.getItem(KEY); } catch (_) { return { v: 1, shown: {} }; }
    try {
      const s = JSON.parse(raw);
      return s && typeof s.shown === 'object' && s.shown ? { v: 1, shown: s.shown } : { v: 1, shown: {} };
    } catch (_) { return { v: 1, shown: {} }; }
  }
  function write(st, s) {
    const text = JSON.stringify(s);
    if (safety()) return safety().safeSet(st, KEY, text);
    try { st.setItem(KEY, text); return true; } catch (_) { return false; }
  }

  function isShown(st, id) { return Object.prototype.hasOwnProperty.call(read(st).shown, id); }
  function markShown(st, id, now = Date.now()) {
    if (!tipById(id)) return false;
    const s = read(st);
    if (s.shown[id]) return false;
    s.shown[id] = now;
    write(st, s);
    return true;
  }
  function reset(st) { write(st, { v: 1, shown: {} }); }
  function nextTip(st, ctx = {}) {
    const shown = read(st).shown;
    return data().TIPS.find((t) => (t.shipped || ctx.includeUnshipped) && !shown[t.id] &&
      (!ctx.event || t.when.includes(ctx.event))) || null;
  }
  function whatsNewList(opts = {}) { return data().WHATS_NEW.filter((w) => w.shipped || opts.includeUnshipped); }

  /**
   * R23 follow-up (rc6): show tips for UI moments that fire no event of their own, without touching Botfour's files.
   * Browser only. Botfour's v15-ui.js renders these, so we watch the DOM for them:
   *   'retry'           — the #9 retry banner  <p class="v15-banner">Again: X · practice, not scored</p>
   *   'component-write' — the #8 part-writing overlay  <div class="v16-cw">
   *   'diagnosis'       — the event 'v16:diagnosis' (R24 v16-weakspot.js; R10's V15.diagnoseWriting was removed in R29-cleanup). In rc6 the
   *                       weak-spot tip stays shipped:false and this listener is only future-proofing.
   * V16Views.showTip(event) does the once-only bookkeeping; `fired` just stops repeat lookups on every re-render.
   */
  const WATCH = [
    { event: 'component-write', match: (el) => el.classList.contains('v16-cw') },
    { event: 'retry', match: (el) => el.classList.contains('v15-banner') && /^Again:/.test(el.textContent.trim()) },
  ];
  function wireTipMoments(win) {
    const doc = win.document, fired = new Set();
    const show = (event) => {
      if (fired.has(event) || !win.V16Views || typeof win.V16Views.showTip !== 'function') return;
      fired.add(event);
      // after the current render, so the toast lands on the finished screen
      win.setTimeout(() => win.V16Views.showTip(event), 0);
    };
    const scan = (node) => {
      if (node.nodeType !== 1) return;
      for (const w of WATCH) {
        if (fired.has(w.event)) continue;
        if (w.match(node) || [...node.querySelectorAll('.v16-cw, .v15-banner')].some(w.match)) show(w.event);
      }
    };
    new win.MutationObserver((records) => {
      if (fired.size >= WATCH.length) return;
      for (const r of records) r.addedNodes.forEach(scan);
    }).observe(doc.body, { childList: true, subtree: true });
    win.addEventListener('v16:diagnosis', () => show('diagnosis'));
  }
  if (typeof window !== 'undefined' && window.document && typeof window.MutationObserver === 'function') {
    if (window.document.body) wireTipMoments(window);
    else window.document.addEventListener('DOMContentLoaded', () => wireTipMoments(window));
  }

  return { KEY, isShown, has: isShown, markShown, reset, nextTip, whatsNewList };
});
