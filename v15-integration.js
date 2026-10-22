/*
 * v15-integration.js — glue between the kanji-app practice flow and the v15 models (spec: V15_INTEGRATION.md).
 * Load last (see the load order in V15_INTEGRATION.md). Exposes window.V15; also a CommonJS module for tests.
 * Every handler takes the storage object (window.localStorage in the app), loads the rank state, applies one
 * rank-model event and saves it, so the app never handles rank state itself.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const g = isNode ? {
    RankModel: require('./rank-model.js'),
    PlacementModel: require('./placement-model.js'),
    UnitTestModel: require('./unit-test-model.js'),
    LevelCheckModel: require('./level-check-model.js'),
    PracticeModel: require('./practice-model.js'),
    ReadingAnswer: require('./reading-answer.js'),
  } : root;
  const api = factory(g, root);
  if (isNode) module.exports = api;
  else root.V15 = api;
})(typeof self !== 'undefined' ? self : this, function (g, root) {
  'use strict';

  const RM = g.RankModel;
  /** Key holding the migration marker: the source format it was migrated from and when. */
  const MIGRATION_KEY = 'ranks:migrated';
  /** Hook-layer reject reasons treated as borderline (retry, no demotion); every other reject is a clear failure. */
  const BORDERLINE_REASONS = ['hook-partial', 'hook-added', 'hook-dropped'];
  /** Near-miss retries allowed per box; one more borderline in the same box is a clear failure. */
  const MAX_BORDERLINE_PER_BOX = 1;

  /** Key holding a copy of the last corrupt `ranks` value, so a bad write never destroys the only copy. */
  const CORRUPT_BACKUP_KEY = 'ranks:corrupt';

  /**
   * The stored rank state, or null when it is missing or corrupt (invalid JSON, or not {kanji: {...}}).
   * @param {Storage} storage
   * @returns {object|null}
   */
  function readStoredRanks(storage) {
    const state = RM.parseRecord(storage.getItem(RM.STORAGE_KEY));
    return RM.isValidState(state) ? state : null;
  }

  /**
   * Build the rank state from the old v14c records (rec:w:<k>, read as the old tier() did), save it and write the
   * migration marker. `from` names why: 'v14-records' on first load, 'corrupt-ranks' after a corrupt value.
   */
  function migrateFromRecords(storage, from, nowIso) {
    const state = RM.migrate(snapshot(storage));
    saveRanks(storage, state);
    storage.setItem(MIGRATION_KEY, JSON.stringify({ from, at: nowIso || null, kanji: Object.keys(state.kanji).length }));
    return state;
  }

  /**
   * A corrupt `ranks` value: copy it to CORRUPT_BACKUP_KEY, then rebuild the state from the old records so every
   * chip keeps the tint the old app gave it (instead of silently starting from an empty state).
   */
  function recoverCorruptRanks(storage, nowIso) {
    storage.setItem(CORRUPT_BACKUP_KEY, storage.getItem(RM.STORAGE_KEY));
    return migrateFromRecords(storage, 'corrupt-ranks', nowIso);
  }

  /**
   * Rank state from storage. Missing gives an empty state (migrateOnce builds the first one); a corrupt value is
   * backed up and re-migrated (recoverCorruptRanks). A storage that refuses the write still gets the rebuilt state.
   */
  function loadRanks(storage) {
    const state = readStoredRanks(storage);
    if (state) return state;
    if (storage.getItem(RM.STORAGE_KEY) === null) return RM.newState();
    try {
      return recoverCorruptRanks(storage);
    } catch (_) {
      return RM.migrate(snapshot(storage));
    }
  }

  /** Persist the rank state. */
  function saveRanks(storage, state) {
    storage.setItem(RM.STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  /** Snapshot of every key in a Storage-like object as {key: string}. */
  function snapshot(storage) {
    const out = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      out[key] = storage.getItem(key);
    }
    return out;
  }

  /**
   * First-load migration: if no rank state exists, build it from the v14 records (rank-model migrate) and write
   * `ranks` plus the marker. A corrupt `ranks` is backed up under CORRUPT_BACKUP_KEY and migrated again. Never
   * deletes old keys; a second call on a valid state is a no-op (idempotent). Returns {migrated, recovered?, state}.
   */
  function migrateOnce(storage, nowIso) {
    const raw = storage.getItem(RM.STORAGE_KEY);
    if (raw === null) return { migrated: true, state: migrateFromRecords(storage, 'v14-records', nowIso) };
    const stored = readStoredRanks(storage);
    if (stored) return { migrated: false, state: stored };
    return { migrated: true, recovered: true, state: recoverCorruptRanks(storage, nowIso) };
  }

  /** Apply one rank-model event to one kanji and persist; returns {from, to, state}. */
  function applyEvent(storage, kanji, event) {
    const state = loadRanks(storage);
    const from = RM.getKanji(state, kanji).rank;
    const next = saveRanks(storage, RM.applyToState(state, kanji, event));
    return { from, to: RM.getKanji(next, kanji).rank, state: next };
  }

  /**
   * 'borderline' or 'clear' for a rejected checkStroke verdict. The hook layer rejects with msg 'Shape' and puts
   * the hook reason in verdict.shape ('hook-added', 'hook-dropped', 'hook-partial'); other rejects have no shape.
   */
  function classifyReject(verdict) {
    return BORDERLINE_REASONS.includes(verdict && verdict.shape) ? 'borderline' : 'clear';
  }

  /** Reading-stage answer (v15 reading UI): correct passes the next reading stage, a miss is a readingMiss. */
  function onReadingResult(storage, kanji, correct) {
    const record = RM.getKanji(loadRanks(storage), kanji);
    if (!correct) return applyEvent(storage, kanji, { type: 'readingMiss' });
    const stage = RM.nextStage(record);
    if (RM.STAGE_KIND[stage] !== 'reading') return { from: record.rank, to: record.rank, state: loadRanks(storage) };
    return applyEvent(storage, kanji, { type: 'pass', stage });
  }

  /**
   * Verdict of one finished memory (free) writing box. rejects = the rejected checkStroke verdicts of that box,
   * wrongKanji = the look-alike extension fired. One near-miss (borderline) retry is allowed per box, and a
   * successful retry counts as clean; a second borderline in the same box counts as a clear failure.
   * Returns {clean, event}: event is 'wrongKanji', 'writingClearFail' or null.
   */
  function boxVerdict({ rejects = [], wrongKanji = false } = {}) {
    if (wrongKanji) return { clean: false, event: 'wrongKanji' };
    const clear = rejects.filter((v) => classifyReject(v) === 'clear').length;
    const borderline = rejects.length - clear;
    if (clear > 0 || borderline > MAX_BORDERLINE_PER_BOX) return { clean: false, event: 'writingClearFail' };
    return { clean: true, event: null };
  }

  /** Apply a finished memory box to the rank state (boxVerdict); a clean box applies nothing. */
  function onWritingBox(storage, kanji, box = {}) {
    const verdict = boxVerdict(box);
    if (!verdict.event) {
      const rank = RM.getKanji(loadRanks(storage), kanji).rank;
      return { from: rank, to: rank, event: null, clean: true, state: loadRanks(storage) };
    }
    return Object.assign(applyEvent(storage, kanji, { type: verdict.event }), { event: verdict.event, clean: false });
  }

  /**
   * A kanji's writing stages all finished in a lesson (celebrate): clean → pass the next writing stage.
   * clean = every memory box of the kanji was clean by boxVerdict (a successful single retry is clean).
   */
  function onKanjiComplete(storage, kanji, { clean }) {
    const record = RM.getKanji(loadRanks(storage), kanji);
    const stage = RM.nextStage(record);
    if (!clean || RM.STAGE_KIND[stage] !== 'writing') return { from: record.rank, to: record.rank, state: loadRanks(storage) };
    return applyEvent(storage, kanji, { type: 'pass', stage });
  }

  /** "I wrote it correctly" button. */
  function onOverride(storage, kanji) {
    return applyEvent(storage, kanji, { type: 'override' });
  }

  /** Apply a finished placement result (never lowers ranks). */
  function applyPlacement(storage, result) {
    return saveRanks(storage, g.PlacementModel.applyResult(loadRanks(storage), result));
  }

  /** Apply level-check results [{kanji, outcome}]; returns {state, changes}. */
  function applyLevelCheck(storage, results) {
    const out = g.LevelCheckModel.applyResults(loadRanks(storage), results);
    saveRanks(storage, out.state);
    return out;
  }

  /** Practice queue for filters (practice-model filterKanji) or weak kanji among them. */
  function practiceQueue(storage, catalog, sets, { filters = {}, weak = false, seed = 1, maxItems, size, readingWords = null } = {}) {
    const state = loadRanks(storage);
    let list = g.PracticeModel.filterKanji(catalog, sets, filters);
    if (weak) list = g.PracticeModel.selectWeak(state, list, size ? { size } : {});
    const options = Object.assign({ seed, readingWords }, maxItems ? { maxItems } : {});
    return g.PracticeModel.buildQueue(state, list, options);
  }

  /** Tier name for the UI (replaces the word-done tier for kanji chips). */
  function tierOf(storage, kanji) {
    return RM.tierOf(loadRanks(storage), kanji);
  }

  return { MIGRATION_KEY, CORRUPT_BACKUP_KEY, BORDERLINE_REASONS, MAX_BORDERLINE_PER_BOX, boxVerdict, loadRanks, saveRanks, snapshot, migrateOnce, classifyReject,
           onReadingResult, onWritingBox, onKanjiComplete, onOverride, applyPlacement, applyLevelCheck,
           practiceQueue, tierOf };
});
