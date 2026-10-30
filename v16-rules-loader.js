/**
 * v16 R21: lazy loading of the look-alike rule files proportion-rules-N4..N1.js (about 460 KB), with a hard gate:
 * no stroke is graded before the rule file for its character has run.
 *
 * Why a gate: the stroke checker reads rules as (window.PROPORTION_RULES || {})[char] (ruleGate in index.html). A
 * rule file that has not loaded yet looks exactly like "this character has no rules", so grading early would
 * silently accept look-alikes (已 for 己). The gate never lets that happen.
 *
 * Which file a character needs comes from proportion-rules-index.js (generated from the rule files by
 * tools/build-rules-index.js). Characters in no file have no rules anywhere and are always ready, exactly as before.
 * Every character is in at most one file, so load order cannot change which rule wins: lazy and eager loading
 * register identical rules (proved by tests/test_rules_loader.js and the R21 replay, see kanji-team/R21-rules-loader.md).
 *
 * API (window.V16Rules):
 *   levelOf(char)            'kana' | 'N5' .. 'N1' | null (no rules)
 *   isLevelLoaded(level)     true once every rule of that file is registered
 *   isReady(chars)           true when every rule file those characters need is registered
 *   loadLevel(level)         Promise<true>; one request per file (promise cached), rejects with a clear Error
 *                            on failure; a later call retries
 *   loadForKanji(chars)      Promise<true> once every needed file is in (mixed-level lists wait for all of them)
 *   holdStroke(char, pad, grade)   the grading guard, see below
 *   isHeld(pad)              true while a stroke on that pad waits for rules (index.html blocks Undo/Clear then)
 *   retry()                  retry every failed file and grade the strokes that were waiting on it
 *                            (also automatic: backoff 1 s, 2 s, 4 s … max 30 s while strokes wait, and on 'online')
 *   loading                  true while any rule file is being fetched (the flag for Botfour's UI)
 *   error                    the last load Error, or null
 * Events on window (for Botfour's UI): 'v16:rules-loading' {levels}, 'v16:rules-ready' {levels},
 *   'v16:rules-error' {level, error}. While a held stroke waits on a failed file, a small
 *   alert bar (#v16-rules-error, role=alert) with a Retry button is shown; it goes away once the rules are in.
 *   R21-fix1: the bar is plain DOM with inline styles so it works without any B4 file; Botfour may restyle it.
 */
