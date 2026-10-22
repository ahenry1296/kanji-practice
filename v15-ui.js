/**
 * v15 screens for the app: Placement, Level check, Unit test and Practice (V15_UI_SPEC.md), ported from
 * kanji-data/prototype/app.js, plus the lesson-side rank hooks (V15_INTEGRATION.md).
 *
 * Loaded after the app's main script, so it can use the app's globals (boxes, cur, gen, loadLesson, loadSet,
 * resetLesson, closePicker, SETS, DATA, $). The app calls in through window.V15UI:
 *   menuHTML()            picker menu under the level bar (renderPicker)
 *   kanjiTier(word)       V15 tier of a one-kanji word, or null (tier() → chip tints)
 *   onReject(box, v)      a rejected stroke (onStroke)
 *   onWrongKanji(box)     the look-alike extension fired (rejectLookalikeExtension)
 *   onCelebrate(k)        a kanji's boxes are all done (celebrate)
 *   onBoxChange()         moving to another box (go)
 *   onLessonEnd()         true when the v15 flow takes over the lesson-complete card (lessonEnd)
 *
 * Test hooks (Bottwo's v15 harness): choice buttons carry data-kanji + data-correct; the typed-reading input carries
 * data-kanji and its feedback data-verdict; practice chips carry data-kanji; the overlay is a .lend.show card.
 */
