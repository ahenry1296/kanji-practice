/*
 * habit-model.js — daily habit streak + daily goal (v16 item #7, spec: V16_API.md "#7"). Pure: no DOM, no storage.
 * Exposes window.HabitModel; also a CommonJS module for tests. All functions return NEW states (never mutate).
 *
 * Research basis (V16_PLAN F15, F2): Duolingo found that letting ONE lesson extend the streak, separately from the
 * daily goal, raised day-14 retention (+3.3%) — https://blog.duolingo.com/improving-the-streak/ . So:
 *   - the streak grows with the FIRST scored retrieval of a local day (low barrier);
 *   - the goal counts scored retrievals (answers from memory: a reading answered or a kanji written), because
 *     testing beats restudy (Roediger & Karpicke 2006). Retries (#9) and contrast items (#6) are not counted —
 *     the caller only records PracticeModel.isScored(item) answers;
 *   - a missed day uses a streak freeze instead of wiping the streak (grace). Policy (Botfive, for Botty to
 *     confirm): a new learner starts with 1 freeze, earns 1 per 7-day streak milestone, holds at most 2.
 *
 * Day boundaries: local calendar days. tzOffsetMin = minutes EAST of UTC (Asia/Tokyo = 540). Default = the
 * runtime zone AT THAT INSTANT (handles DST zones correctly). A day key is 'YYYY-MM-DD' in that zone; day
 * differences are computed from the keys (calendar arithmetic), never by dividing elapsed ms by 24 h.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HabitModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_GOAL = 10;          // scored retrievals per day
  const GOAL_MIN = 1, GOAL_MAX = 200;
  const MAX_FREEZES = 2;
  const START_FREEZES = 1;
  const FREEZE_EVERY_DAYS = 7;      // one freeze earned per 7-day streak milestone
  const DAY_MS = 864e5;

  /** Minutes east of UTC for the runtime zone at `now` (JS getTimezoneOffset is minutes WEST, hence the minus). */
  const runtimeOffset = (now) => -new Date(now).getTimezoneOffset();

  /** Local day key 'YYYY-MM-DD' of instant `now` (ms) in the zone tzOffsetMin. */
  function dayKey(now, tzOffsetMin = runtimeOffset(now)) {
    return new Date(now + tzOffsetMin * 60e3).toISOString().slice(0, 10);
  }
  /** Whole calendar days from day key a to day key b (b − a). */
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
  const isDayKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Date.parse(k + 'T00:00:00Z'));
  const int = (v, d, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

  function newState() {
    return { version: 1, streak: 0, best: 0, lastDay: null, freezes: START_FREEZES, goal: DEFAULT_GOAL, today: { day: null, done: 0 } };
  }

  /** Repair stored junk field by field (a bad field falls back to its default; good fields are kept). */
  function sanitize(s) {
    const d = newState();
    if (!s || typeof s !== 'object' || Array.isArray(s)) return d;
    const streak = int(s.streak, 0, 0, 1e6);
    const t = s.today && typeof s.today === 'object' ? s.today : {};
    return {
      version: 1, streak,
      best: Math.max(streak, int(s.best, 0, 0, 1e6)),
      lastDay: isDayKey(s.lastDay) ? s.lastDay : null,
      freezes: int(s.freezes, d.freezes, 0, MAX_FREEZES),
      goal: int(s.goal, DEFAULT_GOAL, GOAL_MIN, GOAL_MAX),
      today: { day: isDayKey(t.day) ? t.day : null, done: int(t.done, 0, 0, 1e6) },
    };
  }

  /**
   * Bring the state up to `now`: a new day resets today's count; each fully missed day since lastDay uses one
   * freeze; with too few freezes the streak resets to 0. Missed days are "consumed" by advancing lastDay
   * (marked as covered), so calling tick twice never spends a freeze twice.
   */
  function tick(state, now, { tzOffsetMin } = {}) {
    const s = sanitize(state);
    const today = dayKey(now, tzOffsetMin);
    if (s.today.day !== today) s.today = { day: today, done: 0 };
    if (s.lastDay && s.streak > 0) {
      const missed = daysBetween(s.lastDay, today) - 1;   // full days with no review between lastDay and today
      if (missed > 0) {
        if (missed <= s.freezes) {
          s.freezes -= missed;
          s.lastDay = dayKey(Date.parse(today + 'T00:00:00Z') - DAY_MS, 0); // yesterday counts as covered
        } else {
          s.streak = 0;
        }
      }
    }
    return s;
  }

  /**
   * Record `count` scored retrievals at `now`. Returns {state, extended, goalMet, goalReached}.
   *   extended    — this was the first review of the day and the streak grew;
   *   goalReached — true only on the call that crosses the goal (for a one-time celebration).
   */
  function record(state, now, { count = 1, tzOffsetMin } = {}) {
    const s = tick(state, now, { tzOffsetMin });
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const today = s.today.day;
    let extended = false;
    if (n > 0 && s.lastDay !== today) {
      s.streak = s.lastDay && daysBetween(s.lastDay, today) === 1 ? s.streak + 1 : 1;
      s.lastDay = today;
      s.best = Math.max(s.best, s.streak);
      if (s.streak % FREEZE_EVERY_DAYS === 0) s.freezes = Math.min(MAX_FREEZES, s.freezes + 1);
      extended = true;
    }
    const before = s.today.done;
    s.today = { day: today, done: before + n };
    return { state: s, extended, goalMet: s.today.done >= s.goal, goalReached: before < s.goal && s.today.done >= s.goal };
  }

  /** What the main screen shows. dueCounts = {due} (e.g. V15.dueCounts). atRisk = streak alive, nothing today. */
  function status(state, now, dueCounts, { tzOffsetMin } = {}) {
    const s = tick(state, now, { tzOffsetMin });
    return {
      streak: s.streak, best: s.best, done: s.today.done, goal: s.goal,
      due: dueCounts && Number.isFinite(dueCounts.due) ? dueCounts.due : 0,
      goalMet: s.today.done >= s.goal, freezes: s.freezes,
      atRisk: s.streak > 0 && s.lastDay !== s.today.day,
    };
  }

  /** Set the daily goal (integer 1..200; anything else is ignored). */
  function setGoal(state, n) {
    const s = sanitize(state);
    if (Number.isInteger(n) && n >= GOAL_MIN && n <= GOAL_MAX) s.goal = n;
    return s;
  }
  /** Grant one freeze (max 2). */
  function addFreeze(state) {
    const s = sanitize(state);
    s.freezes = Math.min(MAX_FREEZES, s.freezes + 1);
    return s;
  }

  return { DEFAULT_GOAL, MAX_FREEZES, START_FREEZES, FREEZE_EVERY_DAYS, dayKey, daysBetween,
           newState, sanitize, tick, record, status, setGoal, addFreeze };
});
