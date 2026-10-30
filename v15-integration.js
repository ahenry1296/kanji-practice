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
    ProgressModel: require('./progress-model.js'),
    SchedulerModel: require('./scheduler-model.js'),
    GatingModel: require('./gating-model.js'),
    HabitModel: require('./habit-model.js'),
    // v16 R5–R8 (Botfive): partial credit, fading scaffolds, contrast drills, leeches
    PartialCredit: require('./partial-credit.js'),
    FadingScaffolds: require('./fading-scaffolds.js'),
    ContrastModel: require('./contrast-model.js'),
    LeechModel: require('./leech-model.js'),
    LoadModel: require('./load-model.js'),     // v16 R1 load budget (port of 03)
    ExportModel: require('./export-model.js'), // v16 R9 export / import
    DiagnosisModel: require('./diagnosis-model.js'), // v16 R10 component-level writing diagnosis
    SentencesModel: require('./sentences-model.js'), // v16 R11 example sentences (data loaded lazily below)
    StatsModel: require('./stats-model.js'),       // v16 R12 progress statistics
    SessionTimer: require('./session-timer.js'),   // v16 R13 active study time
    ComponentModel: require('./component-model.js'), // v16 R14 component families
    DataSafety: require('./data-safety.js'),         // v16 R18 safe writes, persistence, backup mirror
  } : root;
  const api = factory(g, root);
  if (isNode) module.exports = api;
  else root.V15 = api;
})(typeof self !== 'undefined' ? self : this, function (g, root) {
  'use strict';

  const RM = g.RankModel;

  // ---- v16 R18: every app-logic write goes through DataSafety (data-safety.js) when it is loaded ----------------
  // safeSet never throws: a failed write stays in an in-memory retry queue, safeGet reads through that queue, and
  // 'v16:storage-error' {key, reason} tells the UI. Without data-safety.js the old behaviour (plain setItem) stays.
  // ---- v16 R20: models that v16-loader.js loads after first paint (browser only; node requires everything). ----
  /** True when g[name] is there; otherwise starts loading its group (if the loader is present) and returns false. */
  function lazyReady(name, group) {
    if (g[name]) return true;
    if (root && root.V16Lazy) root.V16Lazy.load(group).catch(() => {});
    return false;
  }
  /** Throw a clear error for sync APIs that views call: B4 should mount through V16Views.load(...). */
  function needLazy(name, group) {
    if (!lazyReady(name, group)) throw new Error(name + ' not loaded yet: use V16Views.load(...) or V16Lazy.load(\'' + group + '\') first');
  }

  function safeSet(storage, key, value) {
    if (g.DataSafety) return g.DataSafety.safeSet(storage, key, value);
    storage.setItem(key, value);
    return true;
  }
  function safeGet(storage, key) { return g.DataSafety ? g.DataSafety.safeGet(storage, key) : storage.getItem(key); }
  function safeRemove(storage, key) { if (g.DataSafety) g.DataSafety.safeRemove(storage, key); else storage.removeItem(key); }
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
    const state = RM.parseRecord(safeGet(storage, RM.STORAGE_KEY));
    return RM.isValidState(state) ? state : null;
  }

  /**
   * Build the rank state from the old v14c records (rec:w:<k>, read as the old tier() did), save it and write the
   * migration marker. `from` names why: 'v14-records' on first load, 'corrupt-ranks' after a corrupt value.
   */
  function migrateFromRecords(storage, from, nowIso) {
    const state = RM.migrate(snapshot(storage));
    saveRanks(storage, state);
    safeSet(storage, MIGRATION_KEY, JSON.stringify({ from, at: nowIso || null, kanji: Object.keys(state.kanji).length }));
    return state;
  }

  /**
   * A corrupt `ranks` value: copy it to CORRUPT_BACKUP_KEY, then rebuild the state from the old records so every
   * chip keeps the tint the old app gave it (instead of silently starting from an empty state).
   */
  function recoverCorruptRanks(storage, nowIso) {
    safeSet(storage, CORRUPT_BACKUP_KEY, safeGet(storage, RM.STORAGE_KEY));
    return migrateFromRecords(storage, 'corrupt-ranks', nowIso);
  }

  /**
   * Rank state from storage. Missing gives an empty state (migrateOnce builds the first one); a corrupt value is
   * backed up and re-migrated (recoverCorruptRanks). A storage that refuses the write still gets the rebuilt state.
   */
  function loadRanks(storage) {
    const state = readStoredRanks(storage);
    if (state) return state;
    if (safeGet(storage, RM.STORAGE_KEY) === null) return RM.newState();
    try {
      return recoverCorruptRanks(storage);
    } catch (_) {
      return RM.migrate(snapshot(storage));
    }
  }

  /** Persist the rank state. */
  function saveRanks(storage, state) {
    safeSet(storage, RM.STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  /** Snapshot of every key in a Storage-like object as {key: string}. */
  function snapshot(storage) {
    const out = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      out[key] = safeGet(storage, key);
    }
    return out;
  }

  /**
   * First-load migration: if no rank state exists, build it from the v14 records (rank-model migrate) and write
   * `ranks` plus the marker. A corrupt `ranks` is backed up under CORRUPT_BACKUP_KEY and migrated again. Never
   * deletes old keys; a second call on a valid state is a no-op (idempotent). Returns {migrated, recovered?, state}.
   */
  function migrateOnce(storage, nowIso) {
    const raw = safeGet(storage, RM.STORAGE_KEY);
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

  /**
   * Reading-stage answer (v15 reading UI): correct passes the next reading stage, a miss is a readingMiss.
   * v16 R5/R7 (optional opts, older callers unchanged):
   *   opts.answer + opts.accepted (typed kana + accepted readings): a wrong answer is first graded with
   *     PartialCredit.grade; verdict 'near' → FSRS 'hard' (no lapse, no rank drop) and the result carries
   *     `partial` (segments/reasons for Botfour's "Almost: long vowel" line).
   *   opts.pairs / opts.kanjiMap: a real miss is checked for a look-alike reading mix-up (recordConfusion,
   *     weight 0.5; the miss itself is the only 'again'). The result carries `confusion` when found.
   */
  function onReadingResult(storage, kanji, correct, opts = {}) {
    const record = RM.getKanji(loadRanks(storage), kanji);
    if (!correct && g.PartialCredit && opts.answer && opts.accepted) {
      const partial = g.PartialCredit.grade(opts.answer, opts.accepted);
      if (partial.verdict === 'near') {
        if (g.SchedulerModel && isStudied(storage, kanji, opts.now)) onReviewDone(storage, kanji, 'hard', opts.now);
        return { from: record.rank, to: record.rank, state: loadRanks(storage), partial };
      }
    }
    if (!correct) {
      if (g.SchedulerModel) onLapse(storage, kanji);   // v16 #1: a reading miss is an FSRS lapse
      const confusion = opts.answer && opts.pairs
        ? recordConfusion(storage, { target: kanji, answerReading: opts.answer }, opts) : null;
      return Object.assign(applyEvent(storage, kanji, { type: 'readingMiss' }), confusion ? { confusion } : {});
    }
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

  /**
   * Apply a finished memory box to the rank state (boxVerdict); a clean box applies nothing.
   * v16 R7: box.answerKanji (the look-alike the checker recognised) + opts.pairs → recordConfusion (weight 1,
   * the wrongKanji lapse is the 'again'); the result then carries `confusion`.
   */
  function onWritingBox(storage, kanji, box = {}, opts = {}) {
    const verdict = boxVerdict(box);
    if (!verdict.event) {
      const rank = RM.getKanji(loadRanks(storage), kanji).rank;
      return { from: rank, to: rank, event: null, clean: true, state: loadRanks(storage) };
    }
    if (g.SchedulerModel) onLapse(storage, kanji);     // v16 #1: clear fail / wrong kanji = FSRS 'again'
    const confusion = box.answerKanji && opts.pairs
      ? recordConfusion(storage, { target: kanji, answerKanji: box.answerKanji }, opts) : null;
    return Object.assign(applyEvent(storage, kanji, { type: verdict.event }), { event: verdict.event, clean: false },
      confusion ? { confusion } : {});
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
    if (g.SchedulerModel) undoLastGrade(storage, kanji); // v16 #1: the undone drop must not stay a lapse
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

  /**
   * The old app's progress record `rec:<k>` exactly as index.html recGet reads it: a corrupt or non-object value
   * gives null (treated as new).
   */
  function readRec(storage, kanji) {
    try {
      const r = JSON.parse(safeGet(storage, 'rec:' + kanji));
      return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
    } catch (_) {
      return null;
    }
  }

  /** Rank state per storage, re-loaded only when the stored `ranks` string changes (progressOf runs per kanji). */
  const rankCache = new WeakMap();
  function cachedRanks(storage) {
    const raw = safeGet(storage, RM.STORAGE_KEY);
    const hit = rankCache.get(storage);
    if (hit && hit.raw === raw) return hit.state;
    const state = loadRanks(storage);
    rankCache.set(storage, { raw, state });
    return state;
  }

  /**
   * v16 #4: the one progress view of a kanji (V16_API.md): {rank, tier, fade, known, due}.
   * @param {Storage} storage
   * @param {string} kanji
   * @param {number} [now] ms since the epoch
   */
  function progressOf(storage, kanji, now = Date.now()) {
    return g.ProgressModel.view(RM.getKanji(cachedRanks(storage), kanji), readRec(storage, kanji), now);
  }

  /**
   * v16 #1 + #2: finish a practice and store its next review. The FSRS card (learning steps 10 min / 4 h / 1 day,
   * then FSRS) sets the due date; the #2 record rule keeps the counters and is the fallback if FSRS fails.
   * Replaces index.html recFinish; fires `v16:due-changed` on `root` with dueCounts when it can.
   * @param {Storage} storage
   * @param {string} key '<kanji>' or 'w:<word>'
   * @param {number} clean @param {number} hints
   * @param {{now?: number, scheduleDays?: number[], stepsMs?: number[]|false, fsrs?: boolean}} [opts] fsrs false =
   *   record rule only (no FSRS)
   * @returns {object} the stored record (plus dueAt: ms until due)
   */
  function recFinish(storage, key, clean, hints, opts = {}) {
    const now = opts.now === undefined ? Date.now() : opts.now;
    const SM = g.SchedulerModel;
    // Counters (done / streak / hints) and the fallback due date: the #2 record rule (learning steps, then ladder).
    const r = SM.finish(readRec(storage, key), clean, hints, now, opts);
    // v16 #1: the FSRS card decides the due date (its own learning steps first, then FSRS). Clean = 'good',
    // hints = 'hard'. rec: keeps nextReview / intervalDays / learnStep in sync with the card, so isDue, dueList
    // and the review queue work unchanged. If FSRS throws, the record rule above stays (ladder fallback).
    if (opts.fsrs !== false) {
      try {
        const stepsMs = opts.stepsMs === false ? [] : opts.stepsMs;
        const card = onReviewDone(storage, key, hints > 0 ? 'hard' : 'good', now, stepsMs === undefined ? undefined : { stepsMs });
        r.intervalDays = SM.intervalDays(card);
        r.nextReview = new Date(card.due).toISOString();
        if (card.phase === 'learning') r.learnStep = card.step;
        else delete r.learnStep;
      } catch (e) {
        if (root && root.console) root.console.warn('FSRS failed, using the ladder', e);
      }
    }
    r.dueAt = Date.parse(r.nextReview) - now;   // ms until due, for the "Next review: in 10 min" seal
    safeSet(storage, 'rec:' + key, JSON.stringify(r));
    if (root && typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('v16:due-changed', { detail: dueCounts(storage, now) }));
    }
    return r;
  }

  // ---- v16 #1: FSRS scheduler (scheduler-model.js). Storage: `sched` = {version:1, cards:{<key>: card}} ----
  /** Scheduler state key, one-time migration marker, and backup of a corrupt `sched` value. */
  const SCHED_KEY = 'sched';
  const SCHED_MIGRATED_KEY = 'sched:migrated';
  const SCHED_BACKUP_KEY = 'sched:backup';

  /** Prefix of the byte-for-byte copies of unreadable `rec:` values (see backupCorruptRecs). Not progress. */
  const REC_CORRUPT_PREFIX = 'rec:corrupt:';

  /** True for a live progress record key `rec:<k>`; false for recovery copies under REC_CORRUPT_PREFIX. */
  function isRecKey(name) {
    return !!name && name.startsWith('rec:') && !name.startsWith(REC_CORRUPT_PREFIX);
  }

  /** Every `rec:` record in storage, keyed without the prefix ("休", "w:休む"). */
  function readAllRecs(storage) {
    const recs = {};
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (isRecKey(name)) {
        const r = readRec(storage, name.slice(4));
        if (r) recs[name.slice(4)] = r;
      }
    }
    return recs;
  }

  /** Stored scheduler state, or null when missing/corrupt. */
  function readSched(storage) {
    try {
      const s = JSON.parse(safeGet(storage, SCHED_KEY));
      return s && typeof s === 'object' && s.cards && typeof s.cards === 'object' && !Array.isArray(s.cards) ? s : null;
    } catch (_) { return null; }
  }

  /**
   * A stored `rec:` value the app cannot use as a record: not JSON, not a plain object, or an object whose
   * nextReview / lastPracticed is set but is not a date. ('' and null-valued fields count as "not set".)
   */
  function isCorruptRecRaw(raw) {
    let r;
    try { r = JSON.parse(raw); } catch (_) { return true; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return true;
    const badDate = (v) => v !== undefined && v !== null && v !== '' && !Number.isFinite(Date.parse(v));
    return badDate(r.nextReview) || badDate(r.lastPracticed);
  }

  /**
   * Fix 1 (V16-RC): copy each corrupt `rec:<k>` value byte-for-byte to `rec:corrupt:<k>` before anything can
   * overwrite it (the next study of <k> replaces a corrupt record). The original stays in place. An existing
   * backup is never overwritten, so a later boot never re-copies. Returns the number of new backups.
   */
  function backupCorruptRecs(storage) {
    const todo = [];
    for (let i = 0; i < storage.length; i += 1) {
      const name = storage.key(i);
      if (!isRecKey(name)) continue;
      const raw = safeGet(storage, name);
      const copy = REC_CORRUPT_PREFIX + name.slice(4);
      if (safeGet(storage, copy) === null && isCorruptRecRaw(raw)) todo.push([copy, raw]);
    }
    for (const [copy, raw] of todo) safeSet(storage, copy, raw);   // after the scan: setItem may reorder keys
    return todo.length;
  }

  /**
   * Fix 2 (V16-RC): after v16 → v15e → v16, records studied on v15e are newer than their FSRS cards (the one-time
   * migration already ran). On every boot, a readable record whose study is newer than its card's last review is
   * re-seeded from the record: due = the record's nextReview exactly (cardFromRecord). "Newer" means
   *   lastPracticed > card.last (+1 s, v16 itself writes both at the same instant), or, for a record with no
   *   lastPracticed, nextReview later than both card.last and card.due;
   * a studied record with no card at all is seeded too. The card keeps its difficulty and lapse count, and never
   * loses reps. Ranks are not touched (v15e keeps `ranks` itself), so no rank can drop. Idempotent: after a
   * re-seed card.last equals the record's time, so the next boot finds nothing newer. Returns the count.
   */
  function reseedFromNewerRecs(storage, now) {
    const SM = g.SchedulerModel;
    const state = readSched(storage);
    if (!state) return 0;
    let n = 0;
    for (const [key, rec] of Object.entries(readAllRecs(storage))) {
      const fresh = SM.cardFromRecord(rec, now);
      if (!fresh) continue;                                   // never studied
      const cur = state.cards[key];
      const curLast = cur && Number.isFinite(Number(cur.last)) ? Number(cur.last) : null;
      const recLast = Date.parse(rec.lastPracticed);
      const recDue = Date.parse(rec.nextReview);
      let newer;
      if (!cur || cur.phase === 'new' || curLast === null) newer = true;
      else if (Number.isFinite(recLast)) newer = recLast > curLast + 1000;
      else newer = Number.isFinite(recDue) && recDue > curLast && recDue > Number(cur.due);
      if (!newer) continue;
      if (cur && cur.phase !== 'new') {
        fresh.difficulty = Number.isFinite(Number(cur.difficulty)) ? Number(cur.difficulty) : fresh.difficulty;
        fresh.lapses = Math.max(0, Number(cur.lapses) || 0);
        fresh.reps = Math.max(fresh.reps, Number(cur.reps) || 0);
      }
      if (!Number.isFinite(recLast)) fresh.last = Math.min(fresh.last, fresh.due); // keep last <= due
      state.cards[key] = fresh;
      n += 1;
    }
    if (n) safeSet(storage, SCHED_KEY, JSON.stringify(state));
    return n;
  }

  /**
   * One-time migration of the old `rec:` ladder into FSRS cards. Keeps every due date exactly, never deletes or
   * changes `rec:` keys or `ranks`. A corrupt `sched` is copied to `sched:backup` and rebuilt. Idempotent:
   * once `sched:migrated` is set and `sched` is valid, it does nothing. Returns {migrated, recovered?, cards}.
   */
  function migrateScheduler(storage, now = Date.now()) {
    const backedUp = backupCorruptRecs(storage);               // fix 1: every boot, cheap, never overwrites
    const existing = readSched(storage);
    if (existing && safeGet(storage, SCHED_MIGRATED_KEY)) {
      const reseeded = reseedFromNewerRecs(storage, now);      // fix 2: re-upgrade after a v15e downgrade
      return { migrated: false, cards: Object.keys(readSched(storage).cards).length, backedUp, reseeded };
    }
    const raw = safeGet(storage, SCHED_KEY);
    const recovered = raw !== null && !existing;
    if (recovered) safeSet(storage, SCHED_BACKUP_KEY, raw);
    const state = g.SchedulerModel.migrate(readAllRecs(storage), null, now);
    if (existing) Object.assign(state.cards, existing.cards); // valid cards written before the marker win
    safeSet(storage, SCHED_KEY, JSON.stringify(state));
    safeSet(storage, SCHED_MIGRATED_KEY, JSON.stringify({ at: new Date(now).toISOString(), cards: Object.keys(state.cards).length }));
    const out = { migrated: true, cards: Object.keys(state.cards).length, backedUp, reseeded: 0 };
    if (recovered) out.recovered = true;
    return out;
  }

  /** The FSRS card for a key (kanji, component, or "w:<word>"), or null if it has none yet. */
  function cardOf(storage, key) {
    const s = readSched(storage);
    return s && s.cards[key] ? g.SchedulerModel.sanitizeCard(s.cards[key]) : null;
  }

  /**
   * Apply one FSRS grade to a key and persist. Before grading, the previous card (or null = "had no card") is
   * saved in state.undo[key], one level deep, so undoLastGrade can put it back (used by "I wrote it correctly").
   * A key with no card yet is first seeded from its old `rec:` record (e.g. written by an older tab).
   */
  function gradeKey(storage, key, grade, now, opts) {
    const SM = g.SchedulerModel;
    const state = readSched(storage) || { version: 1, cards: {} };
    const prev = state.cards[key] || null;
    const settings = schedSettings(storage);
    let card = SM.next(prev || SM.cardFromRecord(readRec(storage, key), now), grade, now, Object.assign({ retention: settings.retention }, opts));
    if (settings.smoothing) {   // v16 R2: spread reviews onto quieter days (±5%)
      const others = Object.keys(state.cards).filter((k) => k !== key).map((k) => Number(state.cards[k].due)).filter(Number.isFinite);
      card = SM.smoothDue(card, others, now);
    }
    state.undo = Object.assign({}, state.undo, { [key]: { card: prev, at: now, grade } });
    state.cards[key] = card;
    safeSet(storage, SCHED_KEY, JSON.stringify(state));
    if (prev && prev.phase === 'review') logReview(storage, grade, now, 1); // v16 R12: retention stats
    trackLeech(storage, key, card, now);              // v16 R8
    return card;
  }

  /**
   * Record one finished review (recFinish below calls this BEFORE writing rec:) and return the new card.
   * grade: 'again' | 'hard' (needed hints) | 'good' (clean) | 'easy'.
   */
  function onReviewDone(storage, key, grade, now = Date.now(), opts) {
    return gradeKey(storage, key, grade, now, opts);
  }

  /**
   * A clear failure / rank drop (writingClearFail, wrongKanji, readingMiss) counts as FSRS 'again'.
   * Only for kanji that were already studied (have a card or a completed rec:); a miss in the very first lesson
   * is not a lapse. Borderline retries never get here (boxVerdict gives no event). Returns the card or null.
   */
  function onLapse(storage, key, now = Date.now(), opts) {
    if (!isStudied(storage, key, now)) return null;
    return gradeKey(storage, key, 'again', now, opts);
  }

  /** Already studied = has an FSRS card or a completed old `rec:` (first-lesson misses are not graded). */
  function isStudied(storage, key, now = Date.now()) {
    const s = readSched(storage);
    return !!(s && s.cards[key]) || !!g.SchedulerModel.cardFromRecord(readRec(storage, key), now);
  }

  /**
   * Undo the last FSRS lapse of a key (restore the snapshot taken before it). Returns true if something was
   * restored. Called by onOverride: a drop undone with "I wrote it correctly" leaves no lapse behind.
   */
  function undoLastGrade(storage, key) {
    const state = readSched(storage);
    const snap = state && state.undo && state.undo[key];
    if (!snap || snap.grade !== 'again') return false;  // only a lapse is undoable; never roll back a pass
    if (snap.card) state.cards[key] = snap.card; else delete state.cards[key];
    delete state.undo[key];
    safeSet(storage, SCHED_KEY, JSON.stringify(state));
    if (snap.card && snap.card.phase === 'review') logReview(storage, snap.grade, snap.at, -1); // R12: un-count it
    return true;
  }

  // ---- v16 R12: stats. Review log `v16:stats-log` = {version, days:{'YYYY-MM-DD': {n, ok}}}, ≤ 60 days. ----
  /** Add (delta 1) or remove (delta −1, undo) one graded review in the day log. Never throws (quota). */
  function logReview(storage, grade, now, delta) {
    if (!g.StatsModel) {
      // R20: StatsModel is deferred. Count this review once it has loaded (same args, so the day is right);
      // promise callbacks run in order, so a later undo (delta −1) still applies after its grade.
      if (root && root.V16Lazy) root.V16Lazy.load('stats').then(() => logReview(storage, grade, now, delta), () => {});
      return;
    }
    try {
      const next = g.StatsModel.logGrade(readJson(storage, g.StatsModel.LOG_KEY), grade, now, undefined, delta);
      safeSet(storage, g.StatsModel.LOG_KEY, JSON.stringify(next));
    } catch (_) { /* stats are best-effort */ }
  }

  /**
   * v16 R12: all progress stats, strictly READ-ONLY on storage (only getItem/key/length). See stats-model.js
   * for the result shape. opts: {now, tzOffsetMin, catalog (default window.PRACTICE_CATALOG), weakLimit}.
   */
  function stats(storage, opts = {}) {
    needLazy('StatsModel', 'stats');   // R20
    const now = opts.now || Date.now();
    const sched = readSched(storage);
    const hs = (() => { try { return g.HabitModel.sanitize(JSON.parse(safeGet(storage, HABIT_KEY))); } catch (_) { return g.HabitModel.newState(); } })();
    const cards = sched ? sched.cards : {};
    const recs = readAllRecs(storage);
    const due = g.StatsModel.forecast(cards, recs, now, Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : -new Date(now).getTimezoneOffset(), 1)[0].due;
    return g.StatsModel.compute({
      cards, recs, log: readJson(storage, g.StatsModel.LOG_KEY),
      timeLog: g.SessionTimer ? readJson(storage, g.SessionTimer.LOG_KEY) : null,   // v16 R13
      habit: g.HabitModel.status(hs, now, { due }, { tzOffsetMin: opts.tzOffsetMin }), habitState: hs,
      weak: g.DiagnosisModel ? weakComponents(storage, now) : [],
      target: schedSettings(storage).retention,
      catalog: opts.catalog || (root && root.PRACTICE_CATALOG) || null,
    }, now, opts);
  }

  // ---- v16 R13: active study time (session-timer.js). ----
  /** Write pending whole seconds of `timer` into the study-time log. No write when nothing is pending. */
  function flushStudyTime(storage, timer) {
    const ST = g.SessionTimer;
    const r = ST.flush(timer, readJson(storage, ST.LOG_KEY));
    if (r.changed) { try { safeSet(storage, ST.LOG_KEY, JSON.stringify(r.log)); } catch (_) { /* quota: retry later */ } }
    return r.changed;
  }

  /**
   * Hook active-time counting into the page. Called once from index.html init. Passive listeners only; input
   * events just move the timer (cheap), storage is written at most every flushMs (throttled) and on hide.
   * win/doc are injectable for tests; opts: {now (clock fn), flushMs (30 s), setInterval, idleMs, capMs}.
   * Returns {timer, flush(), stop()}.
   */
  function setupSessionTiming(storage, win, doc, opts = {}) {
    const ST = g.SessionTimer;
    const clock = opts.now || Date.now;
    const flushMs = opts.flushMs || 30e3;
    const timer = ST.create(opts);
    let lastFlush = clock();
    const flush = () => { lastFlush = clock(); return flushStudyTime(storage, timer); };
    const onInput = () => {
      if (doc.visibilityState === 'hidden') return;
      const now = clock();
      ST.input(timer, now);
      if (now - lastFlush >= flushMs) flush();          // throttled flush while active
    };
    const onHide = () => { ST.pause(timer, clock()); flush(); };
    const onVis = () => { if (doc.visibilityState === 'hidden') onHide(); };
    const P = { passive: true, capture: true };
    const INPUTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'touchmove', 'wheel', 'kanji:stroke'];
    INPUTS.forEach((t) => win.addEventListener(t, onInput, P));
    doc.addEventListener('visibilitychange', onVis, P);
    win.addEventListener('pagehide', onHide, P);
    win.addEventListener('blur', onHide, P);
    const iv = (opts.setInterval || win.setInterval).call(win, () => { if (ST.pendingSeconds(timer)) flush(); }, flushMs);
    const stop = () => {
      INPUTS.forEach((t) => win.removeEventListener(t, onInput, P));
      doc.removeEventListener('visibilitychange', onVis, P);
      win.removeEventListener('pagehide', onHide, P); win.removeEventListener('blur', onHide, P);
      (opts.clearInterval || win.clearInterval).call(win, iv);
    };
    return { timer, flush, stop };
  }

  // ---- v16 R22: B3's nested groups, limited to glyphs the app can draw on their own ----
  // 140 of the group glyphs in nested-groups.js (252 of 4036 groups, e.g. 咅 in 倍) are neither app kanji nor
  // drawable COMPONENT_GLYPHS entries, so a family tile or a practice step for them would have no drawing. Until B3
  // adds drawings for them they are left out here (families and diagnosis both use this filtered copy).
  let drawableMemo = { src: null, cat: null, glyphs: null, out: null };
  /**
   * KANJI_GROUPS without undrawable glyphs: {k: [{g, from, to, depth}]}. Returns null (no nested groups at all) until
   * nested-groups.js, PRACTICE_CATALOG (V15_DATA_SCRIPTS) and COMPONENT_GLYPHS are all loaded, so the result never
   * depends on load order. The 'components' lazy group (v16-loader.js) loads nested-groups.js and component-glyphs.js.
   */
  function drawableGroups({ groups, catalog, glyphs } = {}) {
    const src = groups || (root && root.KANJI_GROUPS) || null;
    const c = catalog || (root && root.PRACTICE_CATALOG) || null;
    const gl = glyphs || (root && root.COMPONENT_GLYPHS && root.COMPONENT_GLYPHS.glyphs) || null;
    if (!src || !c || !c.kanji || !gl) return null;
    const cat = c.kanji;
    const m = drawableMemo;
    if (m.src === src && m.cat === cat && m.glyphs === gl) return m.out;
    // A glyph is drawable only with drawable === true, no open check, and real paths: the same test v16-views
    // uses before it draws. B3 marks glyphs whose parents disagree on stroke shape drawable:false (a86b1a1).
    const drawn = (e) => !!e && e.drawable === true && !e.check && Array.isArray(e.paths) && e.paths.length > 0;
    const ok = (g) => !!cat[g] || drawn(gl[g]);
    const out = {};
    for (const k in src) out[k] = (Array.isArray(src[k]) ? src[k] : []).filter((grp) => grp && ok(grp.g));
    drawableMemo = { src, cat, glyphs: gl, out };
    return out;
  }

  // ---- v16 R14: component families (component-model.js). Read-only on storage. ----
  /** Data for ComponentModel: catalog (default PRACTICE_CATALOG), kanjiMap, FSRS cards, recs. Reads only. */
  function componentData(storage, { kanjiMap, catalog, freqRank } = {}) {
    const sched = readSched(storage);
    return { catalog: catalog || (root && root.PRACTICE_CATALOG) || null,
             kanjiMap: kanjiMap || (root && root.KANJI_DATA && root.KANJI_DATA.kanji) || null,
             freqRank, cards: sched ? sched.cards : {}, recs: readAllRecs(storage),
             // R22: B3's nested groups and drawing keywords, when their lazy files have loaded (else ignored)
             groups: drawableGroups({ catalog }),
             glyphs: (root && root.COMPONENT_GLYPHS && root.COMPONENT_GLYPHS.glyphs) || null };
  }
  /** One component's family {component, meaning, meaningSource, kanji:[{k, level, status}], counts}. */
  function componentFamily(storage, component, opts) {
    needLazy('ComponentModel', 'components');   // R20
    return g.ComponentModel.family(component, componentData(storage, opts));
  }
  /** All families, biggest first; opts.minSize filters small ones. */
  function componentFamilies(storage, opts = {}) {
    needLazy('ComponentModel', 'components');   // R20
    return g.ComponentModel.families(componentData(storage, opts), opts);
  }

  /** All stored `rec:` records as [key without 'rec:', record|null]. */
  function recEntries(storage) {
    const out = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (isRecKey(k)) out.push([k.slice(4), readRec(storage, k.slice(4))]);
    }
    return out;
  }

  /** v16 #2: {due, learning, nextDue|null} over every stored record. */
  function dueCounts(storage, now = Date.now()) {
    return g.SchedulerModel.dueCounts(recEntries(storage), now);
  }

  /** v16 #2: due items most overdue first, [{key, due, phase}]. */
  function dueList(storage, now = Date.now()) {
    return g.SchedulerModel.dueList(recEntries(storage), now);
  }

  /**
   * v16 #3: rankable components of a kanji still below the gate (GatingModel.blockers on progressOf).
   * @param {Storage} storage @param {string} kanji @param {object} kanjiMap DATA.kanji
   * @param {{minTier?: string, now?: number}} [opts] minTier = CONFIG.FLOW.GATE_TIER ('none' disables)
   * @returns {string[]}
   */
  function gateBlockers(storage, kanji, kanjiMap, { minTier, now = Date.now(), ignoreOverride = false } = {}) {
    if (!ignoreOverride && gateOverridden(storage, kanji)) return [];
    const opts = minTier ? { minTier } : {};
    return g.GatingModel.blockers(kanji, kanjiMap, (k) => progressOf(storage, k, now), opts);
  }

  /** v16 #3: storage key of the kanji the learner chose to start anyway ("continue anyway"), a JSON string[]. */
  const GATE_OVERRIDE_KEY = 'v16:gate-override';

  /** Kanji with a "continue anyway" override; a missing or corrupt value is an empty list. */
  function gateOverrides(storage) {
    try {
      const v = JSON.parse(safeGet(storage, GATE_OVERRIDE_KEY));
      return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  /** True when the learner chose "continue anyway" for this kanji. */
  function gateOverridden(storage, kanji) {
    return gateOverrides(storage).includes(kanji);
  }

  /**
   * "Continue anyway": start a gated kanji now. Stored per kanji (idempotent); the components keep their own ranks
   * and are still offered first elsewhere. on=false removes it.
   * @returns {string[]} the override list after the change
   */
  function overrideGate(storage, kanji, on = true) {
    const list = gateOverrides(storage).filter((k) => k !== kanji);
    if (on) list.push(kanji);
    try { safeSet(storage, GATE_OVERRIDE_KEY, JSON.stringify(list)); } catch (_) { /* quota: override for this call only */ }
    return list;
  }

  /**
   * Gate state for the "Learn X first / continue anyway" prompt.
   * @returns {{blockers: string[], overridden: boolean, unlocked: boolean}} blockers ignore the override
   */
  function gateStatus(storage, kanji, kanjiMap, opts = {}) {
    const blockers = gateBlockers(storage, kanji, kanjiMap, Object.assign({}, opts, { ignoreOverride: true }));
    const overridden = gateOverridden(storage, kanji);
    return { blockers, overridden, unlocked: blockers.length === 0 || overridden };
  }

  /**
   * v16 #6: mixed review set for the due kanji (#2 dueList, review phase, kanji keys only) with confusables.js
   * look-alikes. A not-due partner may join unscored only when studied (rank > 0) and not in learning.
   * @param {Storage} storage
   * @param {{pairs: object[], now?: number, seed?: number, maxItems?: number, limit?: number}} opts
   *   pairs = window.CONFUSABLES.pairs; limit = most overdue due kanji taken (default all)
   * @returns {{queue, pairShare, pairShareMet, pairs}} (PracticeModel.mixedReview)
   */
  function mixedReviewQueue(storage, { pairs = [], now = Date.now(), seed = 1, maxItems, limit } = {}) {
    const due = dueList(storage, now).filter((d) => d.phase === 'review' && !d.key.startsWith('w:')).map((d) => d.key);
    const list = limit ? due.slice(0, limit) : due;
    const state = loadRanks(storage);
    const canPartner = (k) => RM.getKanji(state, k).rank > 0 && !g.SchedulerModel.isLearning(readRec(storage, k));
    const opts = Object.assign({ pairs, canPartner, seed }, maxItems ? { maxItems } : {});
    return g.PracticeModel.mixedReview(state, list, opts);
  }

  /**
   * v16 R30: a level check interleaved instead of blocked (LevelCheckModel.interleave): look-alikes back to back,
   * kanji sharing a component next to each other, reading/writing alternating. Order only; grading unchanged.
   * Hook (Botfour, v15-ui.js checkStart): lc.items = V15.levelCheckOrder(LC.selectKanji(...), { pairs:
   * (window.CONFUSABLES || {}).pairs, kanjiMap }). Without kanjiMap only look-alikes and kinds are used.
   */
  function levelCheckOrder(items, { pairs = [], kanjiMap = null } = {}) {
    const componentsOf = kanjiMap ? (k) => g.GatingModel.componentsOf(k, kanjiMap) : () => [];
    return g.LevelCheckModel.interleave(items, { pairs, componentsOf });
  }

  /** v16 #7: storage key of the habit state (HabitModel). */
  const HABIT_KEY = 'habit';

  /** Stored habit state (sanitized; missing/corrupt → new state). */
  function loadHabit(storage) {
    try {
      return g.HabitModel.sanitize(JSON.parse(safeGet(storage, HABIT_KEY)));
    } catch (_) {
      return g.HabitModel.newState();
    }
  }

  /** Save a habit state; a refused write is ignored (the UI still gets the result). */
  function saveHabit(storage, state) {
    try { safeSet(storage, HABIT_KEY, JSON.stringify(state)); } catch (_) { /* quota */ }
  }

  /** Fire CustomEvent('v16:habit', {detail: status}) on window when possible. */
  function emitHabit(detail) {
    if (root && typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('v16:habit', { detail }));
    }
  }

  /**
   * v16 #7: habit status for the main screen ("Due N · done M", streak). Read-only.
   * @returns {{streak, best, done, goal, due, goalMet, freezes, atRisk}}
   */
  function habit(storage, now = Date.now(), { tzOffsetMin } = {}) {
    return g.HabitModel.status(loadHabit(storage), now, dueCounts(storage, now), { tzOffsetMin });
  }

  /**
   * v16 #7: count one scored review (call after a scored item only: PracticeModel.isScored). Saves `habit` and fires
   * `v16:habit` when the streak was extended or the goal was reached by this review.
   * @returns {{status: object, extended: boolean, goalMet: boolean, goalReached: boolean}}
   */
  function recordReview(storage, now = Date.now(), { count = 1, tzOffsetMin } = {}) {
    // v16 R3: a review while on vacation ends the pause first (dates shifted, streak kept), then counts normally.
    // UI hook (Botfour): listen for `v16:vacation-off` (detail {days, shifted}) → toast "Vacation mode is off".
    let vacationEnded = null;
    if (vacationStatus(storage, now).active) {
      vacationEnded = endVacation(storage, now, { tzOffsetMin });
      emit('v16:vacation-off', vacationEnded);
    }
    const r = g.HabitModel.record(loadHabit(storage), now, { count, tzOffsetMin });
    saveHabit(storage, r.state);
    const st = g.HabitModel.status(r.state, now, dueCounts(storage, now), { tzOffsetMin });
    if (r.extended || r.goalReached) emitHabit(st);
    return { status: st, extended: r.extended, goalMet: r.goalMet, goalReached: r.goalReached, vacationEnded };
  }

  /** v16 #7: set the daily goal (1..HabitModel.MAX_GOAL); returns the status and fires `v16:habit`. */
  function setHabitGoal(storage, n, now = Date.now(), { tzOffsetMin } = {}) {
    const s = g.HabitModel.setGoal(loadHabit(storage), n);
    saveHabit(storage, s);
    const st = g.HabitModel.status(s, now, dueCounts(storage, now), { tzOffsetMin });
    emitHabit(st);
    return st;
  }

  /** v16 #7: grant one streak freeze (max HabitModel.MAX_FREEZES); returns the status. */
  function addStreakFreeze(storage, now = Date.now(), { tzOffsetMin } = {}) {
    const s = g.HabitModel.addFreeze(loadHabit(storage));
    saveHabit(storage, s);
    return g.HabitModel.status(s, now, dueCounts(storage, now), { tzOffsetMin });
  }

  /* ==================== v16 R5–R8 glue (Botfive) ====================
   * Storage keys: `contrast` (ContrastModel state), `leech` (LeechModel state). Events on window:
   *   v16:contrast {target, lookalike, kind, weight}  — a look-alike mix-up was recorded ("Mixed up with 末" chip)
   *   v16:leech    {kanji, lapses}                    — a kanji was newly flagged as a leech (toast + home card)
   * UI hooks for Botfour: scaffoldFor (writing guides), foldContrasts (call after each answer in an open review),
   * lessonPick (wrap the new-lesson picker), leechList / leechRestudy / completeLeechRestudy (home card).
   */
  const CONTRAST_KEY = 'contrast';
  const LEECH_KEY = 'leech';

  /** Dispatch a CustomEvent on window; in node (tests) fall back to globalThis when it is an EventTarget. */
  function emit(name, detail) {
    const t = root && typeof root.dispatchEvent === 'function' ? root
      : (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' ? globalThis : null);
    const CE = (t && t.CustomEvent) || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (t && CE) t.dispatchEvent(new CE(name, { detail }));
  }

  function readJson(storage, key) {
    try { return JSON.parse(safeGet(storage, key)); } catch (_) { return null; }
  }

  /** {on, kun} of a kanji from DATA.kanji (missing → empty lists). */
  function readingsFrom(kanjiMap) {
    return (k) => { const K = (kanjiMap || {})[k] || {}; return { on: K.on || [], kun: K.kun || [] }; };
  }

  // Pair index built once per pairs array (window.CONFUSABLES.pairs).
  let indexCache = { pairs: null, index: null };
  function contrastIndex(pairs) {
    if (indexCache.pairs !== pairs) indexCache = { pairs, index: g.ContrastModel.indexPairs(pairs || []) };
    return indexCache.index;
  }

  function loadContrast(storage) { return g.ContrastModel.sanitizeState(readJson(storage, CONTRAST_KEY)); }
  function saveContrast(storage, s) { safeSet(storage, CONTRAST_KEY, JSON.stringify(s)); return s; }

  /**
   * R7: check a failed answer for a look-alike mix-up and, if found, schedule a contrast drill and fire
   * `v16:contrast`. Writing → weight 1 (the caller's lapse is the 'again'); reading → weight 0.5, no extra 'again'.
   * @param {{target, answerKanji?, answerReading?}} answer
   * @param {{pairs, kanjiMap?, now?}} opts
   * @returns {{lookalike, kind, weight, fsrsAgain}|null}
   */
  function recordConfusion(storage, answer, { pairs, kanjiMap, now = Date.now() } = {}) {
    const CM = g.ContrastModel;
    if (!CM || !pairs) return null;
    const index = contrastIndex(pairs);
    const hit = CM.detectConfusion(answer, index, readingsFrom(kanjiMap));
    if (!hit) return null;
    const out = Object.assign({}, hit, CM.confusionOutcome(hit.kind));
    saveContrast(storage, CM.scheduleContrast(loadContrast(storage), { target: answer.target, lookalike: hit.lookalike, kind: hit.kind }, index, now));
    emit('v16:contrast', { target: answer.target, lookalike: hit.lookalike, kind: hit.kind, weight: out.weight });
    return out;
  }

  /** R7: drills due now, heaviest first (for the start of the next review). */
  function dueContrasts(storage, now = Date.now()) {
    return g.ContrastModel.dueContrasts(loadContrast(storage), now);
  }

  /**
   * R7: fold due drills into an OPEN review session; call after each answer. `at` = index just answered.
   * Saves the state (folded drills leave `contrast`). Returns {queue, folded}.
   */
  function foldContrasts(storage, queue, { now = Date.now(), at = -1, max = 2 } = {}) {
    const r = g.ContrastModel.foldIntoSession(queue, loadContrast(storage), now, { at, max });
    if (r.folded.length) saveContrast(storage, r.state);
    return { queue: r.queue, folded: r.folded };
  }

  /** R7: mark a drill done (when it was taken from dueContrasts rather than folded). */
  function completeContrast(storage, drill) {
    return saveContrast(storage, g.ContrastModel.completeContrast(loadContrast(storage), drill));
  }

  /**
   * R7/R8: new-lesson picker wrapper. `ordered` = candidates in component-first order (GatingModel.order).
   * Keeps look-alikes and ANY shared reading out of the same lesson and pauses a look-alike of a kanji whose
   * leech re-study is pending. Returns {lesson, deferred:[{k, reason, with}]}.
   */
  function lessonPick(storage, ordered, size, { pairs = [], kanjiMap = {}, recentReadings } = {}) {
    const paused = new Set(leechList(storage).map((x) => x.kanji));
    return g.ContrastModel.lessonFilter(ordered, size, {
      index: contrastIndex(pairs), readingsOf: readingsFrom(kanjiMap), recentReadings,   // R29: recentReadings
      componentsOf: (k) => g.GatingModel.componentsOf(k, kanjiMap), leechPending: (k) => paused.has(k),
    });
  }

  function loadLeech(storage) { return g.LeechModel.sanitizeState(readJson(storage, LEECH_KEY)); }

  /** R8: after every FSRS grade of a kanji key (not w: words); fires `v16:leech` when newly flagged. */
  function trackLeech(storage, key, card, now) {
    if (!g.LeechModel || key.startsWith('w:') || key.startsWith('ctx:')) return;   // R11: context cards are not leeches
    const r = g.LeechModel.update(loadLeech(storage), key, card, now);
    safeSet(storage, LEECH_KEY, JSON.stringify(r.state));
    if (r.newlyFlagged) emit('v16:leech', { kanji: key, lapses: card.lapses });
  }

  /**
   * R8: leeches waiting for re-study, oldest first [{kanji, flaggedAt, lapses, times}].
   * Leeches the learner dismissed for good (dismissLeech) are left out, so they neither show a card nor pause
   * their look-alikes in the new-lesson picker. opts.includeDismissed = true lists them too.
   */
  function leechList(storage, opts = {}) {
    const all = g.LeechModel ? g.LeechModel.pending(loadLeech(storage)) : [];
    if (opts.includeDismissed) return all;
    const gone = dismissedLeeches(storage);
    return all.filter((l) => !gone[l.kanji]);
  }

  // ---- deferred (b): permanent leech dismiss ----
  // Storage: ONE key, 'v16:leech-dismissed' = {"v":1,"k":{"<kanji>":{"at":<ms>,"lapses":<n>}}}.
  // The 'v16:' prefix means ExportModel.isAppKey includes it in every export and import (no export-model change).
  const LEECH_DISMISS_KEY = 'v16:leech-dismissed';

  /** {kanji: {at, lapses}} for every dismissed leech; {} when none or the stored value is unusable. */
  function dismissedLeeches(storage) {
    const raw = readJson(storage, LEECH_DISMISS_KEY);
    const out = {};
    if (!raw || raw.v !== 1 || !raw.k || typeof raw.k !== 'object' || Array.isArray(raw.k)) return out;
    for (const [k, v] of Object.entries(raw.k)) {
      if (typeof k === 'string' && k && v && Number.isFinite(v.at)) out[k] = { at: v.at, lapses: Number.isFinite(v.lapses) ? v.lapses : 0 };
    }
    return out;
  }

  function writeDismissed(storage, map) {
    return safeSet(storage, LEECH_DISMISS_KEY, JSON.stringify({ v: 1, k: map }));
  }

  /** Dismiss a leech for good (persisted). Keeps the leech record and review history. Returns true when stored. */
  function dismissLeech(storage, kanji, now = Date.now()) {
    if (typeof kanji !== 'string' || !kanji) return false;
    const map = dismissedLeeches(storage);
    const card = cardOf(storage, kanji);
    map[kanji] = { at: now, lapses: card && Number.isFinite(card.lapses) ? card.lapses : 0 };
    writeDismissed(storage, map);
    return !!dismissedLeeches(storage)[kanji];
  }

  /** Undo dismissLeech: the leech card (and the picker pause) come back if it is still pending. */
  function undismissLeech(storage, kanji) {
    const map = dismissedLeeches(storage);
    if (!map[kanji]) return false;
    delete map[kanji];
    writeDismissed(storage, map);
    return true;
  }

  /** R8: re-study steps for a leech, components deepest-first (GatingModel.componentsOf), kanji last (scored). */
  function leechRestudy(storage, kanji, kanjiMap) {
    const state = loadRanks(storage);
    return g.LeechModel.restudyPlan(kanji, (k) => g.GatingModel.componentsOf(k, kanjiMap),
      { isKnown: (k) => RM.getKanji(state, k).rank > 0 });
  }

  /** R8: the scored last step of a re-study is done; lifts the leech-pause on its look-alikes. */
  function completeLeechRestudy(storage, kanji, now = Date.now()) {
    const s = g.LeechModel.completeRestudy(loadLeech(storage), kanji, cardOf(storage, kanji), now);
    safeSet(storage, LEECH_KEY, JSON.stringify(s));
    return s;
  }

  /**
   * R6: writing-guide level for a kanji and its components, from FSRS stability, rank and the last grade.
   * Botfour: level 0 → dots ('step'), 1 → first stroke only, 2 → blank; showPartKeywords for the equation.
   * @returns {{kanji, parts, showPartKeywords}} (FadingScaffolds.forKanji)
   */
  function scaffoldFor(storage, kanji, kanjiMap = {}) {
    const ranks = loadRanks(storage);
    const sched = readSched(storage);
    const input = (k) => {
      const card = cardOf(storage, k);
      const undo = sched && sched.undo && sched.undo[k];
      return { stability: card ? card.stability : 0, phase: card ? card.phase : 'new',
               rank: RM.getKanji(ranks, k).rank, lastGrade: undo ? undo.grade : null };
    };
    return g.FadingScaffolds.forKanji(input(kanji), g.GatingModel.componentsOf(kanji, kanjiMap).map(input));
  }

  /**
   * v16 R27: the saved study order without loading study-order-model.js, so the new-lesson button knows whether to
   * `await V16Lazy.load('order')` first. {order: 'app'|'frequency'|'grade'|'strokes'|'custom'}; 'app' when unset/bad.
   */
  const STUDY_ORDER_KEY = 'v16:study-order';
  function studyOrderSetting(storage) {
    try {
      const o = JSON.parse(storage.getItem(STUDY_ORDER_KEY));
      if (o && ['frequency', 'grade', 'strokes', 'custom'].includes(o.order)) return { order: o.order };
    } catch (e) { /* malformed → default */ }
    return { order: 'app' };
  }

  /**
   * v16 R29 homophone spacing (Botfive; design kanji-team/R29-homophone-spacing.md). Kanji sharing a reading with
   * one introduced in the previous lesson(s) wait for a later lesson, so homophones are not introduced back to back
   * (in-lesson separation already existed in lessonPick). "Previous lesson(s)" = kanji whose FSRS card is still in
   * the 'learning' phase: introduced and not yet graduated (about the last day). Nothing is stored for this: it is
   * read from the schedule, so grading, scheduling and records are untouched.
   * Setting 'v16:homophone-spacing' = {"on": false} turns it off; default on. Never in 'family' mode (a family is
   * often one phonetic series, chosen on purpose), and never at the cost of lesson size: if spacing would leave
   * the lesson short of `limit`, the lesson is picked without it (out.spacing = 'relaxed').
   */
  const HOMOPHONE_SPACING_KEY = 'v16:homophone-spacing';
  function homophoneSpacingSetting(storage) {
    try { const o = JSON.parse(storage.getItem(HOMOPHONE_SPACING_KEY)); if (o && o.on === false) return { on: false }; }
    catch (e) { /* malformed -> default */ }
    return { on: true };
  }
  function setHomophoneSpacing(storage, on) {
    safeSet(storage, HOMOPHONE_SPACING_KEY, JSON.stringify({ on: !!on }));
    return homophoneSpacingSetting(storage);
  }
  /*
   * v16 R31 reading-font variety (Botfive; MARKET_RESEARCH backlog #15, V16_PLAN F3 varied practice; design in
   * kanji-team/R31-reading-font.md). Kanji look different in textbook (kyokasho), Gothic and Mincho faces, and
   * learners who only ever see one face can fail to recognise the others. This decides which face a READING prompt
   * shows. It is display only: it never changes items, order, grading, ranks or scheduling.
   * Setting 'v16:reading-font' = {mode, face}:
   *   mode 'off' (default): readingFontFor returns null and the app keeps its own font, so nothing changes.
   *   mode 'fixed': always `face`.
   *   mode 'vary': a kanji at Bronze or higher gets a face picked from its code point and the local day, so a prompt
   *                keeps one face for the whole day (no flicker on re-render) and moves to the next face the next
   *                day. New kanji (rank 0) stay in the app font, because a first lesson should not add a new face.
   * Faces are system font stacks only (no font download; the app stays offline-first). B4 can use
   * readingFontAvailable(face, document) to hide a face that the device does not have.
   */
  const READING_FONT_KEY = 'v16:reading-font';
  const READING_FONT_MODES = ['off', 'fixed', 'vary'];
  const READING_FACES = {
    textbook: { label: 'Textbook', family: '"UD Digi Kyokasho N-R", "UD デジタル 教科書体 N-R", "YuKyokasho", "Klee One", "Klee", serif' },
    gothic: { label: 'Gothic', family: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Noto Sans CJK JP", sans-serif' },
    mincho: { label: 'Mincho', family: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", serif' },
  };
  const READING_FACE_ORDER = ['textbook', 'gothic', 'mincho'];
  /** The saved setting, sanitized: unknown mode -> 'off', unknown face -> 'textbook'. Malformed JSON -> default. */
  function readingFontSetting(storage) {
    let o = null;
    try { o = JSON.parse(storage.getItem(READING_FONT_KEY)); } catch (e) { /* malformed -> default */ }
    const mode = o && READING_FONT_MODES.includes(o.mode) ? o.mode : 'off';
    const face = o && Object.prototype.hasOwnProperty.call(READING_FACES, o.face) ? o.face : 'textbook';
    return { mode, face };
  }
  /**
   * Save {mode, face} (each optional; missing fields keep the saved value). Returns the sanitized setting.
   * RC17 F7 (B4 rc17 review): a face is only written when the caller passes one (the user picked it). A mode change
   * alone keeps the stored face exactly as stored (also a legacy value), or no face at all: the 'textbook' default of
   * readingFontSetting is a READ default and is never saved (same rule as P6 / RC16b in the views).
   */
  function setReadingFont(storage, { mode, face } = {}) {
    const cur = readingFontSetting(storage);
    let raw;
    try { const o = JSON.parse(storage.getItem(READING_FONT_KEY)); if (o && typeof o === 'object' && 'face' in o) raw = o.face; }
    catch (e) { /* malformed -> no stored face */ }
    const next = { mode: READING_FONT_MODES.includes(mode) ? mode : cur.mode };
    if (Object.prototype.hasOwnProperty.call(READING_FACES, face)) next.face = face;   // the user's pick
    else if (raw !== undefined) next.face = raw;   // keep what was stored, unchanged
    safeSet(storage, READING_FONT_KEY, JSON.stringify(next));
    return readingFontSetting(storage);
  }
  /** Local day number (days since 1970 in the device's time zone), so 'vary' changes face at local midnight. */
  const localDayNo = (now) => {
    const d = new Date(now);
    return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
  };
  /**
   * The face for one reading prompt, or null to keep the app font. Pure apart from reading the setting and ranks.
   * @param {Storage} storage
   * @param {string} kanji
   * @param {{now?: number, rank?: number}} opts rank defaults to the stored rank (V15.loadRanks)
   * @returns {null | {face, label, family}}
   */
  function readingFontFor(storage, kanji, { now = Date.now(), rank, doc } = {}) {
    const st = readingFontSetting(storage);
    if (st.mode === 'off' || typeof kanji !== 'string' || !kanji) return null;
    // RC16 fallback: with `doc`, only faces the device has are used (Fixed: the saved face, else the first available;
    // Vary: rotate over the available faces). None available -> null (app font). Without `doc`: R31 behaviour.
    const pool = doc ? availableReadingFaces(doc) : READING_FACE_ORDER;
    if (!pool.length) return null;
    let face = pool.includes(st.face) ? st.face : pool[0];
    if (st.mode === 'vary') {
      const r = typeof rank === 'number' ? rank : ((loadRanks(storage).kanji[kanji] || {}).rank || 0);
      if (!(r >= 1)) return null;   // new kanji: keep the app font
      face = pool[(kanji.codePointAt(0) + localDayNo(now)) % pool.length];
    }
    return { face, label: READING_FACES[face].label, family: READING_FACES[face].family };
  }
  /** True when the device has a real font for `face` (not only the generic fallback). document.fonts.check needs a DOM. */
  /*
   * RC16 font fallback (Botfive; B4 P6 in kanji-review/B5-proposals.md c4071ac4, Botty: fall back to an available face).
   * Availability is measured, not asked: document.fonts.check() returns true for a system font that is not installed
   * (nothing to load), so R31's check said every face was available. Here a named font counts as present when text
   * set in "<font>, <generic>" measures differently from <generic> alone, for any of three generics. No canvas -> false.
   * Results are cached per document (the font list does not change while the page is open).
   */
  const FONT_PROBE_TEXT = '漢字あ永';
  const fontCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function namedFontPresent(doc, name) {
    let memo = fontCache && fontCache.get(doc);
    if (memo && name in memo) return memo[name];
    let ok = false;
    try {
      const c = doc.createElement('canvas').getContext('2d');
      if (c && typeof c.measureText === 'function') {
        ok = ['monospace', 'serif', 'sans-serif'].some((g) => {
          c.font = '32px ' + g; const base = c.measureText(FONT_PROBE_TEXT).width;
          c.font = '32px ' + name + ', ' + g; return c.measureText(FONT_PROBE_TEXT).width !== base;
        });
      }
    } catch (e) { ok = false; }   // jsdom without canvas, blocked canvas: treat as missing
    if (fontCache) { if (!memo) { memo = {}; fontCache.set(doc, memo); } memo[name] = ok; }
    return ok;
  }
  /** True when the device has at least one NAMED font of the face (generic families never count). */
  function readingFontAvailable(face, doc) {
    const f = READING_FACES[face];
    if (!f || !doc || typeof doc.createElement !== 'function') return false;
    return f.family.split(',').map((x) => x.trim()).filter((x) => x.startsWith('"')).some((x) => namedFontPresent(doc, x));
  }
  /** Faces this device has, in READING_FACE_ORDER. */
  const availableReadingFaces = (doc) => READING_FACE_ORDER.filter((f) => readingFontAvailable(f, doc));

  /*
   * v16 R33 guess-the-meaning pretest (Botfive; design kanji-team/patches/R33-meaning-pretest.md). Before a new
   * kanji's first lesson the learner sees its components (with meanings) and guesses the kanji's meaning from 4
   * choices; then the lesson reveals it as usual. Generation and pretesting help later recall even when the guess
   * is wrong (V16_PLAN F3; components F9/F10). UNGRADED: it never touches stroke scoring, judging, the scheduler,
   * ranks or recs. It only writes its own counters (key 'v16:pretest-stats'). Setting 'v16:meaning-pretest' =
   * {"on": true}; default off, so replays and existing flows do not change.
   */
  const PRETEST_KEY = 'v16:meaning-pretest';
  const PRETEST_STATS_KEY = 'v16:pretest-stats';
  function meaningPretestSetting(storage) {
    try { const o = JSON.parse(storage.getItem(PRETEST_KEY)); if (o && o.on === true) return { on: true }; }
    catch (e) { /* malformed -> default */ }
    return { on: false };
  }
  function setMeaningPretest(storage, on) {
    safeSet(storage, PRETEST_KEY, JSON.stringify({ on: !!on }));
    return meaningPretestSetting(storage);
  }
  /** The meaning shown for a kanji: data keyword, else its first dictionary meaning, else null. */
  function kanjiMeaningText(K) {
    if (!K) return null;
    if (typeof K.keyword === 'string' && K.keyword) return K.keyword;
    return Array.isArray(K.meanings) && typeof K.meanings[0] === 'string' && K.meanings[0] ? K.meanings[0] : null;
  }
  /**
   * The pretest for `kanji`, or null when: the setting is off; the kanji was already seen (card or rec); it has no
   * meaning in the data; none of its components has a meaning; or fewer than 3 distinct distractors exist.
   * Returns {kanji, components:[{c, meaning, known}], choices:[4 strings], answer}. Read-only.
   * Distractors: meanings of kanji sharing a component first (plausible guesses), then other kanji in data order.
   * Choice order is fixed per kanji (no Math.random), so the hook and tests are deterministic.
   */
  function meaningPretest(storage, kanji, opts = {}) {
    if (!meaningPretestSetting(storage).on || typeof kanji !== 'string' || !kanji) return null;
    // Never throws into the lesson flow: if the lazy 'components' bundle is not loaded yet, there is no pretest
    // (the hook preloads it with V16Lazy.load('components'); see the hooks spec).
    const CM = g.ComponentModel;
    if (!CM) return null;
    const data = componentData(storage, opts);
    const K = data.kanjiMap || {};
    // only before the first lesson: no practised rec / scheduled card, and no rank yet
    if (CM.statusOf(data.cards[kanji], data.recs[kanji]) !== 'unseen') return null;
    if (((loadRanks(storage).kanji[kanji] || {}).rank || 0) >= 1) return null;
    const answer = kanjiMeaningText(K[kanji]);
    if (!answer) return null;
    // Components: the practice catalog's list when loaded, else the kanji data's parts (both name the same glyphs).
    let comps = CM.componentsOf(kanji, data);
    if (!comps.length) comps = (Array.isArray((K[kanji] || {}).parts) ? K[kanji].parts : []).map((p) => p && p.g).filter(Boolean);
    const components = [...new Set(comps)].map((c) => {
      const fam = CM.family(c, data);
      return { c, meaning: fam.meaning, known: CM.statusOf(data.cards[c], data.recs[c]) !== 'unseen' };
    }).filter((x) => x.meaning);
    if (!components.length) return null;
    const lc = (s) => s.toLowerCase(); const used = new Set([lc(answer)]); const wrong = [];
    const take = (k) => { const m = kanjiMeaningText(K[k]); if (m && !used.has(lc(m)) && wrong.length < 3) { used.add(lc(m)); wrong.push(m); } };
    for (const x of components) for (const e of CM.family(x.c, data).kanji) if (e.k !== kanji) take(e.k);
    for (const k in K) { if (wrong.length >= 3) break; if (k !== kanji) take(k); }
    if (wrong.length < 3) return null;
    const pos = kanji.codePointAt(0) % 4;   // answer slot, fixed per kanji
    const choices = wrong.slice(); choices.splice(pos, 0, answer);
    return { kanji, components, choices, answer };
  }
  /**
   * Record the learner's guess (a choice string, or null for "skip"). Returns {correct, answer, stats}. Only the
   * counters under 'v16:pretest-stats' {shown, right, skipped} change; emits 'v16:pretest' (detail {kanji, correct}).
   */
  function recordPretestGuess(storage, pretest, choice) {
    const st = pretestStats(storage);
    const skipped = choice == null;
    const correct = !skipped && !!pretest && choice === pretest.answer;
    st.shown += 1; if (correct) st.right += 1; if (skipped) st.skipped += 1;
    safeSet(storage, PRETEST_STATS_KEY, JSON.stringify(st));
    emit('v16:pretest', { kanji: pretest ? pretest.kanji : null, correct, skipped });
    return { correct, answer: pretest ? pretest.answer : null, stats: st };
  }
  /** Counters {shown, right, skipped}; zeros when missing or malformed. */
  function pretestStats(storage) {
    const z = { shown: 0, right: 0, skipped: 0 };
    try { const o = JSON.parse(storage.getItem(PRETEST_STATS_KEY)); if (o) for (const k in z) if (Number.isInteger(o[k]) && o[k] >= 0) z[k] = o[k]; }
    catch (e) { /* malformed -> zeros */ }
    return z;
  }

  /** Kanji introduced recently: FSRS cards still in 'learning' (word w: and context ctx: cards are not kanji). */
  function recentKanji(storage) {
    const s = readSched(storage);
    if (!s) return [];
    return Object.keys(s.cards).filter((k) => !k.startsWith('w:') && !k.startsWith('ctx:') && s.cards[k] && s.cards[k].phase === 'learning');
  }
  /** Map reading -> recent kanji (first one wins), readings as lessonFilter compares them. */
  function recentReadingMap(storage, kanjiMap) {
    const readingsOf = readingsFrom(kanjiMap), m = new Map();
    for (const k of recentKanji(storage)) for (const r of g.ContrastModel.lessonReadings(readingsOf(k))) if (!m.has(r)) m.set(r, k);
    return m;
  }

  /**
   * New-lesson picker (Botty): the next new kanji to introduce.
   *  1. Component-first order over the planned list (GatingModel.order pulls missing components in first),
   *     skipping anything already introduced (rank > 0, an FSRS card, or a studied rec:).
   *  2. Lesson size = min(size, newAllowed). newAllowed comes from opts, else from the load budget
   *     (V15.loadStatus(storage).newAllowed, once that patch is ported), else no budget limit.
   *  3. lessonPick keeps look-alikes / shared readings apart and pauses look-alikes of pending leeches.
   * @param {Storage} storage
   * @param {string[]} planned the level's planned order (e.g. frequency order)
   * @param {{kanjiMap?, pairs?, size?: number, newAllowed?: number, now?: number, orderPlan?: function}} opts
   *   orderPlan (R27): reorders `planned` before gating; default window.V16StudyOrder.plan when loaded
   * @returns {{picks: string[], deferred: {k, reason, with}[], newAllowed: number|null, limit: number,
   *            limitedBy: 'budget'|'size'|null}}  limitedBy says why fewer than `size` could be picked (null = ran out)
   */
  function pickNewLesson(storage, planned, opts = {}) {
    const { kanjiMap = {}, pairs = [], size = 5, newAllowed, now = Date.now(), mode, component, from, catalog } = opts;
    // v16 R14 'family' mode: the planned list becomes the unseen kanji sharing a just-learned component
    // (`component`: glyph or list, or `from`: a just-learned kanji → its components). Everything below
    // (gating, look-alike / same-reading / leech rules in lessonPick, load budget) applies unchanged.
    let family = null;
    if (mode === 'family' && g.ComponentModel) {
      const data = componentData(storage, { kanjiMap, catalog });
      const comps = component ? [].concat(component) : from ? g.ComponentModel.componentsOf(from, data) : [];
      planned = g.ComponentModel.familyPlan(comps, data);
      family = { components: comps, candidates: planned.length };
    }
    // v16 R27: the learner's study order (study-order-model.js, group 'order') reorders the planned list before
    // gating, so components still come first. Not in 'family' mode (that list is the family, not a level).
    // `orderPlan` (tests) overrides window.V16StudyOrder.plan; absent/'app' → the list is left as it was.
    let order = null;
    const orderPlan = typeof opts.orderPlan === 'function' ? opts.orderPlan
      : (root && root.V16StudyOrder && typeof root.V16StudyOrder.plan === 'function' ? root.V16StudyOrder.plan : null);
    if (!family && orderPlan) {
      try { planned = orderPlan(planned || []); order = root && root.V16StudyOrder ? root.V16StudyOrder.get().order : 'custom-fn'; }
      catch (e) { order = null; }   // ordering is optional: on error keep the app order
    }
    let allowed = Number.isFinite(newAllowed) ? newAllowed : null;
    if (allowed === null && typeof api.loadStatus === 'function') {
      try { allowed = api.loadStatus(storage, now).newAllowed; } catch (_) { allowed = null; }  // budget off on error
    }
    const limit = Math.max(0, Math.min(size, allowed === null ? size : allowed));
    const ranks = loadRanks(storage);
    const introduced = (k) => RM.getKanji(ranks, k).rank > 0 || isStudied(storage, k, now);
    const ordered = g.GatingModel.order(planned || [], kanjiMap, { skip: introduced });
    // v16 R29: space homophones across lessons (see homophoneSpacingSetting). Not in family mode; off by setting.
    let spacing = null;
    const recentReadings = !family && limit > 0 && homophoneSpacingSetting(storage).on ? recentReadingMap(storage, kanjiMap) : new Map();
    let r = limit > 0 ? lessonPick(storage, ordered, limit, { pairs, kanjiMap, recentReadings }) : { lesson: [], deferred: [] };
    if (recentReadings.size && r.deferred.some((d) => d.recent)) {
      spacing = 'on';
      if (r.lesson.length < limit) {   // spacing must not shrink the lesson: pick as before R29
        const plain = lessonPick(storage, ordered, limit, { pairs, kanjiMap });
        if (plain.lesson.length > r.lesson.length) { r = plain; spacing = 'relaxed'; }
      }
    }
    const more = ordered.length > r.lesson.length + r.deferred.length;   // candidates left unexamined
    const limitedBy = r.lesson.length < size && (allowed !== null && allowed < size) ? 'budget'
      : r.lesson.length === limit && more ? 'size' : null;
    const out = { picks: r.lesson, deferred: r.deferred, newAllowed: allowed, limit, limitedBy };
    if (family) Object.assign(out, { mode: 'family', family });
    if (order) out.order = order;   // R27: which study order shaped the picks (absent = app order, as before)
    if (spacing) out.spacing = spacing;   // R29: 'on' = a recent homophone was deferred; 'relaxed' = spacing dropped to fill the lesson
    return out;
  }

  /* ==================== port of Botfive 03–05 (deploy) onto v16int ==================== */
  // ---- v16 R1: daily load budget (load-model.js). Keys `load:settings`, `load:today` = {day, newCount}. ----
  // UI hooks (Botfour; not wired):
  //   1. Before starting a NEW kanji lesson: `V15.loadStatus(localStorage).newAllowed`; 0 → say "Today's budget is
  //      full: review first (N due)" and offer reviews; never a dead end (the learner may still continue).
  //      After a new kanji's first completion call `V15.noteNewIntroduced(localStorage)`.
  //   2. Review screen: build the list from `V15.loadStatus(localStorage).today` (most at risk first); show
  //      "+N moved to tomorrow" for `deferred.length`.
  //   3. Forecast chart: `loadStatus().forecast` (reviews per day, 14 days, day 0 = today incl. overdue) vs `capacity`.
  //   4. Settings: `V15.setLoadSettings(localStorage, {minutesPerDay, newPerDayMax})`.
  const LOAD_SETTINGS_KEY = 'load:settings';
  const LOAD_TODAY_KEY = 'load:today';

  /** Due time per key: the FSRS card if any, else the `rec:` nextReview (words, unmigrated records). */
  function dueItems(storage, now) {
    const sched = readSched(storage);
    const cards = sched ? sched.cards : {};
    const recs = readAllRecs(storage);
    const items = [];
    for (const key of new Set([...Object.keys(cards), ...Object.keys(recs)])) {
      const card = cards[key] ? g.SchedulerModel.sanitizeCard(cards[key]) : null;
      const due = card && card.phase !== 'new' ? card.due : (recs[key] ? Date.parse(recs[key].nextReview) : NaN)  // nextReview-only recs count too (migration fix);
      if (Number.isFinite(due)) items.push({ key, due, r: card ? g.SchedulerModel.retrievability(card, now) : 0 });
    }
    return items;
  }

  /** Local midnight (ms) of `now` in zone tzOffsetMin (minutes east of UTC; default runtime zone). */
  function startOfDay(now, tzOffsetMin) {
    return Date.parse(g.HabitModel.dayKey(now, tzOffsetMin) + 'T00:00:00Z') - (tzOffsetMin ?? -new Date(now).getTimezoneOffset()) * 60e3;
  }

  /** New kanji already introduced today (resets on a new local day). */
  function newToday(storage, now, tzOffsetMin) {
    const t = readJson(storage, LOAD_TODAY_KEY);
    return t && t.day === g.HabitModel.dayKey(now, tzOffsetMin) && Number.isInteger(t.newCount) ? t.newCount : 0;
  }
  function noteNewIntroduced(storage, now = Date.now(), { tzOffsetMin } = {}) {
    const n = newToday(storage, now, tzOffsetMin) + 1;
    safeSet(storage, LOAD_TODAY_KEY, JSON.stringify({ day: g.HabitModel.dayKey(now, tzOffsetMin), newCount: n }));
    return n;
  }

  function loadSettings(storage) { return g.LoadModel.sanitizeSettings(readJson(storage, LOAD_SETTINGS_KEY)); }
  function setLoadSettings(storage, patch) {
    const s = g.LoadModel.sanitizeSettings(Object.assign({}, loadSettings(storage), patch));
    safeSet(storage, LOAD_SETTINGS_KEY, JSON.stringify(s));
    return s;
  }

  /**
   * Everything the UI needs, read-only: {settings, capacity, forecast, projectedPeak, newAllowed, newToday,
   * reason, today, deferred}. doneToday (reviews already done today) comes from the #7 habit counter.
   */
  function loadStatus(storage, now = Date.now(), { tzOffsetMin } = {}) {
    const LM = g.LoadModel;
    const settings = loadSettings(storage);
    const items = dueItems(storage, now);
    const fc = LM.forecast(items.map((x) => x.due), startOfDay(now, tzOffsetMin), 14);
    const introduced = newToday(storage, now, tzOffsetMin);
    const allow = LM.newAllowance(fc, settings, { introducedToday: introduced });
    const doneToday = habit(storage, now, { tzOffsetMin }).done;
    const q = LM.todayQueue(items, settings, now, { doneToday });
    return { settings, capacity: allow.capacity, forecast: fc, projectedPeak: allow.projectedPeak,
             newAllowed: allow.allowed, newToday: introduced, reason: allow.reason, today: q.today, deferred: q.deferred };
  }


  // ---- v16 R2: retention setting + load smoothing. Key `sched:settings` = {retention, smoothing}. ----
  // UI hook (Botfour, Settings): "Target recall" slider 80–95% → `V15.setSchedSettings(localStorage, {retention})`.
  // Explain: higher = more reviews, fewer forgotten. Changing it affects future intervals only (no reshuffle).
  const SCHED_SETTINGS_KEY = 'sched:settings';
  const SCHED_DEFAULTS = Object.freeze({ retention: 0.9, smoothing: true });
  function schedSettings(storage) {
    let o = null; try { o = JSON.parse(safeGet(storage, SCHED_SETTINGS_KEY)); } catch (_) { /* default */ }
    o = o && typeof o === 'object' ? o : {};
    const r = Number(o.retention);
    return { retention: Number.isFinite(r) && r >= 0.8 && r <= 0.95 ? Math.round(r * 100) / 100 : SCHED_DEFAULTS.retention,
             smoothing: typeof o.smoothing === 'boolean' ? o.smoothing : SCHED_DEFAULTS.smoothing };
  }
  /** Merge a settings patch (bad values ignored) and save; returns the settings in force. */
  function setSchedSettings(storage, patch) {
    const merged = Object.assign({}, schedSettings(storage), patch);
    safeSet(storage, SCHED_SETTINGS_KEY, JSON.stringify(merged));
    const clean = schedSettings(storage);
    safeSet(storage, SCHED_SETTINGS_KEY, JSON.stringify(clean));
    return clean;
  }

  // ---- v16 R3: vacation mode + backlog recovery. Key `vacation` = {since: ms} while paused. ----
  // UI hooks (Botfour): Settings "Pause (vacation)" toggle → startVacation / endVacation; show
  // `vacationStatus().days`. When `backlogPlan().overdue > 0` show "N overdue · cleared in ~D days at your
  // daily budget" on the home card; new kanji stay paused meanwhile (loadStatus already returns newAllowed 0).
  const VACATION_KEY = 'vacation';
  const DAY_MS = 864e5;
  function vacationStatus(storage, now = Date.now()) {
    const v = readJson(storage, VACATION_KEY);
    const since = v && Number.isFinite(v.since) ? v.since : null;
    return { active: since !== null, since, days: since === null ? 0 : Math.max(0, Math.floor((now - since) / DAY_MS)) };
  }
  function startVacation(storage, now = Date.now()) {
    if (!vacationStatus(storage, now).active) safeSet(storage, VACATION_KEY, JSON.stringify({ since: now }));
    return vacationStatus(storage, now);
  }
  /**
   * End the pause: every review (FSRS card + its rec: nextReview, and rec-only words) is shifted later by the
   * whole days paused, and so is the card's `last`, so recall estimates resume where they stopped instead of
   * dumping a backlog. The streak is kept: lastDay moves to yesterday (no freezes spent). Returns {days, shifted}.
   */
  function endVacation(storage, now = Date.now(), { tzOffsetMin } = {}) {
    const vs = vacationStatus(storage, now);
    safeRemove(storage, VACATION_KEY);
    if (!vs.active || vs.days < 1) return { days: 0, shifted: 0 };
    const shift = vs.days * DAY_MS;
    let shifted = 0;
    const sched = readSched(storage);
    if (sched) {
      for (const k of Object.keys(sched.cards)) {
        const c = sched.cards[k];
        if (!c || c.phase === 'new' || !Number.isFinite(c.due)) continue;
        c.due += shift; if (Number.isFinite(c.last)) c.last += shift;
      }
      safeSet(storage, SCHED_KEY, JSON.stringify(sched));
    }
    const recs = readAllRecs(storage);
    for (const k of Object.keys(recs)) {
      const t = Date.parse(recs[k].nextReview);
      if (!Number.isFinite(t)) continue;   // nextReview-only recs shift too (migration fix)
      recs[k].nextReview = new Date(t + shift).toISOString();
      safeSet(storage, 'rec:' + k, JSON.stringify(recs[k]));
      shifted++;
    }
    const h = loadHabit(storage);
    if (h.streak > 0) { h.lastDay = g.HabitModel.dayKey(now - DAY_MS, tzOffsetMin); saveHabit(storage, h); }
    return { days: vs.days, shifted };
  }

  /**
   * Backlog recovery estimate (read-only): overdue reviews and days to clear them, assuming each day the budget
   * minus that day's own scheduled reviews goes to the backlog (most-forgotten first, via todayQueue).
   */
  function backlogPlan(storage, now = Date.now(), opts = {}) {
    const st = loadStatus(storage, now, opts);
    const overdue = dueItems(storage, now).filter((x) => x.due <= now).length;
    const upcoming = st.forecast.slice(1, 8);
    const avg = upcoming.length ? upcoming.reduce((a, b) => a + b, 0) / upcoming.length : 0;
    const spare = Math.max(1, Math.floor(st.capacity - avg));
    return { overdue, capacity: st.capacity, spare, daysToClear: overdue ? Math.ceil(overdue / spare) : 0 };
  }


  /** Tier name for the UI (replaces the word-done tier for kanji chips). */
  function tierOf(storage, kanji) {
    return RM.tierOf(loadRanks(storage), kanji);
  }

  // Named so pickNewLesson can find later-ported helpers (loadStatus) on the same object.

  // ---- v16 R9: progress export / import (logic in export-model.js; this part only reads/writes storage) -------
  // UI hooks (UI in settings-view.js):
  //   V15.exportProgress(localStorage)         → JSON string; offer as download "kanji-progress-YYYY-MM-DD.json".
  //   V15.exportCsv(localStorage)              → CSV string (kanji,rank,due,stability,lapses); download as .csv.
  //   V15.checkImport(text)                    → {ok, errors, warnings, summary:{keys, kanji, exportedAt}}; show
  //                                              before asking "Merge" or "Replace".
  //   V15.importProgress(localStorage, text, {mode:'merge'|'replace'}) → {ok, errors, written, removed}; then reload.
  //   V15.restoreImportBackup(localStorage)    → undo the last import (true when a backup existed).
  //   Event 'v16:progress-imported' {mode, written, removed} fires after a successful import.

  /** All storage entries as a {key: raw} map. */
  function allEntries(storage) {
    const out = {};
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k != null) out[k] = safeGet(storage, k);
    }
    if (g.DataSafety) Object.assign(out, g.DataSafety.pendingEntries(storage));   // R18: not-yet-written values count
    return out;
  }

  function exportProgress(storage, now) {
    const text = JSON.stringify(g.ExportModel.buildExport(allEntries(storage), now == null ? Date.now() : now), null, 1);
    if (g.DataSafety) {   // R18: remember the export for the backup reminder and refresh the IndexedDB mirror
      g.DataSafety.markExported(storage, now == null ? Date.now() : now);
      g.DataSafety.mirrorBackup(text, { force: true }).catch(() => {});
    }
    return text;
  }

  function exportCsv(storage) {
    return g.ExportModel.toCsv(allEntries(storage), ['none', 'bronze', 'silver', 'gold', 'diamond']);
  }

  function checkImport(text) {
    const v = g.ExportModel.validate(text);
    const keys = v.data ? Object.keys(v.data.keys) : [];
    return { ok: v.ok, errors: v.errors, warnings: v.warnings,
      summary: v.data ? { keys: keys.length, kanji: keys.filter((k) => k.startsWith('rec:')).length, exportedAt: v.data.exportedAt } : null };
  }

  /** Validate, back up every current app key to export:backup, then apply the merge/replace plan. */
  function importProgress(storage, text, opts) {
    const EM = g.ExportModel;
    const v = EM.validate(text);
    if (!v.ok) return { ok: false, errors: v.errors, written: 0, removed: 0 };
    const plan = EM.planImport(allEntries(storage), v.data, opts && opts.mode);
    try {
      storage.setItem(EM.BACKUP_KEY, JSON.stringify({ at: Date.now(), keys: plan.backup }));   // backup FIRST
    } catch (e) {
      return { ok: false, errors: ['could not save a backup (storage full?) — nothing was changed'], written: 0, removed: 0 };
    }
    const written = Object.keys(plan.writes);
    if (g.DataSafety) g.DataSafety.forget(storage, written.concat(plan.removes));   // R18: imported values win
    try {
      written.forEach((k) => storage.setItem(k, plan.writes[k]));   // R18: raw on purpose (import has its own rollback)
      plan.removes.forEach((k) => storage.removeItem(k));   // R18: raw on purpose (import has its own rollback)
    } catch (e) {
      restoreImportBackup(storage);   // half-written import → roll back
      return { ok: false, errors: ['import failed and was rolled back: ' + e.message], written: 0, removed: 0 };
    }
    const result = { mode: plan.mode, written: written.length, removed: plan.removes.length };
    emit('v16:progress-imported', result);
    return Object.assign({ ok: true, errors: [], warnings: v.warnings }, result);
  }

  /** Put back exactly the app keys saved before the last import (keys added by the import are removed). */
  function restoreImportBackup(storage) {
    const EM = g.ExportModel;
    const b = readJson(storage, EM.BACKUP_KEY);
    if (!b || !b.keys || typeof b.keys !== 'object') return false;
    if (g.DataSafety) g.DataSafety.forget(storage, Object.keys(allEntries(storage)));   // R18: the backup wins
    Object.keys(allEntries(storage)).forEach((k) => { if (EM.isAppKey(k) && !(k in b.keys)) storage.removeItem(k); });   // R18: raw on purpose (import has its own rollback)
    Object.keys(b.keys).forEach((k) => storage.setItem(k, b.keys[k]));   // R18: raw on purpose (import has its own rollback)
    return true;
  }


  // ---- v16 R10: component-level writing diagnosis (DiagnosisModel), read side only. ----
  // R29-cleanup (Botfive, 18:10 JST): removed the write glue diagnoseWriting / diagnosisPractice /
  // noteDiagnosisPractised. No app code ever called it, and the live per-attempt weak-part record is R24 weak-spot
  // (v16-weakspot.js, key v16:weakspot, which also fires 'v16:diagnosis'). Wiring R10 too would write a second
  // record of the same attempts. weakComponents stays: stats and study cards read the 'diagnosis' key, which old
  // backups and imports may still carry.
  const DIAGNOSIS_KEY = 'diagnosis';

  function loadDiagnosis(storage) { return g.DiagnosisModel.sanitizeState(readJson(storage, DIAGNOSIS_KEY)); }

  /** Weak components right now: [{g, score, worstStroke, kanji, message}]. */
  function weakComponents(storage, now = Date.now()) {
    return g.DiagnosisModel.weakComponents(loadDiagnosis(storage), now)
      .map((w) => Object.assign(w, { message: g.DiagnosisModel.message(w) }));
  }

  // ---- v16 R11: example sentences / reading in context (see sentences-model.js header for the UI hooks) ----
  // Scheduling choice: a separate FSRS card 'ctx:<kanji>' through gradeKey (same retention, smoothing and load
  // budget via dueItems); the kanji's own card is untouched, and ctx cards are skipped by leech tracking.
  // R11b: sentences are split per JLPT level and loaded lazily (see sentences-model.js createStore).
  //   browser: context-sentences-n5.js is a normal <script> (precached); other levels are injected as <script> on
  //            first use and cached by the service worker at runtime; a failed load → offline fallback, no error.
  //   node:    level files are required.
  let sentenceStore = null;
  function levelFile(level) { return 'context-sentences-' + level.toLowerCase() + '.js'; }
  function loadLevelFile(level) {
    if (typeof module === 'object' && module.exports) return Promise.resolve(require('./' + levelFile(level)));
    return new Promise((resolve, reject) => {
      const doc = root.document;
      if (!doc) { reject(new Error('no document')); return; }
      const el = doc.createElement('script');
      el.src = levelFile(level);
      el.onload = () => { const d = (root.CONTEXT_SENTENCES || {})[level]; d ? resolve(d) : reject(new Error('empty ' + level)); };
      el.onerror = () => { el.remove(); reject(new Error('offline ' + level)); };
      doc.head.appendChild(el);
    });
  }
  function sentences(opts) {
    if (opts && opts.store) return opts.store;                     // tests / custom loaders
    if (opts && opts.data) return g.SentencesModel.createStore(() => Promise.reject(new Error('fixed'))).add(Object.assign({ level: 'X' }, opts.data, { index: Object.fromEntries(Object.keys(opts.data.kanji).map((k) => [k, opts.data.level || 'X'])) }));
    if (!sentenceStore) {
      sentenceStore = g.SentencesModel.createStore(loadLevelFile);
      const preset = g.CONTEXT_SENTENCES || {};
      Object.values(preset).forEach((d) => sentenceStore.add(d));
      if (!preset.N5 && typeof module === 'object' && module.exports) sentenceStore.add(require('./context-sentences-n5.js'));
    }
    return sentenceStore;
  }
  /** Known = rank > 0, or a component of the target kanji (component-first study). */
  function contextKnown(storage, kanji, kanjiMap) {
    const ranks = loadRanks(storage);
    const comps = new Set(kanjiMap ? g.GatingModel.componentsOf(kanji, kanjiMap) : []);
    return (k) => comps.has(k) || RM.getKanji(ranks, k).rank > 0;
  }
  /** True when the kanji's level file is loaded (sync calls then give its real sentences). */
  // R20: before the deferred 'sentences' group has loaded, sync calls answer "nothing loaded yet" (and start the
  // load); async calls wait for it. Callers passing opts.store / opts.data (tests) are unaffected.
  const sentencesOk = (opts) => !!(opts && (opts.store || opts.data)) || lazyReady('SentencesModel', 'sentences');
  const sentencesLoaded = () => (g.SentencesModel || !(root && root.V16Lazy) ? Promise.resolve() : root.V16Lazy.load('sentences'));
  function sentencesReady(kanji, opts) { return sentencesOk(opts) && sentences(opts).ready(kanji); }
  /** Load the kanji's level file; Promise<boolean> (false = offline / failed, never rejects). */
  function loadSentences(kanji, opts) {
    return sentencesLoaded().then(() => sentences(opts).ensure(kanji), () => false);
  }
  /** 1–2 example sentences, easiest for this learner first. Sync: what is loaded now (or the offline fallback);
   *  starts loading the level in the background when needed. */
  function sentencesFor(storage, kanji, opts = {}) {
    if (!sentencesOk(opts)) return [];   // R20: not loaded yet (load started)
    const st = sentences(opts);
    if (!st.ready(kanji)) st.ensure(kanji);
    return st.candidates(kanji, contextKnown(storage, kanji, opts.kanjiMap), opts.limit || 2);
  }
  /** Reading-in-context prompt now (null when nothing is loaded for the kanji). */
  function contextPrompt(storage, kanji, opts = {}) {
    if (!sentencesOk(opts)) return null;   // R20: not loaded yet (load started)
    const st = sentences(opts);
    if (!st.ready(kanji)) st.ensure(kanji);
    return st.prompt(kanji, contextKnown(storage, kanji, opts.kanjiMap));
  }
  /** Same, after loading the level (falls back gracefully offline). Never rejects. */
  function contextPromptAsync(storage, kanji, opts = {}) {
    if (!sentencesOk(opts)) return sentencesLoaded().then(() => contextPromptAsync(storage, kanji, opts), () => null);   // R20
    const st = sentences(opts);   // (no second background load here: a failed level waits for the next call)
    return st.ensure(kanji).catch(() => false).then(() => st.prompt(kanji, contextKnown(storage, kanji, opts.kanjiMap)));
  }
  /** Grade a typed reading (R5 PartialCredit) and schedule the ctx:<kanji> card; emits v16:context-graded. */
  function gradeContext(storage, prompt, answer, opts = {}) {
    const now = opts.now ?? Date.now();
    const r = g.SentencesModel.grade(prompt, answer, g.PartialCredit);
    const card = gradeKey(storage, prompt.key, r.grade, now);
    emit('v16:context-graded', { kanji: prompt.kanji, jaId: prompt.jaId, verdict: r.verdict, grade: r.grade, readingCertain: r.readingCertain });
    return Object.assign({}, r, { card });
  }
  /** Due context-card keys, most overdue first. */
  function contextDue(storage, now = Date.now()) {
    return dueItems(storage, now).filter((i) => i.key.startsWith('ctx:') && i.due <= now).sort((a, b) => a.due - b.due).map((i) => i.key);
  }

  // ---- v16 R18: data safety hooks (logic in data-safety.js; docs in kanji-team/R18-safety-hooks.md) -----------
  /** {due, daysSinceExport, persisted, reason}: show "Export a backup" on home/settings when due. */
  function backupReminder(storage, opts) { return g.DataSafety.backupReminder(storage, opts); }
  function markExported(storage, now) { return g.DataSafety.markExported(storage, now); }
  function snoozeBackupReminder(storage, days, now) { return g.DataSafety.snooze(storage, days, now); }
  /** After the user confirmed: restore the surviving backup through importProgress (merge). Promise. */
  function restoreFromSurvivingBackup(storage, opts = {}) {
    return g.DataSafety.restoreSurviving(storage, Object.assign({ importProgress, buildExport: g.ExportModel.buildExport }, opts));
  }
  /** Call when a lesson has finished; the first time ever it asks for persistent storage. Promise. */
  function onLessonComplete(storage, opts) { return g.DataSafety.requestPersistOnce(storage, opts); }

  /**
   * Startup (one index.html init line, after the migrations). Records persisted(), checks the quota, looks for a
   * surviving backup when local progress is gone (emits 'v16:recovery-available'), else refreshes the daily
   * IndexedDB mirror. Hooks: 'v16:lesson-complete' → persist once; the page's global lessonEnd() is wrapped to
   * emit that event; visibilitychange → retry pending writes. opts: {navigator, indexedDB, now}. Promise.
   */
  async function setupDataSafety(storage, win, opts = {}) {
    const DS = g.DataSafety;
    if (!DS) return null;
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('v16:lesson-complete', () => { DS.requestPersistOnce(storage, opts).catch(() => {}); });
      if (typeof win.lessonEnd === 'function' && !win.lessonEnd.r18) {
        const original = win.lessonEnd;
        win.lessonEnd = function () {   // the end-of-lesson card: the lesson is finished
          const r = original.apply(this, arguments);
          DS.emit('v16:lesson-complete', {});
          return r;
        };
        win.lessonEnd.r18 = true;
      }
      if (win.document) win.document.addEventListener('visibilitychange', () => DS.retryPending(storage));
    }
    const persisted = await DS.checkPersisted(storage, opts);
    const quota = await DS.checkQuota(opts);
    const recovery = await DS.detectRecovery(storage, Object.assign({ buildExport: g.ExportModel.buildExport }, opts));
    const mirrored = recovery ? false : await DS.mirrorBackup(
      JSON.stringify(g.ExportModel.buildExport(allEntries(storage), opts.now || Date.now()), null, 1), opts);
    return { persisted, quota, recovery, mirrored };
  }

  const api = { MIGRATION_KEY, CORRUPT_BACKUP_KEY, BORDERLINE_REASONS, MAX_BORDERLINE_PER_BOX, boxVerdict, loadRanks, saveRanks, snapshot, migrateOnce, classifyReject,
           onReadingResult, onWritingBox, onKanjiComplete, onOverride, applyPlacement, applyLevelCheck,
           practiceQueue, tierOf, readRec, progressOf, recFinish, dueCounts, dueList, gateBlockers, mixedReviewQueue, levelCheckOrder,
           GATE_OVERRIDE_KEY, gateOverrides, gateOverridden, overrideGate, gateStatus,
           HABIT_KEY, habit, recordReview, setHabitGoal, addStreakFreeze,
           SCHED_KEY, SCHED_MIGRATED_KEY, SCHED_BACKUP_KEY, migrateScheduler,
           REC_CORRUPT_PREFIX, backupCorruptRecs, reseedFromNewerRecs, onReviewDone, onLapse, undoLastGrade, cardOf,
           // v16 R5–R8
           CONTRAST_KEY, LEECH_KEY, recordConfusion, dueContrasts, foldContrasts, completeContrast, lessonPick,
           leechList, leechRestudy, HOMOPHONE_SPACING_KEY, homophoneSpacingSetting, setHomophoneSpacing,
           READING_FONT_KEY, READING_FACES, readingFontSetting, setReadingFont, readingFontFor, readingFontAvailable, availableReadingFaces,   // R31 + RC16 fallback
           PRETEST_KEY, PRETEST_STATS_KEY, meaningPretestSetting, setMeaningPretest, meaningPretest, recordPretestGuess, pretestStats,   // R33
           recentKanji, completeLeechRestudy, dismissLeech, undismissLeech, dismissedLeeches, scaffoldFor, pickNewLesson, STUDY_ORDER_KEY, studyOrderSetting,
           // port of 03–05: load budget, retention + smoothing, vacation + backlog
           LOAD_SETTINGS_KEY, LOAD_TODAY_KEY, loadStatus, loadSettings, setLoadSettings, noteNewIntroduced,
           SCHED_SETTINGS_KEY, schedSettings, setSchedSettings,
           VACATION_KEY, vacationStatus, startVacation, endVacation, backlogPlan,
           exportProgress, exportCsv, checkImport, importProgress, restoreImportBackup,
           DIAGNOSIS_KEY, weakComponents,
           sentencesFor, contextPrompt, gradeContext, contextDue,
           sentencesReady, loadSentences, contextPromptAsync,
           stats, flushStudyTime, setupSessionTiming, componentFamily, componentFamilies, drawableGroups,
           // v16 R18 data safety
           backupReminder, markExported, snoozeBackupReminder, restoreFromSurvivingBackup, onLessonComplete, setupDataSafety };
  return api;
});
