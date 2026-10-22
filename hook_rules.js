/* Hook rules layered on top of the app's checkStroke verdict — JS twin of hook_features.py + hook_rules.py.
 * UMD: window.HookRules in the browser, module.exports in Node. Rules data: hook_rules.json (HOOK_RULES.md).
 *
 *   const verdict = HookRules.checkAfterApp(appResult, inkPoints, refPoints, category, rules);
 *
 * inkPoints / refPoints: [{x, y}] or [[x, y]] in KanjiVG units (109 box); multiply the app's box units by 109.
 * category: from HOOK_CATEGORIES (hook-categories.js) — HookRules.categoryOf(char, strokeIndex).
 * An accepted stroke can still fail its tail: {...appResult, ok:false, msg:'Shape', shape:'hook-added'|'hook-dropped'|'hook-partial'}.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HookRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const STEP = 1.0;
  const SMOOTH_RADIUS = 2;
  const TIP_SHARES = [0.06, 0.1, 0.15];
  const TIP_MIN = 3.0;
  const FINAL_SHARE = 0.15;
  const HALF_EPS = 1e-9;
  const TIE_EPS = 1e-9;
  const FLICK_SPREAD = 25.0;
  const FLICK_LOOKBACK = 3;
  const CODE_CATEGORY = { h: 'horizontal', v: 'vertical', d: 'dot', r: 'rise', l: 'leftSweep', s: 'rightSweep',
    b: 'bend', V: 'hookVertical', C: 'hookCorner', H: 'hookHorizontal', U: 'hookCurve', F: 'hookFaint',
    k: 'kana', K: 'kanaHook' };

  const asPair = (p) => (Array.isArray(p) ? p : [p.x, p.y]);
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
  const heading = (a, b) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  // Python round() is banker's rounding on exact halves; measures are compared after rounding the same way
  const round = (v, digits) => {
    const f = 10 ** digits;
    const x = v * f;
    const r = Math.round(x);
    return (Math.abs(x % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r) / f;
  };

  /** Evenly spaced points about STEP apart along the polyline, and the total length. */
  function resample(points) {
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + dist(points[i - 1], points[i]));
    const total = cumulative[cumulative.length - 1];
    const count = Math.max(2, Math.floor(total / STEP));
    const out = [];
    let j = 0;
    for (let k = 0; k <= count; k++) {
      const target = (total * k) / count;
      while (j < points.length - 2 && cumulative[j + 1] < target) j++;
      const span = points.length > 1 ? cumulative[j + 1] - cumulative[j] : 0;
      const t = span > 0 ? (target - cumulative[j]) / span : 0;
      const a = points[j];
      const b = points[Math.min(j + 1, points.length - 1)];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return [out, total];
  }

  /** Moving average; the first and last point stay put. */
  function smooth(points) {
    const n = points.length;
    if (n < 3) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < n - 1; i++) {
      const lo = Math.max(0, i - SMOOTH_RADIUS);
      const hi = Math.min(n - 1, i + SMOOTH_RADIUS);
      let sx = 0;
      let sy = 0;
      for (let q = lo; q <= hi; q++) { sx += points[q][0]; sy += points[q][1]; }
      out.push([sx / (hi - lo + 1), sy / (hi - lo + 1)]);
    }
    out.push(points[n - 1]);
    return out;
  }

  /** Point at arc distance d; halves round up with HALF_EPS slack (as hook_features._at). */
  function at(points, length, d) {
    if (length <= 0) return points[0];
    const index = Math.floor((d / length) * (points.length - 1) + 0.5 + HALF_EPS);
    return points[Math.max(0, Math.min(points.length - 1, index))];
  }

  /** Tail measures (see hook_features.py): length, tipTurn, lateral, tipShare, turn15, lateral15. */
  function tailMeasures(polyline, smoothed = true) {
    let [points, length] = resample(polyline.map(asPair));
    if (smoothed) points = smooth(points);
    const end = points[points.length - 1];
    let best = null;
    for (const share of TIP_SHARES) {
      const tip = Math.max(TIP_MIN, share * length);
      let shaftStart;
      let tipStart;
      if (length >= 2 * tip) {
        shaftStart = at(points, length, length - 2 * tip);
        tipStart = at(points, length, length - tip);
      } else {
        shaftStart = points[0];
        tipStart = at(points, length, length / 2);
      }
      const turn = wrap(heading(tipStart, end) - heading(shaftStart, tipStart));
      if (best === null || Math.abs(turn) > Math.abs(best[0]) + TIE_EPS) {   // near-ties keep the shorter tail
        const mx = tipStart[0] - shaftStart[0];
        const my = tipStart[1] - shaftStart[1];
        const norm = Math.hypot(mx, my) || 1;
        const lateral = (mx * (end[1] - tipStart[1]) - my * (end[0] - tipStart[0])) / norm / (length || 1);
        best = [turn, lateral, tip / (length || 1)];
      }
    }
    const final = FINAL_SHARE * length;
    const a = at(points, length, length - 2 * final);
    const b = at(points, length, length - final);
    const turn15 = length > 0 ? wrap(heading(b, end) - heading(a, b)) : 0;
    const mx = b[0] - a[0];
    const my = b[1] - a[1];
    const norm = Math.hypot(mx, my) || 1;
    const lateral15 = (mx * (end[1] - b[1]) - my * (end[0] - b[0])) / norm / (length || 1);
    return { length: round(length, 3), tipTurn: round(best[0], 2), lateral: round(best[1], 4),
      tipShare: round(best[2], 4), turn15: round(turn15, 2), lateral15: round(lateral15, 4),
      hookShare: round(flickLength(points) / (length || 1), 4), flickTurn: round(flickTurn(points), 2) };
  }

  /** Index where the final straight flick begins (hook_features._flick_start). */
  function flickStart(points) {
    const n = points.length;
    if (n < FLICK_LOOKBACK + 2) return n - 1;
    const end = points[n - 1];
    const endHeading = heading(points[n - 1 - FLICK_LOOKBACK], end);
    let k = n - 1 - FLICK_LOOKBACK;
    while (k > 0 && Math.abs(wrap(heading(points[k - 1], end) - endHeading)) <= FLICK_SPREAD) k--;
    return k;
  }

  function flickLength(points) {
    let total = 0;
    for (let j = flickStart(points); j < points.length - 1; j++) total += dist(points[j], points[j + 1]);
    return total;
  }

  function flickTurn(points) {
    const k = flickStart(points);
    const span = Math.max(Math.floor(TIP_MIN / STEP), points.length - 1 - k);
    const j = Math.max(0, k - span);
    if (k === points.length - 1 || j === k) return 0;
    return wrap(heading(points[k], points[points.length - 1]) - heading(points[j], points[k]));
  }

  /** '' (keep the app's verdict) or 'hook-added' / 'hook-dropped'. ink, ref: tailMeasures results. */
  function hookVerdict(ink, ref, category, rules) {
    if (Math.min(ink.length, ref.length) < rules.minLength) return '';
    const rule = rules.categories[category] || {};
    const added = rule.added;
    const dropped = rule.dropped;
    if (added) {
      const [turnKey, lateralKey] = added.measure === 'final15' ? ['turn15', 'lateral15'] : ['tipTurn', 'lateral'];
      let turnGap = ink[turnKey] - ref[turnKey];
      let lateralGap = ink[lateralKey] - ref[lateralKey];
      const sign = added.sign || 0;   // +1 / -1: only tails turning that way (+ = clockwise); 0: either way
      if (sign) { turnGap *= sign; lateralGap *= sign; } else { turnGap = Math.abs(turnGap); lateralGap = Math.abs(lateralGap); }
      if (turnGap >= added.minTurnGap && lateralGap >= added.minLateralGap) return 'hook-added';
    }
    if (dropped) {
      const side = ref.turn15 >= 0 ? 1 : -1;
      if (side * ink.turn15 < dropped.maxTurnShare * Math.abs(ref.turn15)
          && side * ink.lateral15 < dropped.maxLateralShare * Math.abs(ref.lateral15)) return 'hook-dropped';
    }
    if (rule.partial && isPartial(ink, ref, rule.partial)) return 'hook-partial';
    return '';
  }

  const PARTIAL_MIN_TURN = 0.05;

  /** Ink vs reference hook as ratios toward the reference's hook side (hook_rules.partial_ratios). */
  function partialRatios(ink, ref) {
    const side15 = ref.turn15 >= 0 ? 1 : -1;
    const sideFlick = ref.flickTurn >= 0 ? 1 : -1;
    const turn = (side15 * ink.turn15) / Math.max(Math.abs(ref.turn15), 1e-6);
    const reach = (side15 * ink.lateral15) / Math.max(Math.abs(ref.lateral15), 1e-6);
    return { hookShare: ink.hookShare / Math.max(ref.hookShare, 1e-6), turn15: turn, lateral15: reach,
      flickTurn: (sideFlick * ink.flickTurn) / Math.max(Math.abs(ref.flickTurn), 1e-6),
      reachPerTurn: reach / Math.max(turn, PARTIAL_MIN_TURN) };
  }

  /** True when every {feature, op, value} condition holds (hook_rules.is_partial). */
  function isPartial(ink, ref, conditions) {
    const r = partialRatios(ink, ref);
    return conditions.every((c) => (c.op === '<' ? r[c.feature] < c.value : r[c.feature] >= c.value));
  }

  /** Category of stroke i of char from window.HOOK_CATEGORIES (hook-categories.js), or '' if unknown. */
  function categoryOf(char, i, table) {
    const codes = (table || (typeof window !== 'undefined' && window.HOOK_CATEGORIES) || {})[char];
    return codes && codes[i] ? CODE_CATEGORY[codes[i]] : '';
  }

  /** Layer on a checkStroke result: an accepted stroke can still fail its tail. */
  function checkAfterApp(appResult, inkPoints, refPoints, category, rules) {
    if (!appResult.ok || !category) return appResult;
    const why = hookVerdict(tailMeasures(inkPoints), tailMeasures(refPoints, false), category, rules);
    return why ? { ...appResult, ok: false, msg: 'Shape', shape: why } : appResult;
  }

  return { tailMeasures, hookVerdict, partialRatios, isPartial, categoryOf, checkAfterApp, CODE_CATEGORY };
}));