(function () {
  'use strict';

  /** Rule files in index.html's old eager order. kana and N5 stay eager script tags; N4..N1 load on demand. */
  const LEVELS = ['kana', 'N5', 'N4', 'N3', 'N2', 'N1'];
  const fileOf = (level) => `proportion-rules-${level}.js`;

  const pending = new Map();   // level -> Promise of the load in flight (or done)
  const loaded = new Set();    // levels whose rules are all registered
  const held = [];             // strokes waiting for rules: { char, pad, grade, stroke, count, lockedByR21 }
  const RETRY_MIN_MS = 1000;   // automatic retry backoff while strokes wait on a failed file: 1 s, 2 s, 4 s … 30 s
  const RETRY_MAX_MS = 30000;
  let retryTimer = null;
  let retryAttempt = 0;
  let ownerOf = null;          // char -> level, built from PROPORTION_RULES_INDEX on first use

  const api = { loading: false, error: null };

  /** char -> level map from the generated index (empty if the index is missing: then nothing is lazy-known). */
  function owners() {
    if (!ownerOf) {
      ownerOf = new Map();
      const index = window.PROPORTION_RULES_INDEX || {};
      for (const level of LEVELS) {
        (index[level] || []).forEach((c) => ownerOf.set(c, level));
      }
    }
    return ownerOf;
  }

  api.levelOf = (char) => owners().get(char) || null;

  /** A file counts as loaded when every character the index gives it has rules registered (works for eager tags too). */
  api.isLevelLoaded = (level) => {
    if (loaded.has(level)) {
      return true;
    }
    const chars = (window.PROPORTION_RULES_INDEX || {})[level];
    const rules = window.PROPORTION_RULES || {};
    if (chars && chars.length && chars.every((c) => rules[c])) {
      loaded.add(level);
      return true;
    }
    return false;
  };

  /** Distinct levels the characters need (characters without rules need none). Accepts a string or an array. */
  function levelsFor(chars) {
    const list = typeof chars === 'string' ? [chars] : Array.from(chars || []);
    return [...new Set(list.map(api.levelOf).filter(Boolean))];
  }

  api.isReady = (chars) => levelsFor(chars).every(api.isLevelLoaded);

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (_) { /* very old engines: the flag still works */ }
  }

  function updateFlag() {
    const busy = [...pending.keys()].filter((level) => !api.isLevelLoaded(level));
    api.loading = busy.length > 0;
  }

  /** Inject the rule file's script tag (from the network or the service-worker cache). Resolves true / false. */
  function injectScript(level) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = fileOf(level);
      script.dataset.v16Rules = level;
      script.onload = () => resolve(true);
      script.onerror = () => {
        script.remove();   // a retry adds a fresh tag
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  /**
   * Load one rule file once. Concurrent callers share one request; after a failure the cached promise is dropped
   * so the next call (or retry()) fetches again.
   */
  api.loadLevel = (level) => {
    if (!LEVELS.includes(level)) {
      return Promise.reject(new Error(`V16Rules: unknown rule level "${level}"`));
    }
    if (api.isLevelLoaded(level)) {
      return Promise.resolve(true);
    }
    if (!pending.has(level)) {
      const job = injectScript(level).then((ok) => {
        if (ok && api.isLevelLoaded(level)) {
          return true;
        }
        const error = new Error(`V16Rules: ${fileOf(level)} did not load` +
          (ok ? ' (it ran but registered no rules)' : ' (network or cache error)') + '; strokes are not graded until it does');
        error.level = level;   // so a later successful load of this level can clear it
        throw error;
      });
      pending.set(level, job);
      api.loading = true;
      emit('v16:rules-loading', { levels: [level] });
      job.then(() => {
        if (api.error && api.error.level === level) {
          api.error = null;   // this level's earlier failure is resolved
        }
        updateFlag();
        emit('v16:rules-ready', { levels: [level] });
      }, (error) => {
        pending.delete(level);   // allow a retry
        api.error = error;
        updateFlag();
        emit('v16:rules-error', { level, error });
      });
    }
    return pending.get(level);
  };

  /** Load every rule file the characters need; resolves only when all of them are in (mixed-level reviews). */
  api.loadForKanji = (chars) => Promise.all(levelsFor(chars).map(api.loadLevel)).then(() => true);

  /** The held stroke is still on its pad, as the last stroke, and nothing was added or removed since it was held. */
  function strokeStillThere(item) {
    const strokes = item.pad.strokes || [];
    return strokes.length === item.count && strokes[strokes.length - 1] === item.stroke;
  }

  /**
   * Grade every held stroke whose rules are now registered (oldest first). A stale entry (its stroke was removed or
   * replaced, e.g. the lesson was reset) is dropped without grading, so grade() never sees a missing stroke
   * (the old strokeIndex -1 TypeError) and never re-grades an earlier stroke.
   * grade({ lockedByR21 }) gets whether the gate itself locked the pad: only then may the caller unlock it.
   */
  function releaseHeld() {
    for (let n = 0; n < held.length;) {
      const item = held[n];
      const stale = !strokeStillThere(item);
      if (stale || api.isReady(item.char)) {
        held.splice(n, 1);
        item.pad.rulesHeld = false;
        if (!stale) {
          item.grade({ lockedByR21: item.lockedByR21 });
        }
      } else {
        n++;
      }
    }
    if (!held.length) {
      retryAttempt = 0;
      clearTimeout(retryTimer);
      retryTimer = null;
      hideErrorBar();
    }
  }

  /** A load failed while strokes wait: show the bar and retry automatically with backoff (never a silent lock). */
  function onHeldLoadError(error) {
    api.error = error;
    if (!held.length) {
      return;
    }
    showErrorBar(error);
    if (!retryTimer) {
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retryAttempt);
      retryAttempt++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        api.retry().catch(() => { /* handled by retry() itself */ });
      }, delay);
    }
  }

  /** The visible error: a fixed bar with the message and a Retry button (no-op without a document body). */
  function showErrorBar(error) {
    const doc = window.document;
    if (!doc || !doc.body || !doc.createElement) {
      return;
    }
    let bar = doc.getElementById && doc.getElementById('v16-rules-error');
    if (!bar) {
      bar = doc.createElement('div');
      bar.id = 'v16-rules-error';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1000;' +
        'background:#fff;color:#7a1f1a;border:1px solid #b3261e;border-radius:12px;padding:8px 12px;' +
        'font:14px system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 4px 14px rgba(0,0,0,.12)';
      const text = doc.createElement('span');
      text.className = 'v16-rules-error-text';
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = 'Retry';
      button.onclick = () => {
        retryAttempt = 0;
        api.retry().catch(() => {});
      };
      bar.appendChild(text);
      bar.appendChild(button);
      doc.body.appendChild(bar);
    }
    bar.style.display = 'flex';   // not `hidden`: the inline display:flex would override it
    bar.firstChild.textContent = 'Could not load the stroke rules (' + (error && error.message ? error.message : error) +
      '). Your stroke is kept and will be checked once they load. Retrying automatically.';
  }

  function hideErrorBar() {
    const doc = window.document;
    const bar = doc && doc.getElementById && doc.getElementById('v16-rules-error');
    if (bar) {
      bar.style.display = 'none';
    }
  }

  /**
   * The grading guard. Call it just before a stroke on `pad` is checked against character `char`.
   * Returns false when the rules are in: grade now. Returns true when they are not: the caller must NOT grade; the
   * pad is locked (no further strokes), the rule file is loaded, and grade() is called once it is in. If the load
   * fails the pad stays locked, 'v16:rules-error' fires and retry() (or a later load of that file) resumes it.
   * grade() must itself check that the stroke still belongs to the current lesson (index.html checks `gen`).
   * The held stroke is the pad's last stroke now; it is graded only if it is still exactly that stroke at release.
   * A failed load is never swallowed: it sets V16Rules.error, shows the Retry bar and retries with backoff.
   */
  api.holdStroke = (char, pad, grade) => {
    if (api.isReady(char)) {
      return false;
    }
    // one held stroke per pad: an older entry for this pad is stale (its stroke can no longer be graded in order)
    for (let n = held.length - 1; n >= 0; n--) {
      if (held[n].pad === pad) {
        held.splice(n, 1);
      }
    }
    const strokes = pad.strokes || [];
    const lockedByR21 = !pad.locked;   // release unlocks only a lock the gate itself added
    pad.locked = true;
    pad.rulesHeld = true;
    held.push({ char, pad, grade, stroke: strokes[strokes.length - 1], count: strokes.length, lockedByR21 });
    api.loadForKanji(char).then(releaseHeld, onHeldLoadError);
    return true;
  };

  api.isHeld = (pad) => Boolean(pad && pad.rulesHeld && held.some((item) => item.pad === pad));

  /** Retry every file that held strokes still wait for (Retry button, automatic backoff, or back online). */
  api.retry = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    return api.loadForKanji(held.map((item) => item.char)).then(releaseHeld, (error) => {
      onHeldLoadError(error);
      throw error;
    });
  };

  /**
   * Hard check for code paths that grade synchronously (checkStroke): throws instead of grading without rules.
   * UI paths call holdStroke first, so this only fires for a caller that skipped the gate.
   */
  api.assertReady = (char) => {
    if (!api.isReady(char)) {
      throw new Error(`V16Rules: look-alike rules for ${char} (${fileOf(api.levelOf(char))}) are not loaded; ` +
        'refusing to grade. Await V16Rules.loadForKanji first.');
    }
  };

  window.addEventListener('online', () => { if (held.length) api.retry().catch(() => {}); });

  window.V16Rules = api;
}());
