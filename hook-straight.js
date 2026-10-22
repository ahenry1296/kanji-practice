/**
 * B2: a hook stroke drawn fully straight (full length, no flick) must be rejected.
 *
 * With the old hook rules (kanji-app hook_rules.js, unchanged) a straight continuation past the turn was accepted
 * on about a third of the real-hook strokes (V/C/H/U categories). This layer wraps HookRules.checkAfterApp and,
 * only after the old rules accept, rejects as 'hook-dropped' when all of these hold (ratios from
 * HookRules.partialRatios, ink vs reference):
 *   - full length:  ink length >= STRAIGHT.minLength of the reference;
 *   - no flick:     the final straight run is >= STRAIGHT.minHookShare times the reference hook (the whole tail is
 *                   one straight line), and the flick turn is < STRAIGHT.maxFlickTurn of the reference;
 *   - no turn:      the turn over the final 15 % is < STRAIGHT.maxTurn15 of the reference.
 * Half-drawn and flattened hooks have a hookShare of at most about 1.4, so they are never caught (they stay allowed).
 * Strokes without a hook category (plain corners included) are not touched.
 */
(function (root) {
  'use strict';
  const HOOK_CATEGORIES = ['hookVertical', 'hookCorner', 'hookHorizontal', 'hookCurve'];
  const STRAIGHT = { minLength: 0.9, minHookShare: 3.0, maxFlickTurn: 0.5, maxTurn15: 0.35 };

  /** True when ink is a full-length stroke with a straight tail where ref has a hook. */
  function isStraightThrough(ink, ref) {
    const hooks = root.HookRules;
    if (!ref.length || ink.length < STRAIGHT.minLength * ref.length) return false;
    const r = hooks.partialRatios(ink, ref);
    return r.hookShare >= STRAIGHT.minHookShare && r.flickTurn < STRAIGHT.maxFlickTurn && r.turn15 < STRAIGHT.maxTurn15;
  }

  /** Wrap HookRules.checkAfterApp once; the old verdict always runs first and its rejects are kept as they are. */
  function install() {
    const hooks = root.HookRules;
    if (!hooks || hooks.straightGuard) return;
    const checkAfterApp = hooks.checkAfterApp;
    hooks.checkAfterApp = function (appResult, inkPoints, refPoints, category, rules) {
      const result = checkAfterApp(appResult, inkPoints, refPoints, category, rules);
      if (!result.ok || !HOOK_CATEGORIES.includes(category)) return result;
      const ink = hooks.tailMeasures(inkPoints);
      const ref = hooks.tailMeasures(refPoints, false);
      if (Math.min(ink.length, ref.length) < rules.minLength) return result;
      return isStraightThrough(ink, ref) ? { ...result, ok: false, msg: 'Shape', shape: 'hook-dropped' } : result;
    };
    hooks.straightGuard = { STRAIGHT, isStraightThrough };
  }

  install();
  if (typeof module !== 'undefined' && module.exports) module.exports = { STRAIGHT, isStraightThrough, install };
}(typeof self !== 'undefined' ? self : this));
