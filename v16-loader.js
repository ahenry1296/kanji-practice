/* v16-loader.js — v16 R20 (Botfive): load non-critical v16 scripts after first paint, and view files on first mount.
 *
 * Why: on a slow phone every boot <script> is downloaded and evaluated before the first practice box appears.
 * Models nobody needs for the first lesson (stats, component families, example sentences, tips) now load
 * after the first paint, when the browser is idle; the view files load when B4 first mounts them.
 * Every file stays in the sw.js precache, so all of this works offline once installed.
 *
 * API (browser global V16Lazy; V16Views.load is a convenience alias for B4):
 *   V16Lazy.load(group)        → Promise<void>  load a group (see GROUPS); idempotent, one fetch per file ever
 *   V16Lazy.loaded(group)      → boolean        every file of the group has run (or its global already existed)
 *   V16Lazy.deferUntilIdle()   → Promise<void>  after first paint + idle, load DEFERRED groups in order;
 *                                               then fires window event 'v16:deferred-ready'
 *   V16Lazy.loadView(name)     → Promise<global> CANONICAL: load a view and its models; resolves to the view global
 *                                               ('stats' → StatsView, 'components' → ComponentsView,
 *                                                'settings' → SettingsView, 'study-cards' → StudyCards,
 *                                                'tips' → TipsModel). Old globals keep working once loaded.
 *   V16Views.load(name)        → same as V16Lazy.loadView. MERGED, never owned: B4's v16-views.js assigns its own
 *                                window.V16Views object later, so window.V16Views is an accessor that attaches
 *                                load (and VIEWS) onto whatever object is assigned, unless it already has a load.
 *                                Re-checked on DOMContentLoaded too (in case the property was redefined).
 * Errors: a file that fails (offline and not cached, 404) rejects with Error('v16-loader: failed <file>') and
 * is forgotten, so the next load() retries it. Files inside a group load in order (later files may use earlier).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.V16Lazy = api.V16Lazy; api.installViewsAlias(root); }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  /** Each file with the test that tells it has already run (so an eager <script> tag is never loaded twice). */
  const PRESENT = {
    'stats-model.js': () => !!root.StatsModel,
    'component-model.js': () => !!root.ComponentModel,
    'nested-groups.js': () => !!root.KANJI_GROUPS,   // R22: B3's nested groups (~283 KB)
    'component-glyphs.js': () => !!root.COMPONENT_GLYPHS,   // R22: B3's drawings (also lazy-loaded by v16-views.js)
    'context-sentences-n5.js': () => !!(root.CONTEXT_SENTENCES && root.CONTEXT_SENTENCES.N5),
    'sentences-model.js': () => !!root.SentencesModel,
    'tips-data.js': () => !!root.TIPS_DATA,
    'tips-model.js': () => !!root.TipsModel,
    'stats-view.js': () => !!root.StatsView,
    'components-view.js': () => !!root.ComponentsView,
    'settings-view.js': () => !!root.SettingsView,
    'study-cards-view.js': () => !!root.StudyCards,
    'weakspot-model.js': () => !!root.WeakSpotModel,   // R24
    'v16-weakspot.js': () => !!root.V16WeakSpot,       // R24: observer on checkStroke (installs itself once)
    'notes-model.js': () => !!root.V16Notes,           // R25: personal component stories (v16:notes)
    'practice-catalog.js': () => !!root.PRACTICE_CATALOG,   // R26 needs the catalog to tell in-app kanji (v15-ui.js also lazy-loads it)
    'placement-model.js': () => !!root.PlacementModel,   // R26 needs applyResult (v15-ui.js also lazy-loads it)
    'known-import-model.js': () => !!root.V16KnownImport,   // R26: "I already know these" import
    'study-order-data.js': () => !!root.STUDY_ORDER_DATA,   // R27: per-kanji frequency / grade / strokes (~38 KB)
    'study-order-model.js': () => !!root.V16StudyOrder,     // R27: alternate study orders
    'word-unlock-model.js': () => !!root.V16WordUnlock,     // R28: words you can read (uses READING_WORDS from v15-ui)
  };
  /** Groups: files in load order. */
  const GROUPS = {
    stats: ['stats-model.js'],
    components: ['component-model.js', 'nested-groups.js', 'component-glyphs.js'],
    sentences: ['context-sentences-n5.js', 'sentences-model.js'],
    tips: ['tips-data.js', 'tips-model.js'],
    weakspot: ['weakspot-model.js', 'v16-weakspot.js'],   // R24 weak-spot diagnosis (~21 KB)
    known: ['practice-catalog.js', 'placement-model.js', 'known-import-model.js'],   // R26 (~6 KB new; the catalog is skipped when v15-ui already loaded it); not deferred: loaded on demand by the import UI (V16Lazy.load('known'))
    order: ['study-order-data.js', 'study-order-model.js'],   // R27 alternate study orders (~45 KB); deferred, and
    //   loaded on demand by the new-lesson button when V15.studyOrderSetting(localStorage).order !== 'app'
    unlock: ['word-unlock-model.js'],   // R28 words you can read (~8 KB); deferred; the data (reading-words.js) is v15-ui's
    notes: ['notes-model.js'],   // R25 personal component stories (~6 KB); drafts use ComponentModel when 'components' has loaded
  };
  /** Loaded after the first paint, in this order (what the first lesson is least likely to need goes last). */
  // R24: 'weakspot' first: it is small and records strokes, so it should be watching before the first lesson starts.
  // R25: 'notes' last: only needed when the learner opens a kanji's info/study card.
  // R27: 'order' right after 'weakspot': the next new-kanji lesson needs it (when the learner chose an order).
  // R28: 'unlock' just before 'notes': only needed on a result screen or the word list, after the first lesson.
  const DEFERRED = ['weakspot', 'order', 'stats', 'components', 'sentences', 'tips', 'unlock', 'notes'];
  /** View name → [groups it needs, its own file, its global]. */
  const VIEWS = {
    stats: [['stats'], 'stats-view.js', 'StatsView'],
    components: [['components'], 'components-view.js', 'ComponentsView'],
    settings: [[], 'settings-view.js', 'SettingsView'],
    'study-cards': [['components', 'sentences'], 'study-cards-view.js', 'StudyCards'],
    tips: [['tips'], null, 'TipsModel'],
  };

  const pending = {};   // file → Promise while loading or after success (deleted on failure → retry)

  /** Load one classic script once. */
  function loadFile(file) {
    if (PRESENT[file] && PRESENT[file]()) return Promise.resolve();
    if (pending[file]) return pending[file];
    pending[file] = new Promise((resolve, reject) => {
      const doc = root.document;
      if (!doc) { reject(new Error('v16-loader: no document for ' + file)); return; }
      const el = doc.createElement('script');
      el.src = file;
      el.async = false;
      el.onload = () => resolve();
      el.onerror = () => { el.remove(); reject(new Error('v16-loader: failed ' + file)); };
      doc.head.appendChild(el);
    }).catch((err) => { delete pending[file]; throw err; });
    return pending[file];
  }
  /** Files one after another (a later file may need an earlier one). */
  function loadSeq(files) {
    return files.reduce((p, f) => p.then(() => loadFile(f)), Promise.resolve());
  }

  function load(group) {
    if (!GROUPS[group]) return Promise.reject(new Error('v16-loader: unknown group ' + group));
    return loadSeq(GROUPS[group]);
  }
  function loaded(group) {
    return !!GROUPS[group] && GROUPS[group].every((f) => PRESENT[f]());
  }

  /** Resolves after the next frame has painted, then when the browser is idle (setTimeout fallback, e.g. Safari). */
  function afterPaintIdle() {
    return new Promise((resolve) => {
      const raf = root.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      raf(() => setTimeout(() => {
        if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(() => resolve(), { timeout: 2000 });
        else setTimeout(resolve, 200);
      }, 0));
    });
  }
  let deferred = null;
  /** Called once by index.html after boot. Failures are logged, not thrown (each group retries on its next load()). */
  function deferUntilIdle() {
    if (deferred) return deferred;
    deferred = afterPaintIdle()
      .then(() => DEFERRED.reduce((p, g) => p.then(() => load(g).catch((e) => console.warn(e.message))), Promise.resolve()))
      .then(() => { if (root.dispatchEvent && typeof CustomEvent === 'function') root.dispatchEvent(new CustomEvent('v16:deferred-ready')); });
    return deferred;
  }

  /** B4: V16Views.load('stats').then((StatsView) => StatsView.mount(el, ...)). */
  function loadView(name) {
    const v = VIEWS[name];
    if (!v) return Promise.reject(new Error('v16-loader: unknown view ' + name));
    const [groups, file, global] = v;
    return groups.reduce((p, g) => p.then(() => load(g)), Promise.resolve())
      .then(() => (file ? loadFile(file) : undefined))
      .then(() => root[global]);
  }

  /** Add load/VIEWS to a V16Views object (non-enumerable, so B4's object keeps its own shape). Never overwrites. */
  function attachLoad(obj) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || !Object.isExtensible(obj)) return obj;
    if (typeof obj.load !== 'function') Object.defineProperty(obj, 'load', { value: loadView, configurable: true, writable: true });
    if (!obj.VIEWS) Object.defineProperty(obj, 'VIEWS', { value: VIEWS, configurable: true, writable: true });
    return obj;
  }
  /**
   * window.V16Views as an accessor: reading gives the current object; assigning a new object (B4's v16-views.js
   * does `root.V16Views = {...}`) stores it and attaches load. Starts as a small {load, VIEWS} object, as in R20.
   */
  function installViewsAlias(win) {
    let current = attachLoad(win.V16Views || {});
    try {
      Object.defineProperty(win, 'V16Views', { configurable: true, enumerable: true,
        get: () => current, set: (v) => { current = attachLoad(v); } });
    } catch (_) { win.V16Views = current; }   // property not configurable: plain value (V16Lazy.loadView still works)
    if (win.addEventListener) win.addEventListener('DOMContentLoaded', () => attachLoad(win.V16Views));
  }

  return {
    V16Lazy: { load, loaded, deferUntilIdle, loadView, GROUPS, DEFERRED },
    V16Views: attachLoad({}),
    installViewsAlias,
    attachLoad,
  };
});
