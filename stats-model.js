/*
 * stats-model.js — v16 R12 progress statistics. Pure: no DOM, no storage writes (the glue V15.stats only reads).
 * Exposes window.StatsModel; also a CommonJS module for tests.
 *
 * compute(input, now, opts) → {
 *   forecast:  30 local days [{day:'YYYY-MM-DD', due, kanji, word, context}], overdue counted in day 0 (today);
 *   retention: {target, last7:{reviews, recalled, actual}, last30:{…}, source, note}
 *              actual = recalled / reviews over graded REVIEWS (cards that were already in review phase), from the
 *              small per-day review log `v16:stats-log` (glue in v15-integration gradeKey; capped at 60 days).
 *              Nothing older exists: before R12 the app stored no review history (only each card's current state
 *              and one undo snapshot), so `actual` is null until reviews are logged, never an estimate;
 *   streak:    {current, best, lastDay, freezes, atRisk, activeDays:[day…]} — habit stores no per-day history;
 *              activeDays = days in the review log with at least one graded review (≤ 60 days back);
 *   levels:    {N5:{total, seen, learning, mature, unseen}, …} from the catalog (mature = stability ≥ 21 d);
 *   weak:      top weak components (diagnosis), as V15.weakComponents gives them, capped at opts.weakLimit (5);
 *   timePerDay: R13 active study time, last 30 Tokyo days [{day, seconds}] (oldest first) from input.timeLog
 *              (`v16:study-time`, session-timer.js); null with timeNote when nothing has been recorded yet.
 * }
 *
 * input = {cards: {key: card}, recs: {key: rec}, log: {days:{day:{n, ok}}}|null, habit: status|null,
 *          habitState: sanitized habit state|null, weak: [...], target: 0.8–0.95, catalog: {kanji:{k:{level}}}|null}
 * Day boundaries: tzOffsetMin = minutes east of UTC (Asia/Tokyo 540), default the runtime zone (like HabitModel).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StatsModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 864e5;
  const FORECAST_DAYS = 30;
  const MATURE_DAYS = 21;
  const LOG_KEY = 'v16:stats-log';   // exported/imported with progress (v16: prefix)
  const LOG_MAX_DAYS = 60;
  const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
  const TIME_NOTE = 'No study time recorded yet (active time is counted from R13 on); timePerDay is null.';
  const TIME_SOURCE_NOTE = 'Active time only: input-to-input gaps, paused after 60 s idle or when hidden, gap ≤ 2 min.';
  const NO_LOG_NOTE = 'No review history before R12: only current card states are stored. Actual retention starts ' +
    'counting from the first graded review after this update.';

  const runtimeOffset = (now) => -new Date(now).getTimezoneOffset();
  /** 'YYYY-MM-DD' of instant t in zone tz (minutes east of UTC). */
  const dayKey = (t, tz) => new Date(t + tz * 60e3).toISOString().slice(0, 10);
  /** Local midnight (ms, UTC instant) of the day containing t. */
  const startOfDay = (t, tz) => Date.parse(dayKey(t, tz) + 'T00:00:00Z') - tz * 60e3;
  const kindOf = (key) => (key.startsWith('ctx:') ? 'context' : key.startsWith('w:') ? 'word' : 'kanji');
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

  /**
   * Due time per key: the FSRS card when it has one, else the record's nextReview (words / unmigrated records).
   * New cards and records never studied are not due. Returns [[key, dueMs]].
   */
  function dueList(cards, recs) {
    const out = [];
    for (const key in cards) {
      const c = cards[key];
      if (!c || c.phase === 'new') continue;
      const d = num(c.due);
      if (Number.isFinite(d)) out.push([key, d]);
    }
    for (const key in recs) {
      if (cards[key]) continue;
      const d = Date.parse(recs[key] && recs[key].nextReview);
      if (Number.isFinite(d)) out.push([key, d]);
    }
    return out;
  }

  /** 30 local days of due reviews; anything due before tomorrow (incl. overdue) lands on today. */
  function forecast(cards, recs, now, tz, days = FORECAST_DAYS) {
    const start = startOfDay(now, tz);
    const rows = [];
    for (let i = 0; i < days; i++) rows.push({ day: dayKey(start + i * DAY_MS + 12 * 3600e3, tz), due: 0, kanji: 0, word: 0, context: 0 });
    for (const [key, d] of dueList(cards, recs)) {
      // whole local days after today's midnight; DST-safe enough for ±1 h (index by day key would be exact)
      const i = d < start + DAY_MS ? 0 : Math.floor((d - start) / DAY_MS);
      if (i >= days) continue;
      rows[i].due++; rows[i][kindOf(key)]++;
    }
    return rows;
  }

  /** {reviews, recalled, actual} over the last `n` local days (today included) of the log. */
  function window_(log, now, tz, n) {
    let reviews = 0, recalled = 0;
    const days = log && log.days && typeof log.days === 'object' ? log.days : {};
    const from = dayKey(startOfDay(now, tz) - (n - 1) * DAY_MS + 12 * 3600e3, tz);
    const to = dayKey(now, tz);
    for (const d in days) {
      if (d < from || d > to) continue;
      const e = days[d] || {};
      const a = Math.max(0, Math.floor(num(e.n)) || 0), b = Math.max(0, Math.floor(num(e.ok)) || 0);
      reviews += a; recalled += Math.min(a, b);
    }
    return { reviews, recalled, actual: reviews ? Math.round((recalled / reviews) * 1000) / 1000 : null };
  }

  function retention(log, target, now, tz) {
    const hasLog = !!(log && log.days && Object.keys(log.days).length);
    return {
      target, last7: window_(log, now, tz, 7), last30: window_(log, now, tz, 30),
      source: hasLog ? LOG_KEY : null,
      note: hasLog ? 'actual = recalled / graded reviews (again = not recalled), logged since R12' : NO_LOG_NOTE,
    };
  }

  function streak(habit, habitState, log) {
    const days = log && log.days ? Object.keys(log.days).filter((d) => num(log.days[d] && log.days[d].n) > 0).sort() : [];
    const h = habit || {};
    return { current: h.streak || 0, best: h.best || 0, lastDay: habitState ? habitState.lastDay : null,
             freezes: h.freezes || 0, atRisk: !!h.atRisk, activeDays: days,
             note: 'Habit keeps only current/best streak; activeDays come from the review log (≤ 60 days).' };
  }

  /** Per JLPT level: total (catalog), seen = learning + mature, unseen = total − seen. */
  function levels(cards, recs, catalog) {
    if (!catalog || !catalog.kanji) return null;
    const out = {};
    for (const L of LEVELS) out[L] = { total: 0, seen: 0, learning: 0, mature: 0, unseen: 0 };
    for (const k in catalog.kanji) {
      const row = out[catalog.kanji[k] && catalog.kanji[k].level];
      if (!row) continue;
      row.total++;
      const c = cards[k];
      if (c && c.phase !== 'new') {
        if (c.phase === 'review' && num(c.stability) >= MATURE_DAYS) row.mature++; else row.learning++;
      } else if (recs[k] && (recs[k].lastPracticed || recs[k].nextReview)) row.learning++; // studied, no card yet
    }
    for (const L of LEVELS) { const r = out[L]; r.seen = r.learning + r.mature; r.unseen = r.total - r.seen; }
    return out;
  }

  const hasDays = (log) => !!(log && log.days && typeof log.days === 'object' && Object.keys(log.days).length);
  /** Last 30 local days of active seconds (0 for days without study), or null when the log is empty. */
  function timePerDay(log, now, tz, days = FORECAST_DAYS) {
    if (!hasDays(log)) return null;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dayKey(now - i * DAY_MS, tz);
      const v = Number(log.days[d]);
      out.push({ day: d, seconds: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0 });
    }
    return out;
  }

  function compute(input, now = Date.now(), opts = {}) {
    const tz = Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : runtimeOffset(now);
    const cards = (input && input.cards) || {};
    const recs = (input && input.recs) || {};
    const t = Number(input && input.target);
    const ret = retention(input.log, Number.isFinite(t) ? t : 0.9, now, tz);
    // B5 polish: the "no review history before R12" note only makes sense for a learner who practised before the
    // log existed (a rec last practised before today). A brand-new learner gets no note. retention() is unchanged.
    const practisedBefore = Object.values(recs).some((r) => r && Date.parse(r.lastPracticed) < startOfDay(now, tz));
    if (!ret.source && !practisedBefore) ret.note = null;
    return {
      forecast: forecast(cards, recs, now, tz, opts.days || FORECAST_DAYS),
      retention: ret,
      streak: streak(input.habit, input.habitState, input.log),
      levels: levels(cards, recs, input.catalog),
      levelsNote: input.catalog ? null : 'Catalog not loaded yet (practice-catalog.js); levels is null.',
      weak: (input.weak || []).slice(0, opts.weakLimit || 5),
      timePerDay: timePerDay(input.timeLog, now, opts.timeTzOffsetMin ?? 540),
      timeNote: hasDays(input.timeLog) ? TIME_SOURCE_NOTE : TIME_NOTE,
    };
  }

  /**
   * Log update for one grade (used by the glue; returns a NEW log, the caller saves it). Only reviews of cards
   * already in review phase count. ok = grade other than 'again'. Keeps the newest LOG_MAX_DAYS days.
   */
  function logGrade(log, grade, now, tz, delta = 1) {
    const days = Object.assign({}, log && log.days && typeof log.days === 'object' ? log.days : {});
    const d = dayKey(now, Number.isFinite(tz) ? tz : runtimeOffset(now));
    const e = Object.assign({ n: 0, ok: 0 }, days[d]);
    e.n = Math.max(0, e.n + delta);
    if (grade !== 'again') e.ok = Math.max(0, e.ok + delta);
    days[d] = e;
    const keys = Object.keys(days).sort();
    while (keys.length > LOG_MAX_DAYS) delete days[keys.shift()];
    return { version: 1, days };
  }

  return { FORECAST_DAYS, MATURE_DAYS, LOG_KEY, LOG_MAX_DAYS, LEVELS, TIME_NOTE, NO_LOG_NOTE,
           dayKey, startOfDay, forecast, timePerDay, TIME_SOURCE_NOTE, retention, levels, compute, logGrade };
});
