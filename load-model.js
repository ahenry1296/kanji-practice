/*
 * load-model.js — daily load budget + load forecast (v16 lane item R1, MARKET_RESEARCH.md pain #1 "review
 * pile-ups and burnout"). Pure: no DOM, no storage. Exposes window.LoadModel; also CommonJS for tests.
 *
 * Idea: the learner sets a daily time budget (minutes). Reviews are estimated at SEC_PER_REVIEW each, a new kanji
 * (its lesson + learning steps) at SEC_PER_NEW. New kanji are throttled when the PROJECTED review load over the
 * next days would exceed the budget, because every new kanji adds future reviews (that is how pile-ups start).
 * Reviews are never rescheduled here: due dates stay FSRS's. When more reviews are due than fit today, the queue
 * shows the most-at-risk ones first (lowest retrievability) and the rest simply wait for tomorrow.
 * Component-first: throttling limits HOW MANY new kanji start, never which; the gating order still decides.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoadModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 864e5;
  /** Rough per-item costs (s). Writing a kanji from memory takes longer than a flashcard; tune from telemetry later. */
  const SEC_PER_REVIEW = 20;
  const SEC_PER_NEW = 90;
  const DEFAULTS = Object.freeze({ minutesPerDay: 15, newPerDayMax: 10, horizonDays: 7 });

  /** Repair settings: integers in range, else the default. */
  function sanitizeSettings(s) {
    const o = s && typeof s === 'object' ? s : {};
    const int = (v, d, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
    return {
      minutesPerDay: int(o.minutesPerDay, DEFAULTS.minutesPerDay, 5, 240),
      newPerDayMax: int(o.newPerDayMax, DEFAULTS.newPerDayMax, 0, 50),
      horizonDays: int(o.horizonDays, DEFAULTS.horizonDays, 1, 30),
    };
  }

  /** Reviews that fit in the budget per day. */
  const reviewCapacity = (settings) => Math.floor(sanitizeSettings(settings).minutesPerDay * 60 / SEC_PER_REVIEW);

  /**
   * Due reviews per local day for the next `days` days. due = array of due times (ms). Overdue items land in day 0.
   * startOfToday = ms of local midnight today (caller computes it in the user's zone, e.g. Asia/Tokyo).
   */
  function forecast(dueTimes, startOfToday, days = 14) {
    const out = new Array(days).fill(0);
    for (const t of dueTimes) {
      if (!Number.isFinite(t)) continue;
      const d = Math.max(0, Math.floor((t - startOfToday) / DAY_MS));
      if (d < days) out[d]++;
    }
    return out;
  }

  /**
   * How many NEW kanji may start today. The projected load is the busiest day in the horizon, where reviews
   * that do not fit roll over to the next day (a backlog grows). Each new kanji costs SEC_PER_NEW today and
   * adds ~1 review per day in the following days (learning steps, then the first FSRS reviews).
   * Returns {allowed, capacity, projectedPeak, reason}: reason is 'ok' | 'over-budget' | 'daily-max'.
   */
  function newAllowance(fc, settings, { introducedToday = 0 } = {}) {
    const s = sanitizeSettings(settings);
    const cap = reviewCapacity(s);
    let carry = 0, peak = 0;
    for (let d = 0; d < Math.min(s.horizonDays, fc.length); d++) {
      const load = fc[d] + carry;
      peak = Math.max(peak, load);
      carry = Math.max(0, load - cap);
    }
    if (peak >= cap) return { allowed: 0, capacity: cap, projectedPeak: peak, reason: 'over-budget' };
    const budgetLeftSec = s.minutesPerDay * 60 - Math.min(fc[0] || 0, cap) * SEC_PER_REVIEW;
    const byTime = Math.floor(budgetLeftSec / SEC_PER_NEW);
    const byPeak = cap - peak;                 // each new kanji adds ~1 review to the peak days
    const left = Math.max(0, s.newPerDayMax - introducedToday);
    const allowed = Math.max(0, Math.min(byTime, byPeak, left));
    return { allowed, capacity: cap, projectedPeak: peak, reason: allowed === 0 && left === 0 ? 'daily-max' : 'ok' };
  }

  /**
   * Today's review list within the budget. items = [{key, due, r}] where r = retrievability now (0..1).
   * Most at risk first (lowest r, then most overdue); returns {today: keys, deferred: keys}.
   */
  function todayQueue(items, settings, now, { doneToday = 0 } = {}) {
    const due = items.filter((it) => Number.isFinite(it.due) && it.due <= now)
      .sort((a, b) => (a.r - b.r) || (a.due - b.due) || (a.key < b.key ? -1 : 1));
    const room = Math.max(0, reviewCapacity(settings) - doneToday);
    return { today: due.slice(0, room).map((x) => x.key), deferred: due.slice(room).map((x) => x.key) };
  }

  return { SEC_PER_REVIEW, SEC_PER_NEW, DEFAULTS, sanitizeSettings, reviewCapacity, forecast, newAllowance, todayQueue };
});
