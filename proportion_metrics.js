/**
 * Proportion metrics and rule evaluation, a JS port of svg_path.py, gen_stroke_features.py
 * (stroke_features) and proportion_metrics.py. No dependencies; works in browsers
 * (window.ProportionMetrics) and node (module.exports).
 *
 * Input strokes are SVG path `d` strings or polylines ([[x, y], ...]) in the 109-unit KanjiVG box,
 * in stroke order. Parity with the Python code is checked by test_proportion_metrics_parity.py.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ProportionMetrics = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CANVAS = 109;
  const SAMPLES_PER_SEGMENT = 24;
  const TOUCH_TOLERANCE = 5.0;
  const HOOK_TAIL_DEGREES = 40;
  const HOOK_MIN_LENGTH = 25;
  const CURVE_BEND_DEGREES = 30;
  const TURN_THRESHOLD = 8;
  const HORIZONTAL_DEGREES = 20;
  const FIELDS = ["dir", "cls", "bend", "turn", "len", "sx", "sy", "ex", "ey", "cx", "cy", "touches", "crosses"];
  const COLUMN = Object.fromEntries(FIELDS.map((name, i) => [name, i]));
  const POSITION_FIELDS = ["sx", "sy", "ex", "ey", "cx", "cy"];
  const TOKEN_PATTERN = /[MmCcSsLlZzHhVv]|-?\d*\.?\d+(?:e-?\d+)?/g;

  /**
   * Python-compatible round(): nearest to the exact binary value, half-to-even on exact ties.
   * @param {number} value
   * @param {number} [digits=0]
   * @returns {number}
   */
  function pyRound(value, digits = 0) {
    // toFixed rounds the exact binary value to nearest (like Python) but breaks exact ties upward;
    // Python breaks them to even, so detect exact ties from the full decimal expansion.
    const expansion = Math.abs(value).toFixed(100);
    const fraction = expansion.slice(expansion.indexOf(".") + 1);
    const isTie = fraction[digits] === "5" && /^0*$/.test(fraction.slice(digits + 1));
    if (!isTie) return Number(value.toFixed(digits));
    const factor = 10 ** digits;
    const lower = Math.floor(Math.abs(value) * factor);
    return (Math.sign(value) * (lower % 2 === 0 ? lower : lower + 1)) / factor;
  }

  /** Exact product a * b as [rounded, error] (Dekker / Veltkamp splitting). */
  function twoProduct(a, b) {
    const split = (x) => {
      const scaled = 134217729 * x; // 2^27 + 1
      const high = scaled - (scaled - x);
      return [high, x - high];
    };
    const product = a * b;
    const [ah, al] = split(a);
    const [bh, bl] = split(b);
    return [product, ((ah * bh - product) + ah * bl + al * bh) + al * bl];
  }

  /**
   * Distance between two points, matching Python math.dist (correctly rounded) bit for bit in
   * practice; Math.hypot and a plain sqrt differ in the last bit too often.
   */
  function dist(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const [xx, xxError] = twoProduct(dx, dx);
    const [yy, yyError] = twoProduct(dy, dy);
    const sum = xx + yy;
    const virtual = sum - xx;
    const sumError = (xx - (sum - virtual)) + (yy - virtual) + xxError + yyError;
    if (sum === 0) return 0;
    const root = Math.sqrt(sum);
    const [square, squareError] = twoProduct(root, root);
    return root + ((sum - square) - squareError + sumError) / (2 * root);
  }

  /** x cubed, close to the correctly rounded value of Python's x ** 3. */
  function cube(x) {
    const [square, squareError] = twoProduct(x, x);
    const [high, highError] = twoProduct(square, x);
    return high + (highError + squareError * x);
  }

  /**
   * Cubic segments of SVG path data (M L H V C S Z, absolute and relative).
   * @param {string} pathData
   * @returns {number[][][]} segments as [p0, p1, p2, p3]
   */
  function pathSegments(pathData) {
    const tokens = pathData.match(TOKEN_PATTERN) || [];
    let index = 0;
    let current = [0, 0];
    let start = current;
    let lastControl = null;
    let command = "";
    const segments = [];
    const number = () => parseFloat(tokens[index++]);
    while (index < tokens.length) {
      if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
      const relative = command === command.toLowerCase();
      const kind = command.toUpperCase();
      const [ox, oy] = relative ? current : [0, 0];
      if (kind === "M") {
        current = [ox + number(), oy + number()];
        start = current;
        lastControl = null;
        command = relative ? "l" : "L";
      } else if (kind === "L") {
        const point = [ox + number(), oy + number()];
        segments.push([current, current, point, point]);
        current = point;
        lastControl = null;
      } else if (kind === "H") {
        const point = [(relative ? ox : 0) + number(), current[1]];
        segments.push([current, current, point, point]);
        current = point;
      } else if (kind === "V") {
        const point = [current[0], (relative ? oy : 0) + number()];
        segments.push([current, current, point, point]);
        current = point;
      } else if (kind === "C" || kind === "S") {
        const control1 = kind === "C" ? [ox + number(), oy + number()]
          : lastControl ? [2 * current[0] - lastControl[0], 2 * current[1] - lastControl[1]] : current;
        const control2 = [ox + number(), oy + number()];
        const point = [ox + number(), oy + number()];
        segments.push([current, control1, control2, point]);
        lastControl = control2;
        current = point;
      } else if (kind === "Z") {
        segments.push([current, current, start, start]);
        current = start;
      } else {
        index++; // unknown token: skip
      }
    }
    return segments;
  }

  /** Point on a cubic Bezier at parameter t. */
  function cubicPoint([p0, p1, p2, p3], t) {
    const s = 1 - t;
    return [0, 1].map((k) => cube(s) * p0[k] + 3 * s * s * t * p1[k] + 3 * s * t * t * p2[k] + cube(t) * p3[k]);
  }

  /** Polyline of SVG path data, SAMPLES_PER_SEGMENT points per segment. */
  function samplePath(pathData) {
    const points = [];
    for (const segment of pathSegments(pathData)) {
      for (let k = points.length ? 1 : 0; k <= SAMPLES_PER_SEGMENT; k++) {
        points.push(cubicPoint(segment, k / SAMPLES_PER_SEGMENT));
      }
    }
    return points;
  }

  /**
   * Polyline sampled exactly as Python samples the equivalent "M p0 L p1 L p2 …" path, so array
   * input gives the same features as path strings.
   * @param {number[][]} polyline
   * @returns {number[][]}
   */
  function samplePolyline(polyline) {
    const points = [];
    for (let i = 1; i < polyline.length; i++) {
      const [a, b] = [polyline[i - 1], polyline[i]];
      for (let k = points.length ? 1 : 0; k <= SAMPLES_PER_SEGMENT; k++) {
        points.push(cubicPoint([a, a, b, b], k / SAMPLES_PER_SEGMENT));
      }
    }
    return points.length ? points : polyline.slice();
  }

  /**
   * Evenly spaced points about `step` apart along a polyline, and its total length.
   * @returns {{points: number[][], length: number}}
   */
  function resample(points, step = 1.0) {
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + dist(points[i - 1], points[i]));
    const total = cumulative[cumulative.length - 1];
    const count = Math.max(2, Math.trunc(total / step));
    const result = [];
    let j = 0;
    for (let k = 0; k <= count; k++) {
      const distance = (total * k) / count;
      while (j < cumulative.length - 2 && cumulative[j + 1] < distance) j++;
      const span = cumulative[j + 1] - cumulative[j] || 1;
      const u = (distance - cumulative[j]) / span;
      const a = points[j];
      const b = points[j + 1];
      result.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
    return { points: result, length: total };
  }

  /** Direction from a to b in degrees (SVG y-down). */
  function angle(a, b) {
    return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  }

  /** Angle difference normalized to [-180, 180), like Python's (v + 180) % 360 - 180. */
  function wrapDegrees(value) {
    return ((((value + 180) % 360) + 360) % 360) - 180;
  }

  /** True when segment pq properly intersects rs. */
  function segmentsCross(p, q, r, s) {
    const side = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0;
  }

  /** Class index (0 straight, 1 curve, 2 hook), total bend and turn direction of one stroke. */
  function classify(points, length) {
    const n = points.length;
    const direction = (start, end) =>
      angle(points[Math.min(n - 1, Math.trunc(n * start))], points[Math.min(n - 1, Math.trunc(n * end))]);
    const tenths = Array.from({ length: 10 }, (_, x) => direction(x / 10, (x + 1) / 10));
    const turns = Array.from({ length: 9 }, (_, k) => wrapDegrees(tenths[k + 1] - tenths[k]));
    const netTurn = turns.reduce((sum, t) => sum + t, 0);
    const bend = pyRound(turns.reduce((sum, t) => sum + Math.abs(t), 0));
    const tailTurn = wrapDegrees(direction(0.9, 1) - direction(0.72, 0.88));
    let cls = 0;
    if (Math.abs(tailTurn) >= HOOK_TAIL_DEGREES && length >= HOOK_MIN_LENGTH) cls = 2;
    else if (bend >= CURVE_BEND_DEGREES) cls = 1;
    const turn = netTurn > TURN_THRESHOLD ? "cw" : netTurn < -TURN_THRESHOLD ? "ccw" : "";
    return [cls, bend, turn];
  }

  /** Every second element, like Python list[start::2]. */
  function everyOther(list, start = 0) {
    return list.filter((_, i) => i >= start && (i - start) % 2 === 0);
  }

  /** Indices of earlier strokes this stroke touches and crosses. */
  function contacts(points, earlier) {
    const touches = [];
    const crosses = [];
    const mine = everyOther(points);
    const mineNext = everyOther(points, 2);
    earlier.forEach((otherPoints, j) => {
      const other = everyOther(otherPoints);
      const otherNext = everyOther(otherPoints, 2);
      let crossed = false;
      for (let a = 0; a < mineNext.length && !crossed; a++) {
        for (let c = 0; c < otherNext.length; c++) {
          if (segmentsCross(mine[a], mineNext[a], other[c], otherNext[c])) { crossed = true; break; }
        }
      }
      if (crossed) {
        crosses.push(j);
        return;
      }
      let nearest = Infinity;
      for (const a of mine) for (const b of other) nearest = Math.min(nearest, dist(a, b));
      if (nearest <= TOUCH_TOLERANCE) touches.push(j);
    });
    return [touches, crosses];
  }

  /** Coordinate scaled to 0–1 and rounded to 3 places. */
  const unit = (value) => pyRound(value / CANVAS, 3);

  /**
   * Feature rows (FIELDS order) for strokes given as SVG d strings or polylines in the 109 box.
   * @param {(string|number[][])[]} strokes
   * @returns {Array[]}
   */
  function strokeFeatures(strokes) {
    const sampled = strokes.map((stroke) => resample(typeof stroke === "string" ? samplePath(stroke) : samplePolyline(stroke)));
    const longest = Math.max(...sampled.map((s) => s.length)) || 1;
    return sampled.map(({ points, length }, i) => {
      const [cls, bend, turn] = classify(points, length);
      const centerX = points.reduce((sum, p) => sum + p[0], 0) / points.length;
      const centerY = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const [touches, crosses] = contacts(points, sampled.slice(0, i).map((s) => s.points));
      const first = points[0];
      const last = points[points.length - 1];
      return [
        pyRound(angle(first, last)), cls, bend, turn, pyRound(length / longest, 3),
        unit(first[0]), unit(first[1]), unit(last[0]), unit(last[1]),
        unit(centerX), unit(centerY), touches, crosses,
      ];
    });
  }

  /**
   * Rows with positions moved into the character's own bounding box (larger side = 1).
   * @param {Array[]} rows
   * @returns {Array[]}
   */
  function relativeRows(rows) {
    const xs = rows.flatMap((r) => ["sx", "ex", "cx"].map((f) => r[COLUMN[f]]));
    const ys = rows.flatMap((r) => ["sy", "ey", "cy"].map((f) => r[COLUMN[f]]));
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const scale = Math.max(Math.max(...xs) - left, Math.max(...ys) - top, 1e-6);
    return rows.map((row) => {
      const copy = row.slice();
      for (const field of POSITION_FIELDS) {
        const origin = field.endsWith("x") ? left : top;
        copy[COLUMN[field]] = pyRound((row[COLUMN[field]] - origin) / scale, 4);
      }
      return copy;
    });
  }

  /** Width and height of the box around all start, end and centroid points. */
  function boundingBox(rows) {
    const xs = rows.flatMap((r) => ["sx", "ex", "cx"].map((f) => r[COLUMN[f]]));
    const ys = rows.flatMap((r) => ["sy", "ey", "cy"].map((f) => r[COLUMN[f]]));
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  }

  /**
   * Value of a rule metric for one character's feature rows; null if a stroke index is missing.
   * @param {{type: string, strokes?: number[], field?: string, fields?: string[]}} metric
   * @param {Array[]} featureRows
   * @returns {number|null}
   */
  function metricValue(metric, featureRows) {
    const strokes = metric.strokes || [];
    if (strokes.some((i) => i >= featureRows.length)) return null;
    const rows = relativeRows(featureRows);
    const at = (i, field) => rows[strokes[i]][COLUMN[field]];
    switch (metric.type) {
      case "lengthRatio":
        return at(0, "len") / Math.max(at(1, "len"), 1e-6);
      case "angle":
        return at(0, "dir");
      case "position":
        return at(0, metric.field);
      case "bend":
        return at(0, "bend");
      case "strokeCount":
        return rows.length;
      case "aspectRatio": {
        const [width, height] = boundingBox(rows);
        return width / Math.max(height, 1e-6);
      }
      case "horizontalCount":
        return rows.filter((r) => Math.abs(r[COLUMN.dir]) <= HORIZONTAL_DEGREES).length;
      case "contact": {
        const column = metric.field === "touch" ? "touches" : "crosses";
        return at(0, column).includes(strokes[1]) ? 1 : 0;
      }
      case "relativePosition":
        return at(0, metric.fields[0]) - rows[strokes[1]][COLUMN[metric.fields[1]]];
      case "endGap": {
        const end = rows[strokes[0]];
        const start = rows[strokes[1]];
        return dist([end[COLUMN.ex], end[COLUMN.ey]], [start[COLUMN.sx], start[COLUMN.sy]]);
      }
      case "hook":
        return at(0, "cls") === 2 ? 1 : 0;
      default:
        throw new Error(`unknown metric ${metric.type}`);
    }
  }

  /** Feature rows from raw strokes, or the rows themselves if already features. */
  function toRows(strokes) {
    const isRows = strokes.length > 0 && Array.isArray(strokes[0]) && typeof strokes[0][0] === "number"
      && strokes[0].length === FIELDS.length;
    return isRows ? strokes : strokeFeatures(strokes);
  }

  /**
   * Same semantics as validate_proportions.py: value beyond threshold, allowing `tolerance`.
   * @param {{metric: object, comparator: string, threshold: number, tolerance: number}} rule
   * @param {Array} strokes SVG d strings, polylines, or feature rows
   * @returns {{passes: boolean, value: number|null}}
   */
  function evaluateRule(rule, strokes) {
    const value = metricValue(rule.metric, toRows(strokes));
    if (value === null) return { passes: false, value };
    const passes = rule.comparator === ">" ? value > rule.threshold - rule.tolerance
      : value < rule.threshold + rule.tolerance;
    return { passes, value };
  }

  /**
   * Evaluate every rule for `char` (rules keyed by char, as in proportion-rules-*.js).
   * @returns {{passes: boolean, failed: object[]}}
   */
  function checkChar(char, strokes, rulesByChar) {
    const rows = toRows(strokes);
    const failed = (rulesByChar[char] || [])
      .map((rule) => ({ rule, ...evaluateRule(rule, rows) }))
      .filter((result) => !result.passes);
    return { passes: failed.length === 0, failed };
  }

  // ---------- stroke-pair topology (lenient contact check; mirrors proportion_metrics.py) ----------
  // Distances are shares of the drawn character's size (larger side of the bounding box of all
  // points). See kanji-data/STROKE_TOPOLOGY.md.

  const TOPOLOGY_TOUCH = 0.05;
  const TOPOLOGY_NEAR = 0.15;
  const TOPOLOGY_END_SHARE = 0.15;
  const TOPOLOGY_CHECK = {
    missingCrossDepth: 0.03,
    missingCrossGap: 0.03,
    extraCrossSeparation: 0.08,
    extraCrossDepth: 0.09,
    touchCrossDepth: 0.26,
  };

  /** Resampled points (about 1 unit apart), every second one kept, per stroke. */
  function topologyPoints(strokes) {
    return strokes.map((stroke) =>
      everyOther(resample(typeof stroke === "string" ? samplePath(stroke) : samplePolyline(stroke)).points));
  }

  /** Cumulative arc length at each point. */
  function arcLengths(points) {
    const out = [0];
    for (let i = 1; i < points.length; i++) out.push(out[i - 1] + dist(points[i - 1], points[i]));
    return out;
  }

  /** "start", "body" or "end": where point `index` lies along the stroke. */
  function strokePart(index, arc) {
    const total = arc[arc.length - 1] || 1;
    const share = arc[index] / total;
    return share <= TOPOLOGY_END_SHARE ? "start" : share >= 1 - TOPOLOGY_END_SHARE ? "end" : "body";
  }

  /** Larger side of the bounding box of every point (at least 1). */
  function characterSize(strokes) {
    const xs = strokes.flatMap((s) => s.map((p) => p[0]));
    const ys = strokes.flatMap((s) => s.map((p) => p[1]));
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  }

  /**
   * Min distance, where ("end-body" …) and cross depth of strokes a (earlier) and b, as shares of size.
   * Depth: for the deepest crossing, the smaller along-stroke distance from it to either stroke's nearer end.
   * @returns {[number, string, number]}
   */
  function pairMeasure(a, b, size) {
    const arcA = arcLengths(a);
    const arcB = arcLengths(b);
    let depth = 0;
    for (let k = 0; k < a.length - 1; k++) {
      for (let m = 0; m < b.length - 1; m++) {
        if (segmentsCross(a[k], a[k + 1], b[m], b[m + 1])) {
          const da = Math.min(arcA[k], arcA[arcA.length - 1] - arcA[k + 1]);
          const db = Math.min(arcB[m], arcB[arcB.length - 1] - arcB[m + 1]);
          depth = Math.max(depth, Math.min(da, db));
        }
      }
    }
    let best = Infinity;
    let bestK = 0;
    let bestM = 0;
    a.forEach((p, k) => b.forEach((q, m) => {
      const d = dist(p, q);
      if (d < best) { best = d; bestK = k; bestM = m; }
    }));
    return [best / size, `${strokePart(bestK, arcA)}-${strokePart(bestM, arcB)}`, depth / size];
  }

  /**
   * Reference rows [i, j, relation (0 separate, 1 touches, 2 crosses), min distance, where, depth]
   * for stroke pairs within TOPOLOGY_NEAR.
   */
  function strokeTopology(strokes) {
    const points = topologyPoints(strokes);
    const size = characterSize(points);
    const rows = [];
    for (let j = 0; j < points.length; j++) {
      for (let i = 0; i < j; i++) {
        const [gap, where, depth] = pairMeasure(points[i], points[j], size);
        if (gap > TOPOLOGY_NEAR) continue;
        const relation = depth > 0 ? 2 : gap <= TOPOLOGY_TOUCH ? 1 : 0;
        rows.push([i, j, relation, pyRound(gap, 3), where, pyRound(depth, 3)]);
      }
    }
    return rows;
  }

  /**
   * Clear contact violations of a drawing against its reference topology ([] = pass). Lenient:
   * only stored reference pairs are checked and every borderline case passes.
   * @returns {{kind: string, strokes: number[], gap: number, depth: number}[]}
   */
  function topologyViolations(topology, strokes) {
    const points = topologyPoints(strokes);
    const size = characterSize(points);
    const t = TOPOLOGY_CHECK;
    const out = [];
    for (const [i, j, relation, refGap, , refDepth] of topology) {
      if (j >= points.length) continue;
      const [gap, , depth] = pairMeasure(points[i], points[j], size);
      let kind = null;
      if (relation === 2 && refDepth >= t.missingCrossDepth && depth === 0 && gap > t.missingCrossGap) kind = "missingCross";
      else if (relation === 0 && refGap >= t.extraCrossSeparation && depth > t.extraCrossDepth) kind = "extraCross";
      else if (relation === 1 && depth > t.touchCrossDepth) kind = "touchCrossed";
      if (kind) out.push({ kind, strokes: [i, j], gap, depth });
    }
    return out;
  }

  return { FIELDS, pyRound, pathSegments, samplePath, resample, samplePolyline, strokeFeatures, relativeRows, metricValue,
    evaluateRule, checkChar, TOPOLOGY_CHECK, strokeTopology, topologyViolations };
});
