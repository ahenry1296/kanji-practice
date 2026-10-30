/**
 * v16 R18 (Botfive): data safety on iOS / Safari, which can evict site data.
 *
 *  1. Persistence  requestPersistOnce() asks navigator.storage.persist() ONCE, after the first finished lesson
 *                  (event 'v16:lesson-complete'); checkPersisted() reads persisted() at startup. Both are stored in
 *                  the 'v16:safety' key with a timestamp. A missing API is recorded as {supported:false}.
 *  2. Quota        checkQuota() → navigator.storage.estimate() with a near-full threshold (80 %).
 *                  safeSet() wraps every app-logic setItem: on any write error the value is kept in an in-memory
 *                  retry queue (safeGet() reads through it, so a pending grade is never lost or overwritten by a
 *                  stale read), the capped logs are trimmed, the queue is retried, and if it still fails
 *                  'v16:storage-error' {key, reason, pending} is emitted. Later writes and retryPending() flush it;
 *                  'v16:storage-ok' {flushed} fires when the queue drains again.
 *  3. Reminder     backupReminder() → {due, daysSinceExport, persisted, reason}: when storage is not persisted,
 *                  suggest an export after every 7 study days (days in the stats / study-time logs) since the
 *                  last export. markExported() / snooze().
 *  4. Recovery     'export:backup' lives in localStorage (pre-import snapshot), so a wipe kills it too. The latest
 *                  full export is mirrored to IndexedDB (daily, and after each export). At startup, if
 *                  localStorage has no progress but a backup survives, 'v16:recovery-available' {source, at,
 *                  kanji, keys} is emitted. Restoring needs an explicit {confirm:true} from the UI.
 *
 * Safari note: a full ITP eviction also clears IndexedDB; the mirror protects against localStorage-only loss and
 * corruption. Only an exported file is fully safe, which is why the reminder exists.
 *
 * No DOM. All browser objects are injectable (opts.navigator, opts.indexedDB) so node tests can fake them.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DataSafety = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const STATE_KEY = 'v16:safety';              // {persist:{asked,result,at}, persisted:{value,at,supported}, lastExport, snoozeUntil}
  const LOG_KEYS = ['v16:stats-log', 'v16:study-time'];   // capped logs, trimmed first when storage is full
  const TRIM_MIN_DAYS = 7;                     // never trim a log below a week
  const NEAR_FULL = 0.8;                       // usage / quota at which we warn
  const REMIND_DAYS = 7;                       // study days between export reminders
  const DAY_MS = 864e5;
  const MIRROR_EVERY_MS = DAY_MS;              // IndexedDB mirror throttle
  const IDB_NAME = 'kanji-safety', IDB_STORE = 'backup', IDB_KEY = 'latest';

  // ---- events ----
  function emit(name, detail) {
    const t = root && typeof root.dispatchEvent === 'function' ? root
      : (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' ? globalThis : null);
    const CE = (t && t.CustomEvent) || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (t && CE) t.dispatchEvent(new CE(name, { detail }));
  }

  // ---- 2. safe writes with an in-memory retry queue ----
  /** One queue (Map key → raw value, insertion order) per storage object. */
  const queues = new WeakMap();
  function queueOf(storage) {
    let q = queues.get(storage);
    if (!q) { q = new Map(); queues.set(storage, q); }
    return q;
  }
  function isQuota(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
  }
  /** setItem that returns the error instead of throwing. */
  function rawSet(storage, key, value) {
    try { storage.setItem(key, value); return null; } catch (e) { return e || new Error('write failed'); }
  }
  /** Write queued values in order; stops at the first failure. Returns that error or null. */
  function flushQueue(storage) {
    const q = queueOf(storage);
    for (const [k, v] of [...q]) {
      const e = rawSet(storage, k, v);
      if (e) return e;
      q.delete(k);
    }
    return null;
  }
  /** Read through the queue: a pending value wins over what is (still) on disk. */
  function safeGet(storage, key) {
    const q = queues.get(storage);
    return q && q.has(key) ? q.get(key) : storage.getItem(key);
  }
  /** Keys only in the queue (not yet on disk), for listing all entries. */
  function pendingEntries(storage) {
    const q = queues.get(storage);
    return q ? Object.fromEntries(q) : {};
  }
  function pendingCount(storage) { const q = queues.get(storage); return q ? q.size : 0; }

  /**
   * Shrink the capped logs (oldest days first) to free space: each log keeps max(7, half) of its days.
   * Works on the queued value when the log itself is pending. Returns the number of days dropped.
   */
  function trimLogs(storage) {
    const q = queueOf(storage);
    let dropped = 0;
    for (const key of LOG_KEYS) {
      let log;
      try { log = JSON.parse(safeGet(storage, key)); } catch (_) { continue; }
      if (!log || !log.days || typeof log.days !== 'object') continue;
      const days = Object.keys(log.days).sort();
      const keep = Math.max(TRIM_MIN_DAYS, Math.floor(days.length / 2));
      if (days.length <= keep) continue;
      const next = Object.assign({}, log, { days: {} });
      days.slice(-keep).forEach((d) => { next.days[d] = log.days[d]; });
      dropped += days.length - keep;
      const raw = JSON.stringify(next);
      if (q.has(key)) q.set(key, raw);
      else rawSet(storage, key, raw);   // smaller than before; if even this fails there is nothing more to do here
    }
    return dropped;
  }

  /**
   * Write key=value, never throwing and never dropping the value. Returns true when everything (this value and
   * any earlier pending ones) is on disk, false when it is still queued (and 'v16:storage-error' was emitted).
   */
  function safeSet(storage, key, value) {
    const q = queueOf(storage);
    const hadPending = q.size > 0;
    q.delete(key); q.set(key, String(value));   // newest value last, replacing an older pending one
    let err = flushQueue(storage);
    if (err) { trimLogs(storage); err = flushQueue(storage); }
    if (!err) {
      if (hadPending) emit('v16:storage-ok', { flushed: true });
      return true;
    }
    emit('v16:storage-error', { key, reason: isQuota(err) ? 'quota' : String(err.message || err.name || err), pending: q.size });
    return false;
  }
  /** Remove a key on disk and from the queue (a later remove must not be undone by an old pending write). */
  function safeRemove(storage, key) {
    queueOf(storage).delete(key);
    try { storage.removeItem(key); } catch (_) { /* nothing to free */ }
  }
  /** Drop pending values for keys written directly (import / undo import), so an old value never overwrites them. */
  function forget(storage, keys) { const q = queues.get(storage); if (q) keys.forEach((k) => q.delete(k)); }
  /** Retry pending writes (call on visibilitychange / after the user frees space). True when the queue is empty. */
  function retryPending(storage) {
    if (!pendingCount(storage)) return true;
    let err = flushQueue(storage);
    if (err) { trimLogs(storage); err = flushQueue(storage); }
    if (!err) emit('v16:storage-ok', { flushed: true });
    return !err;
  }

  // ---- state key ----
  function readState(storage) {
    try { const s = JSON.parse(safeGet(storage, STATE_KEY)); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; }
  }
  function writeState(storage, patch) {
    const s = Object.assign(readState(storage), patch);
    safeSet(storage, STATE_KEY, JSON.stringify(s));
    return s;
  }
  function storageApi(opts) {
    const nav = (opts && opts.navigator) || (root && root.navigator);
    return nav && nav.storage ? nav.storage : null;
  }

  // ---- 1. persistence ----
  /** Startup: read persisted() and record it. Resolves {supported, value}. */
  async function checkPersisted(storage, opts = {}) {
    const sa = storageApi(opts), now = opts.now || Date.now();
    if (!sa || typeof sa.persisted !== 'function') {
      writeState(storage, { persisted: { supported: false, value: false, at: now } });
      return { supported: false, value: false };
    }
    let value = false;
    try { value = !!(await sa.persisted()); } catch (_) { value = false; }
    writeState(storage, { persisted: { supported: true, value, at: now } });
    return { supported: true, value };
  }
  /**
   * Ask for persistent storage once ever (after the first finished lesson). Returns the recorded result, or
   * null when it was already asked. persist() may resolve false (the browser decides); that is recorded too.
   */
  async function requestPersistOnce(storage, opts = {}) {
    const s = readState(storage);
    if (s.persist && s.persist.asked) return null;
    const sa = storageApi(opts), now = opts.now || Date.now();
    let result, supported = !!(sa && typeof sa.persist === 'function');
    // Mark as asked BEFORE awaiting so a second lesson-complete during the prompt cannot ask twice.
    writeState(storage, { persist: { asked: true, supported, result: null, at: now } });
    if (!supported) result = false;
    else { try { result = !!(await sa.persist()); } catch (_) { result = false; } }
    writeState(storage, { persist: { asked: true, supported, result, at: now },
      persisted: { supported, value: result, at: now } });
    return { supported, result };
  }

  // ---- 2b. quota estimate ----
  /** {supported, usage, quota, ratio, nearFull}; emits 'v16:storage-near-full' when ratio ≥ 80 %. */
  async function checkQuota(opts = {}) {
    const sa = storageApi(opts);
    if (!sa || typeof sa.estimate !== 'function') return { supported: false, usage: null, quota: null, ratio: null, nearFull: false };
    try {
      const { usage = 0, quota = 0 } = await sa.estimate();
      const ratio = quota ? usage / quota : null;
      const r = { supported: true, usage, quota, ratio, nearFull: ratio != null && ratio >= (opts.threshold || NEAR_FULL) };
      if (r.nearFull) emit('v16:storage-near-full', r);
      return r;
    } catch (_) {
      return { supported: false, usage: null, quota: null, ratio: null, nearFull: false };
    }
  }

  // ---- 3. backup reminder ----
  function dayKey(t, tz) { return new Date(t + tz * 60000).toISOString().slice(0, 10); }
  /** Study days = union of days in the stats and study-time logs. */
  function studyDays(storage) {
    const set = new Set();
    for (const key of LOG_KEYS) {
      try { const l = JSON.parse(safeGet(storage, key)); if (l && l.days) Object.keys(l.days).forEach((d) => set.add(d)); } catch (_) { /* skip */ }
    }
    return [...set].sort();
  }
  /**
   * {due, daysSinceExport, persisted, reason}. daysSinceExport counts STUDY days after the last export day
   * (all study days if never exported). opts: {now, tzOffsetMin (default Tokyo +540)}.
   */
  function backupReminder(storage, opts = {}) {
    const now = opts.now || Date.now(), tz = Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : 540;
    const s = readState(storage);
    const persisted = !!(s.persisted && s.persisted.value);
    const since = s.lastExport ? dayKey(s.lastExport, tz) : '';
    const daysSinceExport = studyDays(storage).filter((d) => d > since).length;
    const out = (due, reason) => ({ due, daysSinceExport, persisted, reason });
    if (persisted) return out(false, 'storage is persistent');
    if (s.snoozeUntil && now < s.snoozeUntil) return out(false, 'snoozed');
    if (daysSinceExport < REMIND_DAYS) return out(false, `${daysSinceExport} of ${REMIND_DAYS} study days since the last export`);
    return out(true, s.lastExport
      ? `${daysSinceExport} study days since your last export, and this browser may clear saved data`
      : `${daysSinceExport} study days and no export yet, and this browser may clear saved data`);
  }
  function markExported(storage, now = Date.now()) { return writeState(storage, { lastExport: now, snoozeUntil: null }); }
  function snooze(storage, days = 1, now = Date.now()) { return writeState(storage, { snoozeUntil: now + days * DAY_MS }); }

  // ---- 4. IndexedDB mirror + recovery ----
  function idbOf(opts) { return (opts && opts.indexedDB) || (root && root.indexedDB) || null; }
  function idbOpen(idb) {
    return new Promise((res, rej) => {
      const r = idb.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function idbTx(db, mode, fn) {
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, mode), st = tx.objectStore(IDB_STORE);
      const req = fn(st);
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  }
  /** The mirrored backup {at, text} or null (also null without IndexedDB). */
  async function readMirror(opts = {}) {
    const idb = idbOf(opts);
    if (!idb) return null;
    try { const db = await idbOpen(idb); const v = await idbTx(db, 'readonly', (s) => s.get(IDB_KEY)); db.close(); return v || null; } catch (_) { return null; }
  }
  /**
   * Save exportText to IndexedDB. Throttled to once a day unless opts.force (after an export). Resolves true when
   * written. Never mirrors a progress-less export (a wiped localStorage must not overwrite a good backup).
   */
  async function mirrorBackup(exportText, opts = {}) {
    const idb = idbOf(opts), now = opts.now || Date.now();
    if (!idb || !exportText || !summarize(exportText).kanji) return false;
    try {
      const db = await idbOpen(idb);
      const old = await idbTx(db, 'readonly', (s) => s.get(IDB_KEY));
      if (!opts.force && old && now - old.at < MIRROR_EVERY_MS) { db.close(); return false; }
      await idbTx(db, 'readwrite', (s) => s.put({ at: now, text: exportText }, IDB_KEY));
      db.close();
      return true;
    } catch (_) { return false; }
  }
  /** {keys, kanji} of an export text (kanji = rec: keys that are not words). */
  function summarize(text) {
    try {
      const keys = Object.keys(JSON.parse(text).keys || {});
      return { keys: keys.length, kanji: keys.filter((k) => k.startsWith('rec:') && !k.startsWith('rec:w:')).length || keys.filter((k) => k.startsWith('rec:')).length };
    } catch (_) { return { keys: 0, kanji: 0 }; }
  }
  /** True when localStorage holds no progress (no rec: keys and no scheduler cards); migrate markers don't count. */
  function progressEmpty(storage) {
    for (let i = 0; i < storage.length; i += 1) { const k = storage.key(i); if (k && k.startsWith('rec:')) return false; }
    try { const s = JSON.parse(safeGet(storage, 'sched')); if (s && s.cards && Object.keys(s.cards).length) return false; } catch (_) { /* corrupt = empty */ }
    return true;
  }
  /**
   * Find a surviving backup when local progress is gone: IndexedDB mirror first, then 'export:backup'.
   * Resolves {source:'indexeddb'|'export:backup', at, text, kanji, keys} or null.
   * buildExport(keys, at) turns the export:backup snapshot into import text (ExportModel.buildExport).
   */
  async function findSurvivingBackup(storage, opts = {}) {
    if (!progressEmpty(storage)) return null;
    const m = await readMirror(opts);
    if (m && m.text && summarize(m.text).kanji) return Object.assign({ source: 'indexeddb', at: m.at, text: m.text }, summarize(m.text));
    try {
      const b = JSON.parse(safeGet(storage, 'export:backup'));
      if (b && b.keys && opts.buildExport) {
        const text = JSON.stringify(opts.buildExport(b.keys, b.at));
        if (summarize(text).kanji) return Object.assign({ source: 'export:backup', at: b.at, text }, summarize(text));
      }
    } catch (_) { /* none */ }
    return null;
  }
  /** Startup check: emits 'v16:recovery-available' {source, at, kanji, keys} (no text) and resolves it, or null. */
  async function detectRecovery(storage, opts = {}) {
    const f = await findSurvivingBackup(storage, opts);
    if (!f) return null;
    const summary = { source: f.source, at: f.at, kanji: f.kanji, keys: f.keys };
    emit('v16:recovery-available', summary);
    return summary;
  }
  /**
   * Restore through the existing import path (opts.importProgress(storage, text, {mode:'merge'})). Refuses
   * without opts.confirm === true: the UI must ask the user first. Resolves the import result + source.
   */
  async function restoreSurviving(storage, opts = {}) {
    if (opts.confirm !== true) return { ok: false, errors: ['restore needs the user to confirm first'] };
    const f = await findSurvivingBackup(storage, opts);
    if (!f) return { ok: false, errors: ['no surviving backup found'] };
    const r = opts.importProgress(storage, f.text, { mode: 'merge' });
    return Object.assign({ source: f.source, at: f.at }, r);
  }

  return { STATE_KEY, LOG_KEYS, NEAR_FULL, REMIND_DAYS, TRIM_MIN_DAYS, IDB_NAME,
    emit, isQuota, safeSet, safeGet, safeRemove, forget, retryPending, pendingCount, pendingEntries, trimLogs, readState,
    checkPersisted, requestPersistOnce, checkQuota, studyDays, backupReminder, markExported, snooze,
    readMirror, mirrorBackup, summarize, progressEmpty, findSurvivingBackup, detectRecovery, restoreSurviving };
});
