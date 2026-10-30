/*
 * known-import-model.js — v16 R26 "I already know these" import (Botfive). Exposes window.KnownImport (pure) and
 * window.V16KnownImport (storage wrapper); CommonJS for tests. Design: kanji-team/R26-known-import.md; UI hooks for
 * Botfour: kanji-team/R26-known-import-hooks.md.
 *
 * Why (MARKET_RESEARCH.md §2 pain #2 "control over order and pace", backlog #11 '"already know" import from WaniKani or
 * Anki' — Ringotan's WK sync is praised; V16_PLAN.md §3 #3 fallback "placement-known kanji count as known"): a learner
 * coming from another app pastes the kanji they know (any text: a WaniKani/Anki export, a list, a paragraph). Every
 * kanji in the app's catalog found in it is raised to at least Bronze — exactly what a passed placement question does
 * (PlacementModel.applyResult: never lowers a rank). So component gating and lesson picking treat them as known.
 *
 * Safety: preview before apply; the last import can be undone ('v16:known-import' keeps the previous rank of every
 * kanji it raised). Undo only reverts kanji still at the rank the import gave them (later progress is kept).
 * Grading, scheduling (FSRS cards) and records are not touched.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./rank-model.js') : root.RankModel,
                      isNode ? require('./placement-model.js') : root.PlacementModel);
  if (isNode) module.exports = api;
  else { root.KnownImport = api; root.V16KnownImport = api.bind(root); }
})(typeof self !== 'undefined' ? self : this, function (RM, PM) {
  'use strict';

  const KEY = 'v16:known-import';
  const MAX_INPUT = 200000;   // characters read from a paste/file (a full WK export is ~30 KB)
  const HAN = /\p{Script=Han}/u;

  /**
   * Kanji in text, first-seen order, deduplicated, split into those in the catalog (`isKanji(k)` true) and others.
   * @returns {{kanji: string[], notInApp: string[]}}
   */
  function parse(text, isKanji) {
    const seen = new Set(), kanji = [], notInApp = [];
    for (const ch of String(text || '').slice(0, MAX_INPUT)) {
      if (!HAN.test(ch) || seen.has(ch)) continue;
      seen.add(ch);
      (isKanji(ch) ? kanji : notInApp).push(ch);
    }
    return { kanji, notInApp };
  }

  /** What apply would do: raise = below Bronze now; already = Bronze or higher (left alone). */
  function preview(rankState, kanji) {
    const raise = [], already = [];
    for (const k of kanji) (RM.getKanji(rankState, k).rank < RM.RANK.bronze ? raise : already).push(k);
    return { raise, already };
  }

  /** {state, undo}: the new rank state (via PlacementModel.applyResult) and the undo record for the raised kanji. */
  function apply(rankState, kanji, now = Date.now()) {
    const { raise } = preview(rankState, kanji);
    const prev = {};
    for (const k of raise) prev[k] = RM.getKanji(rankState, k).rank;
    // R26-fix1: remember which kanji had no entry before, so undo can delete them instead of leaving rank-0 defaults.
    const fresh = raise.filter((k) => !Object.prototype.hasOwnProperty.call((rankState && rankState.kanji) || {}, k));
    return { state: PM.applyResult(rankState, { known: raise }), undo: { v: 1, at: now, prev, fresh } };
  }

  /**
   * Revert an undo record: kanji still at Bronze go back to their previous rank; others (since practised) stay.
   * R26-fix1: a reverted kanji listed in undo.fresh (no entry before the import) is deleted, not left at rank 0.
   * Records written before fix1 have no `fresh` and revert as before.
   */
  function revert(rankState, undo) {
    const kanji = Object.assign({}, rankState.kanji);
    const reverted = [], kept = [];
    const fresh = new Set((undo && undo.fresh) || []);
    for (const [k, rank] of Object.entries((undo && undo.prev) || {})) {
      const rec = RM.getKanji(rankState, k);
      if (rec.rank !== RM.RANK.bronze) { kept.push(k); continue; }
      if (fresh.has(k)) delete kanji[k]; else kanji[k] = Object.assign({}, rec, { rank });
      reverted.push(k);
    }
    return { state: { version: RM.STATE_VERSION, kanji }, reverted, kept };
  }

  /** Browser wrapper: reads/writes ranks through window.V15 (loadRanks/saveRanks), catalog from PRACTICE_CATALOG. */
  function bind(win) {
    const store = () => win.localStorage;
    const isKanji = (k) => !!(win.PRACTICE_CATALOG && win.PRACTICE_CATALOG.kanji && win.PRACTICE_CATALOG.kanji[k]);
    const set = (key, v) => (win.DataSafety && win.DataSafety.safeSet ? win.DataSafety.safeSet(store(), key, v) : store().setItem(key, v));
    const fire = (detail) => { try { win.dispatchEvent(new win.CustomEvent('v16:known-import', { detail })); } catch (e) { /* tests */ } };
    function lastUndo() { try { const u = JSON.parse(store().getItem(KEY)); return u && u.prev ? u : null; } catch (e) { return null; } }
    return {
      KEY, MAX_INPUT,
      /** {kanji, notInApp, raise, already} for pasted text; nothing is saved. */
      preview(text) { const p = parse(text, isKanji); return Object.assign(p, preview(win.V15.loadRanks(store()), p.kanji)); },
      /** Apply: raise to Bronze, save ranks + undo record, fire event. Returns {raised: n}. */
      apply(text) {
        const { kanji } = parse(text, isKanji);
        const hadRanks = store().getItem(RM.STORAGE_KEY) !== null;
        const out = apply(win.V15.loadRanks(store()), kanji);
        const raised = Object.keys(out.undo.prev).length;
        // R26-fix2: an import that raises nothing changes no rank, so it saves nothing and keeps the
        // existing undo record (before, a no-op re-import overwrote it and the earlier import became un-undoable).
        if (raised === 0) { fire({ action: 'apply', raised }); return { raised }; }
        win.V15.saveRanks(store(), out.state);
        // R26-fix1: noRanks = the import created the ranks key, so undo may remove it again when it ends up empty.
        if (!hadRanks) out.undo.noRanks = true;
        set(KEY, JSON.stringify(out.undo));
        fire({ action: 'apply', raised });
        return { raised };
      },
      /** The last import, {at, count} or null. */
      last() { const u = lastUndo(); return u ? { at: u.at, count: Object.keys(u.prev).length } : null; },
      /** Undo the last import once. Returns {reverted, kept} counts, or null when there is nothing to undo. */
      undo() {
        const u = lastUndo();
        if (!u) return null;
        const out = revert(win.V15.loadRanks(store()), u);
        // R26-fix1: if the import created the ranks key and nothing is left in it, remove the key instead of saving {}.
        if (u.noRanks && Object.keys(out.state.kanji).length === 0) store().removeItem(RM.STORAGE_KEY);
        else win.V15.saveRanks(store(), out.state);
        store().removeItem(KEY);
        fire({ action: 'undo', reverted: out.reverted.length });
        return { reverted: out.reverted.length, kept: out.kept.length };
      },
    };
  }

  return { KEY, MAX_INPUT, parse, preview, apply, revert, bind };
});
