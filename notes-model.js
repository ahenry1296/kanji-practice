/*
 * notes-model.js — v16 R25 personal component stories (Botfive). Exposes window.NotesModel (pure logic) and
 * window.V16Notes (thin storage wrapper); CommonJS for tests. Design: kanji-team/R25-notes.md; UI hooks for
 * Botfour: kanji-team/R25-notes-hooks.md.
 *
 * Why (V16_PLAN.md §3 #16 "optional component story field", F10; MARKET_RESEARCH.md §2 pain #8 "mnemonics that
 * feel rigid … users want to write their own", backlog #12, §4 gap #1 "writing-first + mnemonics + components"):
 * the learner can keep ONE short line per kanji, e.g. "寸 measure + 日 sun → time (時)". The app suggests a draft
 * built from the kanji's components and their meanings (component-model.js, read-only); the learner edits it.
 * The note is an aid shown next to the kanji — it never affects grading, ranks or scheduling.
 *
 * Storage: one key 'v16:notes' = { v: 1, n: { kanji: { t: text, at: ms } } }, exported by export-model.js with the
 * other v16: keys. Capped: MAX_LEN characters per note, MAX_NOTES notes (oldest edits dropped first).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.NotesModel = api; root.V16Notes = api.bind(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const KEY = 'v16:notes';
  const MAX_LEN = 200;      // one line, like a card back; long stories belong elsewhere
  const MAX_NOTES = 3000;   // > all N5–N1 kanji (~2,200), so the cap only bites on garbage input

  function empty() { return { v: VERSION, n: {} }; }

  /** True for a single kanji / kana character (one code point), the only keys a note can have. */
  function isChar(k) { return typeof k === 'string' && [...k].length === 1 && /\S/.test(k); }

  /**
   * Clean user text: NFC, control characters → space, runs of whitespace → one space, trimmed, cut to MAX_LEN
   * code points (never splitting a surrogate pair). Returns '' for nothing left.
   */
  function clean(text) {
    if (typeof text !== 'string') return '';
    const s = text.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
    return [...s].slice(0, MAX_LEN).join('');
  }

  /** Parse a stored value. Anything malformed becomes an empty state (bad entries are dropped, not thrown). */
  function parse(raw) {
    let o;
    try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return empty(); }
    const out = empty();
    if (!o || typeof o !== 'object' || !o.n || typeof o.n !== 'object') return out;
    for (const [k, e] of Object.entries(o.n)) {
      const t = e && clean(e.t);
      if (isChar(k) && t) out.n[k] = { t, at: Number.isFinite(e.at) ? e.at : 0 };
    }
    return cap(out);
  }

  /** Keep the MAX_NOTES most recently edited notes. */
  function cap(state) {
    const keys = Object.keys(state.n);
    if (keys.length <= MAX_NOTES) return state;
    keys.sort((a, b) => state.n[b].at - state.n[a].at);
    const n = {};
    for (const k of keys.slice(0, MAX_NOTES)) n[k] = state.n[k];
    return { v: VERSION, n };
  }

  /** The note text for kanji k, or null. */
  function get(state, k) { const e = state && state.n && state.n[k]; return e ? e.t : null; }

  /** New state with k's note set to text (cleaned). Empty text deletes the note. Throws on a bad kanji key. */
  function set(state, k, text, now = Date.now()) {
    if (!isChar(k)) throw new TypeError('NotesModel.set: kanji must be one character');
    const n = Object.assign({}, (state && state.n) || {});
    const t = clean(text);
    if (t) n[k] = { t, at: now }; else delete n[k];
    return cap({ v: VERSION, n });
  }

  /**
   * Suggested draft for k: "寸 measure + 日 sun → 時". components = [{component, meaning}] (ComponentModel.family
   * entries, in the kanji's part order). Components without a meaning are shown bare; with no components → ''.
   * The arrow target is the kanji itself (its keyword is shown next to the note by the UI, so it is not repeated).
   */
  function draft(k, components) {
    const parts = (components || []).filter((c) => c && c.component && c.component !== k)
      .map((c) => (c.meaning ? `${c.component} ${String(c.meaning).split(/[;,]/)[0].trim()}` : c.component));
    return parts.length ? clean(`${parts.join(' + ')} → ${k}`) : '';
  }

  /** Browser wrapper bound to a window: load/save under KEY (via DataSafety.safeSet when present) + draftFor. */
  function bind(win) {
    const store = () => win.localStorage;
    function load() { try { return parse(store().getItem(KEY)); } catch (e) { return empty(); } }
    function save(state) {
      const raw = JSON.stringify(state);
      if (win.DataSafety && typeof win.DataSafety.safeSet === 'function') win.DataSafety.safeSet(store(), KEY, raw);
      else store().setItem(KEY, raw);
    }
    return {
      KEY, MAX_LEN,
      get: (k) => get(load(), k),
      /** Save (or with '' delete) k's note; fires 'v16:note' {kanji, text|null}. Returns the stored text or null. */
      set(k, text) {
        const next = set(load(), k, text);
        save(next);
        const t = get(next, k);
        try { win.dispatchEvent(new win.CustomEvent('v16:note', { detail: { kanji: k, text: t } })); } catch (e) { /* no DOM events (tests) */ }
        return t;
      },
      count: () => Object.keys(load().n).length,
      /** Draft from ComponentModel when loaded (group 'components'); '' otherwise. */
      draftFor(k) {
        const CM = win.ComponentModel;
        if (!CM || typeof CM.componentsOf !== 'function') return '';
        // Only the catalog (components + meanings) is needed; no progress data is read.
        const data = { catalog: win.PRACTICE_CATALOG || null, kanjiMap: (win.KANJI_DATA && win.KANJI_DATA.kanji) || null };
        try { return draft(k, CM.componentsOf(k, data).map((g) => CM.family(g, data))); } catch (e) { return ''; }
      },
    };
  }

  return { VERSION, KEY, MAX_LEN, MAX_NOTES, empty, isChar, clean, parse, cap, get, set, draft, bind };
});
