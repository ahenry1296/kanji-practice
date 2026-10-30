/*
 * export-model.js — progress export / import (v16 lane item R9). Pure: no DOM, no storage access.
 * Works on plain {key: rawString} maps so V15 glue (v15-integration.js) owns all reading and writing.
 * Exposes window.ExportModel; also CommonJS for tests.
 *
 * File format (FORMAT = 'kanji-progress', VERSION = 1):
 *   { format, version, exportedAt: ISO, app: 'v16', keys: { <storageKey>: <raw string value> } }
 * Values are stored as the exact raw strings from localStorage, so an export → import round trip is lossless.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExportModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 'kanji-progress';
  const VERSION = 1;
  const BACKUP_KEY = 'export:backup';   // last pre-import snapshot (never exported itself)

  // Which storage keys belong to the app. Exact names plus prefixes; anything else (other sites' junk) is ignored.
  const EXACT_KEYS = ['ranks', 'ranks:migrated', 'sched', 'sched:migrated', 'sched:settings', 'habit', 'contrast',
    'leech', 'vacation', 'settings', 'diagnosis', 'lv', 'set', 'v16:gate-override'];
  const PREFIXES = ['rec:', 'hints:', 'load:', 'v16:'];
  // Recovery copies: not progress, would only bloat the file and could resurrect old data.
  const EXCLUDED = [BACKUP_KEY, 'sched:backup', 'ranks:corrupt'];
  const EXCLUDED_PREFIXES = ['rec:corrupt:'];   // byte-for-byte copies of corrupt rec: values (V16-RC fix 1)
  // Keys whose value must be valid JSON (an object) for the file to pass validation.
  const JSON_KEYS = ['ranks', 'sched', 'sched:settings', 'habit', 'contrast', 'leech', 'vacation', 'settings', 'diagnosis', 'v16:weakspot', 'v16:notes', 'v16:known-import', 'v16:study-order', 'v16:unlock', 'v16:reading-font', 'v16:meaning-pretest', 'v16:pretest-stats'];   // R24: v16:weakspot is exported by the v16: prefix; listed here so import checks it is JSON; R25/R26/R27/R28/R31: same for v16:notes, v16:known-import, v16:study-order, v16:unlock, v16:reading-font; R33: v16:meaning-pretest, v16:pretest-stats
  const MAX_KEYS = 20000;               // sanity cap against a bogus/huge file

  function isAppKey(key) {
    if (typeof key !== 'string' || EXCLUDED.includes(key) || EXCLUDED_PREFIXES.some((p) => key.startsWith(p))) return false;
    return EXACT_KEYS.includes(key) || PREFIXES.some((p) => key.startsWith(p));
  }

  function parse(raw) { try { return JSON.parse(raw); } catch (e) { return undefined; } }
  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

  /** Build the export object from a {key: raw} map (non-app keys dropped). */
  function buildExport(entries, now) {
    const keys = {};
    Object.keys(entries || {}).sort().forEach((k) => {
      if (isAppKey(k) && typeof entries[k] === 'string') keys[k] = entries[k];
    });
    return { format: FORMAT, version: VERSION, exportedAt: new Date(now).toISOString(), app: 'v16', keys };
  }

  /**
   * Validate a parsed (or raw string) export file. Returns {ok, errors[], warnings[], data}.
   * data.keys holds only app keys. Unknown keys are dropped with a warning, not an error.
   */
  function validate(input) {
    const errors = []; const warnings = [];
    const obj = typeof input === 'string' ? parse(input) : input;
    if (!isObj(obj)) return { ok: false, errors: ['not a JSON object'], warnings, data: null };
    if (obj.format !== FORMAT) errors.push('wrong format (expected "' + FORMAT + '")');
    if (!Number.isInteger(obj.version) || obj.version < 1) errors.push('missing version');
    else if (obj.version > VERSION) errors.push('file is from a newer app version (' + obj.version + ')');
    if (!isObj(obj.keys)) errors.push('missing keys');
    const keys = {};
    if (isObj(obj.keys)) {
      const names = Object.keys(obj.keys);
      if (names.length > MAX_KEYS) errors.push('too many keys');
      names.forEach((k) => {
        const v = obj.keys[k];
        if (!isAppKey(k)) { warnings.push('ignored unknown key ' + k); return; }
        if (typeof v !== 'string') { errors.push(k + ': value must be a string'); return; }
        const mustJson = JSON_KEYS.includes(k) || k.startsWith('rec:');
        if (mustJson && !isObj(parse(v))) { errors.push(k + ': not a valid JSON object'); return; }
        keys[k] = v;
      });
      const ranks = keys.ranks && parse(keys.ranks);
      if (ranks && !isObj(ranks.kanji)) errors.push('ranks: missing kanji map');
      const sched = keys.sched && parse(keys.sched);
      if (sched && !isObj(sched.cards)) errors.push('sched: missing cards map');
    }
    const ok = errors.length === 0;
    return { ok, errors, warnings, data: ok ? Object.assign({}, obj, { keys }) : null };
  }

  // ---- merge helpers: "newer wins" per item, existing data kept when in doubt --------------------------------

  const time = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : -Infinity; };
  // rec: newer lastPracticed wins; a record with only nextReview (older builds) falls back to that date.
  const recTime = (r) => (Number.isFinite(time(r && r.lastPracticed)) ? time(r.lastPracticed) : time(r && r.nextReview));
  const cardTime = (c) => time(c && c.last);
  // A rank record has no timestamp: the higher rank (then more progress) wins, so a merge never demotes.
  const rankScore = (r) => (r && Number(r.rank)) || 0;

  /** Merge two map objects item by item; pick(a, b) returns true when incoming b should replace a. */
  function mergeMap(cur, inc, pick) {
    const out = Object.assign({}, cur);
    Object.keys(inc || {}).forEach((k) => { if (!(k in out) || pick(out[k], inc[k])) out[k] = inc[k]; });
    return out;
  }

  function mergeValue(key, curRaw, incRaw) {
    if (curRaw == null) return incRaw;
    const cur = parse(curRaw); const inc = parse(incRaw);
    if (key.startsWith('rec:') && isObj(cur) && isObj(inc)) return recTime(inc) > recTime(cur) ? incRaw : curRaw;
    if (key === 'sched' && isObj(cur) && isObj(inc) && isObj(cur.cards) && isObj(inc.cards)) {
      return JSON.stringify(Object.assign({}, cur, { cards: mergeMap(cur.cards, inc.cards, (a, b) => cardTime(b) > cardTime(a)) }));
    }
    if (key === 'ranks' && isObj(cur) && isObj(inc) && isObj(cur.kanji) && isObj(inc.kanji)) {
      return JSON.stringify(Object.assign({}, cur, { kanji: mergeMap(cur.kanji, inc.kanji, (a, b) => rankScore(b) > rankScore(a)) }));
    }
    if ((key === 'leech' || key === 'contrast') && isObj(cur) && isObj(inc)) {
      return JSON.stringify(Object.assign({}, inc, cur));   // union, this device's entries win
    }
    return curRaw;   // settings, habit, vacation, load:*, lv, …: keep this device's value
  }

  /**
   * Plan an import. mode 'merge' (default) or 'replace'.
   * Returns {writes: {key: raw}, removes: [key], backup: {key: raw}} — the glue applies it after saving backup.
   * replace: every current app key not in the file is removed. merge: nothing is removed.
   */
  function planImport(current, data, mode) {
    const cur = {}; Object.keys(current || {}).forEach((k) => { if (isAppKey(k)) cur[k] = current[k]; });
    const inc = (data && data.keys) || {};
    const writes = {}; const removes = [];
    if (mode === 'replace') {
      Object.assign(writes, inc);
      Object.keys(cur).forEach((k) => { if (!(k in inc)) removes.push(k); });
    } else {
      Object.keys(inc).forEach((k) => {
        const v = mergeValue(k, cur[k], inc[k]);
        if (v !== cur[k]) writes[k] = v;
      });
    }
    return { mode: mode === 'replace' ? 'replace' : 'merge', writes, removes, backup: cur };
  }

  // ---- CSV -------------------------------------------------------------------------------------------------

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * CSV of kanji progress: kanji,rank,due,stability,lapses (one row per kanji seen in ranks, sched or rec:).
   * rank = tier name when tiers given, else the number. due = ISO date of the FSRS card (or the rec's nextReview).
   */
  function toCsv(entries, tiers) {
    const ranks = parse(entries.ranks); const sched = parse(entries.sched);
    const rk = isObj(ranks) && isObj(ranks.kanji) ? ranks.kanji : {};
    const cards = isObj(sched) && isObj(sched.cards) ? sched.cards : {};
    // R11: only kanji rows; 'ctx:'/'w:' cards are internal (they stay in the JSON export)
    const set = new Set([...Object.keys(rk), ...Object.keys(cards).filter((k) => !k.includes(':'))]);
    Object.keys(entries).forEach((k) => { if (k.startsWith('rec:') && isAppKey(k)) set.add(k.slice(4)); }); // no recovery copies
    const rows = [['kanji', 'rank', 'due', 'stability', 'lapses']];
    [...set].sort().forEach((k) => {
      const r = rk[k]; const c = cards[k]; const rec = parse(entries['rec:' + k]);
      const n = r && Number.isFinite(Number(r.rank)) ? Number(r.rank) : 0;
      const dueT = c && Number.isFinite(Number(c.due)) ? Number(c.due) : time(isObj(rec) && rec.nextReview);
      rows.push([k, tiers && tiers[n] ? tiers[n] : n, Number.isFinite(dueT) ? new Date(dueT).toISOString() : '',
        c && Number.isFinite(Number(c.stability)) ? Number(c.stability) : '', c && Number.isFinite(Number(c.lapses)) ? Number(c.lapses) : '']);
    });
    return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
  }

  return { FORMAT, VERSION, BACKUP_KEY, EXACT_KEYS, PREFIXES, isAppKey, buildExport, validate, planImport, mergeValue, toCsv };
});