(function (root) {
  'use strict';

  const V15 = root.V15;
  const RM = root.RankModel;
  // Deferred models: loaded after the page with the data files (window.V15_DATA_SCRIPTS); bound in coreReady.
  let RA = null;
  let PM = null;
  let UT = null;
  let LC = null;
  let PR = null;
  const store = root.localStorage;

  /** {kanji: words} over all levels, built once reading-words.js is in (see loadWords). Null until then. */
  let WORDS = null;

  /** Global each deferred script defines; a script that loaded without defining it is fetched again. */
  const DATA_GLOBALS = {
    'reading-answer.js': 'ReadingAnswer', 'placement-model.js': 'PlacementModel', 'unit-test-model.js': 'UnitTestModel',
    'level-check-model.js': 'LevelCheckModel', 'practice-model.js': 'PracticeModel', 'reading-words.js': 'READING_WORDS',
    'reading-tests.js': 'READING_TESTS', 'placement-pools.js': 'PLACEMENT_POOLS', 'practice-catalog.js': 'PRACTICE_CATALOG',
    'practice-sets.js': 'PRACTICE_SETS',
  };
  /** Attempts per script: a fresh WebKit context can fail a fetch while the service worker installs. */
  const LOAD_TRIES = 3;
  /**
   * B5: the reading words (2.6 MB, ~50 ms to parse) are not in V15_DATA_SCRIPTS. They load on demand (loadWords)
   * or, at the latest, once the browser is idle after first paint (prefetchWords).
   */
  const WORDS_SCRIPT = 'reading-words.js';
  /** Longest wait for an idle moment before the words are prefetched anyway. */
  const PREFETCH_TIMEOUT_MS = 3000;
  /** WebKit has no requestIdleCallback: prefetch this long after first paint instead. */
  const PREFETCH_FALLBACK_MS = 1500;

  /** Inject one script; resolves true once it ran and its global (if known) exists. */
  function loadScript(src, attempt) {
    return new Promise((done) => {
      const el = document.createElement('script');
      el.src = attempt ? `${src}?retry=${attempt}` : src;
      el.onload = () => done(!DATA_GLOBALS[src] || root[DATA_GLOBALS[src]] !== undefined);
      el.onerror = () => { el.remove(); done(false); };
      document.head.appendChild(el);
    });
  }

  /** Load one script, retrying up to LOAD_TRIES times; resolves true when it is in. */
  async function loadWithRetries(src) {
    for (let attempt = 0; attempt < LOAD_TRIES; attempt++) {
      if (await loadScript(src, attempt)) return true;
    }
    return false;
  }

  /**
   * The deferred models and the small data files (READING_TESTS, PLACEMENT_POOLS, PRACTICE_CATALOG, PRACTICE_SETS)
   * load after the page, in order (window.V15_DATA_SCRIPTS). Resolves once they are all bound; enough for the
   * picker menu (level-check count, placement resume), not for any v15 screen.
   */
  const coreReady = new Promise((resolve) => {
    const loadAll = async () => {
      for (const src of root.V15_DATA_SCRIPTS || []) await loadWithRetries(src);
      RA = root.ReadingAnswer;
      PM = root.PlacementModel;
      UT = root.UnitTestModel;
      LC = root.LevelCheckModel;
      PR = root.PracticeModel;
      if (!RA) {
        console.warn('v15: reading models did not load; v15 screens stay unavailable');
        return;   // coreReady stays pending: screens never render half-loaded
      }
      resolve();
      // The menu's level-check count needs LevelCheckModel. Patch the open menu in place: rebuilding the picker
      // here replaced the buttons under a tap in progress, and the tap was lost (B4, WebKit placement).
      refreshMenu();
    };
    if (document.readyState === 'complete') loadAll(); else root.addEventListener('load', loadAll, { once: true });
  });

  /** Resolves dataReady; set below, called once by loadWords. */
  let markDataReady = null;
  /**
   * Everything a v15 screen needs: the models, the data files and the reading words (WORDS is set). Every screen
   * and action waits for it, so no v15 screen can render against a missing ReadingAnswer (bug B1) or missing words
   * (B5). It does not start any loading itself: loadWords (on demand) or prefetchWords (idle) does.
   */
  const dataReady = new Promise((resolve) => { markDataReady = resolve; });
  let wordsLoading = null;

  /**
   * Load reading-words.js once (after the models, since RA builds the index) and resolve dataReady. Safe to call
   * any number of times; later calls return the same promise.
   * @returns {Promise<void>} dataReady
   */
  function loadWords() {
    if (!wordsLoading) {
      wordsLoading = coreReady.then(async () => {
        if (!root.READING_WORDS && !(await loadWithRetries(WORDS_SCRIPT))) {
          console.warn('v15: reading words did not load; v15 screens stay unavailable');
          wordsLoading = null;   // a later screen or tap tries again
          return;
        }
        WORDS = RA.wordsByKanji(root.READING_WORDS);
        pruneRuns();   // needs WORDS (drill words of saved level-check / practice items)
        // No menu refresh here: the menu does not use WORDS, and the picker is never rebuilt on data arrival (B4).
        markDataReady();
      });
    }
    return dataReady;
  }

  /**
   * Prefetch the words when the browser is first idle after first paint, so a reading screen opened later is
   * instant. requestIdleCallback where there is one (Chromium), else a timer (WebKit).
   */
  function prefetchWords() {
    const start = () => { loadWords(); };
    const whenIdle = () => {
      if ('requestIdleCallback' in root) root.requestIdleCallback(start, { timeout: PREFETCH_TIMEOUT_MS });
      else setTimeout(start, PREFETCH_FALLBACK_MS);
    };
    // After the models are in (they load after the load event) and the next frame has painted.
    coreReady.then(() => requestAnimationFrame(() => setTimeout(whenIdle, 0)));
  }
  const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
  const KEYS = {
    placement: 'v15:placement',
    unit: 'v15:unit',
    check: 'v15:check',
    practice: 'v15:practice',
    unitResults: 'v15:unit-results',
  };
  const TIER_LABEL = { none: 'Not started', bronze: 'Bronze', silver: 'Silver', gold: 'Gold', diamond: 'Diamond' };
  /** Feedback before the next question; short so a quick second tap never lands on a stale question. */
  const FEEDBACK_MS = 300;
  const LEVEL_UP_MS = 1200;
  const OVERRIDE_MS = 10000;
  const TOAST_MS = 2000;
  const INTRO = 'Find your level. We start at N5 and move up while you know at least 8 of 10. Three misses in a level ends the test. Nothing you have already learned is lowered.';

  // ------------------------------------------------------------------ helpers

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const ranks = () => V15.loadRanks(store);
  /**
   * Read-only rank state for chip tints, re-parsed only when the stored string changes: the app's tier() runs once
   * per picker chip, and parsing the whole state for each was the per-step cost. Callers that pass a state on to
   * the models use ranks(), which returns a fresh copy the models may change.
   */
  let tintCache = { raw: undefined, state: null };
  const tintRanks = () => {
    const raw = store.getItem(RM.STORAGE_KEY);
    if (raw !== tintCache.raw || !tintCache.state) tintCache = { raw, state: V15.loadRanks(store) };
    return tintCache.state;
  };
  const tierOf = (kanji) => RM.tierOf(tintRanks(), kanji);
  const tierName = (rank) => RM.TIERS[rank];
  const studied = () => LC.selectKanji(ranks(), { size: Infinity });

  function readJson(key) {
    try { return JSON.parse(store.getItem(key)); } catch (e) { return null; }
  }

  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  /** True when `i` is a whole-number index into `list` (a non-empty array). */
  const isIndexInto = (i, list) => Array.isArray(list) && Number.isInteger(i) && i >= 0 && i < list.length;
  const isKanjiItem = (it) => isObj(it) && typeof it.kanji === 'string';
  /**
   * A writing item, or a reading item with a drill word to show. A missing `word` is backfilled from WORDS
   * (older saved runs lack it); a kanji with no drill word stays word-less and fails.
   * @param {object} it a kanji item ({kanji, kind, word?})
   * @returns {boolean}
   */
  const hasWord = (it) => it.kind === 'writing' || Boolean(it.word || (it.word = RA.drillWord(WORDS[it.kanji] || [])));

  /**
   * R1-2: does `saved` have the shape its screen needs to resume? A run written by an older build, partly written,
   * or pointing at a unit that no longer exists fails, so the caller can drop it instead of throwing.
   * @param {string} key one of the KEYS resume keys
   * @param {*} saved the parsed value (anything JSON.parse can return)
   * @returns {boolean}
   */
  function isValidRun(key, saved) {
    if (!isObj(saved)) return false;
    if (key === KEYS.placement) {
      return Boolean(root.PLACEMENT_POOLS.levels[saved.level]) && isIndexInto(saved.asked, saved.queue)
        && saved.queue.every((k) => typeof k === 'string') && Number.isInteger(saved.correct) && Number.isInteger(saved.misses)
        && Array.isArray(saved.answers) && Array.isArray(saved.passedLevels) && !saved.finished;
    }
    if (key === KEYS.check) {
      if (!Array.isArray(saved.items) || !saved.items.every(isKanjiItem)) return false;
      // Drop reading items with no drill word (checkWord would return null), keeping the index on the same item.
      const kept = saved.items.filter(hasWord);
      saved.index -= saved.items.slice(0, saved.index).filter((it) => !kept.includes(it)).length;
      saved.items = kept;
      return isIndexInto(saved.index, saved.items) && Array.isArray(saved.results)
        && (saved.changes === undefined || Array.isArray(saved.changes));
    }
    if (key === KEYS.practice) {
      return isIndexInto(saved.index, saved.queue) && saved.queue.every((it) => isKanjiItem(it) && hasWord(it))
        && Array.isArray(saved.results)
        && isObj(saved.before);
    }
    if (key === KEYS.unit) {
      const unit = typeof saved.level === 'string' && UT.getUnit(root.READING_TESTS, saved.level, saved.unit);
      return Boolean(unit) && isIndexInto(saved.index, unit.questions) && isObj(saved.answers);
    }
    return true;
  }

  /** The saved run under `key`, or null; an invalid one (see isValidRun) is deleted so it can't block the screen. */
  function readRun(key) {
    if (store.getItem(key) === null) return null;
    const saved = readJson(key);   // null for invalid JSON, which isValidRun rejects
    if (isValidRun(key, saved)) return saved;
    store.removeItem(key);
    return null;
  }

  /**
   * Delete every invalid saved run (see readRun). Runs once the reading words are in (loadWords): validating a
   * level-check or practice run needs WORDS, so before that it does nothing.
   */
  function pruneRuns() {
    if (!WORDS) return;
    for (const key of [KEYS.placement, KEYS.check, KEYS.practice, KEYS.unit]) readRun(key);
  }

  function saveKey(key, value) {
    try { store.setItem(key, JSON.stringify(value)); } catch (e) { toast("Couldn't save progress. Free some space and try again."); }
  }

  /** The word to quiz a kanji's reading with: a single-kanji drill word when there is one, else its first drill word. */
  function readingWordFor(kanji) {
    const pool = RA.drillWords(WORDS[kanji] || []);
    return pool.find((w) => w.w === kanji) || pool[0] || null;
  }

  function wordHTML(word, kanji) {
    if (!word) return esc(kanji);
    if (word.w === kanji) return esc(word.w);
    return esc(word.w).split(esc(kanji)).join(`<u>${esc(kanji)}</u>`);
  }

  /** Four reading choices: the answer plus three drill-word readings of other kanji in `pool` (never an accepted reading). */
  function readingChoices(kanji, pool) {
    const word = readingWordFor(kanji);
    if (!word) return null;
    const start = Math.max(0, pool.indexOf(kanji));
    const wrong = [];
    for (let i = 1; i < pool.length && wrong.length < 3; i += 1) {
      const other = readingWordFor(pool[(start + i * 7) % pool.length]);
      if (!other || other.r === word.r || wrong.includes(other.r) || RA.readingMatches(other.r, word)) continue;
      wrong.push(other.r);
    }
    const choices = wrong.slice();
    choices.splice(kanji.codePointAt(0) % (wrong.length + 1), 0, word.r);
    return { word, choices };
  }

  const levelPool = (level) => PR.filterKanji(root.PRACTICE_CATALOG, root.PRACTICE_SETS, { levels: [level] });
  const levelOf = (kanji) => (root.PRACTICE_CATALOG.kanji[kanji] || {}).level || 'N5';

  // ------------------------------------------------------------------ toast + override pill (lesson screen)

  let toastTimer = null;
  function toast(text) {
    const el = document.getElementById('v15toast');
    if (!el) return;
    // Just below the writing box, centred between the undo and clear buttons: clear of the word label and header at
    // every width. The live region stays in the accessibility tree; only its text and the .on class change.
    const pad = typeof boxes !== 'undefined' && boxes[cur] && boxes[cur].pad;
    const top = pad ? pad.cv.getBoundingClientRect().bottom + 6 : 96;
    el.style.top = `${Math.round(top)}px`;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('on'); el.textContent = ''; }, TOAST_MS);
  }

  /**
   * Pending override: {kanji, mode: 'lesson'|'check'|'practice'}.
   * UX-B4: the pill names its kanji. In a level check or practice it sits in the miss banner when the overlay shows
   * (missBanner) and floats under the writing box only while a writing item is on screen; it is cleared when the
   * item after the miss is done (checkAdvance / practiceAdvance). In a lesson it floats and times out as before.
   */
  let override = null;
  let overrideTimer = null;

  const overrideLabel = (kanji) => `I wrote ${kanji} correctly`;

  /** Show the floating pill only when there is no overlay to hold it (lesson pad, writing items). */
  function syncOverridePill() {
    const el = document.getElementById('v15ovr');
    if (!el) return;
    const overlayShown = Boolean(host() && host().classList.contains('show'));
    el.hidden = !override || overlayShown;
    if (!override) return;
    el.querySelector('.v15-ovr-label').textContent = overrideLabel(override.kanji);
    el.setAttribute('aria-label', overrideLabel(override.kanji));
  }

  function showOverride(info) {
    override = info;
    clearTimeout(overrideTimer);
    if (info.mode === 'lesson') overrideTimer = setTimeout(hideOverride, OVERRIDE_MS);
    syncOverridePill();
  }

  function hideOverride() {
    override = null;
    clearTimeout(overrideTimer);
    syncOverridePill();
  }

  /** The inline pill inside a check / practice miss banner, when that miss can still be overridden. */
  function inlineOverrideHTML(kanji) {
    if (!override || override.mode === 'lesson' || override.kanji !== kanji) return '';
    return `<button class="ib wide v15-ovr" data-v15="override" aria-label="${esc(overrideLabel(kanji))}"><span aria-hidden="true">✓</span>I wrote <span lang="ja">${esc(kanji)}</span> correctly</button>`;
  }

  function onOverrideClick() {
    applyOverride();
    if (S.view) render();
  }

  function applyOverride() {
    if (!override) return;
    const info = override;
    hideOverride();
    let restored = null;
    if (info.mode === 'check') {
      const change = checkRecord(info.kanji, 'override');
      if (change && change.to > change.from) restored = change.to;
      S.lc.banner = null;
    } else {
      const res = V15.onOverride(store, info.kanji);
      if (res.to > res.from) restored = res.to;
      if (info.mode === 'practice') {
        const last = S.pr.results[S.pr.results.length - 1];
        if (last) Object.assign(last, { ok: true, overridden: true });
        S.pr.banner = null;
      }
    }
    toast(restored !== null ? `Thanks — rank restored to ${TIER_LABEL[tierName(restored)]}.` : 'Thanks — the miss was removed.');
  }

  /**
   * The rank one more clear writing failure would drop the kanji to, or null when it would not drop (no failure yet
   * to count, or already at the writing floor). Asks the rank model, never guesses.
   */
  function nextMissDropsTo(kanji) {
    const record = RM.getKanji(ranks(), kanji);
    const after = RM.applyEvent(record, { type: 'writingClearFail' }).rank;
    return after < record.rank ? after : null;
  }

  // ------------------------------------------------------------------ lesson-side rank hooks

  /** Kanji with a clear writing failure in the current lesson (reset when the lesson generation changes). */
  let failed = { gen: -1, kanji: new Set() };
  function failedKanji() {
    if (failed.gen !== gen) failed = { gen, kanji: new Set() };
    return failed.kanji;
  }

  /** Kanji boxes only (not part or word boxes). */
  const kanjiOfBox = (box) => (box && box.s && box.s.t === 'K' ? box.s.kc : null);

  /**
   * A rejected stroke: the first near miss (hook-layer reject) in a box is a free retry; a second one, or any other
   * reject, is the box's clear failure (once per box). In a v15 writing item the failure ends the item.
   */
  function onReject(box, verdict) {
    const kanji = kanjiOfBox(box);
    if (!kanji) return;
    const state = box.v15 = box.v15 || { borderline: 0, failed: false };
    // classifyReject reads verdict.shape, where the hook layer names a near miss ('hook-dropped' …).
    const near = V15.classifyReject(verdict) === 'borderline';
    if (near && state.borderline < V15.MAX_BORDERLINE_PER_BOX) {
      state.borderline += 1;
      if (S.writing && S.writing.mode === 'practice' && S.pr) S.pr.retried += 1;   // R1-5: counted on the summary
      toast('Almost — try that stroke once more.');
      return;
    }
    if (state.failed) return;
    state.failed = true;
    if (near) toast('Not quite — that counts as a miss.');
    boxFailed(kanji, near ? { rejects: [verdict, verdict] } : { rejects: [verdict] });
  }

  function onWrongKanji(box) {
    const kanji = kanjiOfBox(box);
    if (!kanji) return;
    const state = box.v15 = box.v15 || { borderline: 0, failed: false };
    toast("That's a different kanji.");
    if (state.failed) return;
    state.failed = true;
    boxFailed(kanji, { wrongKanji: true });
  }

  function boxFailed(kanji, boxInfo) {
    failedKanji().add(kanji);
    const item = S.writing && S.writing.kanji === kanji ? S.writing : null;
    if (item) {
      setTimeout(() => writingItemDone(false, boxInfo), 0);
      return;
    }
    const res = V15.onWritingBox(store, kanji, boxInfo);
    showOverride({ kanji, mode: 'lesson' });
    if (res.to < res.from) toast(`Missed — ${TIER_LABEL[tierName(res.from)]} → ${TIER_LABEL[tierName(res.to)]}.`);
  }

  function onCelebrate(k) {
    if (!k || k.isWord || k.isPart) return;
    if (S.writing && S.writing.kanji === k.k) {
      setTimeout(() => writingItemDone(true, null), 0);
      return;
    }
    V15.onKanjiComplete(store, k.k, { clean: !failedKanji().has(k.k) });
  }

  function onBoxChange() {
    if (override && override.mode === 'lesson') hideOverride();
  }

  function onLessonEnd() {
    return Boolean(S.writing);
  }

  /** Tier of a one-kanji word from the v15 rank (null when it is not a kanji or not studied yet). */
  function kanjiTier(word) {
    if (!word || [...word].length !== 1 || typeof DATA === 'undefined' || !DATA.kanji[word]) return null;
    const t = tierOf(word);
    return t === 'none' ? null : t;
  }

  // ------------------------------------------------------------------ overlay state

  const S = { view: null, modal: null, writing: null, lessonReplaced: false, pl: null, ut: null, lc: null, pr: null };

  function host() { return document.getElementById('v15'); }

  function openView(view) {
    if (typeof closePicker === 'function') closePicker();
    if (typeof closeEnd === 'function') closeEnd();
    hideOverride();
    S.view = view;
    S.modal = null;
    host().classList.add('show');
    lastScreen = '';
  }

  /** Close the overlay; reload the learner's lesson if a writing item replaced it. */
  function closeView() {
    if (override && override.mode !== 'lesson') hideOverride();
    S.view = null;
    S.modal = null;
    S.writing = null;
    host().classList.remove('show');
    host().innerHTML = '';
    if (S.lessonReplaced) {
      S.lessonReplaced = false;
      const id = store.getItem('set') || SETS[0].id;
      loadSet(id);
    }
  }

  // ------------------------------------------------------------------ shared markup

  function lbButton({ ja, en, act, arg = '', pri = false, disabled = false }) {
    const label = ja ? `<span lang="ja">${esc(ja)}</span><small>${esc(en)}</small>` : `<span>${esc(en)}</span>`;
    return `<button class="${pri ? 'pri' : ''}" data-v15="${act}" data-arg="${esc(arg)}" aria-label="${esc(en)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  }

  const bottomBar = (buttons) => `<div class="v15-bar"><div class="lb">${buttons.map(lbButton).join('')}</div></div>`;

  function segBar(done, total) {
    let out = '';
    for (let i = 0; i < total; i += 1) out += `<i class="seg ${i < done ? 'done' : i === done ? 'now' : ''}"></i>`;
    return `<div class="segs" aria-hidden="true">${out}</div>`;
  }

  const topLine = (label, done, total) => `<div class="v15-top"><span class="v15-count" tabindex="-1">${esc(label)}</span>${segBar(done, total)}</div>`;
  const badge = (tier) => `<span class="v15-badge tier ${tier}">${TIER_LABEL[tier]}</span>`;
  const changeHTML = (from, to) => `<span class="v15-change">${badge(tierName(from))}<span class="to" aria-label="to">→</span>${badge(tierName(to))}</span>`;
  const quitButton = () => '<button class="ib v15-quit" data-v15="quit" aria-label="Quit test"><span aria-hidden="true">✕</span></button>';

  function chip(kanji, { tier = tierOf(kanji), act = '', isNew = false, sel = false } = {}) {
    const tint = tier === 'none' ? '' : `tier ${tier}`;
    const dot = isNew ? '<i class="new" aria-label="New"></i>' : '';
    if (act) {
      return `<button class="v15-chip ${tint} ${sel ? 'sel' : ''}" lang="ja" data-v15="${act}" data-arg="${esc(kanji)}" data-kanji="${esc(kanji)}" data-tier="${tier}" aria-pressed="${sel}">${esc(kanji)}${dot}</button>`;
    }
    return `<span class="v15-chip ${tint}" lang="ja" data-tier="${tier}">${esc(kanji)}${dot}</span>`;
  }

  const card = (inner, extra = '') => `<section class="lcard v15-card">${inner}</section>${extra}`;

  /** Reading choices with the harness hooks: data-kanji on each, data-correct true/false. */
  function choiceRows(kanji, set, act, feedback) {
    return set.choices.map((c) => {
      const right = c === set.word.r;
      let cls = '';
      let tag = '';
      if (feedback) {
        if (right) { cls = 'right'; tag = feedback.correct ? 'Correct' : `Answer: ${set.word.r}`; } else if (c === feedback.picked) cls = 'wrong';
      }
      return `<button class="v15-choice ${cls}" lang="ja" data-v15="${act}" data-arg="${esc(c)}" data-kanji="${esc(kanji)}" data-correct="${right}" ${feedback ? 'disabled' : ''}><span>${esc(c)}</span><span class="tag" lang="en" ${tag ? 'data-announce' : ''}>${esc(tag)}</span></button>`;
    }).join('');
  }

  // ------------------------------------------------------------------ menu (§3)

  function menuHTML() {
    const lcCount = LC ? Math.min(LC.DEFAULT_SIZE, studied().length) : 0;   // 0 until the models are in
    // Read only: invalid runs are deleted by pruneRuns before this renders. Until the pools load a run can't be
    // validated, so fall back to "a key exists".
    const resume = (root.PLACEMENT_POOLS ? isValidRun(KEYS.placement, readJson(KEYS.placement)) : store.getItem(KEYS.placement)) ? '<b>Resume</b>' : '';
    const btn = (ja, en, act, extra = '') => `<button data-v15="${act}" aria-label="${en}"><span lang="ja">${ja}</span><small>${en}</small><span class="v15-mbadge">${extra}</span></button>`;
    return `<div class="lb v15-menu">${btn('診断', 'Placement', 'openPlacement', resume)}${btn('確認', 'Level check', 'openCheck', lcCount ? `<b>${lcCount}</b>` : '')}${btn('単元', 'Unit test', 'openUnits')}${btn('練習', 'Practice', 'openPractice')}</div>`;
  }

  /**
   * Bring a menu already on the page up to date without replacing its buttons (B4): copy the badges (Resume,
   * level-check count) from a fresh menuHTML(). A tap in progress keeps its target, so it opens the screen once
   * dataReady resolves. (The buttons are not disabled while loading: a press begun then would be dropped.)
   */
  function refreshMenu() {
    const tmp = document.createElement('div');
    tmp.innerHTML = menuHTML();
    for (const menu of document.querySelectorAll('.v15-menu')) {
      for (const fresh of tmp.querySelectorAll('button[data-v15]')) {
        const old = menu.querySelector(`button[data-v15="${fresh.dataset.v15}"]`);
        if (!old) continue;
        const badge = old.querySelector('.v15-mbadge');
        const next = fresh.querySelector('.v15-mbadge');
        if (badge && next && badge.innerHTML !== next.innerHTML) badge.innerHTML = next.innerHTML;
      }
    }
  }

  // ------------------------------------------------------------------ placement (§4)

  function placementView() {
    const pl = S.pl;
    if (pl.step === 'intro') {
      return card(`<h1 tabindex="-1"><span class="ja" lang="ja">診断</span>Placement</h1>
        <p>${INTRO}</p>
        ${pl.retake ? '<p class="v15-muted">Retaking never lowers a rank.</p>' : ''}`,
      bottomBar([{ ja: '始める', en: 'Start', act: 'placementStart', pri: true }, { ja: '戻る', en: 'Back', act: 'quit' }]));
    }
    if (pl.step === 'result') return placementResultView();
    const st = pl.state;
    const q = PM.nextQuestion(st);
    const set = readingChoices(q.kanji, root.PLACEMENT_POOLS.levels[q.level].kanji.map((e) => e.c));
    const fb = pl.feedback;
    const idk = `<button class="v15-choice idk ${fb && fb.picked === null ? 'wrong' : ''}" data-v15="placementChoose" data-arg="" ${fb ? 'disabled' : ''}>I don't know</button>`;
    const banner = pl.levelUp ? `<p class="v15-banner" data-announce>${esc(pl.levelUp.from)} passed · on to ${esc(pl.levelUp.to)}</p>` : '';
    return card(`${quitButton()}
      ${topLine(`${q.level} · ${st.asked + 1} / ${st.queue.length}`, st.asked, st.queue.length)}
      ${banner}
      <div class="${set.word.w === q.kanji ? 'v15-char' : 'v15-word'}" lang="ja">${wordHTML(set.word, q.kanji)}</div>
      <p class="v15-ask">How is this read?</p>
      <div class="v15-choices" role="group" aria-label="Readings">${choiceRows(q.kanji, set, 'placementChoose', fb)}${idk}</div>
      ${st.level === 'N5' && st.asked === 0 && !pl.state.answers.length ? `<p class="v15-small v15-muted" style="margin-top:16px">${INTRO}</p>` : ''}`);
  }

  function placementResultView() {
    const pl = S.pl;
    const res = pl.result;
    const top = res.stopReason === 'top';
    const stop = res.stopReason === 'misses' ? `Stopped after 3 misses in ${res.estimatedLevel}.`
      : top ? 'You passed every level.' : `Below 8 of 10 in ${res.estimatedLevel}.`;
    return card(`<p class="v15-headline" tabindex="-1" data-announce>${top ? 'Your level: N1 — all levels passed' : `Your level: ${esc(res.estimatedLevel)}`}</p>
      <p>Passed: ${res.passedLevels.length ? esc(res.passedLevels.join(', ')) : 'none yet'} · Known kanji: ${res.known.length}</p>
      <p class="v15-small v15-muted">${esc(stop)}</p>
      <div class="v15-chips">${res.known.map((k) => chip(k, { isNew: pl.before[k] === 0 })).join('')}</div>
      ${res.known.some((k) => pl.before[k] === 0) ? '<p class="v15-legend v15-small v15-muted"><i class="new" aria-hidden="true"></i>New to you</p>' : ''}
      <p data-announce>${esc(placementSavedText(pl.saved))}</p>`,
    bottomBar([{ ja: '次へ', en: `Practice ${res.estimatedLevel}`, act: 'placementPractice', pri: true }, { ja: '終わる', en: 'Done', act: 'quit' }]));
  }

  /** "Saved. 4 kanji are now Bronze." plus the already-higher clause only when there are any. */
  function placementSavedText({ raised, higher }) {
    return `Saved. ${raised} kanji ${raised === 1 ? 'is' : 'are'} now Bronze${higher ? `; ${higher} ${higher === 1 ? 'was' : 'were'} already higher` : ''}.`;
  }

  /** Finish: apply the result at once (never lowers a rank), then show it. */
  function placementFinish() {
    const pl = S.pl;
    pl.result = PM.result(pl.state);
    pl.before = {};
    for (const k of pl.result.known) pl.before[k] = RM.getKanji(ranks(), k).rank;
    V15.applyPlacement(store, pl.result);
    pl.saved = {
      raised: pl.result.known.filter((k) => pl.before[k] === 0).length,
      higher: pl.result.known.filter((k) => pl.before[k] > 0).length,
    };
    pl.step = 'result';
    store.removeItem(KEYS.placement);
  }

  // ------------------------------------------------------------------ unit test (§5)

  const unitsOf = (level) => ((root.READING_TESTS.levels || {})[level]) || [];
  const unitObj = () => UT.getUnit(root.READING_TESTS, S.ut.level, S.ut.unit);

  function unitView() {
    const ut = S.ut;
    if (ut.step === 'picker') {
      const tabs = LEVELS.map((l) => `<button class="${l === ut.level ? 'on' : ''}" data-v15="unitLevel" data-arg="${l}" data-level="${l}" aria-pressed="${l === ut.level}" aria-label="Level ${l}"></button>`).join('');
      const last = readJson(KEYS.unitResults) || {};
      const units = unitsOf(ut.level);
      const rows = units.map((u) => {
        const r = last[`${ut.level}-${u.unit}`];
        const lastText = r ? ` · ${r.score} / ${r.total} · ${r.passed ? 'Passed' : 'Not yet'}` : '';
        return `<button class="v15-row" data-v15="unitOpen" data-arg="${u.unit}"><span class="grow">Unit ${u.unit} · ${u.kanji.length} kanji${esc(lastText)}<span class="kanjis" lang="ja">${esc(u.kanji.join(''))}</span></span><span aria-hidden="true">›</span></button>`;
      }).join('');
      const list = units.length ? `<div class="v15-rows">${rows}</div>` : '<p class="v15-muted">No units for this level yet.</p>';
      return card(`<h1 tabindex="-1"><span class="ja" lang="ja">単元</span>Unit test</h1><div class="v15-units"><div class="v15-tabs" role="group" aria-label="JLPT level">${tabs}</div>${list}</div>`,
        bottomBar([{ ja: '戻る', en: 'Back', act: 'quit' }]));
    }
    if (ut.step === 'result') return unitResultView();
    const unit = unitObj();
    const q = unit.questions[ut.index];
    const picked = ut.answers[q.kanji];
    const rows = q.choices.map((c) => `<button class="v15-choice ${picked === c ? 'picked' : ''}" lang="ja" data-v15="unitChoose" data-arg="${esc(c)}" data-kanji="${esc(q.kanji)}" data-correct="${c === q.answer}" aria-pressed="${picked === c}"><span>${esc(c)}</span></button>`).join('');
    const isLast = ut.index === unit.questions.length - 1;
    return card(`${quitButton()}
      ${topLine(`Unit ${ut.unit} · ${ut.index + 1} / ${unit.questions.length}`, ut.index, unit.questions.length)}
      <div class="v15-word" lang="ja">${wordHTML({ w: q.w }, q.kanji)}</div>
      <div class="v15-gloss">${esc(q.m)}</div>
      <p class="v15-ask">Choose the reading.</p>
      <div class="v15-choices" role="group" aria-label="Readings">${rows}</div>`,
    bottomBar([{ ja: '戻る', en: 'Back', act: 'unitBack', disabled: ut.index === 0 },
      isLast ? { ja: '終わる', en: 'Finish', act: 'unitFinish', pri: true } : { ja: '次へ', en: 'Next', act: 'unitNext', pri: true, disabled: picked === undefined }]));
  }

  function unitResultView() {
    const ut = S.ut;
    const r = ut.result;
    // A miss row: chip, then "会社 — かいしゃ" (just "いち" when the word is the chip's kanji), then what was chosen.
    const misses = r.misses.map((m) => `<button class="v15-row" data-v15="practiceKanji" data-arg="${esc(m.kanji)}">${chip(m.kanji)}
      <span class="grow"><span lang="ja">${m.w === m.kanji ? '' : `${esc(m.w)} — `}${esc(m.expected)}</span> · ${m.given === null ? 'no answer' : `you chose <span lang="ja">${esc(m.given)}</span>`}</span><span aria-hidden="true">›</span></button>`).join('');
    const hasNext = Boolean(UT.getUnit(root.READING_TESTS, ut.level, ut.unit + 1));
    const buttons = r.passed
      ? [{ ja: '次へ', en: hasNext ? 'Next unit' : 'Units', act: 'unitNextUnit', pri: true }, { ja: '繰り返す', en: 'Retry', act: 'unitRetry' }]
      : [{ ja: '繰り返す', en: 'Retry', act: 'unitRetry', pri: true }, { ja: '練習', en: 'Practise misses', act: 'practiceMisses' }];
    return card(`<p class="v15-headline" tabindex="-1" data-announce>${r.passed ? 'Passed!' : 'Not yet'}</p>
      <p class="v15-score" data-announce>Score: ${r.score} / ${r.total} (${Math.round(r.ratio * 100)}%)</p>
      <p class="v15-small v15-muted">${r.passed ? 'Pass mark: 80%' : 'Failed · pass mark: 80%'}</p>
      ${r.misses.length ? `<p class="v15-group">Misses (${r.misses.length})</p><div class="v15-rows">${misses}</div>` : ''}`,
    bottomBar(buttons));
  }

  function unitFinish() {
    const ut = S.ut;
    S.modal = null;
    ut.result = UT.scoreUnit(unitObj(), ut.answers);
    ut.step = 'result';
    const last = readJson(KEYS.unitResults) || {};
    last[`${ut.level}-${ut.unit}`] = { score: ut.result.score, total: ut.result.total, passed: ut.result.passed };
    saveKey(KEYS.unitResults, last);
    store.removeItem(KEYS.unit);
  }

  // ------------------------------------------------------------------ writing items (level check + practice)

  /** Replace the lesson with a one-box recall lesson of the kanji (meaning + reading shown, written from memory). */
  function startWriting(kanji, mode) {
    const word = readingWordFor(kanji);
    S.writing = { kanji, mode };
    S.lessonReplaced = true;
    host().classList.remove('show');
    host().innerHTML = '';
    loadLesson({ id: `v15:${kanji}`, title: kanji, custom: true, level: levelOf(kanji),
      words: [{ w: kanji, r: word ? word.r : '', m: word ? word.m : '' }] }, { force: true, kanjiOnly: true, recallOnly: true });
  }

  /** The writing item ended: clean (celebrate) or failed (first clear failure of its box). */
  function writingItemDone(clean, boxInfo) {
    if (!S.writing) return;
    const { kanji, mode } = S.writing;
    let repeatToast = '';
    S.writing = null;
    resetLesson();
    host().classList.add('show');
    if (mode === 'check') {
      const lc = S.lc;
      const outcome = clean ? 'correct' : V15.boxVerdict(boxInfo).event;
      const change = checkRecord(kanji, outcome);
      lc.banner = null;
      if (!clean) {
        const drop = change && change.to < change.from ? { from: change.from, to: change.to } : null;
        lc.banner = { kanji, drop, warnTo: drop ? null : nextMissDropsTo(kanji) };
      }
      checkAdvance();
      if (!clean) showOverride({ kanji, mode: 'check' });
    } else {
      const pr = S.pr;
      let drop = null;
      if (clean) {
        const done = V15.onKanjiComplete(store, kanji, { clean: true });
        pr.results.push({ kind: 'writing', ok: true });
        pr.banner = done.to > done.from ? { kanji, up: { from: done.from, to: done.to } } : null;
      } else {
        const res = V15.onWritingBox(store, kanji, boxInfo);
        if (res.to < res.from) drop = { from: res.from, to: res.to };
        pr.results.push({ kind: 'writing', ok: false });
        pr.banner = { kanji, drop, warnTo: drop ? null : nextMissDropsTo(kanji) };
      }
      // Review E1: announce a writing rep after a clean write, and after any write that leaves no banner showing.
      const next = pr.queue[pr.index + 1];
      if (next && next.repeat && next.kind === 'writing' && (clean || !pr.banner)) repeatToast = clean ? `✓ Good — write ${kanji} once more.` : `Write ${kanji} once more.`;
      practiceAdvance();
      if (!clean) showOverride({ kanji, mode: 'practice' });
      // A rep of the same kanji reloads the same box: say so after the new box is up, or it looks like the
      // stroke was lost (E2E_PASS #1).
      if (repeatToast) toast(repeatToast);
    }
    render();
  }

  function missBanner(b) {
    if (!b) return '';
    if (b.up) return `<p class="v15-banner" data-announce><span lang="ja">${esc(b.kanji)}</span> ${changeHTML(b.up.from, b.up.to)}</p>`;
    const k = `<span lang="ja">${esc(b.kanji)}</span>`;
    // UX-B4: say what a drop dropped to, and warn only when the rank model says the next miss would drop it
    const text = b.drop ? `Missed — ${k} dropped to ${TIER_LABEL[tierName(b.drop.to)]}.`
      : b.warnTo != null ? `Missed — ${k}. One more miss drops it to ${TIER_LABEL[tierName(b.warnTo)]}.`
        : `Missed — ${k} will need another try.`;
    return `<div class="v15-banner miss"><p data-announce>${text}</p>${inlineOverrideHTML(b.kanji)}</div>`;
  }

  // ------------------------------------------------------------------ level check (§6)

  /**
   * R1-4 (spec §9): record one level-check outcome and apply it to the ranks right away, so answers given before a
   * quit or Start over still count. `lc.results` / `lc.changes` only feed the score and the result screen.
   * @param {string} kanji
   * @param {string} outcome a LevelCheckModel outcome ('correct', 'readingMiss', 'writingClearFail', 'override' …)
   * @returns {{kanji: string, outcome: string, from: number, to: number} | undefined} the rank change, if any
   */
  function checkRecord(kanji, outcome) {
    const lc = S.lc;
    lc.results.push({ kanji, outcome });
    const change = V15.applyLevelCheck(store, [{ kanji, outcome }]).changes[0];
    if (change) lc.changes.push(change);
    saveCheck();
    return change;
  }

  /**
   * Save the level-check run. The saved index is the first unanswered item (overrides are not answers), so a run
   * left during an answer's feedback resumes after it and no item is applied twice; a fully answered run is removed.
   */
  function saveCheck() {
    const lc = S.lc;
    const next = lc.results.filter((r) => r.outcome !== 'override').length;
    if (next >= lc.items.length) { store.removeItem(KEYS.check); return; }
    saveKey(KEYS.check, { items: lc.items, index: next, results: lc.results, changes: lc.changes });
  }

  function checkStart() {
    const lc = S.lc;
    lc.items = LC.selectKanji(ranks(), { readingWords: WORDS });
    if (!lc.items.length) { lc.step = 'empty'; return; }
    Object.assign(lc, { index: 0, results: [], changes: [], step: 'items', feedback: null, banner: null });
    saveCheck();
    checkShowItem();
  }

  /** Writing items leave the overlay for the lesson pad; reading items stay. */
  function checkShowItem() {
    const lc = S.lc;
    const item = lc.items[lc.index];
    if (item && item.kind === 'writing') startWriting(item.kanji, 'check');
  }

  function checkAdvance() {
    const lc = S.lc;
    if (override && override.mode === 'check') hideOverride();   // UX-B4: the pill belongs to the item just done
    lc.index += 1;
    lc.feedback = null;
    if (lc.index >= lc.items.length) {
      lc.step = 'result';   // ranks were already updated item by item (checkRecord)
      store.removeItem(KEYS.check);
      return;
    }
    saveCheck();
    checkShowItem();
  }

  function checkView() {
    const lc = S.lc;
    if (lc.step === 'empty') {
      return card(`<h1 tabindex="-1"><span class="ja" lang="ja">確認</span>Level check</h1><p>No studied kanji yet. Finish a lesson or take Placement first.</p>`,
        bottomBar([{ ja: '診断', en: 'Placement', act: 'openPlacement', pri: true }, { ja: '戻る', en: 'Back', act: 'quit' }]));
    }
    if (lc.step === 'result') {
      const correct = lc.results.filter((r) => r.outcome === 'correct').length;
      // UX-B4: a miss on the last item keeps its banner (and its pill) on the result screen
      return card(`${missBanner(lc.banner)}<p class="v15-headline" tabindex="-1" data-announce>Level check done</p>
        <p class="v15-score" data-announce>Score: ${correct} / ${lc.items.length} correct</p>
        ${changeGroupsHTML(groupChanges(lc.changes))}`,
      // UX-B4: offer weak practice only when there is something weak to practise
      bottomBar(anyWeak()
        ? [{ ja: '練習', en: 'Practise weak kanji', act: 'practiceWeak', pri: true }, { ja: '終わる', en: 'Done', act: 'quit' }]
        : [{ ja: '終わる', en: 'Done', act: 'quit', pri: true }]));
    }
    const item = lc.items[lc.index];
    // Behind the resume dialog no items are loaded yet: show the title only (this threw before, so the dialog never drew)
    // R1-1: always with Quit, so a run that somehow has no current item is never a dead end.
    if (!item) return card(`${quitButton()}<h1 tabindex="-1"><span class="ja" lang="ja">確認</span>Level check</h1>`);
    const head = `${quitButton()}${topLine(`${lc.index + 1} / ${lc.items.length}`, lc.index, lc.items.length)}${missBanner(lc.banner)}`;
    if (item.kind === 'writing') return card(`${head}<p class="v15-ask">Write: <span lang="ja">${esc(item.kanji)}</span></p>`);
    const word = checkWord(item);
    const fb = lc.feedback;
    const buttons = fb ? [{ en: 'Next', act: 'checkNext', pri: true }] : [{ en: 'Check', act: 'checkReading', pri: true }, { en: "I don't know", act: 'checkIdk' }];
    return card(`${head}
      <div class="${word.w === item.kanji ? 'v15-char' : 'v15-word'}" lang="ja">${wordHTML(word, item.kanji)}</div>
      <div class="v15-gloss">${esc(word.m)}</div>
      ${readingInputHTML(item.kanji, lc.typed, fb)}
      <div>${fb ? readingFeedbackHTML(word, fb.correct) : ''}</div>`, bottomBar(buttons));
  }

  /** The drill word a level-check reading item asks for (older saved runs may lack item.word). */
  function checkWord(item) {
    if (!item.word) item.word = RA.drillWord(WORDS[item.kanji] || []);
    return item.word;
  }

  /** The typed-reading field shared by level check and practice (read-only once the answer is judged). */
  function readingInputHTML(kanji, typed, feedback) {
    return `<input id="v15-reading" type="text" class="v15-input" lang="ja" data-kanji="${esc(kanji)}" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="ひらがな" aria-label="Reading in hiragana" value="${esc(typed || '')}" ${feedback ? 'readonly' : ''}>`;
  }

  /** "Correct", or "Answer: かいしゃ (also: …)" listing the other accepted readings. */
  function readingFeedbackHTML(word, correct) {
    if (correct) return '<p class="v15-feedback ok" data-verdict="correct" data-announce>Correct</p>';
    const alts = RA.acceptedReadings(word).filter((r) => r !== word.r);
    return `<p class="v15-feedback" data-verdict="wrong" data-announce>Answer: <span lang="ja">${esc(word.r)}</span>${alts.length ? ` <span class="also">(also: <span lang="ja">${esc(alts.join('、'))}</span>)</span>` : ''}</p>`;
  }

  function groupChanges(changes) {
    const per = new Map();
    for (const c of changes) {
      const prev = per.get(c.kanji);
      per.set(c.kanji, { kanji: c.kanji, from: prev ? prev.from : c.from, to: c.to, capped: Boolean(c.capped || (prev && prev.capped)) });
    }
    const state = ranks();
    const groups = { up: [], down: [], pending: [], same: [] };
    for (const c of per.values()) {
      const rec = RM.getKanji(state, c.kanji);
      if (c.to > c.from) groups.up.push(c);
      else if (c.to < c.from) groups.down.push(c);
      else if (rec.clearFails > 0 || rec.retry || c.capped) groups.pending.push({ ...c, rec });
      else groups.same.push(c);
    }
    return groups;
  }

  /**
   * U3: why a kanji whose rank didn't move is pending, e.g. "Gold · pending (one more miss drops it)".
   * @param {{rank: number, clearFails: number, retry: boolean}} rec the kanji's current rank record
   * @param {boolean} capped a correct answer was not counted because of the 12-hour check cap (E2E_PASS #4)
   * @returns {string} HTML: the tier badge plus a plain-words reason
   */
  function pendingHTML(rec, capped = false) {
    const left = RM.CLEAR_FAILS_TO_DEMOTE - rec.clearFails;
    let why;
    if (rec.clearFails > 0 && rec.rank > RM.WRITING_FLOOR) why = left === 1 ? 'one more miss drops it' : `${left} more misses drop it`;
    else if (rec.clearFails > 0) why = `can't drop below ${TIER_LABEL[tierName(RM.WRITING_FLOOR)]}`;
    else if (!capped) why = 'near miss; write it cleanly to clear';
    // Capped: give the cap reason, and keep any miss warning beside it (review E4).
    if (capped) why = why ? `a check raises a kanji one tier per 12 hours; ${why}` : 'a check raises a kanji one tier per 12 hours';
    return `<span class="v15-change">${badge(tierName(rec.rank))}</span> · pending (${why})`;
  }

  function changeGroupsHTML(groups) {
    const titles = { up: 'Moved up', down: 'Moved down', pending: 'Pending', same: 'No change' };
    return Object.keys(titles).filter((g) => groups[g].length).map((g) => `<p class="v15-group">${titles[g]} (${groups[g].length})</p>
      <div class="v15-rows">${groups[g].map((c) => `<div class="v15-row">${chip(c.kanji)}<span class="grow">${g === 'pending' ? pendingHTML(c.rec, c.capped) : changeHTML(c.from, c.to)}</span></div>`).join('')}</div>`).join('');
  }

  // ------------------------------------------------------------------ practice (§8)

  function practiceFilters() {
    const f = S.pr.filters;
    const out = {};
    if (f.level) out.levels = [f.level];
    if (f.setId) out.setId = f.setId;
    if (f.radical) out.radical = Number(f.radical);
    if (f.component) out.component = f.component;
    return out;
  }

  function practicePlan() {
    const pr = S.pr;
    const filters = practiceFilters();
    const list = PR.filterKanji(root.PRACTICE_CATALOG, root.PRACTICE_SETS, filters);
    const opts = { filters, seed: pr.seed, readingWords: WORDS };
    if (!list.length) return { list, kanji: [], queue: [], state: 'noMatch' };
    if (pr.mode === 'weak') {
      if (!studied().length) return { list, kanji: [], queue: [], state: 'noStudied' };
      const weak = PR.selectWeak(ranks(), list);
      if (!weak.length) return { list, kanji: [], queue: [], state: 'noWeak' };
      return { list, kanji: weak, queue: V15.practiceQueue(store, root.PRACTICE_CATALOG, root.PRACTICE_SETS, Object.assign(opts, { weak: true })), state: 'ok' };
    }
    const inList = new Set(list);
    const chosen = pr.chosen.filter((k) => inList.has(k));
    const queue = chosen.length
      ? V15.practiceQueue(store, root.PRACTICE_CATALOG, root.PRACTICE_SETS, Object.assign(opts, { filters: Object.assign({ kanji: chosen }, filters) }))
      : [];
    return { list, kanji: chosen, queue, state: 'ok' };
  }

  /**
   * Readable label of a practice component (E2E_PASS #6): a glyph as it is; a KanjiVG code (CDP-xxxx) by the name in
   * PRACTICE_CATALOG.componentNames (from radicals.py), else the code itself.
   * @param {string} component glyph or code
   * @returns {string}
   */
  function componentLabel(component) {
    const names = root.PRACTICE_CATALOG.componentNames || {};
    return Object.prototype.hasOwnProperty.call(names, component) ? names[component] : component;
  }

  function selectRow(label, field, options) {
    const value = S.pr.filters[field];
    const opts = options.map(([v, text]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(text)}</option>`).join('');
    return `<div class="v15-filter"><label for="v15-f-${field}">${label}:</label><select id="v15-f-${field}" data-v15-change="${field}">${opts}</select></div>`;
  }

  function practiceSetupView() {
    const pr = S.pr;
    const plan = practicePlan();
    const levelList = PR.filterKanji(root.PRACTICE_CATALOG, root.PRACTICE_SETS, pr.filters.level ? { levels: [pr.filters.level] } : {});
    const sets = root.PRACTICE_SETS.sets.filter((s) => !pr.filters.level || s.levels.includes(pr.filters.level));
    const radicals = [...new Set(levelList.map((k) => root.PRACTICE_CATALOG.kanji[k].radical))].sort((a, b) => a - b);
    const components = [...new Set(levelList.flatMap((k) => root.PRACTICE_CATALOG.kanji[k].components))]
      .sort((a, b) => componentLabel(a).localeCompare(componentLabel(b)) || (a < b ? -1 : a > b ? 1 : 0));
    const filters = selectRow('Level', 'level', [['', 'All']].concat(LEVELS.map((l) => [l, l])))
      + selectRow('Set', 'setId', [['', 'Any']].concat(sets.map((s) => [s.id, s.title])))
      + selectRow('Radical', 'radical', [['', 'Any']].concat(radicals.map((r) => [r, `No. ${r}`])))
      + selectRow('Component', 'component', [['', 'Any']].concat(components.map((c) => [c, componentLabel(c)])));
    let body = '';
    if (plan.state === 'noMatch') {
      body = '<p>No kanji match these filters.</p><div class="v15-pills"><button class="v15-pill" data-v15="clearFilters">Clear filters</button></div>';
    } else if (plan.state === 'noStudied') {
      body = '<p>No studied kanji yet. Finish a lesson or take Placement first.</p><div class="v15-pills"><button class="v15-pill on" data-v15="openPlacement"><span lang="ja">診断</span> Placement</button></div>';
    } else if (plan.state === 'noWeak') {
      body = '<p>Nothing weak right now — nice. Choose kanji to practise instead.</p><div class="v15-pills"><button class="v15-pill on" data-v15="practiceMode" data-arg="choose">Choose</button></div>';
    } else if (pr.mode === 'choose') {
      const chosen = new Set(pr.chosen);
      body = `<div class="v15-pills"><button class="v15-pill" data-v15="selectAll">Select all (${plan.list.length})</button><button class="v15-pill" data-v15="selectNone">Clear</button></div>
        <div class="v15-chips v15-grid">${plan.list.map((k) => chip(k, { act: 'toggleKanji', sel: chosen.has(k) })).join('')}</div>`;
    }
    const summary = plan.state === 'ok' ? `<p class="v15-score" data-announce>${plan.kanji.length} kanji · ${plan.queue.length} items</p>` : '';
    return card(`<h1 tabindex="-1"><span class="ja" lang="ja">練習</span>Practice</h1>
      <div class="v15-seg" role="group" aria-label="Kanji to practise">
        <button class="${pr.mode === 'weak' ? 'on' : ''}" aria-pressed="${pr.mode === 'weak'}" data-v15="practiceMode" data-arg="weak">Weak</button>
        <button class="${pr.mode === 'choose' ? 'on' : ''}" aria-pressed="${pr.mode === 'choose'}" data-v15="practiceMode" data-arg="choose">Choose</button>
      </div>
      ${filters}${summary}${body}`,
    bottomBar([{ ja: '始める', en: 'Start', act: 'practiceStart', pri: true, disabled: !plan.queue.length }, { ja: '戻る', en: 'Back', act: 'quit' }]));
  }

  function practiceShowItem() {
    const pr = S.pr;
    const item = pr.queue[pr.index];
    if (item && item.kind === 'writing') startWriting(item.kanji, 'practice');
  }

  function practiceAdvance() {
    const pr = S.pr;
    if (override && override.mode === 'practice') hideOverride();   // UX-B4: the pill belongs to the item just done
    pr.index += 1;
    pr.cur = { typed: '', feedback: null };
    if (pr.index >= pr.queue.length) { pr.step = 'result'; store.removeItem(KEYS.practice); return; }
    saveKey(KEYS.practice, { queue: pr.queue, index: pr.index, results: pr.results, seed: pr.seed, before: pr.before, retried: pr.retried });
    practiceShowItem();
  }

  function practiceView() {
    const pr = S.pr;
    if (pr.step === 'setup') return practiceSetupView();
    if (pr.step === 'result') {
      const reading = pr.results.filter((r) => r.kind === 'reading');
      const writing = pr.results.filter((r) => r.kind === 'writing');
      const ok = (list) => list.filter((r) => r.ok).length;
      const moved = Object.keys(pr.before).map((k) => ({ kanji: k, from: pr.before[k], to: RM.getKanji(ranks(), k).rank })).filter((c) => c.to !== c.from);
      // UX-B4: a miss on the last item keeps its banner (and its pill) on the result screen
      return card(`${missBanner(pr.banner)}<p class="v15-headline" tabindex="-1" data-announce>Practice done</p>
        <p class="v15-score" data-announce>Reading ${ok(reading)} / ${reading.length} · Writing ${ok(writing)} / ${writing.length}</p>
        <p class="v15-muted">Retried near misses: ${pr.retried}</p>
        ${moved.length ? changeGroupsHTML(groupChanges(moved)) : ''}`,
      bottomBar([{ ja: '繰り返す', en: 'Again', act: 'practiceAgain', pri: true }, { ja: '終わる', en: 'Done', act: 'quit' }]));
    }
    const item = pr.queue[pr.index];
    const again = item.repeat && !pr.banner ? `<p class="v15-banner" data-announce>Once more: <span lang="ja">${esc(item.kanji)}</span></p>` : '';
    const head = `${quitButton()}${topLine(`${pr.index + 1} / ${pr.queue.length}`, pr.index, pr.queue.length)}${missBanner(pr.banner)}${again}`;
    if (item.kind === 'writing') return card(`${head}<p class="v15-ask">Write: <span lang="ja">${esc(item.kanji)}</span></p>`);
    const word = item.word;
    const fb = pr.cur.feedback;
    const buttons = fb ? [{ en: 'Next', act: 'practiceNext', pri: true }] : [{ en: 'Check', act: 'practiceCheck', pri: true }, { en: "I don't know", act: 'practiceIdk' }];
    return card(`${head}
      <div class="v15-word" lang="ja">${wordHTML(word, item.kanji)}</div>
      <div class="v15-gloss">${esc(word.m)}</div>
      ${readingInputHTML(item.kanji, pr.cur.typed, fb)}
      <div>${fb ? readingFeedbackHTML(word, fb.correct) : ''}</div>`, bottomBar(buttons));
  }

  function practiceStartQueue(queue) {
    const pr = S.pr;
    Object.assign(pr, { queue, index: 0, results: [], before: {}, retried: 0, banner: null, step: 'items', cur: { typed: '', feedback: null } });
    for (const it of queue) pr.before[it.kanji] = RM.getKanji(ranks(), it.kanji).rank;
    saveKey(KEYS.practice, { queue, index: 0, results: [], seed: pr.seed, before: pr.before, retried: 0 });
    practiceShowItem();
  }

  /** Whether any studied kanji is weak (PracticeModel.selectWeak over the whole catalog). */
  function anyWeak() {
    return studied().length > 0 && PR.selectWeak(ranks(), Object.keys(root.PRACTICE_CATALOG.kanji)).length > 0;
  }

  function freshPractice(setup = {}) {
    return Object.assign({ step: 'setup', mode: anyWeak() ? 'weak' : 'choose', filters: { level: '', setId: '', radical: '', component: '' },
      chosen: [], queue: [], index: 0, results: [], seed: 1, before: {}, retried: 0, banner: null, cur: { typed: '', feedback: null } }, setup);
  }

  // ------------------------------------------------------------------ modal

  function modalHTML() {
    const m = S.modal;
    if (!m) return '';
    if (m.kind === 'resume') {
      return `<div class="v15-modal" role="alertdialog" aria-modal="true" aria-label="Resume"><div class="lcard"><p>Resume where you left off? (${esc(m.label)})</p>
        <div class="lb">${lbButton({ ja: '続ける', en: 'Resume', act: 'resume', pri: true })}${lbButton({ ja: '最初から', en: 'Start over', act: 'startOver' })}</div></div></div>`;
    }
    if (m.kind === 'discardUnit') {
      return `<div class="v15-modal" role="alertdialog" aria-modal="true" aria-label="${esc(m.label)}"><div class="lcard"><p>You have an unfinished unit test (${esc(m.saved.level)} · Unit ${esc(m.saved.unit)}). Start Unit ${esc(m.unit)} anyway? Your progress there will be lost.</p>
        <div class="lb">${lbButton({ ja: '新しく始める', en: 'Start new', act: 'discardUnitStart', pri: true })}${lbButton({ ja: 'やめる', en: 'Cancel', act: 'closeModal' })}</div></div></div>`;
    }
    return `<div class="v15-modal" role="alertdialog" aria-modal="true" aria-label="Unanswered"><div class="lcard"><p>${m.count} unanswered. Unanswered count as misses.</p>
      <div class="lb">${lbButton({ ja: '終わる', en: 'Finish', act: 'unitFinishConfirm', pri: true })}${lbButton({ ja: '戻る', en: 'Go back', act: 'closeModal' })}</div></div></div>`;
  }

  /**
   * Offer to resume the run saved under `key`, or start fresh.
   * @param {string} key storage key of the saved run
   * @param {(saved: object) => string} label dialog text for the saved run
   * @param {(saved: object) => void} onResume restores the saved run
   * @param {() => void} onStart starts a fresh run
   */
  function maybeResume(key, label, onResume, onStart) {
    const saved = readRun(key);
    let text = null;
    try { text = saved && label(saved); } catch (e) { store.removeItem(key); }   // belt and braces for R1-2
    if (!text) { onStart(); return; }
    S.modal = { kind: 'resume', label: text, onResume: () => onResume(saved), onRestart: () => { store.removeItem(key); onStart(); } };
  }

  // ------------------------------------------------------------------ actions

  const ACTIONS = {
    quit: closeView,
    closeModal() { S.modal = null; },
    resume() { const m = S.modal; S.modal = null; m.onResume(); },
    /** 'Start new' in the unfinished-unit confirm: drop the other unit's saved run and start the tapped unit. */
    discardUnitStart() { const m = S.modal; S.modal = null; store.removeItem(KEYS.unit); m.onConfirm(); },
    startOver() { const m = S.modal; S.modal = null; m.onRestart(); },

    openPlacement() {
      openView('placement');
      S.pl = { step: 'intro', retake: studied().length > 0, state: null, feedback: null, levelUp: null, result: null, before: {}, saved: null };
      maybeResume(KEYS.placement, (s) => `${s.level} · ${s.asked + 1} / ${s.queue.length}`,
        (s) => { S.pl.state = s; S.pl.step = 'question'; }, ACTIONS.placementStart);
    },
    placementStart() {
      S.pl.state = PM.start(root.PLACEMENT_POOLS);
      S.pl.step = 'question';
      saveKey(KEYS.placement, S.pl.state);
    },
    placementChoose(text) {
      const pl = S.pl;
      if (pl.feedback || pl.step !== 'question') return;
      const q = PM.nextQuestion(pl.state);
      const set = readingChoices(q.kanji, root.PLACEMENT_POOLS.levels[q.level].kanji.map((e) => e.c));
      const picked = text === '' ? null : text;
      pl.feedback = { picked, correct: picked !== null && picked === set.word.r };
      setTimeout(() => { ACTIONS.placementAdvance(); render(); }, FEEDBACK_MS);
    },
    placementAdvance() {
      const pl = S.pl;
      if (!pl.feedback) return;
      const from = pl.state.level;
      pl.state = PM.answer(root.PLACEMENT_POOLS, pl.state, pl.feedback.correct);
      pl.feedback = null;
      pl.levelUp = null;
      if (pl.state.finished) { placementFinish(); return; }
      saveKey(KEYS.placement, pl.state);
      if (pl.state.level !== from) {
        pl.levelUp = { from, to: pl.state.level };
        const shown = pl.levelUp;
        setTimeout(() => { if (S.pl && S.pl.levelUp === shown) { S.pl.levelUp = null; if (S.view === 'placement') render(); } }, LEVEL_UP_MS);
      }
    },
    placementPractice() {
      const level = S.pl.result.estimatedLevel;
      openView('practice');
      S.pr = freshPractice({ filters: { level, setId: '', radical: '', component: '' } });
    },

    openUnits() { openView('unit'); S.ut = { step: 'picker', level: 'N5', unit: null, answers: {}, index: 0, result: null }; },
    unitLevel(level) { S.ut.level = level; },
    unitOpen(n) {
      const ut = S.ut;
      const unit = Number(n);
      const start = () => {
        Object.assign(ut, { unit, answers: {}, index: 0, step: 'question', result: null });
        saveKey(KEYS.unit, { level: ut.level, unit, answers: {}, index: 0 });
      };
      const saved = readRun(KEYS.unit);
      if (saved && !(saved.level === ut.level && Number(saved.unit) === unit)) {
        // R1-8: another unit's run is saved; ask before replacing it (Cancel = closeModal keeps it).
        S.modal = { kind: 'discardUnit', label: `Start ${ut.level} Unit ${unit}? (unfinished: ${saved.level} Unit ${saved.unit})`, saved, unit, onConfirm: start };
        return;
      }
      maybeResume(KEYS.unit,
        (s) => `${s.level} Unit ${s.unit} · ${s.index + 1} / ${UT.getUnit(root.READING_TESTS, s.level, s.unit).questions.length}`,
        (s) => Object.assign(ut, s, { step: 'question' }), start);
    },
    /** Pick a reading; moves on to the next question (the last one finishes when everything is answered). */
    unitChoose(c) {
      const ut = S.ut;
      const unit = unitObj();
      const q = unit.questions[ut.index];
      ut.answers = Object.assign({}, ut.answers, { [q.kanji]: c });
      if (ut.index < unit.questions.length - 1) ut.index += 1;
      else if (unit.questions.every((x) => ut.answers[x.kanji] !== undefined)) { unitFinish(); return; }
      saveKey(KEYS.unit, { level: ut.level, unit: ut.unit, answers: ut.answers, index: ut.index });
    },
    unitNext() { S.ut.index += 1; },
    unitBack() { if (S.ut.index > 0) S.ut.index -= 1; },
    unitFinish() {
      const missing = unitObj().questions.filter((q) => S.ut.answers[q.kanji] === undefined).length;
      if (missing) { S.modal = { kind: 'unanswered', count: missing }; return; }
      unitFinish();
    },
    unitFinishConfirm: unitFinish,
    unitRetry() { Object.assign(S.ut, { answers: {}, index: 0, step: 'question', result: null }); },
    unitNextUnit() {
      const ut = S.ut;
      if (UT.getUnit(root.READING_TESTS, ut.level, ut.unit + 1)) Object.assign(ut, { unit: ut.unit + 1, answers: {}, index: 0, step: 'question', result: null });
      else ut.step = 'picker';
    },
    practiceMisses() { openView('practice'); S.pr = freshPractice({ mode: 'choose', chosen: S.ut.result.misses.map((m) => m.kanji) }); },
    practiceKanji(k) { openView('practice'); S.pr = freshPractice({ mode: 'choose', chosen: [k] }); },

    openCheck() {
      openView('check');
      S.lc = { step: 'items', items: [], index: 0, results: [], feedback: null, banner: null, changes: [] };
      if (!studied().length) { S.lc.step = 'empty'; return; }
      maybeResume(KEYS.check, (s) => `Level check · ${s.index + 1} / ${s.items.length}`,
        (s) => {
          // A run saved before R1-4 has no `changes`: its answers never reached the ranks, so apply them once now.
          if (!s.changes) s.changes = V15.applyLevelCheck(store, s.results).changes;
          Object.assign(S.lc, s, { step: 'items' });
          checkShowItem();
        }, checkStart);
    },
    /** Judge the typed reading with LevelCheckModel.readingOutcome (ReadingAnswer: kana/width/alts lenient, romaji rejected). */
    checkReading() {
      const lc = S.lc;
      if (lc.feedback) return;
      const input = document.getElementById('v15-reading');
      lc.typed = input ? input.value : '';
      const item = lc.items[lc.index];
      checkWord(item);
      ACTIONS.checkResult(LC.readingOutcome(item, lc.typed));
    },
    checkIdk() { if (!S.lc.feedback) ACTIONS.checkResult('readingMiss'); },
    /** Record a reading outcome and show its feedback until Next. */
    checkResult(outcome) {
      const lc = S.lc;
      lc.feedback = { correct: outcome === 'correct' };
      lc.banner = null;
      checkRecord(lc.items[lc.index].kanji, outcome);
    },
    checkNext() { S.lc.typed = ''; checkAdvance(); },

    openPractice() {
      openView('practice');
      S.pr = freshPractice();
      maybeResume(KEYS.practice, (s) => `Practice · ${s.index + 1} / ${s.queue.length}`,
        (s) => { Object.assign(S.pr, { retried: 0 }, s, { step: 'items', cur: { typed: '', feedback: null } }); practiceShowItem(); }, () => {});
    },
    practiceWeak() { openView('practice'); S.pr = freshPractice({ mode: 'weak' }); },
    practiceMode(mode) { S.pr.mode = mode; },
    clearFilters() { S.pr.filters = { level: '', setId: '', radical: '', component: '' }; },
    selectAll() { S.pr.chosen = practicePlan().list.slice(); },
    selectNone() { S.pr.chosen = []; },
    toggleKanji(k) { const pr = S.pr; pr.chosen = pr.chosen.includes(k) ? pr.chosen.filter((x) => x !== k) : pr.chosen.concat([k]); },
    practiceStart() { const plan = practicePlan(); if (plan.queue.length) practiceStartQueue(plan.queue); },
    practiceCheck() {
      const input = document.getElementById('v15-reading');
      S.pr.cur.typed = input ? input.value : '';
      ACTIONS.practiceReading(PR.checkAnswer(S.pr.queue[S.pr.index], S.pr.cur.typed));
    },
    practiceIdk() { ACTIONS.practiceReading(false); },
    practiceReading(correct) {
      const pr = S.pr;
      pr.cur.feedback = { correct };
      pr.banner = null;
      pr.results.push({ kind: 'reading', ok: correct });
      V15.onReadingResult(store, pr.queue[pr.index].kanji, correct);
    },
    practiceNext: practiceAdvance,
    override: applyOverride,
    practiceAgain() { S.pr.seed += 1; S.pr.step = 'setup'; },
  };

  // ------------------------------------------------------------------ render + events

  /** Which screen is showing; focus moves to its heading (or input) only when this changes. */
  function screenKey() {
    const st = S[{ placement: 'pl', unit: 'ut', check: 'lc', practice: 'pr' }[S.view]] || {};
    const count = host().querySelector('.v15-count');   // "N5 · 3 / 10": changes with every question
    return [S.view, st.step, st.unit, st.level, count ? count.textContent : '', S.modal ? S.modal.kind : ''].join('|');
  }

  let lastScreen = '';
  let lastSaid = '';

  function render() {
    if (!S.view) return;
    if (!WORDS) {   // models / reading words not in yet: show a placeholder and render for real once they are
      host().innerHTML = '<p class="v15-loading" role="status">Loading…</p>';
      loadWords().then(render);
      return;
    }
    const views = { placement: placementView, unit: unitView, check: checkView, practice: practiceView };
    const was = document.activeElement;
    const hadFocus = host().contains(was);
    const wasKey = !hadFocus ? '' : was.dataset.v15 ? `[data-v15="${was.dataset.v15}"][data-arg="${CSS.escape(was.dataset.arg || '')}"]` : (was.id ? `#${was.id}` : '*');
    host().innerHTML = views[S.view]() + modalHTML();
    const key = screenKey();
    restoreFocus(key !== lastScreen, wasKey);
    lastScreen = key;
    announce();
    syncOverridePill();
  }

  /** New screen: dialog button, else reading input, else the heading. Same screen: the control that had focus. */
  function restoreFocus(newScreen, wasKey) {
    const h = host();
    const usable = (el) => el && !el.disabled && !el.readOnly && el.offsetParent !== null;
    let target = null;
    if (!newScreen && wasKey) {
      const same = h.querySelector(wasKey);
      target = usable(same) ? same : h.querySelector('.v15-bar button.pri:not([disabled])');
    }
    if (newScreen || (!target && wasKey)) {
      target = h.querySelector('.v15-modal button') || h.querySelector('#v15-reading')
        || h.querySelector('h1[tabindex], .v15-headline[tabindex], .v15-count[tabindex]');
    }
    if (target) target.focus({ preventScroll: !newScreen });
  }

  /** Tab / Shift+Tab stay inside the open v15 screen (it is a modal dialog over the lesson). */
  function trapTab(e) {
    if (e.key !== 'Tab' || !S.view) return;
    const h = host();
    const items = [...h.querySelectorAll('button:not([disabled]), input, select, [tabindex="0"]')].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (!h.contains(at)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && (at === first || !items.includes(at))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  }

  /** Copy the screen's verdict / result / banner text into the persistent polite live region. */
  function announce() {
    const live = document.getElementById('v15live');
    if (!live) return;
    const text = [...host().querySelectorAll('[data-announce]')].map((el) => el.innerText.trim()).filter(Boolean).join('. ');
    if (text === lastSaid) return;
    lastSaid = text;
    live.textContent = text;
  }

  function onClick(e) {
    const el = e.target.closest('[data-v15]');
    if (!el || el.disabled) return;
    const act = ACTIONS[el.dataset.v15];
    if (!act) return;
    e.stopPropagation();
    const run = () => { act(el.dataset.arg); render(); };
    if (WORDS) { run(); return; }
    // B5: the words are still loading. Keep the tap (taps run in order once they are in) and show it is coming.
    const shown = S.view ? host().querySelector('.v15-loading') : null;
    if (S.view && !shown) host().insertAdjacentHTML('afterbegin', '<p class="v15-loading" role="status">Loading…</p>');
    loadWords().then(run);
  }

  function onChange(e) {
    const el = e.target.closest('[data-v15-change]');
    if (!el || !S.pr) return;
    const field = el.dataset.v15Change;
    S.pr.filters[field] = el.value;
    if (field === 'level') Object.assign(S.pr.filters, { setId: '', radical: '', component: '' });
    render();
  }

  /** True while an IME is composing in the reading input (also covers browsers that send keyCode 229). */
  let composing = false;

  function onKey(e) {
    if (e.key !== 'Enter' || e.target.id !== 'v15-reading') return;
    if (composing || e.isComposing || e.keyCode === 229) return;   // Enter confirms the IME candidate, not the answer
    e.preventDefault();
    if (S.view === 'check') { if (S.lc && !S.lc.feedback) { ACTIONS.checkReading(); render(); } }
    else if (S.pr && !S.pr.cur.feedback) { ACTIONS.practiceCheck(); render(); }
  }

  /**
   * The open picker (lesson rows, search results) ends above the writing controls, so #undo and #clear stay
   * visible and tappable and no row sits under them (the app's max-height is 72vh, which reached past them).
   */
  function fitPicker() {
    const list = document.getElementById('klist');
    const controls = document.querySelector('#stage .controls');
    if (!list || !controls || !list.classList.contains('show')) return;
    const gap = 8;
    const slide = 8;   // the list opens with a 6 px translateY that is still running when it is measured
    const room = controls.getBoundingClientRect().top - list.getBoundingClientRect().top - gap - slide;
    list.style.maxHeight = room > 200 ? `min(72vh, ${Math.floor(room)}px)` : '';
  }

  function watchPicker() {
    const list = document.getElementById('klist');
    if (!list) return;
    new MutationObserver(fitPicker).observe(list, { attributes: true, attributeFilter: ['class'] });
    list.addEventListener('transitionend', fitPicker);
    window.addEventListener('resize', fitPicker);
    fitPicker();
  }

  function init() {
    watchPicker();
    if (!document.getElementById('v15')) {
      document.body.insertAdjacentHTML('afterbegin', '<div class="lend v15" id="v15" role="dialog" aria-modal="true" aria-label="Test"></div>');
    }
    document.body.insertAdjacentHTML('beforeend',
      '<button class="ib wide" id="v15ovr" hidden aria-label="I wrote it correctly"><span aria-hidden="true">✓</span><span class="v15-ovr-label">I wrote it correctly</span></button>'
      + '<div id="v15toast" role="status" aria-live="polite" aria-atomic="true"></div>'
      + '<div id="v15live" class="v15-sr" aria-live="polite" aria-atomic="true"></div>');
    document.getElementById('v15ovr').addEventListener('click', onOverrideClick);
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keydown', trapTab);
    document.addEventListener('compositionstart', () => { composing = true; });
    // Safari fires compositionend before the confirming Enter's keydown: clear the flag on the next task
    document.addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });
    if (typeof renderPicker === 'function') renderPicker();
    prefetchWords();
  }

  root.V15UI = { dataReady, loadWords, menuHTML, pruneRuns, kanjiTier, onReject, onWrongKanji, onCelebrate, onBoxChange, onLessonEnd, state: S, actions: ACTIONS, render, toast };
  init();
})(window);
