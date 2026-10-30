/*
 * session-timer.js — v16 R13 active study time. Pure: no DOM, no storage (glue: V15.setupSessionTiming).
 * Exposes window.SessionTimer; also a CommonJS module for tests.
 *
 * Only ACTIVE time counts. Time is credited between two input events (pointer / key / touch / stroke):
 *   - gap ≤ IDLE_MS (60 s): the whole gap is credited, but never more than CAP_MS (2 min) for one gap;
 *   - gap > IDLE_MS: the user went idle → timer paused, the gap credits nothing; the next input restarts it;
 *   - hide (visibility hidden, pagehide, blur): credits up to the hide (same rules), then pauses.
 * With the defaults the 60 s idle limit is always reached before the 2 min cap; the cap is the hard ceiling that
 * still holds if idleMs is raised by config (tested). Credited time is split at Tokyo midnight (tzOffsetMin 540).
 *
 * Log (storage key LOG_KEY, v16: prefix → included in export/import): {version:1, days:{'YYYY-MM-DD': seconds}},
 * newest MAX_DAYS (60) days kept. Pending time is kept in ms; flush() moves whole seconds into the log and keeps
 * the remainder, so nothing is written while idle (no whole second pending → no write).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionTimer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const IDLE_MS = 60e3;
  const CAP_MS = 120e3;
  const MAX_DAYS = 60;
  const TOKYO = 540;
  const LOG_KEY = 'v16:study-time';
  const DAY_MS = 864e5;

  const dayKey = (t, tz) => new Date(t + tz * 60e3).toISOString().slice(0, 10);

  /** New timer. opts: {idleMs, capMs, tzOffsetMin}. pending = {day: ms not yet flushed}. */
  function create(opts = {}) {
    return { idleMs: opts.idleMs || IDLE_MS, capMs: opts.capMs || CAP_MS,
             tz: Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : TOKYO, last: null, pending: {} };
  }

  /** Add the interval [from, from+ms) to pending, split at local midnights. */
  function credit(timer, from, ms) {
    let t = from, left = ms;
    while (left > 0) {
      const nextMidnight = Date.parse(dayKey(t, timer.tz) + 'T00:00:00Z') - timer.tz * 60e3 + DAY_MS;
      const part = Math.min(left, nextMidnight - t);
      const d = dayKey(t, timer.tz);
      timer.pending[d] = (timer.pending[d] || 0) + part;
      t += part; left -= part;
    }
  }

  /** Credit the gap since the last input up to `now` (rules above). Returns ms credited. */
  function closeGap(timer, now) {
    if (timer.last === null || !(now > timer.last)) return 0;
    const gap = now - timer.last;
    if (gap > timer.idleMs) return 0;                  // went idle: paused, nothing credited
    const ms = Math.min(gap, timer.capMs);
    credit(timer, timer.last, ms);
    return ms;
  }

  /** An input event at `now` (only call while the page is visible). */
  function input(timer, now) {
    closeGap(timer, now);
    timer.last = now;
    return timer;
  }

  /** Page hidden / pagehide / blur: credit up to now, then pause until the next input. */
  function pause(timer, now) {
    closeGap(timer, now);
    timer.last = null;
    return timer;
  }

  /** Whole seconds pending (what a flush would write). */
  function pendingSeconds(timer) {
    let s = 0;
    for (const d in timer.pending) s += Math.floor(timer.pending[d] / 1000);
    return s;
  }

  /**
   * Merge pending whole seconds into a log and return {log, changed}. Ms remainders stay pending.
   * changed=false → caller must not write (keeps storage untouched while idle).
   */
  function flush(timer, log) {
    if (!pendingSeconds(timer)) return { log, changed: false };
    const days = Object.assign({}, log && log.days && typeof log.days === 'object' ? log.days : {});
    for (const d in timer.pending) {
      const s = Math.floor(timer.pending[d] / 1000);
      if (!s) continue;
      days[d] = (Number(days[d]) || 0) + s;
      timer.pending[d] -= s * 1000;
      if (!timer.pending[d]) delete timer.pending[d];
    }
    const keys = Object.keys(days).sort();
    while (keys.length > MAX_DAYS) delete days[keys.shift()];
    return { log: { version: 1, days }, changed: true };
  }

  return { IDLE_MS, CAP_MS, MAX_DAYS, TOKYO, LOG_KEY, dayKey, create, input, pause, closeGap, pendingSeconds, flush };
});
