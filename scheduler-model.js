/*
 * scheduler-model.js — FSRS-5 spaced-repetition scheduler for kanji (v16 item #1, spec: V16_API.md "#1").
 * Pure functions, no DOM, no storage. Exposes window.SchedulerModel; also a CommonJS module for tests.
 *
 * Algorithm: FSRS-5 (Free Spaced Repetition Scheduler) by Jarrett Ye / open-spaced-repetition.
 *   Formulas: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm  (section "FSRS-5")
 *   Default parameters: py-fsrs v5 / ts-fsrs v4 `default_w` (FSRS-5, 19 weights),
 *     https://github.com/open-spaced-repetition/py-fsrs  and  https://github.com/open-spaced-repetition/ts-fsrs
 *   Background: https://expertium.github.io/Algorithm.html , https://docs.ankiweb.net/faqs/what-spaced-repetition-algorithm
 *
 * Each card has its own Stability S (days until recall probability falls to 90%) and Difficulty D (1..10).
 * Why it replaces the old ladder [1,3,7,14,30] (V16_PLAN G1):
 *   - a review that needed hints is graded `hard`: stability grows less, it is NOT reset to 1 day;
 *   - a late but correct review earns more stability (lower retrievability R at review → larger gain);
 *   - there is no 30-day cap (only MAX_INTERVAL_DAYS, ~100 years, as a sanity bound).
 * Learning steps (v16 #2, Botthree 3c3522c, kept per Botty 10-26): a new card first walks LEARNING_STEPS_MS
 * (10 min, 4 h, 1 day). Clean → next step, hints/again → step 0. Finishing the last step "graduates" the card:
 * FSRS takes over with stability 1 day (the old first interval), due 1 day later.
 * Ranks/tiers (rank-model.js) and component-first gating are untouched: this module only decides WHEN a
 * kanji (or component, or word) is due, never what is unlocked, so the radical-first order is preserved.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SchedulerModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** FSRS-5 default weights w[0..18] (py-fsrs v5 / ts-fsrs default_w). */
  const DEFAULT_W = Object.freeze([
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
    1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
  ]);
  /** Forgetting-curve constants of FSRS-4.5/5: R(t,S) = (1 + FACTOR·t/S)^DECAY, so R(S,S) = 0.9. */
  const DECAY = -0.5;
  const FACTOR = 19 / 81;
  const DAY_MS = 864e5;
  const DEFAULT_RETENTION = 0.9;
  const MIN_STABILITY = 0.01;
  const MAX_INTERVAL_DAYS = 36500;
  /** v16 #2 learning steps (same values as Botthree's 3c3522c), in ms. */
  const LEARNING_STEPS_MS = Object.freeze([10 * 60e3, 4 * 3600e3, DAY_MS]);
  /** Grades as in FSRS/Anki. The app uses `good` (clean) and `hard` (needed hints); `again` = forgotten. */
  const GRADES = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const gradeValue = (grade) => (typeof grade === 'number' ? clamp(Math.round(grade), 1, 4) : GRADES[grade] || GRADES.good);

  /** A brand-new card (never reviewed). */
  function newCard() {
    return { phase: 'new', step: 0, stability: 0, difficulty: 0, due: null, last: null, reps: 0, lapses: 0 };
  }

  /** Probability (0..1) of recalling a card `elapsedDays` after its last review. */
  function forgettingCurve(elapsedDays, stability) {
    return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / Math.max(stability, MIN_STABILITY), DECAY);
  }

  /** Current retrievability of a card at `now` (ms); 0 for a new card. */
  function retrievability(card, now) {
    if (!card || card.phase === 'new' || !card.last) return 0;
    return forgettingCurve((now - card.last) / DAY_MS, card.stability);
  }

  /** Days until recall probability falls to `retention` (FSRS next-interval formula), unrounded. */
  function interval(stability, retention = DEFAULT_RETENTION) {
    const r = clamp(retention, 0.7, 0.99);
    return clamp((stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1), 0, MAX_INTERVAL_DAYS);
  }

  // ---- FSRS-5 update rules (names follow the wiki) ----
  const initStability = (G, w) => Math.max(w[G - 1], MIN_STABILITY);
  const initDifficulty = (G, w) => w[4] - Math.exp(w[5] * (G - 1)) + 1; // unclamped D0, also used for mean reversion
  function nextDifficulty(D, G, w) {
    const delta = -w[6] * (G - 3);
    const damped = D + delta * (10 - D) / 9;                   // linear damping: harder to move near 10
    const reverted = w[7] * initDifficulty(4, w) + (1 - w[7]) * damped; // mean reversion toward D0(easy)
    return clamp(reverted, 1, 10);
  }
  function recallStability(D, S, R, G, w) {
    const hardPenalty = G === 2 ? w[15] : 1;
    const easyBonus = G === 4 ? w[16] : 1;
    return S * (1 + Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9]) * (Math.exp(w[10] * (1 - R)) - 1) * hardPenalty * easyBonus);
  }
  function forgetStability(D, S, R, w) {
    const sf = w[11] * Math.pow(D, -w[12]) * (Math.pow(S + 1, w[13]) - 1) * Math.exp(w[14] * (1 - R));
    return Math.min(sf, S); // a lapse never increases stability
  }
  /** FSRS-5 short-term (same-day) review: S·e^(w17·(G−3+w18)). */
  const shortTermStability = (S, G, w) => S * Math.exp(w[17] * (G - 3 + w[18]));

  /**
   * Schedule the next review after a review of `card` with `grade` at `now` (ms). Returns a NEW card.
   * @param {object} card  stored card (or null for new)
   * @param {'again'|'hard'|'good'|'easy'|1|2|3|4} grade
   * @param {number} now   epoch ms
   * @param {{retention?:number, w?:number[], minIntervalDays?:number}} opts
   *   minIntervalDays (default 1) keeps the app's day-granular reviews: nothing is due again the same day.
   */
  function next(card, grade, now, { retention = DEFAULT_RETENTION, w = DEFAULT_W, minIntervalDays = 1, stepsMs = LEARNING_STEPS_MS } = {}) {
    const G = gradeValue(grade);
    const c = sanitizeCard(card);
    const counts = { reps: c.reps + 1, lapses: c.lapses + (G === 1 && c.phase === 'review' ? 1 : 0) };

    // New or learning card: walk the short steps first (stepsMs = [] or false skips them).
    if (stepsMs && stepsMs.length && c.phase !== 'review') {
      const step = c.phase === 'new' || G <= 2 ? 0 : c.step + 1;   // hints/again restart the steps
      // Difficulty is tracked from the first answer so graduation starts FSRS with an informed D.
      const D = c.phase === 'new' ? clamp(initDifficulty(G, w), 1, 10) : nextDifficulty(c.difficulty, G, w);
      if (step < stepsMs.length - 1 || c.phase === 'new') {
        return { phase: 'learning', step, stability: 0, difficulty: D, due: now + stepsMs[step], last: now, ...counts };
      }
      // Last step passed cleanly: graduate. Stability 1 day = the old ladder's first interval.
      return { phase: 'review', step: 0, stability: 1, difficulty: D, due: now + stepsMs[stepsMs.length - 1], last: now, ...counts };
    }

    let S, D;
    if (c.phase !== 'review') {          // steps disabled: plain FSRS first review
      S = initStability(G, w);
      D = clamp(initDifficulty(G, w), 1, 10);
    } else {
      const elapsed = c.last ? (now - c.last) / DAY_MS : 0;
      D = nextDifficulty(c.difficulty, G, w);
      if (elapsed < 1 && c.last) S = shortTermStability(c.stability, G, w);
      else {
        const R = forgettingCurve(elapsed, c.stability);
        S = G === 1 ? forgetStability(c.difficulty, c.stability, R, w) : recallStability(c.difficulty, c.stability, R, G, w);
      }
    }
    S = Math.max(S, MIN_STABILITY);
    const days = Math.max(minIntervalDays, Math.round(interval(S, retention)));
    return { phase: 'review', step: 0, stability: S, difficulty: D, due: now + days * DAY_MS, last: now, ...counts };
  }

  /**
   * Load smoothing (v16 R2, like Anki's "load balancer"): move a review due in ≥3 days by up to ±5% (min ±1 day)
   * to the least busy day, so reviews do not bunch up. otherDue = due times (ms) of the other cards.
   * Ties go to the original day, then the earlier day. Learning cards and short intervals are left alone.
   * Moving by ≤5% changes the expected recall at review by well under 1 point at retention 0.9.
   */
  function smoothDue(card, otherDue, now) {
    if (!card || card.phase !== 'review' || card.last == null) return card;
    const iv = Math.round((card.due - card.last) / DAY_MS);
    if (iv < 3) return card;
    const delta = Math.max(1, Math.round(iv * 0.05));
    const loadOn = (days) => {
      const lo = now + days * DAY_MS - DAY_MS / 2, hi = lo + DAY_MS;
      let n = 0; for (const t of otherDue) if (t >= lo && t < hi) n++; return n;
    };
    let best = iv, bestLoad = loadOn(iv);
    for (let d = iv - delta; d <= iv + delta; d++) {
      const l = loadOn(d);
      if (l < bestLoad || (l === bestLoad && Math.abs(d - iv) < Math.abs(best - iv)) ||
          (l === bestLoad && Math.abs(d - iv) === Math.abs(best - iv) && d < best)) { best = d; bestLoad = l; }
    }
    return best === iv ? card : Object.assign({}, card, { due: card.last + best * DAY_MS });
  }

  /** Repair a stored card: bad numbers fall back to safe values; an unusable card becomes new. */
  function sanitizeCard(card) {
    if (!card || typeof card !== 'object') return newCard();
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : d);
    const S = num(card.stability, 0);
    if (card.phase === 'learning') {
      return { phase: 'learning', step: clamp(Math.floor(num(card.step, 0)), 0, LEARNING_STEPS_MS.length - 1), stability: 0,
               difficulty: clamp(num(card.difficulty, 5), 1, 10), due: num(card.due, null), last: num(card.last, null),
               reps: Math.max(0, num(card.reps, 0)), lapses: Math.max(0, num(card.lapses, 0)) };
    }
    if (card.phase !== 'review' || !(S > 0)) return newCard();
    return {
      phase: 'review', step: 0, stability: S,
      difficulty: clamp(num(card.difficulty, 5), 1, 10),
      due: num(card.due, null), last: num(card.last, null),
      reps: Math.max(0, num(card.reps, 0)), lapses: Math.max(0, num(card.lapses, 0)),
    };
  }

  /** Whole days of the card's current interval (for "Next review: in N days"); 0 while a step is under a day. */
  function intervalDays(card) {
    if (!card || card.due == null || card.last == null) return 1;
    const d = (card.due - card.last) / DAY_MS;
    return d < 1 ? 0 : Math.round(d);
  }

  /**
   * Convert one old v15 `rec:<k>` record into an FSRS review card, keeping its due date exactly.
   * Old record: {cleanRecalls, hintsUsed, lastPracticed: ISO, nextReview: ISO, intervalDays, streak, done}.
   *   stability  = intervalDays (min 1): the old ladder roughly targeted "still remembered at the next review",
   *                and S is by definition the 90%-recall interval, so this is the closest neutral guess;
   *   difficulty = FSRS D0(good) ≈ 5.28, or D0(hard) ≈ 6.75 if the last session needed hints (streak 0);
   *   due        = Date.parse(nextReview) (unchanged, so nobody's review queue moves on upgrade);
   *   last       = Date.parse(lastPracticed); reps = done (or 1).
   * Returns null for a record that was never completed (no lastPracticed AND no nextReview): that kanji stays new.
   * A record with nextReview but no lastPracticed (older builds, Bottwo QA) keeps its due date exactly; its
   * `last` is worked out as nextReview − intervalDays, or `now` when that cannot be worked out.
   */
  function cardFromRecord(rec, now, w = DEFAULT_W) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const iv = Number(rec.intervalDays);
    let last = Date.parse(rec.lastPracticed);
    if (!Number.isFinite(last)) {
      const dueOnly = Date.parse(rec.nextReview);
      if (!Number.isFinite(dueOnly)) return null;                 // never studied: stays new
      last = Number.isFinite(iv) && iv > 0 ? Math.min(now, dueOnly - iv * DAY_MS) : now;
    }
    const S = Number.isFinite(iv) && iv >= 1 ? iv : 1;
    let due = Date.parse(rec.nextReview);
    if (!Number.isFinite(due)) due = Math.min(now, last + S * DAY_MS); // missing date → due (as the app treated it)
    if (Number.isInteger(rec.learnStep)) {  // a record saved mid-steps by the v16 #2 build
      return { phase: 'learning', step: clamp(rec.learnStep, 0, LEARNING_STEPS_MS.length - 1), stability: 0,
               difficulty: clamp(initDifficulty(3, w), 1, 10), due, last, reps: Math.max(1, Math.floor(Number(rec.done) || 0)), lapses: 0 };
    }
    const hadHints = Number(rec.streak) === 0 && Number(rec.hintsUsed) > 0;
    return {
      phase: 'review', step: 0, stability: S,
      difficulty: clamp(initDifficulty(hadHints ? 2 : 3, w), 1, 10),
      due, last,
      reps: Math.max(1, Math.floor(Number(rec.done) || 0)), lapses: 0,
    };
  }

  /**
   * Migrate all old records. `recs` maps key (without the "rec:" prefix, e.g. "休" or "w:休む") → parsed record.
   * `ranks` is accepted for API symmetry and never read or changed (tiers stay as they are).
   * @returns {{version:1, cards:Object<string,object>}}
   */
  function migrate(recs, ranks, now) { // eslint-disable-line no-unused-vars
    const cards = {};
    for (const key of Object.keys(recs || {})) {
      const card = cardFromRecord(recs[key], now);
      if (card) cards[key] = card;
    }
    return { version: 1, cards };
  }


  /* ==================== v16 #2 record API (Botthree 3c3522c), kept for v15-integration.js ====================
   * These work on `rec:<k>` records, not FSRS cards. V15.recFinish uses finish() for the record's counters
   * (done / streak / hints at the v15 pace) and as the ladder fallback when FSRS is off or throws; then the
   * FSRS card (next(), above) sets nextReview. dueCounts / dueList / isLearning back V15.dueCounts, V15.dueList,
   * the mixed review queue (#6) and the habit status (#7). LEARNING_STEPS_MS is shared with next() above.
   */

  /** v15 CONFIG.SCHEDULE_DAYS, used when the caller passes none. */
  const DEFAULT_SCHEDULE_DAYS = Object.freeze([1, 3, 7, 14, 30]);

  /**
   * True while a record is in learning (has a valid `learnStep`).
   * @param {object|null} rec
   * @returns {boolean}
   */
  function isLearning(rec) {
    return !!rec && Number.isInteger(rec.learnStep) && rec.learnStep >= 0;
  }

  /**
   * The v15 recFinish rule, unchanged (index.html): new → first interval; a review with hints → first interval;
   * otherwise one step up the day list.
   * @param {object} r record (mutated)
   * @param {number} clean clean recalls this session
   * @param {number} hints hints used this session
   * @param {number} now ms
   * @param {number[]} S schedule in days
   * @returns {object} r
   */
  function finishV15(r, clean, hints, now, S) {
    const wasReview = !!r.lastPracticed;
    let iv;
    if (wasReview && hints > 0) iv = S[0];
    else {
      const i = S.indexOf(r.intervalDays);
      iv = r.intervalDays ? S[Math.min(i + 1, S.length - 1)] : S[0];
    }
    r.cleanRecalls = (Number(r.cleanRecalls) || 0) + clean;
    r.done = (Number(r.done) || 0) + 1;
    r.hintsUsed = (Number(r.hintsUsed) || 0) + hints;
    r.streak = hints > 0 ? 0 : (Number(r.streak) || 0) + 1;
    r.lastPracticed = new Date(now).toISOString();
    r.intervalDays = iv;
    r.nextReview = new Date(now + iv * 864e5).toISOString();
    return r;
  }

  /**
   * Record one finished practice of a kanji / word and schedule its next review.
   * @param {object|null} rec the current `rec:<k>` record (null = new or corrupt); not mutated
   * @param {number} clean clean recalls this session
   * @param {number} hints hints used this session
   * @param {number} now ms
   * @param {{scheduleDays?: number[], stepsMs?: number[]|false}} [opts] stepsMs false or [] = v15 behaviour
   * @returns {object} the new record to store
   */
  function finish(rec, clean, hints, now, opts = {}) {
    const S = opts.scheduleDays || DEFAULT_SCHEDULE_DAYS;
    const steps = opts.stepsMs === undefined ? LEARNING_STEPS_MS : opts.stepsMs || [];
    // Same starting record as v15 (a copy of the stored one, or the v15 blank), so stored JSON keeps its key order.
    const r = rec ? Object.assign({}, rec)
      : { cleanRecalls: 0, hintsUsed: 0, lastPracticed: null, nextReview: null, intervalDays: 0 };
    const isNew = !r.lastPracticed;
    if (!steps.length || (!isNew && !isLearning(r))) {
      delete r.learnStep;
      return finishV15(r, clean, hints, now, S);
    }
    if (isNew) {
      finishV15(r, clean, hints, now, S); // counts done / streak exactly like a v15 first completion
      r.intervalDays = 0;
      r.learnStep = 0;
    } else {
      // A learning review: stats only; done and streak keep the v15 pace (hints still reset streak).
      r.cleanRecalls = (Number(r.cleanRecalls) || 0) + clean;
      r.hintsUsed = (Number(r.hintsUsed) || 0) + hints;
      if (hints > 0) r.streak = 0;
      r.lastPracticed = new Date(now).toISOString();
      r.learnStep = hints > 0 ? 0 : Math.min(r.learnStep + 1, steps.length - 1);
    }
    if (r.learnStep >= steps.length - 1) {
      // Graduation: the last step's wait, then the v15 day schedule from its first interval.
      delete r.learnStep;
      r.intervalDays = S[0];
    }
    r.nextReview = new Date(now + steps[Math.min(isLearning(r) ? r.learnStep : steps.length - 1, steps.length - 1)]).toISOString();
    return r;
  }

  /** A record that has been studied: it has lastPracticed, or (older builds) only a nextReview due date. */
  function studiedRec(rec) {
    return !!rec && (!!rec.lastPracticed || Number.isFinite(Date.parse(rec.nextReview)));
  }

  /**
   * Due summary over stored records.
   * @param {Array<[string, object|null]>} entries [key without 'rec:', record]
   * @param {number} now ms
   * @returns {{due: number, learning: number, nextDue: number|null}} nextDue = earliest future due (ms)
   */
  function dueCounts(entries, now) {
    let due = 0;
    let learning = 0;
    let nextDue = null;
    for (const [, rec] of entries) {
      if (!studiedRec(rec)) continue;
      const t = Date.parse(rec.nextReview);
      if (isLearning(rec)) learning += 1;
      if (t <= now) due += 1;
      else if (t > now && (nextDue === null || t < nextDue)) nextDue = t;
    }
    return { due, learning, nextDue };
  }

  /**
   * Due items, most overdue first.
   * @param {Array<[string, object|null]>} entries
   * @param {number} now ms
   * @returns {Array<{key: string, due: number, phase: 'learning'|'review'}>}
   */
  function dueList(entries, now) {
    return entries
      .filter(([, rec]) => studiedRec(rec) && Date.parse(rec.nextReview) <= now)
      .map(([key, rec]) => ({ key, due: Date.parse(rec.nextReview), phase: isLearning(rec) ? 'learning' : 'review' }))
      .sort((a, b) => a.due - b.due);
  }

  return { LEARNING_STEPS_MS, DEFAULT_W, DECAY, FACTOR, GRADES, DEFAULT_RETENTION, MAX_INTERVAL_DAYS,
           newCard, next, smoothDue, retrievability, interval, forgettingCurve, intervalDays, sanitizeCard, cardFromRecord, migrate,
           // v16 #2 record API (3c3522c)
           DEFAULT_SCHEDULE_DAYS, isLearning, finish, finishV15, dueCounts, dueList };
});
