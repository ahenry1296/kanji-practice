/*
 * rank-model.js — reference implementation of the per-kanji rank model (spec: RANK_MODEL.md).
 *
 * Pure functions only: no DOM, no localStorage, no clock. Every function returns a new object
 * and never mutates its arguments. Loads as a browser global (window.RankModel) or a CommonJS module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RankModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Tier names by rank number; rank 0 = not started. */
  const TIERS = ['none', 'bronze', 'silver', 'gold', 'diamond'];
  const RANK = { none: 0, bronze: 1, silver: 2, gold: 3, diamond: 4 };
  /** Stage of the next attempt for each rank: bronze/silver are reading, gold/diamond writing. */
  const STAGE_KIND = { bronze: 'reading', silver: 'reading', gold: 'writing', diamond: 'writing' };
  /** Clear writing failures in a row that demote. */
  const CLEAR_FAILS_TO_DEMOTE = 2;
  /** Lowest rank a writing failure can drop to (writing stays unlocked; RANK_MODEL.md, choice C3). */
  const WRITING_FLOOR = RANK.silver;
  /** Lowest rank a reading miss can drop a studied kanji to (RANK_MODEL.md, spec change 2026-10-22). */
  const READING_FLOOR = RANK.bronze;
  /**
   * A level check raises a kanji at most one tier per this many ms (12 hours; RANK_MODEL.md, Level-check spacing).
   * Drops are never limited, and other paths (lessons, practice, placement) are not limited.
   */
  const CHECK_PROMOTION_GAP_MS = 12 * 60 * 60 * 1000;
  const STATE_VERSION = 1;
  /** localStorage key the app would store the state under (RANK_MODEL.md). */
  const STORAGE_KEY = 'ranks';

  /** A fresh kanji record. */
  function newKanji() {
    return { rank: 0, clearFails: 0, retry: false, undo: null };
  }

  /** An empty state. */
  function newState() {
    return { version: STATE_VERSION, kanji: {} };
  }

  /**
   * Rank as a whole number 0 (none) … 4 (diamond). A stored value that is not a finite number (a string such as
   * "gold", NaN, null) gives 0; a fraction is rounded down; anything outside the range is clamped, so a kanji can
   * never get stuck on a rank that no event can move (nextStage / TIERS[rank] would be undefined).
   * @param {*} value
   * @returns {number}
   */
  function sanitizeRank(value) {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    if (!Number.isFinite(n)) return RANK.none;
    return Math.min(RANK.diamond, Math.max(RANK.none, Math.floor(n)));
  }

  /**
   * A kanji record with every field of a safe type: rank via sanitizeRank, clearFails a whole number from 0 up to
   * CLEAR_FAILS_TO_DEMOTE - 1 (else 0), retry a boolean (only literal true counts), undo a sanitized record or null.
   * @param {*} record stored value (may be missing or of the wrong shape)
   * checkPromotedAt (ms since the epoch of the last level-check promotion) is kept only when it is a finite number
   * >= 0; it is absent otherwise, so records that never had a check promotion keep exactly the four fields.
   * @returns {{rank: number, clearFails: number, retry: boolean, undo: object|null, checkPromotedAt?: number}}
   */
  function sanitizeRecord(record) {
    const r = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
    const fails = r.clearFails;
    const clearFails = Number.isInteger(fails) && fails >= 0 && fails < CLEAR_FAILS_TO_DEMOTE ? fails : 0;
    const undo = r.undo && typeof r.undo === 'object' && !Array.isArray(r.undo)
      ? Object.assign(sanitizeRecord(Object.assign({}, r.undo, { undo: null })), { undo: null })
      : null;
    return withCheckStamp({ rank: sanitizeRank(r.rank), clearFails, retry: r.retry === true, undo }, r.checkPromotedAt);
  }

  /** record with checkPromotedAt set to at when at is a finite number >= 0, else without the field (new object). */
  function withCheckStamp(record, at) {
    const out = Object.assign({}, record);
    delete out.checkPromotedAt;
    if (typeof at === 'number' && Number.isFinite(at) && at >= 0) out.checkPromotedAt = at;
    return out;
  }

  /**
   * True when a level check may raise this record now: it has no check promotion yet (old records, migrated ones),
   * at least CHECK_PROMOTION_GAP_MS have passed since it (exactly 12 hours counts), or the stamp lies in the future
   * (the device clock went back), which must not lock the kanji.
   * @param {object} record sanitized kanji record
   * @param {number} now ms since the epoch
   */
  function canCheckPromote(record, now) {
    const at = record.checkPromotedAt;
    return typeof at !== 'number' || now - at >= CHECK_PROMOTION_GAP_MS || now < at;
  }

  /**
   * True when `state` has the stored shape: an object whose `kanji` is a plain object of records.
   * @param {*} state
   * @returns {boolean}
   */
  function isValidState(state) {
    return Boolean(state) && typeof state === 'object' && !Array.isArray(state)
      && Boolean(state.kanji) && typeof state.kanji === 'object' && !Array.isArray(state.kanji);
  }

  /** Record of one kanji (a fresh one if missing), sanitized so a bad stored value cannot freeze it. */
  function getKanji(state, kanji) {
    const records = isValidState(state) ? state.kanji : {};
    return sanitizeRecord(Object.prototype.hasOwnProperty.call(records, kanji) ? records[kanji] : null);
  }

  /** Tier name of a kanji. */
  function tierOf(state, kanji) {
    return TIERS[getKanji(state, kanji).rank];
  }

  /** Stage the kanji is working towards: 'bronze'…'diamond', or null when diamond is held. */
  function nextStage(record) {
    return record.rank >= RANK.diamond ? null : TIERS[record.rank + 1];
  }

  /** True once reading is passed (silver held), which unlocks writing. */
  function writingUnlocked(record) {
    return record.rank >= RANK.silver;
  }

  /** Drop one tier, never below floor; remembers the previous record so an override can undo it. */
  function demote(record, floor) {
    const rank = Math.max(floor, record.rank - 1);
    return { rank, clearFails: 0, retry: false, undo: rank < record.rank ? Object.assign({}, record, { undo: null }) : null };
  }

  /**
   * Apply one event to one kanji record and return the new record.
   * Events: {type:'pass', stage, checkAt?} | {type:'readingMiss'} | {type:'writingBorderline'}
   *       | {type:'writingClearFail'} | {type:'wrongKanji'} | {type:'override'}.
   * Invalid events (passing a stage that is not the next one, writing before silver) return the record unchanged.
   */
  function applyEvent(record, event) {
    const r = sanitizeRecord(record);
    const next = applyEventRank(r, event);
    // The check stamp survives every event; a pass from a level check ({type:'pass', stage, checkAt}) that raises the
    // rank sets it to checkAt.
    const raisedByCheck = event.type === 'pass' && next.rank > r.rank && event.checkAt != null;
    return withCheckStamp(next, raisedByCheck ? event.checkAt : r.checkPromotedAt);
  }

  /** applyEvent without the check stamp (r sanitized). */
  function applyEventRank(r, event) {
    switch (event.type) {
      case 'pass':
        if (!event.stage || event.stage !== nextStage(r)) return r;
        if (STAGE_KIND[event.stage] === 'writing' && !writingUnlocked(r)) return r;
        return { rank: r.rank + 1, clearFails: 0, retry: false, undo: null };
      case 'readingMiss':
        return demote(r, Math.min(r.rank, READING_FLOOR));   // a studied kanji keeps bronze; none stays none
      case 'writingBorderline':
        if (!writingUnlocked(r)) return r;
        return Object.assign({}, r, { retry: true, undo: null });
      case 'writingClearFail':
      case 'wrongKanji': {
        if (!writingUnlocked(r)) return r;
        const clearFails = r.clearFails + 1;
        if (clearFails >= CLEAR_FAILS_TO_DEMOTE) return demote(r, WRITING_FLOOR);
        return Object.assign({}, r, { clearFails, retry: false, undo: null });
      }
      case 'override':
        if (r.undo) return Object.assign({}, r.undo, { clearFails: 0, retry: false, undo: null });
        return Object.assign({}, r, { clearFails: 0, retry: false, undo: null });
      default:
        return r;
    }
  }

  /** Apply an event to a kanji inside the whole state. */
  function applyToState(state, kanji, event) {
    const next = applyEvent(getKanji(state, kanji), event);
    return { version: STATE_VERSION, kanji: Object.assign({}, state.kanji, { [kanji]: next }) };
  }

  /** Parse a stored app record; corrupt or non-object → null (as the app's recGet). */
  function parseRecord(text) {
    try {
      const r = JSON.parse(text);
      return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Rank from an old word record, exactly as the old app tints its chip (RANK_MODEL.md, Migration). The app's
   *   function tier(w){const n=Number((recGet('w:'+w)||{}).done)||0;return n?CONFIG.MASTERY[Math.min(n,4)-1]:''}
   * gives MASTERY[min(n, 4) - 1] for n = Number(done): done 1, 2, 3, 4+ → bronze, silver, gold, diamond. Any n that
   * does not index MASTERY (0, NaN, negative, fractional such as 2.5) shows no tint → 0. A record without done
   * (old format, only lastPracticed) shows no tint → 0.
   */
  function rankFromRecord(record) {
    const n = Number((record || {}).done) || 0;
    if (!n) return 0;
    const index = Math.min(n, 4) - 1;   // index into MASTERY ['bronze','silver','gold','diamond']
    return Number.isInteger(index) && index >= 0 ? index + 1 : 0;
  }

  /**
   * Build the rank state from the app's current localStorage (a {key: string} map).
   * Only the single-kanji word records rec:w:<k> count: they are what the old app's chip tint reads (tier(w) above).
   * Kanji records rec:<k> are not shown as a tint and are ignored, so every kanji keeps exactly the tint it had.
   * Old keys are left alone (the migration only adds STORAGE_KEY).
   */
  function migrate(storage) {
    const state = newState();
    const chars = new Set();
    for (const key of Object.keys(storage)) {
      const m = /^rec:w:(.+)$/.exec(key);
      if (m && Array.from(m[1]).length === 1 && /\p{Script=Han}/u.test(m[1])) chars.add(m[1]);
    }
    for (const k of Array.from(chars).sort()) {
      const rank = rankFromRecord(parseRecord(storage['rec:w:' + k]));
      if (rank > 0) state.kanji[k] = Object.assign(newKanji(), { rank });
    }
    return state;
  }

  return {
    TIERS, RANK, STAGE_KIND, CLEAR_FAILS_TO_DEMOTE, WRITING_FLOOR, READING_FLOOR, CHECK_PROMOTION_GAP_MS, STATE_VERSION,
    STORAGE_KEY, newKanji, canCheckPromote, newState, sanitizeRank, sanitizeRecord, isValidState, getKanji, tierOf, nextStage, writingUnlocked,
    applyEvent, applyToState, parseRecord, rankFromRecord, migrate,
  };
});
