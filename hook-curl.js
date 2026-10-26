/**
 * HOTFIX-curl: a short pen-lift curl at the end of a stroke must not count as an added hook.
 *
 * Apple Pencil (and fingers) often leave a 2-5 unit curl (of the 109-unit KanjiVG box) as the pen lifts. The old
 * hook rules (kanji-app hook_rules.js, unchanged) measure the tail over as little as 3 units, so on accurate
 * left sweeps (夫 3, 大 2, 天 3, 木 3, 人 1) that curl was rejected as 'hook-added' ("Almost — try that stroke once
 * more").
 *
 * index.html's checkStroke (port/index-patches/HOTFIX-curl-index.patch) calls HookRules.curlGuard when a stroke is
 * rejected: if the ink ends in a curl (see trimCurl) it checks the stroke again without it, and accepts when that
 * passes. This covers every end check (the app's hook angle/flick checks and the hook layer's 'added hook') for
 * every stroke type. Deliberate added hooks are 8+ units, longer than CURL.maxLength, so they still fail.
 * The same applies to a curl where the pen lands (the start of the stroke). Strokes too short for a 5-unit trim
 * (dots, about 7-14 units) only have curls under DOT_CURL.maxLength (about 2 units) ignored.
 * Load it after hook_rules.js (it sets HookRules.curlGuard).
 */
(function (root) {
  'use strict';
  /** maxLength: longest curl ignored, in units (5 plus half a resample step, so a 5-unit curl counts);
   * minTurn: degrees off the stroke's direction that make it a curl;
   * lookback: units before the curl that give the stroke's direction. */
  const CURL = { maxLength: 5.5, minTurn: 27.0, lookback: 3.0 };
  /** The same for short strokes (dots): only a curl under about 2 units is ignored. */
  const DOT_CURL = { maxLength: 2.5, minTurn: 27.0, lookback: 2.0 };
  const STEP = 1.0;

  const asPair = (p) => (Array.isArray(p) ? p : [p.x, p.y]);
  const heading = (a, b) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

  /** Points about STEP units apart along the polyline, and its length. */
  function resample(points) {
    const out = [points[0]];
    let length = 0;
    let carry = 0;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const seg = Math.hypot(bx - ax, by - ay);
      let d = STEP - carry;
      while (d <= seg) {
        out.push([ax + ((bx - ax) * d) / seg, ay + ((by - ay) * d) / seg]);
        d += STEP;
      }
      carry = seg - (d - STEP);
      length += seg;
    }
    const last = points[points.length - 1];
    if (carry > 1e-9) out.push(last);
    return [out, length];
  }

  /**
   * The ink without its pen-lift curl. For each point in the last CURL.maxLength units it measures the turn
   * between the CURL.lookback units before the point and the straight line from the point to the end; when the
   * sharpest turn is at least CURL.minTurn degrees the ink is cut there. Otherwise the ink comes back unchanged.
   * Strokes shorter than 2 * CURL.maxLength + CURL.lookback use DOT_CURL; shorter than that again are left alone.
   * @param {Array} polyline [{x, y}] or [[x, y]], KanjiVG units
   * @returns {{points: number[][], curl: number}} points (as pairs) and the length of the curl removed (0 if none)
   */
  function trimCurl(polyline) {
    const [points, length] = resample(polyline.map(asPair));
    const n = points.length;
    const fits = (limits) => length >= 2 * limits.maxLength + limits.lookback;
    const limits = fits(CURL) ? CURL : DOT_CURL;
    if (!fits(limits)) return { points, curl: 0 };
    const lookback = Math.round(limits.lookback / STEP);
    const end = points[n - 1];
    let cut = -1;
    let sharpest = 0;
    for (let i = n - 2; i >= lookback && (n - 1 - i) * STEP < limits.maxLength; i--) {
      const turn = Math.abs(wrap(heading(points[i], end) - heading(points[i - lookback], points[i])));
      if (turn > sharpest) { sharpest = turn; cut = i; }
    }
    if (sharpest < limits.minTurn) return { points, curl: 0 };
    return { points: points.slice(0, cut + 1), curl: (n - 1 - cut) * STEP };
  }

  /** Number of points at the end of pts (KanjiVG pairs) that make up a curl of the given length. */
  function curlPointCount(scaled, curl) {
    let remaining = curl;   // walk back from the end until the curl's length is used up
    let keep = scaled.length - 1;
    while (keep > 1 && remaining > 0) {
      remaining -= Math.hypot(scaled[keep][0] - scaled[keep - 1][0], scaled[keep][1] - scaled[keep - 1][1]);
      keep--;
    }
    return scaled.length - 1 - keep;
  }

  /**
   * The stroke's points without a pen-lift curl at its end or a pen-down curl at its start, or null when it has
   * neither.
   * @param {Array<{x:number, y:number}>} pts the pad's points, in box units (0..1)
   * @param {number} [units] box size in KanjiVG units (109)
   * @returns {Array|null} a contiguous slice of pts (the same point objects) with the curls cut off
   */
  function withoutCurl(pts, units = 109) {
    if (!pts || pts.length < 3) return null;
    const scaled = pts.map((q) => [q.x * units, q.y * units]);
    const tail = curlPointCount(scaled, trimCurl(scaled).curl);
    const reversed = scaled.slice(0, scaled.length - tail).reverse();
    const head = reversed.length >= 3 ? curlPointCount(reversed, trimCurl(reversed).curl) : 0;
    if (!tail && !head) return null;
    return pts.slice(head, pts.length - tail);
  }

  /** Expose the guard as HookRules.curlGuard (index.html's checkStroke retries a reject without the curl). */
  function install() {
    const hooks = root.HookRules;
    if (!hooks || hooks.curlGuard) return;
    hooks.curlGuard = { CURL, DOT_CURL, trimCurl, withoutCurl };
  }

  install();
  if (typeof module !== 'undefined' && module.exports) module.exports = { CURL, DOT_CURL, trimCurl, withoutCurl, install };
}(typeof self !== 'undefined' ? self : this));
