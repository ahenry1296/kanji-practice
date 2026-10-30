/*
 * v16-views.js — Botfour: mounts Botfive's prebuilt views (stats, components, settings, study cards) in one
 * overlay (#v16v), opened from the picker menu (V15UI.menuHTML adds the buttons, data-v16view="<name>").
 * The views read storage themselves; the only writes here are the ones the study cards ask for through their
 * events (the cards never write storage). Load after study-cards-view.js and v15-ui.js.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const store = root.localStorage;

  const TITLES = {
    stats: ['統計', 'Stats'],
    parts: ['部品', 'Kanji families'],
    settings: ['設定', 'Settings'],
    study: ['学習', 'Study cards'],
    whatsnew: ['新機能', "What's new"],
    words: ['読める', 'Words you can read'],   // RC11-word-unlock-ui (R28)
  };
  // View → R19 tip event (tips-data.js `when`).
  const TIP_EVENT = { parts: 'components', settings: 'settings', study: 'leech' };

  const kanjiMap = () => (root.KANJI_DATA && root.KANJI_DATA.kanji) || {};
  const pairs = () => (root.CONFUSABLES ? root.CONFUSABLES.pairs : []);
  const LESSON_SIZE = 5;
  /** The kanji on screen in the lesson (index.html globals D / cur), for the sentence card; else B5 picks a due one. */
  const lessonKanji = () => {
    try { const k = D[cur] && D[cur].k; return k && kanjiMap()[k] ? k : undefined; } catch (e) { return undefined; }
  };

  const mounted = {};          // name → {handle, el}
  let current = null;
  let returnFocus = null;
  const dismissedLeeches = new Set();   // no V15 write API for "dismiss" yet: hidden for this session only


  // ---- Component glyph drawings (B3's component-glyphs.js, loaded on first use: ~200 KB) ----
  // Decorates B5's ComponentsView tiles/family header and the weak-spot card from outside (MutationObserver),
  // so B5's view files stay unchanged. Entries flagged check (stroke data in doubt) or without paths keep the text glyph.
  const GLYPH_FILE = 'component-glyphs.js';
  let glyphLoad = null;
  function loadGlyphs() {
    if (root.COMPONENT_GLYPHS) return Promise.resolve(root.COMPONENT_GLYPHS);
    if (!glyphLoad) {
      glyphLoad = new Promise((resolve) => {
        const s = doc.createElement('script');
        s.src = GLYPH_FILE;
        s.onload = () => resolve(root.COMPONENT_GLYPHS || null);
        s.onerror = () => resolve(null);   // offline / missing: text glyphs stay
        doc.head.appendChild(s);
      });
    }
    return glyphLoad;
  }
  /** Drawable entry for a component, or null (no data, flagged check, or no paths). */
  function glyphEntry(g) {
    const e = root.COMPONENT_GLYPHS && root.COMPONENT_GLYPHS.glyphs[g];
    return e && e.drawable && !e.check && e.paths && e.paths.length ? e : null;
  }
  const glyphSvg = (e) => `<svg class="v16g" viewBox="0 0 109 109" aria-hidden="true" focusable="false">${
    e.paths.map((d) => `<path d="${esc(d)}"/>`).join('')}</svg>`;
  /** "from 話": the kanji whose strokes the drawing was taken from (omitted when it is the component itself). */
  const fromNote = (e) => (e.pathsFrom && e.pathsFrom !== e.g
    ? `<small class="v16g-from">from <span lang="ja">${esc(e.pathsFrom)}</span></small>` : '');

  /** Drawings taken from a host kanji sit where they were in it: fit the viewBox to the strokes (square, padded). */
  function fitDrawings(el) {
    el.querySelectorAll('svg.v16g:not([data-fit])').forEach((svg) => {
      const b = svg.getBBox();
      if (!b.width && !b.height) return;   // not laid out yet (hidden pane): try again on the next change
      svg.dataset.fit = '';
      const side = Math.max(b.width, b.height, 30) + 16;
      const x = b.x + b.width / 2 - side / 2;
      const y = b.y + b.height / 2 - side / 2;
      svg.setAttribute('viewBox', `${x.toFixed(1)} ${y.toFixed(1)} ${side.toFixed(1)} ${side.toFixed(1)}`);
    });
  }

  function decorateParts(el) {
    el.querySelectorAll('.cv-comp[data-comp] .cv-glyph:not([data-v16g])').forEach((span) => {
      span.dataset.v16g = '';
      const e = glyphEntry(span.closest('.cv-comp').dataset.comp);
      if (e) span.innerHTML = glyphSvg(e);
    });
    const h = el.querySelector('#cv-h-fam:not([data-v16g])');
    const sel = el.querySelector('.cv-comp[aria-pressed="true"]');
    if (h && sel) {
      h.dataset.v16g = '';
      const e = glyphEntry(sel.dataset.comp);
      if (e) h.insertAdjacentHTML('beforebegin', `<div class="v16g-fig">${glyphSvg(e)}${fromNote(e)}</div>`);
    }
  }
  function decorateWeakSpot(el) {
    const card = el.querySelector('.sc-weakspot');
    const d = el.v16data && el.v16data() && el.v16data().weakSpot;
    if (!card || !d || card.querySelector('.v16g-fig')) return;
    const e = glyphEntry(d.component);
    const h = card.querySelector('h3');
    if (e && h) h.insertAdjacentHTML('afterend', `<div class="v16g-fig">${glyphSvg(e)}<small>The part on its own</small>${fromNote(e)}</div>`);
  }
  function watchGlyphs(name, el) {
    const decorate = name === 'parts' ? decorateParts : name === 'study' ? decorateWeakSpot : null;
    if (!decorate) return;
    const run = () => { if (root.COMPONENT_GLYPHS) { decorate(el); fitDrawings(el); } };
    new MutationObserver(run).observe(el, { childList: true, subtree: true });
    loadGlyphs().then(run);
  }

  function overlay() {
    let el = doc.getElementById('v16v');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'v16v';
      el.className = 'lend';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.innerHTML = `<div class="v16v-card">
        <div class="v16v-head"><h1 tabindex="-1"></h1><button type="button" class="v16v-back" data-v16v="close">Back</button></div>
        <div class="v16v-body"></div></div>`;
      doc.body.appendChild(el);
      el.addEventListener('click', (e) => { if (e.target.closest('[data-v16v="close"]')) close(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
      wireCardEvents(el);
    }
    return el;
  }

  // ---- Research #3: display-font toggle (textbook / Mincho / Gothic). ----
  // Display text only: it swaps the --mincho custom property via html[data-kfont]. The stroke-order paths, the
  // ghost/trace layers, the drawing canvas and grading use no font (KanjiVG paths + canvas ink), so they cannot change;
  // t20.py checks that. Saved under 'v16:font' (v16: keys travel with ExportModel backups). Mincho = no attribute = v16 as before.
  const FONT_KEY = 'v16:font';
  const FONTS = [['textbook', '教', 'Textbook'], ['mincho', '明', 'Mincho'], ['gothic', 'ゴ', 'Gothic']];
  function fontPref() {
    let v = null; try { v = store.getItem(FONT_KEY); } catch (e) { /* storage blocked: default */ }
    return FONTS.some((f) => f[0] === v) ? v : 'mincho';
  }
  function applyFont(v) {
    const html = doc.documentElement;
    if (v === 'mincho') html.removeAttribute('data-kfont'); else html.setAttribute('data-kfont', v);
  }
  function setFont(v) {
    if (!FONTS.some((f) => f[0] === v)) return;
    try { if (v === 'mincho') store.removeItem(FONT_KEY); else store.setItem(FONT_KEY, v); } catch (e) { /* applies for this visit only */ }
    applyFont(v);
  }
  applyFont(fontPref());
  /** RC16-reading-font-ui (R31): "Reading font" Off / Fixed / Vary, and for Fixed only the faces this device has.
   *  Display only: saved with V15.setReadingFont; built with createElement/textContent. */
  function readingFontSection() {
    const V = root.V15;
    if (!V || !V.setReadingFont || !V.readingFontSetting || !V.READING_FACES) return null;
    const el = doc.createElement('fieldset');
    el.className = 'v16-font v16-rfont';   // same look as the Kanji font box
    const mk = (tag, props) => Object.assign(doc.createElement(tag), props || {});
    const legend = mk('legend', { textContent: 'Reading font' });
    const note = mk('p', { textContent: 'The font of the kanji in reading questions. Vary rotates fonts on review kanji so you learn the shapes, not one font. Answers and reviews stay the same.' });
    const mLab = mk('label', { htmlFor: 'v16-rf-mode', textContent: 'Reading font ' });
    const mode = mk('select', { id: 'v16-rf-mode' });
    mode.style.minHeight = '44px';
    for (const [v, t] of [['off', 'Off'], ['fixed', 'Fixed'], ['vary', 'Vary']]) mode.append(mk('option', { value: v, textContent: t }));
    mLab.append(mode);
    const fLab = mk('label', { htmlFor: 'v16-rf-face', textContent: 'Font ' });
    const face = mk('select', { id: 'v16-rf-face' });
    face.style.minHeight = '44px';
    fLab.append(face);
    const none = mk('p', { className: 'v16-rf-none', textContent: 'This device has none of the extra fonts, so the app font is used.' });
    el.append(legend, note, mLab, fLab, none);
    let needPick = false;   // RC16b: saved face missing on this device; cleared by a pick
    const avail = () => Object.keys(V.READING_FACES).filter((f) => V.readingFontAvailable && V.readingFontAvailable(f, doc));
    function update() {
      const st = V.readingFontSetting(store);
      const a = avail();
      mode.value = st.mode;
      face.replaceChildren(...a.map((f) => mk('option', { value: f, textContent: V.READING_FACES[f].label })));
      // RC16b: the saved face as stored (a legacy value like 'kaisho' sanitizes to 'textbook', so read the raw key).
      // Not on this device -> a selected, disabled placeholder; nothing is written until the user picks a face.
      let raw = null;
      try { raw = (JSON.parse(store.getItem(V.READING_FONT_KEY)) || {}).face; } catch (e) { /* malformed: treat as missing */ }
      if (raw != null && !a.includes(raw)) needPick = true;   // sticky until a pick: a mode change may rewrite the face
      if (!needPick && a.includes(st.face)) face.value = st.face;
      else if (a.length) {
        needPick = true;
        face.prepend(mk('option', { value: '', textContent: 'Saved font not on this device', disabled: true, selected: true }));
        face.value = '';
      }
      fLab.style.display = st.mode !== 'fixed' || !a.length ? 'none' : '';   // CSS display beats [hidden]
      none.style.display = st.mode !== 'fixed' || a.length > 0 ? 'none' : '';
    }
    el.addEventListener('change', (e) => {
      if (e.target === mode) {
        V.setReadingFont(store, { mode: mode.value });   // RC16b: the face is only saved when the user picks one
      } else if (e.target === face) { if (face.value) { needPick = false; V.setReadingFont(store, { face: face.value }); } }   // RC16b: placeholder '' never saves
      else return;
      update();
    });
    update();
    return { el, update, unmount() { if (el.parentNode) el.remove(); } };
  }
  /** RC17-meaning-pretest-ui (R33 hooks 1+5): "Guess the meaning before new kanji" checkbox (default off).
   *  Reading the setting never writes; only a tick/untick saves (V15.setMeaningPretest). textContent only. */
  function pretestSection() {
    const V = root.V15;
    if (!V || !V.meaningPretestSetting || !V.setMeaningPretest) return null;
    const mk = (tag, props) => Object.assign(doc.createElement(tag), props || {});
    const el = mk('fieldset', { className: 'v16-font v16-ptset' });
    const box = mk('input', { type: 'checkbox', id: 'v16-pt-on' });
    box.style.minWidth = box.style.minHeight = '24px';
    const lab = mk('label', { htmlFor: 'v16-pt-on' });
    lab.style.minHeight = '44px';
    lab.append(box, mk('span', { textContent: ' Guess the meaning before new kanji' }));
    const stats = mk('p', { className: 'v16-pt-stats' });
    el.append(mk('legend', { textContent: 'Meaning guess' }),
      mk('p', { textContent: 'Before a new kanji\'s first lesson, guess its meaning from its parts. Just for fun: it is not graded and does not change reviews.' }),
      lab, stats);
    function update() {
      box.checked = V.meaningPretestSetting(store).on;
      const st = V.pretestStats ? V.pretestStats(store) : null;
      stats.textContent = st && st.shown ? `Guesses: ${st.right} right of ${st.shown} (${st.skipped} skipped)` : '';
      stats.style.display = stats.textContent ? '' : 'none';
    }
    box.addEventListener('change', () => { V.setMeaningPretest(store, box.checked); update(); });
    update();
    return { el, update, unmount() { if (el.parentNode) el.remove(); } };
  }
  /** RC17 (R33 hooks 2-4): before a lesson introduces `k`, show the guess card when V15.meaningPretest has one, then
   *  `go`. Off, no pretest, or any failure -> `go` right away (never blocks the lesson). Nothing written while off. */
  // RC17b F3: lesson starts are queued, so a second start while a card is open waits instead of dropping the first.
  let ptQueue = Promise.resolve();
  function pretestThen(picks, go) {
    const V = root.V15;
    let on = false;
    try { on = !!(V && V.meaningPretest && V.meaningPretestSetting && V.meaningPretestSetting(store).on); } catch (e) { on = false; }
    if (!on) { ptQueue = ptQueue.then(() => { try { go(); } catch (e) { /* app error, as before */ } }); return; }
    const ks = [].concat(picks).filter((k) => typeof k === 'string' && k);
    const run = () => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; const o = doc.getElementById('v16pt'); if (o) o.remove(); try { go(); } catch (e) { /* app error */ } resolve(); };
      const step = (i) => {   // RC17b F4: one card per new kanji (meaningPretest is null for seen ones), then the lesson
        if (i >= ks.length) return finish();
        let pt = null;
        try { pt = V.meaningPretest(store, ks[i]); } catch (e) { return finish(); }
        if (!pt) return step(i + 1);
        try { pretestCard(pt, () => step(i + 1)); } catch (e) { finish(); }
        return undefined;
      };
      const begin = () => { try { step(0); } catch (e) { finish(); } };
      if (root.V16Lazy && root.V16Lazy.load) root.V16Lazy.load('components').then(begin, finish).catch(finish);
      else begin();
    });
    ptQueue = ptQueue.then(run, run);
  }
  function pretestCard(pt, next) {
    const mk = (tag, props) => Object.assign(doc.createElement(tag), props || {});
    const old = doc.getElementById('v16pt'); if (old) old.remove();
    const ov = mk('div', { id: 'v16pt', className: 'v16-pt' });
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'v16pt-h');
    Object.assign(ov.style, { position: 'fixed', inset: '0', zIndex: '9000', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,.45)', padding: '12px', boxSizing: 'border-box' });
    const card = mk('div');
    Object.assign(card.style, { background: 'var(--paper, #faf8f2)', color: 'var(--ink, #23261f)', borderRadius: '14px', padding: '16px',
      width: 'min(420px, 100%)', maxHeight: '100%', overflow: 'auto', boxSizing: 'border-box', textAlign: 'center', font: '16px var(--ui, sans-serif)' });
    const h = mk('h2', { id: 'v16pt-h', textContent: 'What might this mean?' });
    Object.assign(h.style, { font: '600 18px var(--ui, sans-serif)', margin: '0 0 4px', color: 'inherit' });
    const big = mk('div', { textContent: pt.kanji, lang: 'ja' });
    Object.assign(big.style, { fontSize: '64px', lineHeight: '1.1', margin: '4px 0', fontFamily: 'var(--mincho)' });   // RC17b F6: the Kanji font, as in the lesson
    const parts = mk('p', { className: 'v16-pt-parts' });
    parts.style.margin = '0 0 10px';
    pt.components.forEach((x, i) => {
      if (i) parts.append(doc.createTextNode(' · '));
      parts.append(mk('span', { textContent: x.c, lang: 'ja' }), doc.createTextNode(' ' + x.meaning));
    });
    const grid = mk('div');
    Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' });
    const btnStyle = (b) => Object.assign(b.style, { minHeight: '44px', padding: '6px 8px', borderRadius: '10px', border: '2px solid currentColor',
      background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' });
    const choices = pt.choices.map((c) => { const b = mk('button', { type: 'button', textContent: c, className: 'v16-pt-choice' }); b.dataset.choice = c; btnStyle(b); return b; });
    grid.append(...choices);
    const msg = mk('p', { className: 'v16-pt-msg' });
    msg.setAttribute('aria-live', 'polite'); msg.style.margin = '10px 0 0'; msg.style.fontWeight = '600';
    const row = mk('div'); row.style.marginTop = '10px';
    const skip = mk('button', { type: 'button', textContent: 'Skip', className: 'v16-pt-skip' }); btnStyle(skip);
    skip.style.minWidth = '44px';
    row.append(skip);
    card.append(h, big, parts, grid, msg, row);
    ov.append(card);
    doc.body.append(ov);
    let answered = false;
    const back = doc.activeElement;   // RC17b F5: focus returns here after the last card
    const close = () => { ov.remove(); if (!doc.getElementById('v16pt') && back && back.isConnected && back.focus) try { back.focus(); } catch (e) { /* gone */ } next(); };
    function answer(choice) {
      if (answered) return; answered = true;
      let r = null;
      try { r = root.V15.recordPretestGuess(store, pt, choice); } catch (e) { r = null; }
      for (const b of choices) {
        b.disabled = true;
        if (b.dataset.choice === pt.answer) { b.textContent = '✓ ' + b.dataset.choice; b.style.fontWeight = '700'; b.style.borderWidth = '4px'; }
        else if (b.dataset.choice === choice) b.textContent = '✗ ' + b.dataset.choice;
      }
      msg.textContent = r && r.correct ? `Good guess: it means ${pt.answer}.` : `It means ${pt.answer}.`;
      skip.textContent = 'Continue'; skip.className = 'v16-pt-next';
      skip.focus();
    }
    grid.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && grid.contains(b)) answer(b.dataset.choice); });
    skip.addEventListener('click', () => { if (!answered) { try { root.V15.recordPretestGuess(store, pt, null); } catch (e) { /* counters only */ } } close(); });
    ov.addEventListener('keydown', (e) => {   // RC17b F5: Esc = Skip/Continue (as other v16 overlays); Tab stays in the card
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); skip.click(); return; }
      if (e.key !== 'Tab') return;
      const f = [...card.querySelectorAll('button')].filter((b) => !b.disabled);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (doc.activeElement === first || !card.contains(doc.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (doc.activeElement === last || !card.contains(doc.activeElement))) { e.preventDefault(); first.focus(); }
    });
    ov.addEventListener('focusout', (e) => { if (ov.isConnected && e.relatedTarget && !ov.contains(e.relatedTarget)) { const b = card.querySelector('button:not([disabled])'); if (b) b.focus(); } });
    choices[0].focus();
  }
  /** The settings pane: SettingsView in its own box (its update() re-renders only that), the font choice below it. */
  function settingsWithFont(el) {
    const inner = doc.createElement('div');
    const fs = doc.createElement('fieldset');
    fs.className = 'v16-font';
    const cur = fontPref();
    fs.innerHTML = `<legend>Kanji font</legend><p>Changes how kanji are shown. Stroke order, tracing and grading stay the same.</p>${
      FONTS.map(([id, ja, en]) => `<label><input type="radio" name="v16font" value="${id}"${id === cur ? ' checked' : ''}><span lang="ja" data-kf="${id}">${ja}</span> ${en}</label>`).join('')}`;
    fs.addEventListener('change', (e) => { if (e.target.name === 'v16font') setFont(e.target.value); });
    el.append(inner, fs);
    const kn = root.V16KnownUI ? root.V16KnownUI.settingsSection() : null;   // RC9-known-import-ui (R26)
    if (kn) fs.before(kn.el);
    const so = root.V16OrderUI ? root.V16OrderUI.settingsSection() : null;   // RC10-study-order-ui (R27)
    if (so) fs.before(so.el);
    const rf = readingFontSection();   // RC16-reading-font-ui (R31)
    if (rf) fs.before(rf.el);
    const pts = pretestSection();   // RC17-meaning-pretest-ui (R33)
    if (pts) fs.before(pts.el);
    const h = root.SettingsView.mount(inner);
    // RC7-polish: the font choice sits just above About (SettingsView's last section), not below the credits.
    // SettingsView re-renders its box with innerHTML, so put it back after each render. settings-view.js is not edited.
    const place = () => {
      const about = inner.querySelector('section[aria-labelledby="st-h-about"]');
      if (about && fs.nextElementSibling !== about) about.before(fs);
      else if (!about && fs.parentNode !== el) el.append(fs);
      if (pts && pts.el.nextElementSibling !== fs) fs.before(pts.el);
      if (rf && rf.el.nextElementSibling !== (pts ? pts.el : fs)) (pts ? pts.el : fs).before(rf.el);
      if (so && so.el.nextElementSibling !== (rf ? rf.el : pts ? pts.el : fs)) (rf ? rf.el : pts ? pts.el : fs).before(so.el);
      if (kn && kn.el.nextElementSibling !== (so ? so.el : fs)) (so ? so.el : fs).before(kn.el);
    };
    place();
    const mo = root.MutationObserver ? new root.MutationObserver(place) : null;
    if (mo) mo.observe(inner, { childList: true });
    return { update() { const v = fontPref(); for (const r of fs.querySelectorAll('input')) r.checked = r.value === v; if (h && h.update) h.update(); if (kn) kn.update(); if (so) so.update(); if (rf) rf.update(); if (pts) pts.update(); place(); },
             unmount() { if (mo) mo.disconnect(); if (kn) kn.unmount(); if (so) so.unmount(); if (rf) rf.unmount(); if (pts) pts.unmount(); if (fs.parentNode) fs.remove(); if (h && h.unmount) h.unmount(); } };
  }

  /** One container per view, kept mounted between visits (update() refreshes it). */
  function pane(name) {
    if (mounted[name]) return mounted[name];
    const el = doc.createElement('div');
    el.className = `v16v-pane v16v-${name}`;
    overlay().querySelector('.v16v-body').appendChild(el);
    let handle = null;
    if (name === 'stats') handle = root.StatsView.mount(el);
    if (name === 'parts') handle = root.ComponentsView.mount(el, { kanjiMap: kanjiMap(), pairs: pairs(), size: LESSON_SIZE });
    if (name === 'settings') handle = settingsWithFont(el);
    if (name === 'study') handle = studyCards(el);
    if (name === 'whatsnew') handle = whatsNew(el);
    if (name === 'words' && root.V16WordsUI) handle = root.V16WordsUI.mount(el, startKanji);   // RC11-word-unlock-ui (R28)
    watchGlyphs(name, el);
    mounted[name] = { el, handle };
    return mounted[name];
  }

  function open(name) {
    if (!TITLES[name]) return;
    if (typeof closePicker === 'function') closePicker();   // index.html global (lexical, not on window)
    returnFocus = doc.activeElement;
    const ov = overlay();
    const [ja, en] = TITLES[name];
    ov.setAttribute('aria-label', en);
    ov.querySelector('h1').innerHTML = `<span class="ja" lang="ja">${ja}</span>${en}`;
    for (const m of Object.values(mounted)) m.el.hidden = true;
    const p = pane(name);
    p.el.hidden = false;
    if (p.handle && typeof p.handle.update === 'function') p.handle.update();
    current = name;
    ov.classList.add('show');
    ov.querySelector('h1').focus();
    if (TIP_EVENT[name] && !(name === 'study' && !(p.el.v16data() || {}).leechNotice)) showTip(TIP_EVENT[name]);
    if (name === 'study' && (p.el.v16data() || {}).contextSentence) showTip('sentence');
  }

  function close() {
    const ov = doc.getElementById('v16v');
    if (!ov) return;
    ov.classList.remove('show');
    current = null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }

  // ------------------------------------------------------------------ study cards (R17)

  const CARDS = [
    ['leechNotice', 'Needs a fresh look'],
    ['weakSpot', 'Weak spot'],
    ['contrastDrill', 'Look-alikes'],
    ['contextSentence', 'In a sentence'],
  ];

  /** Mounts the four cards; update() rebuilds them from storage. Returns {update, unmount}. */
  function studyCards(el) {
    let cards = [];
    let data = null;
    const unmountAll = () => { cards.forEach((c) => c.unmount()); cards = []; el.innerHTML = ''; };
    const update = () => {
      unmountAll();
      data = root.StudyCards.build(store, { kanjiMap: kanjiMap(), kanji: lessonKanji() });
      if (data.leechNotice && dismissedLeeches.has(data.leechNotice.kanji)) data.leechNotice = null;
      for (const [name, label] of CARDS) {
        const slot = doc.createElement('section');
        slot.className = 'v16v-slot';
        slot.setAttribute('aria-label', label);
        el.appendChild(slot);
        cards.push(root.StudyCards[name].mount(slot, data[name], { kanjiMap: kanjiMap() }));
      }
      if (root.V16WeakSpotUI) root.V16WeakSpotUI.mountCard(el);   // RC8-weakspot-ui (R24)
      if (root.V16NotesUI) root.V16NotesUI.mountCard(el, lessonKanji());   // RC8-notes-ui (R25)
    };
    el.v16data = () => data;
    return { update, unmount: unmountAll };
  }

  /** The app's writes for the card events (bubbling from the cards). */
  function wireCardEvents(ov) {
    const E = root.StudyCards ? root.StudyCards.EVENTS : null;
    if (!E) return;
    const studyData = () => (mounted.study ? mounted.study.el.v16data() : null) || {};
    ov.addEventListener(E.sentence, (e) => {
      const prompt = studyData().contextSentence;
      if (prompt) root.V15.gradeContext(store, prompt, e.detail.input);
    });
    ov.addEventListener(E.contrast, (e) => {
      if (!e.detail.correct) return;   // a miss keeps the drill pending
      const [target, lookalike] = e.detail.pair;
      const drill = root.V15.dueContrasts(store).find((d) => d.target === target && d.lookalike === lookalike);
      if (drill) root.V15.completeContrast(store, drill);
    });
    ov.addEventListener(E.practise, (e) => { close(); startKanji([e.detail.component || e.detail.kanji]); });
    ov.addEventListener(E.restudy, (e) => { close(); root.V15UI.actions.leechStart(e.detail.kanji); });
    ov.addEventListener(E.dismiss, (e) => { dismissedLeeches.add(e.detail.kanji); });
  }

  function startKanji(picks) {
    if (picks && picks.length) pretestThen(picks, () => root.V15UI.startKanjiLesson(picks));   // RC17 (R33 hook 2); RC17b: each new kanji
  }

  // ------------------------------------------------------------------ new kanji (V15.pickNewLesson)

  const REASON_TEXT = {
    lookalike: (d) => `${d.k} waits (looks like ${d.with})`,
    'same-reading': (d) => `${d.k} waits (same reading as ${d.with})`,
    'leech-pause': (d) => `${d.k} waits until ${d.with} is re-studied`,
    'component-deferred': (d) => `${d.k} waits for its part ${d.with}`,
  };

  /** One line explaining what pickNewLesson held back, or '' when nothing was. */
  function explainPick(result) {
    const parts = (result.deferred || []).map((d) => (REASON_TEXT[d.reason] || ((x) => `${x.k} waits`))(d));
    if (result.limitedBy === 'budget') parts.unshift(result.picks.length ? "Today's new-kanji budget is nearly used" : "Today's new-kanji budget is full: review first");
    return parts.join(' · ');
  }

  /** Starts the picked lesson and says why anything was deferred (never a dead end: the toast says what to do). */
  function startPicked(result) {
    let why = explainPick(result);
    const ord = root.V16OrderUI && result.order && result.order !== 'app' ? root.V16OrderUI.label(result.order) : '';   // R27 hook 4
    if (ord && result.picks.length) why = why ? `${why} Order: ${ord}.` : `Order: ${ord}.`;
    if (result.picks.length) startKanji(result.picks);
    if (why || !result.picks.length) root.V15UI.toast(why || 'No new kanji left on this tab.');
  }

  /** The planned order for the default picker: the kanji of the current tab's lessons, in lesson order. */
  function plannedKanji() {
    const map = kanjiMap();
    let level = null;
    try { level = pickLv(); } catch (e) { level = null; }      // index.html globals (not window properties)
    let sets = [];
    try { sets = SETS.filter((set) => set.level === level); } catch (e) { sets = []; }
    const out = [];
    for (const set of sets) for (const word of set.words || []) {
      for (const ch of String(word.w || word)) if (map[ch] && !out.includes(ch)) out.push(ch);
    }
    return out;
  }

  /** The default "new kanji" lesson: the next unintroduced kanji of the tab, through the R7/R8/R14 picker rules. */
  function newLesson() {
    const go = () => startPicked(root.V15.pickNewLesson(store, plannedKanji(), { kanjiMap: kanjiMap(), pairs: pairs(), size: LESSON_SIZE }));
    // RC10-study-order-ui (R27 hook 1): a non-app order needs the 'order' group first; on failure the app order is used.
    let order = 'app';
    try { order = root.V15.studyOrderSetting ? root.V15.studyOrderSetting(store).order : 'app'; } catch (e) { order = 'app'; }
    if (order !== 'app' && !root.V16StudyOrder && root.V16Lazy && root.V16Lazy.load) return root.V16Lazy.load('order').then(go, go);
    go();
    return undefined;
  }

  /** A family lesson for a component (ComponentsView "Learn this family"), re-picked with the app's data. */
  function familyLesson(component) {
    startPicked(root.V15.pickNewLesson(store, [], { mode: 'family', component, kanjiMap: kanjiMap(), pairs: pairs(), size: LESSON_SIZE }));
  }

  // ------------------------------------------------------------------ R19 tips and what's new

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** Shows the first unshown shipped tip for this event once (TipsModel only returns shipped tips). */
  function showTip(event) {
    // Guard: right after a reload V16Views.open('settings') can run before V15UI exists. Skip without
    // marking the tip shown, so it still appears once on a later trigger instead of throwing now.
    if (!root.V15UI || typeof root.V15UI.toast !== 'function') return null;
    const TM = root.TipsModel;
    const tip = TM && TM.nextTip(store, { event });
    if (!tip) return null;
    TM.markShown(store, tip.id);
    root.V15UI.toast(`${tip.title}: ${tip.body}`);
    return tip.id;
  }

  /** The "What's new in v16" list (shipped items only). */
  function whatsNew(el) {
    const update = () => {
      const items = root.TipsModel ? root.TipsModel.whatsNewList() : [];
      el.innerHTML = `<ul class="v16v-new">${items.map((w) => `<li>${esc(w.text)}</li>`).join('')}</ul>`;
    };
    return { update };
  }

  // ------------------------------------------------------------------ R18 backup banner

  /** One banner at the bottom (role=status); `buttons` = [[label, fn]]. */
  function banner(kind, text, buttons) {
    let el = doc.getElementById('v16bk');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'v16bk';
      el.setAttribute('role', 'status');
      doc.body.appendChild(el);
    }
    el.dataset.kind = kind;
    el.innerHTML = `<p>${esc(text)}</p><div></div>`;
    for (const [label, fn] of buttons) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => { el.remove(); fn(); });
      el.lastChild.appendChild(b);
    }
    return el;
  }

  /** Startup check: suggest an export after 7 study days without one (not persisted storage only). */
  function backupCheck() {
    if (!root.V15 || !root.V15.backupReminder) return;
    let r = null;
    try { r = root.V15.backupReminder(store); } catch (e) { return; }
    if (!r || !r.due) return;
    banner('reminder', 'Back up your progress: this browser may clear it. Download a copy from Settings.', [
      ['Back up', () => open('settings')],
      ['Later', () => root.V15.snoozeBackupReminder(store, 1)],
    ]);
    showTip('backup-reminder');
  }

  // ------------------------------------------------------------------ wiring

  doc.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v16view]');
    if (b) { e.preventDefault(); open(b.dataset.v16view); return; }
    if (e.target.closest('[data-v16new]')) { e.preventDefault(); newLesson(); }
  });
  // "Learn this family" (ComponentsView): the view picks, the app starts the lesson.
  doc.addEventListener('kanji:family-lesson', (e) => {
    const detail = e.detail || {};
    close();
    if (detail.component) familyLesson(detail.component);
    else startKanji(detail.lesson && detail.lesson.picks);
  });
  // Settings import / undo replaced the progress: start fresh from storage.
  root.addEventListener('v16:progress-imported', () => root.location.reload());

  // R18 events (emitted on window by DataSafety).
  root.addEventListener('v16:recovery-available', (e) => {
    const d = e.detail || {};
    const when = d.at ? new Date(d.at).toLocaleDateString() : 'earlier';
    banner('recovery', `Your progress on this device is missing. A backup from ${when} (${d.kanji || 0} kanji) was found.`, [
      ['Restore', () => root.V15.restoreFromSurvivingBackup(store, { confirm: true }).then(() => root.location.reload())],
      ['Not now', () => {}],
    ]);
  });
  root.addEventListener('v16:storage-error', () => {
    banner('error', "Couldn't save your progress (storage is full). It is kept for now; download a backup from Settings.", [
      ['Back up', () => open('settings')],
      ['OK', () => {}],
    ]);
  });
  root.addEventListener('v16:storage-ok', () => { const el = doc.getElementById('v16bk'); if (el && el.dataset.kind === 'error') el.remove(); });
  root.addEventListener('v16:keyword', () => { const el = doc.getElementById('v16prompt'); if (el) { delete el.dataset.html; updatePrompt(); } });
  // RC7 (research pain #9 sync/reliability, gap #5 offline): say plainly when the app goes offline that nothing is lost.
  // A short status chip, not a banner: it takes no taps (pointer-events: none) and hides itself.
  let netTimer = 0;
  function netChip(text, ms) {
    let el = doc.getElementById('v16net');
    if (!el) { el = doc.createElement('div'); el.id = 'v16net'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); doc.body.appendChild(el); }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(netTimer);
    netTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  root.addEventListener('offline', () => netChip('Offline · progress is saved on this device', 6000));
  root.addEventListener('online', () => { if (doc.getElementById('v16net')) netChip('Back online', 2500); });   // only after an offline notice
  if (root.navigator && root.navigator.onLine === false) netChip('Offline · progress is saved on this device', 6000);
  root.addEventListener('v16:lesson-complete', () => { setTimeout(() => showTip('lesson-complete'), 1800); });
  if (doc.readyState === 'complete') setTimeout(backupCheck, 0); else root.addEventListener('load', () => setTimeout(backupCheck, 0));


  // ---- R7 clear writing prompts (V16-prompts-ui) ----
  /**
   * Plain words for the checker's EXISTING reject codes (verdict.shape, else verdict.msg). Display only: the checker
   * and grading are unchanged. Unknown codes fall back to GENERIC (never invented detail).
   *   first:<code>  stroke 1 re-judged at stroke 2's scale → text for <code>
   *   pair:<code>   strokes 1+2 do not fit together → text for <code>
   *   topology:<kind> → TOPOLOGY
   */
  const REJECT_TEXT = {
    'hook-added': 'it ends with a hook, but this stroke ends plainly',
    'hook-dropped': 'it needs a hook at the end',
    'hook-missing': 'it needs a hook at the end',
    'hook-partial': 'the hook at the end is too small',
    'hook-flat': 'the hook at the end is too flat',
    'hook-flick': 'it has a flick at the end; stop cleanly instead',
    'hook-angle': 'the hook at the end points the wrong way',
    direction: 'it goes in the wrong direction',
    'Wrong direction': 'it goes in the wrong direction',
    veer: 'it drifts away from its line',
    bend: 'the bend is in the wrong place or missing',
    curve: 'it curves too much or too little',
    length: 'it is the wrong length',
    'Too short': 'it is too short',
    'Too long': 'it is too long',
    proportion: 'its length does not match the other strokes',
    'Start at the dot': 'it starts in the wrong place (start at the dot)',
    'End is off': 'it ends in the wrong place',
    'Wrong order': 'that looks like a later stroke; check the stroke order',
  };
  const TOPOLOGY = 'it crosses or touches the other strokes in the wrong place';
  const GENERIC = "it doesn't match this stroke yet";
  function rejectText(verdict) {
    const code = String((verdict && (verdict.shape || verdict.msg)) || '');
    const inner = code.replace(/^(first|pair):/, '');
    if (/^topology:/.test(inner)) return TOPOLOGY;
    return REJECT_TEXT[inner] || GENERIC;
  }
  /** "Stroke 3: it needs a hook at the end." stroke = 1-based; redo-first verdicts are always stroke 1. */
  function rejectMessage(verdict, stroke) {
    const n = verdict && (verdict.redoFirst || /^first:/.test(verdict.shape || '')) ? 1 : stroke;
    const t = rejectText(verdict);
    return `Stroke ${n}: ${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
  }

  const activeBox = () => { try { return boxes[cur] || null; } catch (e) { return null; } };
  const isMemoryBox = (c) => { try { return isMem(c.s); } catch (e) { return false; } };
  /** Meaning · reading · box n of N · stroke count, for the box being written. */
  function promptHtml(c) {
    const k = c.k.isPart ? c.k.src : c.k;
    const baseOf = (b) => (b.k.isPart ? b.k.src.k : b.k.k);
    const mine = boxes.filter((b) => b.k && baseOf(b) === k.k);   // this kanji's boxes (parts, stages, word)
    const at = mine.indexOf(c) + 1;
    const reading = String(k.reading || (k.kun && k.kun[0]) || (k.on && k.on[0]) || '').replace(/-/g, '').replace(/\./g, '·');
    const n = Math.min(c.pad.strokes.length + 1, c.k.strokes);
    const what = c.k.isPart ? `the part of <span lang="ja">${esc(k.k)}</span>` : `<span lang="ja">${esc(k.k)}</span>`;
    const cue = maskedWord(k.k);
    const cueHtml = cue ? `<span class="v16p-word"> · <span class="v16-sr">in </span><span lang="ja">${esc(cue.masked)}</span> <span lang="ja">${esc(cue.r)}</span></span>` : '';
    let own = ''; try { own = store.getItem(`v16:kw:${k.k}`) || ''; } catch (e) { /* default keyword */ }   // RC7 custom keyword
    return `<p><b>Write ${what}</b> “${esc(own || k.keyword || (k.meanings || [])[0] || '')}”${reading ? ` · <span lang="ja">${esc(reading)}</span>` : ''}${cueHtml}</p>
<p class="v16p-meta">Box ${at} of ${mine.length} · ${c.k.strokes} stroke${c.k.strokes === 1 ? '' : 's'} · now stroke ${n}</p>`;
  }
  /**
   * Research #2 (MARKET_RESEARCH backlog #7): an example word with the target kanji masked (e.g. ＿生 せんせい), so a
   * prompt is not ambiguous between homophones. Display only. Prefers a word from the current lesson, then the
   * first common multi-character READING_WORDS entry. Null for a single character with no such word.
   */
  const MASK = '＿';
  const wordCache = new Map();
  function maskedWord(kanji) {
    if (!kanji || [...kanji].length !== 1) return null;
    const set = typeof curSet !== 'undefined' ? curSet : null;   // index.html global (let), read at call time
    const key = `${set && set.id}|${kanji}`;
    if (wordCache.has(key)) return wordCache.get(key);
    const ok = (w) => w && typeof w.w === 'string' && w.r && [...w.w].length > 1 && w.w.includes(kanji);
    // A compound (other characters kanji too, e.g. 先生) beats an okurigana form (先ず): the mask then hides a kanji in a kanji word.
    const compound = (w) => ok(w) && /^[\u3400-\u9fff々]+$/.test(w.w);
    const words = set && Array.isArray(set.words) ? set.words : [];
    let hit = words.find(compound) || null;
    if (!hit && root.READING_WORDS && root.READING_WORDS.levels) {
      for (const lv of Object.values(root.READING_WORDS.levels)) {
        const list = (lv && lv[kanji]) || [];
        hit = list.find((w) => compound(w) && w.common !== false) || list.find(compound);
        if (hit) break;
      }
    }
    if (!hit) hit = words.find(ok) || null;
    const out = hit ? { masked: hit.w.split(kanji).join(MASK), r: hit.r, w: hit.w } : null;
    wordCache.set(key, out);
    return out;
  }
  function promptBar() {
    let el = doc.getElementById('v16prompt');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'v16prompt';
      el.setAttribute('role', 'status');
      el.innerHTML = '<div class="v16p-text"></div><button type="button" class="v16p-replay" aria-label="Replay this stroke"><span aria-hidden="true">▶</span><span class="v16p-rl"> Replay stroke</span></button>';
      el.querySelector('button').addEventListener('click', replayStroke);
      // RC7 (research backlog #7 "plus audio"): hear the example word's reading. The reading is already printed in the
      // bar, so this adds no answer the learner can't see; it never touches grading.
      const say = doc.createElement('button');
      say.type = 'button'; say.className = 'v16p-say'; say.hidden = true;
      say.setAttribute('aria-label', 'Hear the example word');
      say.innerHTML = '<span aria-hidden="true">🔊</span>';
      say.addEventListener('click', () => { if (say.dataset.say) sayText(say.dataset.say); });
      el.appendChild(say);
      // Inside #stage, absolutely placed: the bar takes no flow space, so layout() keeps v15f's pad size.
      (doc.getElementById('stage') || doc.body).appendChild(el);
    }
    return el;
  }
  function canSpeak() {
    return 'speechSynthesis' in root && typeof root.SpeechSynthesisUtterance === 'function' && !(typeof CONFIG !== 'undefined' && CONFIG.SPEAK_WORD === false);
  }
  function sayText(text) {
    if (typeof speak === 'function') { speak(text); return; }   // index.html's speak(): ja voice, rate, iOS audio session
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; speechSynthesis.speak(u); } catch (e) { /* no audio */ }
  }
  function updatePrompt() {
    const c = activeBox();
    const writing = c && c.k && c.pad && doc.body.contains(c.b) && !doc.querySelector('#v16v.show');
    const el = promptBar();
    el.hidden = !writing;
    if (!writing) return;
    const text = promptHtml(c);
    if (el.dataset.html !== text) { el.querySelector('.v16p-text').innerHTML = text; el.dataset.html = text; }
    const done = c.pad.strokes.length >= c.k.strokes;
    el.querySelector('button').hidden = done || isMemoryBox(c);   // memory boxes test recall: no replay there
    const say = el.querySelector('.v16p-say');
    if (say) {
      const k = c.k.isPart ? c.k.src : c.k;
      const cue = canSpeak() ? maskedWord(k.k) : null;
      say.dataset.say = cue ? cue.r : '';
      say.hidden = !cue || !el.querySelector('.v16p-word');
    }
    placePrompt(el);
  }
  /** The bar is centred over the stage's bottom strip; narrow it so it never covers a control (#undo, #clear, hint,
   * any button) that shares its row. The bar stays centred, so it is cut on both sides by the nearest control. */
  function placePrompt(el) {
    el.style.maxWidth = '';
    if (el.hidden || getComputedStyle(el).display === 'none') return;
    const bar = el.getBoundingClientRect();
    if (!bar.width) return;
    const mid = (bar.left + bar.right) / 2;
    let half = Infinity;
    for (const b of doc.querySelectorAll('#stage button, #panel button, .controls button')) {
      if (el.contains(b) || b.closest('[hidden]')) continue;
      const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
      if (!r.width || cs.visibility === 'hidden' || r.bottom <= bar.top || r.top >= bar.bottom) continue;
      if (r.right <= mid) half = Math.min(half, mid - r.right);
      else if (r.left >= mid) half = Math.min(half, r.left - mid);
      else half = 0;
    }
    if (half === Infinity) return;
    const max = Math.max(0, Math.floor(2 * half - 8));   // 4px clear of the control on each side
    if (bar.width > max) el.style.maxWidth = `${max}px`;
    if (!max) el.hidden = true;                           // no room at all: hide rather than cover a button
  }
  /** Animate the current stroke's reference path in the box's own SVG (display only). */
  function replayStroke() {
    const c = activeBox();
    if (!c) return;
    const i = Math.min(c.pad.strokes.length, c.k.strokes - 1);
    const svg = c.b.querySelector(':scope > svg');
    if (!svg || !c.k.paths[i]) return;
    svg.querySelectorAll('.v16p-anim').forEach((p) => p.remove());
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', c.k.paths[i]);
    path.setAttribute('class', 'v16p-anim');
    svg.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    path.getBoundingClientRect();
    path.style.transition = 'stroke-dashoffset 900ms ease-in-out';
    path.style.strokeDashoffset = '0';
    setTimeout(() => path.remove(), 2200);
  }
  /** Refresh after the app's upd() (index.html global, defined after this file loads). */
  function wrapUpd() {
    if (typeof root.upd !== 'function' || root.upd.v16prompt) return;
    const appUpd = root.upd;
    root.upd = function () { const r = appUpd.apply(this, arguments); updatePrompt(); return r; };
    root.addEventListener('resize', () => { const el = doc.getElementById('v16prompt'); if (el && !el.hidden) placePrompt(el); });
    root.upd.v16prompt = true;
    if (activeBox()) updatePrompt();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wrapUpd); else wrapUpd();

  /* R21 rules-fetch error bar (#v16-rules-error, created by v16-rules-loader.js on body with a fixed inline style that sat
   * over the bottom toolbar). Move it into #stage so v16-theme.css can place it in the prompt strip, then narrow it like
   * the prompt bar so neither it nor its Retry button covers a control. The loader's own code is untouched. */
  let shownBar = null;
  /* Phones clamp the bar to 2 lines, which cut off the 'stroke kept / retrying' part. Show a short message; tapping it
   * toggles the loader's full text. The full text is kept in data-full (and in the title) and refreshed if the loader rewrites it. */
  const SHORT_RULES_ERROR = 'Offline \u00b7 stroke kept';   // fits one 12px line in the ~105px a 375px phone leaves; Retry says the rest
  function shortenRulesError(bar) {
    const t = bar.querySelector('.v16-rules-error-text');
    if (!t) return;
    const cur = t.textContent;
    if (cur !== SHORT_RULES_ERROR && cur !== t.dataset.full) { t.dataset.full = cur; t.title = cur; }
    if (!t.dataset.full) return;
    if (!t.dataset.v16short) {
      t.dataset.v16short = '1'; t.setAttribute('role', 'button'); t.tabIndex = 0;
      const toggle = () => { const open = t.classList.toggle('v16-open'); t.textContent = open ? t.dataset.full : SHORT_RULES_ERROR; t.setAttribute('aria-expanded', String(open)); };
      t.addEventListener('click', toggle);
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    if (!t.classList.contains('v16-open') && t.textContent !== SHORT_RULES_ERROR) { t.textContent = SHORT_RULES_ERROR; t.setAttribute('aria-expanded', 'false'); }
  }
  function placeRulesError(force) {
    const bar = doc.getElementById('v16-rules-error'), stage = doc.getElementById('stage');
    if (!bar || !stage) return;
    if (bar.parentNode !== stage) stage.appendChild(bar);
    shortenRulesError(bar);
    const shown = bar.style.display !== 'none';
    if (shown && (force === true || shownBar !== bar)) placePrompt(bar);   // our own maxWidth write must not re-trigger
    shownBar = shown ? bar : null;
  }
  if (typeof MutationObserver === 'function') {   // body childList (bar created) + the bar's display toggles
    const mo = new MutationObserver((list) => {
      if (list.some((m) => m.type === 'childList' || (m.target.id === 'v16-rules-error' && (m.target.style.display !== 'none') !== (shownBar === m.target)))) placeRulesError();
    });
    const watch = () => mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    if (doc.body) watch(); else doc.addEventListener('DOMContentLoaded', watch);
  }
  root.addEventListener('v16:rules-error', () => setTimeout(() => placeRulesError(true), 0));
  root.addEventListener('resize', () => placeRulesError(true));

  // Merge into any existing V16Views (R20 defines V16Views.load before this file runs); descriptors keep the `current` getter live.
  const api = { esc, canSpeak, say: sayText, rejectMessage, rejectText, REJECT_TEXT, updatePrompt, replayStroke, showTip, backupCheck, newLesson, familyLesson, explainPick, plannedKanji, open, close, get current() { return current; } };
  root.V16Views = Object.defineProperties(root.V16Views || {}, Object.getOwnPropertyDescriptors(api));
})(window);

/*
 * RC8-miss-nudge (B4): visual-only feedback after an early miss. For misses 1 to MISSES_FOR_HINT-1 on a stroke,
 * the expected start point blinks and a small arrow shows the direction for 1.6 s. There is no text, and it does
 * not count as a hint: grading, hint counts and the trace guide (shown on the MISSES_FOR_HINT-th miss) are unchanged.
 * Backlog #6 (fading scaffolds: a small cue first, the full trace only later).
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const SHOW_MS = 1600;
  let timer = 0;
  function clearNudge() {
    clearTimeout(timer);
    doc.querySelectorAll('.v16-nudge').forEach((g) => g.remove());
  }
  function nudge(c, n) {
    clearNudge();
    const d = c && c.k && c.k.paths && c.k.paths[n];
    const svg = d && c.b && c.b.querySelector(':scope>svg');
    if (!svg) return;
    const g = doc.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'v16-nudge');
    g.setAttribute('aria-hidden', 'true');
    g.dataset.n = n;
    const q = doc.createElementNS(SVGNS, 'path');
    q.setAttribute('d', d);
    const L = q.getTotalLength();
    const a = q.getPointAtLength(0);
    const b = q.getPointAtLength(Math.min(L, Math.max(6, L * 0.3)));
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const h = 4;
    const tip = (t) => `${(b.x - h * Math.cos(ang + t)).toFixed(2)} ${(b.y - h * Math.sin(ang + t)).toFixed(2)}`;
    g.innerHTML = `<path class="v16-nudge-dir" d="M${a.x.toFixed(2)} ${a.y.toFixed(2)}L${b.x.toFixed(2)} ${b.y.toFixed(2)}M${tip(-0.55)}L${b.x.toFixed(2)} ${b.y.toFixed(2)}L${tip(0.55)}"/><circle class="v16-nudge-dot" cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="3.4"/>`;
    svg.appendChild(g);
    timer = setTimeout(clearNudge, SHOW_MS);
  }
  function wrap() {
    const orig = root.reject;
    if (typeof orig !== 'function' || orig.v16nudge) return;
    const wrapped = function (c, p, n) {
      const out = orig.apply(this, arguments);
      try {
        const lim = typeof CONFIG !== 'undefined' && CONFIG.CHECK && CONFIG.CHECK.MISSES_FOR_HINT || 3;
        const m = c && c.miss ? c.miss[n] : 0;
        if (m > 0 && m < lim) nudge(c, n); else clearNudge();
      } catch (e) { /* display only */ }
      return out;
    };
    wrapped.v16nudge = true;
    root.reject = wrapped;
  }
  // The next stroke, undo, clear or a box change clears it early.
  doc.addEventListener('pointerdown', (e) => { if (e.target && e.target.closest && (e.target.closest('canvas') || e.target.closest('#undo,#clear'))) clearNudge(); }, true);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wrap); else wrap();
  root.V16Nudge = { clear: clearNudge };
})(window);

/*
 * RC8-weakspot-ui (B4): the UI for Botfive's R24 weak-spot diagnosis (R24-weakspot-hooks.md). It reads window.V16WeakSpot
 * (spots, practiceSet) and never writes v16:weakspot. The study view gets a "Weak spots" card (up to 3 spots, with
 * misses/attempts and an example kanji) and a Practise button that walks practiceSet() in an unscored overlay through
 * KanjiWriting.startComponentWrite: a component step writes that part, and a kanji step writes each part of the kanji
 * in turn. No grade, rank or FSRS call. The weak-spot tip stays with tips-model.js. Without V16WeakSpot nothing is shown.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const esc = (t) => root.V16Views.esc(t);   // RC14b: one escaper (first IIFE)
  const api = () => root.V16WeakSpot || null;
  function loaded() {
    if (api()) return Promise.resolve(api());
    if (root.V16Lazy && root.V16Lazy.load) return root.V16Lazy.load('weakspot').then(api, () => null);
    return Promise.resolve(null);
  }
  function spots() { try { return (api() && api().spots({ limit: 3 })) || []; } catch (e) { return []; } }

  function cardHTML(list) {
    const rows = list.map((s) => {
      const ex = (s.examples && s.examples[0]) || null;
      const m = Math.round(s.misses), a = Math.max(Math.round(s.attempts), m);
      return `<li><span class="v16ws-g" lang="ja" aria-hidden="true">${esc(ex ? ex.kanji : s.label)}</span>`
        + `<span class="v16ws-t"><b lang="ja">${esc(s.label)}</b><span>${m} of ${a} tries missed${ex ? ` · e.g. <span lang="ja">${esc(ex.kanji)}</span>` : ''}</span></span></li>`;
    }).join('');
    return `<h3>Weak spots</h3><ul>${rows}</ul><button type="button" class="v16ws-go">Practise</button>`;
  }
  function mountCard(el) {
    const old = el.querySelector('.v16ws-card');
    if (old) old.remove();
    const list = spots();
    if (!list.length) return;
    const sec = doc.createElement('section');
    sec.className = 'v16v-slot v16ws-card';
    sec.setAttribute('aria-label', 'Weak spots');
    sec.innerHTML = cardHTML(list);
    sec.querySelector('.v16ws-go').addEventListener('click', () => start());
    el.insertBefore(sec, el.firstChild);
  }

  /** Expands practiceSet() into boxes: [{k, part, label}] (a kanji step becomes one box per part). */
  function boxesFor(set) {
    const KW = root.KanjiWriting, out = [];
    if (!KW) return out;
    set.forEach((st, si) => {
      if (st.kind === 'component') {
        if (KW.componentTarget(st.kanji, st.component)) out.push({ k: st.kanji, part: st.component, step: si, label: `Write <b lang="ja">${esc(st.component)}</b> as in <span lang="ja">${esc(st.kanji)}</span>` });
      } else {
        for (let i = 0; i < 40 && KW.componentTarget(st.kanji, i); i++) out.push({ k: st.kanji, part: i, step: si, label: `Write <b lang="ja">${esc(st.kanji)}</b>, part by part` });
      }
    });
    return out;
  }

  let run = null;
  function close() {
    if (!run) return;
    if (run.h) try { run.h.cancel(); } catch (e) { /* already finished */ }
    run.ov.remove();
    const back = run.back; run = null;
    if (back && back.isConnected) back.focus();
  }
  function start() {
    close();
    let set = [];
    try { set = api() ? api().practiceSet({ limit: 8, perSpot: 3 }) : []; } catch (e) { set = []; }
    const boxes = boxesFor(set);
    const ov = doc.createElement('div');
    ov.id = 'v16ws';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'v16ws-h');
    ov.innerHTML = '<div class="v16ws-in"><h2 id="v16ws-h" tabindex="-1">Weak-spot practice</h2><p class="v16ws-p" aria-live="polite"></p>'
      + '<div class="v16ws-box"></div><div class="v16ws-b"><button type="button" class="v16ws-skip">Skip</button><button type="button" class="v16ws-x">Done</button></div></div>';
    doc.body.appendChild(ov);
    run = { ov, boxes, i: -1, h: null, back: doc.activeElement, steps: set.length };
    ov.querySelector('.v16ws-x').addEventListener('click', close);
    ov.querySelector('.v16ws-skip').addEventListener('click', () => next());
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    next();
    ov.querySelector('h2').focus();
  }
  function next() {
    if (!run) return;
    const r = run;
    if (r.h) { const h = r.h; r.h = null; try { h.cancel(); } catch (e) { /* done */ } }
    r.i += 1;
    const host = r.ov.querySelector('.v16ws-box'), p = r.ov.querySelector('.v16ws-p');
    host.innerHTML = '';
    if (r.i >= r.boxes.length) {
      p.textContent = r.boxes.length ? 'All done. This practice is not scored.' : 'Nothing to practise right now.';
      r.ov.querySelector('.v16ws-skip').hidden = true;
      r.ov.querySelector('.v16ws-x').focus();
      return;
    }
    const b = r.boxes[r.i];
    p.innerHTML = `Step ${b.step + 1} of ${r.steps}: ${b.label}`;
    r.h = root.KanjiWriting.startComponentWrite(b.k, b.part, (res) => {
      if (run !== r || res.cancelled) return;
      setTimeout(() => { if (run === r) next(); }, 450);
    }, { container: host, guide: 'faint', keepOpen: true });
    if (!r.h) next();
  }

  root.V16WeakSpotUI = { mountCard, start, close, boxesFor, loaded };
  // The study view is built before the deferred weakspot group may load. Refresh an open card once it does.
  loaded().then((w) => {
    const el = w && doc.querySelector('#v16v .v16v-slot') && doc.querySelector('#v16v .v16v-slot').parentElement;
    if (el) mountCard(el);
  });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * RC8-notes-ui (B4): the UI for Botfive's R25 personal stories (R25-notes-hooks.md). The study view gets a "Your story"
 * card for the kanji on screen: the learner's own one-line note, an Edit/Add button and a single-line editor
 * (maxlength V16Notes.MAX_LEN, counted in code points; placeholder and "Use suggestion" from draftFor). It saves on
 * Enter or blur, and Escape cancels. Notes are plain text: everything goes in through textContent/value, never innerHTML.
 * While the on-screen kanji is still being written (box not finished) the note stays hidden so it cannot give the
 * answer away. Re-renders on v16:note. Without V16Notes nothing is shown. No grade, rank or schedule change.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const api = () => root.V16Notes || null;
  function loaded() {
    if (api()) return Promise.resolve(api());
    if (root.V16Lazy && root.V16Lazy.load) return root.V16Lazy.load('notes').then(api, () => null);
    return Promise.resolve(null);
  }
  const maxLen = () => (api() && api().MAX_LEN) || 200;
  const cut = (t) => [...String(t)].slice(0, maxLen()).join('');
  /** False while the on-screen box for k is unfinished (a note would give the answer away). */
  function revealed(k) {
    try {
      const b = boxes[cur];
      if (b && D[cur] && D[cur].k === k && !b.allDone) return false;
    } catch (e) { /* no lesson on screen */ }
    return true;
  }
  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  let host = null, kanji = null;

  function render(sec, k, editing) {
    const A = api();
    sec.textContent = '';
    const h = el('h3', null, 'Your story for ');
    const g = el('span', 'v16nt-k', k); g.lang = 'ja'; h.appendChild(g);
    sec.appendChild(h);
    if (!revealed(k)) { sec.appendChild(el('p', 'v16nt-m', 'Finish writing this kanji to see or edit your story.')); return; }
    const note = A.get(k);
    if (!editing) {
      const p = el('p', note ? 'v16nt-t' : 'v16nt-m', note || 'No story yet. Write a one-line reminder in your own words.');
      sec.appendChild(p);
      const b = el('button', 'v16nt-e', note ? 'Edit' : 'Add story'); b.type = 'button';
      b.addEventListener('click', () => render(sec, k, true));
      sec.appendChild(b);
      return;
    }
    let draft = '';
    try { draft = A.draftFor(k) || ''; } catch (e) { draft = ''; }
    const lab = el('label', 'v16nt-l');
    lab.appendChild(el('span', 'v16nt-sr', 'Your story'));
    const inp = el('input', 'v16nt-i'); inp.type = 'text'; inp.maxLength = maxLen(); inp.value = note || '';
    inp.placeholder = draft || 'e.g. a picture that helps you remember it'; inp.autocomplete = 'off';
    lab.appendChild(inp); sec.appendChild(lab);
    const row = el('div', 'v16nt-b');
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save) { try { A.set(k, cut(inp.value)); } catch (e) { /* storage full: keep the old note */ } }
      render(sec, k, false);
      const eb = sec.querySelector('.v16nt-e'); if (eb) eb.focus();
    };
    inp.addEventListener('input', () => { const c = cut(inp.value); if (c !== inp.value) inp.value = c; });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (!sec.contains(doc.activeElement)) finish(true); }, 0));
    if (draft) {
      const u = el('button', 'v16nt-u', 'Use suggestion'); u.type = 'button';
      u.addEventListener('mousedown', (e) => e.preventDefault());
      u.addEventListener('click', () => { inp.value = cut(draft); inp.focus(); });
      row.appendChild(u);
    }
    const sv = el('button', 'v16nt-s', 'Save'); sv.type = 'button';
    sv.addEventListener('mousedown', (e) => e.preventDefault());
    sv.addEventListener('click', () => finish(true));
    row.appendChild(sv); sec.appendChild(row);
    inp.focus();
  }
  function mountCard(parent, k) {
    const old = parent.querySelector('.v16nt-card');
    if (old) old.remove();
    host = null; kanji = null;
    if (!api() || !k) return;
    const sec = el('section', 'v16v-slot v16nt-card');
    sec.setAttribute('aria-label', 'Your story');
    const ws = parent.querySelector('.v16ws-card');
    parent.insertBefore(sec, ws ? ws.nextSibling : parent.firstChild);
    host = sec; kanji = k;
    render(sec, k, false);
  }
  root.addEventListener('v16:note', (e) => {
    if (!host || !host.isConnected || !e.detail || e.detail.kanji !== kanji) return;
    if (host.querySelector('.v16nt-i')) return;   // keep an open editor; it saves its own value
    render(host, kanji, false);
  });
  root.V16NotesUI = { mountCard, loaded };
  // The deferred notes group may load after the study view opened.
  loaded().then((A) => {
    if (!A) return;
    const v = doc.querySelector('#v16v .v16v-slot');
    if (v && v.parentElement && !v.parentElement.querySelector('.v16nt-card')) {
      let k; try { k = D[cur] && D[cur].k; } catch (e) { k = undefined; }
      if (k) mountCard(v.parentElement, k);
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * RC9-known-import-ui (B4): the UI for Botfive's R26 "I already know some kanji" import (R26-known-import-hooks.md).
 * A dialog with a textarea (and a text-file picker) for a paste from WaniKani, Anki or any list. It shows a live preview
 * (V16KnownImport.preview: nothing saved), then a confirm button "Mark N as known" (disabled at 0) that calls apply(),
 * then "Marked N as known · Undo". Settings gets an entry plus the last import date with Undo until undone; the
 * welcome screen gets a pill. Pasted and file text is untrusted: it is only read by preview/apply and shown through
 * textContent (never innerHTML). Nothing is written before the confirm. Without the 'known' group nothing is shown.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const api = () => root.V16KnownImport || null;
  function loaded() {
    if (api()) return Promise.resolve(api());
    if (root.V16Lazy && root.V16Lazy.load) return root.V16Lazy.load('known').then(api, () => null);
    return Promise.resolve(null);
  }
  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(cls, text) { const b = el('button', cls, text); b.type = 'button'; return b; }
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  const SHOW = 400;   // raise-list characters shown; the rest is counted
  const day = (t) => { try { return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return ''; } };

  let dlg = null;
  function close() {
    if (!dlg) return;
    const back = dlg.back; dlg.ov.remove(); dlg = null;
    doc.removeEventListener('keydown', onKey, true);
    if (back && back.isConnected) back.focus();
  }
  function onKey(e) { if (e.key === 'Escape' && dlg) { e.preventDefault(); e.stopPropagation(); close(); } }

  function open() {
    close();
    const ov = el('div'); ov.id = 'v16kn';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'v16kn-h');
    const box = el('div', 'v16kn-in');
    const h = el('h2', null, 'I already know some kanji'); h.id = 'v16kn-h'; h.tabIndex = -1;
    const hint = el('p', 'v16kn-hint', 'Paste kanji from WaniKani, Anki or any list. Other text is ignored.');
    const lab = el('label', 'v16kn-l'); lab.appendChild(el('span', 'v16nt-sr', 'Kanji you know'));
    const ta = el('textarea', 'v16kn-ta'); ta.rows = 4; ta.spellcheck = false; ta.setAttribute('autocomplete', 'off');
    lab.appendChild(ta);
    const fl = el('label', 'v16kn-f', 'Or open a text file ');
    const fi = el('input'); fi.type = 'file'; fi.accept = '.txt,.csv,.tsv,.json,.md,text/*'; fl.appendChild(fi);
    const pv = el('p', 'v16kn-pv'); pv.setAttribute('aria-live', 'polite');
    const list = el('p', 'v16kn-list'); list.lang = 'ja';
    const go = btn('v16kn-go', 'Mark 0 as known'); go.disabled = true;
    const done = el('p', 'v16kn-done'); done.setAttribute('aria-live', 'polite');
    const undo = btn('v16kn-undo', 'Undo'); undo.hidden = true;
    const x = btn('v16kn-x', 'Close');
    const row = el('div', 'v16kn-b'); row.append(go, x);
    const row2 = el('div', 'v16kn-b2'); row2.append(done, undo);
    box.append(h, hint, lab, fl, pv, list, row, row2);
    ov.appendChild(box); doc.body.appendChild(ov);
    dlg = { ov, back: doc.activeElement };
    doc.addEventListener('keydown', onKey, true);
    if (api()) ta.maxLength = api().MAX_INPUT;
    let t = null, count = 0;
    const render = () => {
      const A = api();
      if (!A) { pv.textContent = 'Loading…'; go.disabled = true; return; }
      let p = null;
      try { p = A.preview(ta.value.slice(0, A.MAX_INPUT)); } catch (e) { p = null; }
      count = p ? n(p.raise) : 0;
      if (!ta.value.trim() || !p) { pv.textContent = ''; list.textContent = ''; }
      else {
        pv.textContent = `${count} kanji will be marked Bronze · ${n(p.already)} already known · ${n(p.notInApp)} not in this app`;
        const shown = p.raise.slice(0, SHOW).join(' ');
        list.textContent = p.raise.length > SHOW ? `${shown} … and ${p.raise.length - SHOW} more` : shown;
      }
      go.textContent = `Mark ${count} as known`;
      go.disabled = count === 0;
    };
    const later = () => { clearTimeout(t); t = setTimeout(render, 150); };
    ta.addEventListener('input', later);
    fi.addEventListener('change', () => {
      const f = fi.files && fi.files[0];
      if (!f) return;
      const max = (api() && api().MAX_INPUT) || 200000;
      (f.text ? f.text() : Promise.reject()).then((s) => { ta.value = String(s).slice(0, max); render(); }, () => { pv.textContent = 'That file could not be read as text.'; });
    });
    go.addEventListener('click', () => {
      const A = api();
      if (!A || go.disabled) return;
      let r = null;
      try { r = A.apply(ta.value.slice(0, A.MAX_INPUT)); } catch (e) { r = null; }
      if (!r) { done.textContent = 'Could not save. Nothing was changed.'; return; }
      done.textContent = `Marked ${r.raised} as known.`;
      undo.hidden = !r.raised;
      ta.value = ''; render();
      (r.raised ? undo : x).focus();
    });
    undo.addEventListener('click', () => {
      const A = api();
      let r = null;
      try { r = A && A.undo(); } catch (e) { r = null; }
      done.textContent = r ? `Undone: ${r.reverted} kanji back to how they were.` : 'Nothing to undo.';
      undo.hidden = true; x.focus();
    });
    x.addEventListener('click', close);
    render();
    loaded().then((A) => { if (A && dlg && dlg.ov === ov) { ta.maxLength = A.MAX_INPUT; render(); } });
    ta.focus();
  }

  /** Settings: an entry button plus "Last import: date · N kanji · Undo" until undone. {el, update, unmount} */
  function settingsSection() {
    if (!root.V16Lazy) return null;
    const sec = el('section', 'v16kn-set'); sec.setAttribute('aria-labelledby', 'v16kn-sh');
    const h = el('h3', null, 'I already know some kanji'); h.id = 'v16kn-sh';
    const p = el('p', 'v16kn-sp', 'Mark kanji you learned elsewhere (WaniKani, Anki, a list) as known.');
    const ob = btn('v16kn-open', 'Import known kanji');
    const last = el('p', 'v16kn-last'); const ub = btn('v16kn-sundo', 'Undo import'); ub.hidden = true;
    const row = el('div', 'v16kn-b2'); row.append(last, ub);
    sec.append(h, p, ob, row);
    const update = () => {
      const A = api(); let l = null;
      try { l = A && A.last(); } catch (e) { l = null; }
      last.textContent = l ? `Last import: ${day(l.at)} · ${l.count} kanji` : '';
      ub.hidden = !l;
    };
    ob.addEventListener('click', () => open());
    ub.addEventListener('click', () => { const A = api(); try { if (A) A.undo(); } catch (e) { /* nothing to undo */ } update(); });
    const onEv = () => update();
    root.addEventListener('v16:known-import', onEv);
    loaded().then(update);
    return { el: sec, update, unmount() { root.removeEventListener('v16:known-import', onEv); sec.remove(); } };
  }
  root.V16KnownUI = { open, close, settingsSection, loaded };
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * RC10-study-order-ui (B4): Settings → "Order of new kanji" for Botfive's R27 (R27-study-order-hooks.md). Radio rows
 * (app, frequency, grade, strokes, custom) save at once through V16StudyOrder.set; "My own list" opens a textarea with a
 * live customSummary preview (nothing saved) and a Save button (disabled when none of it is in the app). Pasted text is
 * untrusted: it only goes to customSummary/set and is shown through textContent (never innerHTML).
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const api = () => root.V16StudyOrder || null;
  const LABELS = { app: 'App order', frequency: 'Most common first', grade: 'School grade', strokes: 'Fewest strokes first', custom: 'My own list' };
  const label = (o) => LABELS[o] || '';
  function loaded() {
    if (api()) return Promise.resolve(api());
    if (root.V16Lazy && root.V16Lazy.load) return root.V16Lazy.load('order').then(api, () => null);
    return Promise.resolve(null);
  }
  function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  let uid = 0;
  function settingsSection() {
    if (!root.V16Lazy) return null;
    const id = `v16so${++uid}`;
    const sec = el('section', 'v16so-set'); sec.setAttribute('aria-labelledby', `${id}-h`);
    const h = el('h3', null, 'Order of new kanji'); h.id = `${id}-h`;
    const fs = el('div', 'v16so-list'); fs.setAttribute('role', 'radiogroup'); fs.setAttribute('aria-labelledby', `${id}-h`);
    const radios = {};
    for (const o of ['app', 'frequency', 'grade', 'strokes', 'custom']) {
      const l = el('label', 'v16so-row'); const r = el('input'); r.type = 'radio'; r.name = id; r.value = o;
      l.append(r, el('span', null, o === 'app' ? 'App order (default)' : o === 'custom' ? 'My own list…' : label(o)));
      fs.appendChild(l); radios[o] = r;
    }
    const help = el('p', 'v16so-help', 'Parts are still taught before the kanji that use them.');
    const cu = el('div', 'v16so-cu'); cu.hidden = true;
    const cl = el('label', 'v16so-cl'); cl.appendChild(el('span', null, "Paste your course's kanji in order (RTK, WaniKani, Genki…)"));
    const ta = el('textarea', 'v16so-ta'); ta.rows = 4; ta.spellcheck = false; ta.setAttribute('autocomplete', 'off'); cl.appendChild(ta);
    const sum = el('p', 'v16so-sum'); sum.setAttribute('aria-live', 'polite');
    const first = el('p', 'v16so-first'); first.lang = 'ja';
    const save = el('button', 'v16so-save', 'Save my list'); save.type = 'button'; save.disabled = true;
    const msg = el('p', 'v16so-msg'); msg.setAttribute('aria-live', 'polite');
    cu.append(cl, sum, first, save, msg);
    sec.append(h, fs, help, cu);
    const cur = () => { const A = api(); try { if (A) return A.get(); } catch (e) { /* */ } try { return root.V15.studyOrderSetting(root.localStorage); } catch (e) { return { order: 'app' }; } };
    const render = () => {
      const A = api(); if (!A) return;
      if (A.MAX_INPUT) ta.maxLength = A.MAX_INPUT;
      let s = null; try { s = A.customSummary(ta.value); } catch (e) { s = null; }
      if (!ta.value.trim() || !s) { sum.textContent = ''; first.textContent = ''; save.disabled = true; return; }
      sum.textContent = `${s.total} kanji · ${s.inApp} in this app · ${s.notInApp} not in this app`;
      first.textContent = (s.first || []).join(' ');
      save.disabled = !s.inApp;
    };
    let t = null;
    ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 150); });
    const update = () => {
      const s = cur(); const o = LABELS[s.order] ? s.order : 'app';
      for (const k in radios) radios[k].checked = k === o;
      cu.hidden = o !== 'custom';
      if (o === 'custom' && !ta.value && Array.isArray(s.list)) { ta.value = s.list.join(''); render(); }
    };
    fs.addEventListener('change', (e) => {
      const o = e.target && e.target.value; if (!LABELS[o]) return;
      msg.textContent = '';
      loaded().then((A) => {
        if (!A) return;
        if (o === 'custom') {
          cu.hidden = false;
          const s = A.get();
          if (Array.isArray(s.list) && s.list.length) { A.set('custom'); if (!ta.value) ta.value = s.list.join(''); }
          render(); ta.focus();
          return;
        }
        cu.hidden = true; A.set(o);
      });
    });
    save.addEventListener('click', () => {
      const A = api(); if (!A || save.disabled) return;
      let r = null; try { r = A.set('custom', ta.value); } catch (e) { r = null; }
      msg.textContent = r ? `Saved: ${Array.isArray(r.list) ? r.list.length : 0} kanji in your order.` : 'None of these kanji are in this app. Nothing was saved.';
      update();
    });
    const onEv = () => update();
    root.addEventListener('v16:study-order', onEv);
    update(); loaded().then(() => { update(); render(); });
    return { el: sec, update, unmount() { root.removeEventListener('v16:study-order', onEv); sec.remove(); } };
  }
  root.V16OrderUI = { settingsSection, label, loaded, LABELS };
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * RC11-word-unlock-ui (B4): the UI for Botfive's R28 "words you can read" (R28-word-unlock-hooks.md). Display only.
 * - Menu "Words you can read" (V15UI.menuHTML) with a badge of new readable words since the list was last opened.
 * - The view: "You can read N of T words", up to 3 "Learn next" kanji (+count, sample words, a Learn button that
 *   starts the usual lesson for that kanji), then the readable words, 60 at a time with "Show more".
 *   Opening it calls markSeen(); the v16:unlock event clears the menu badge.
 * - Result screens (level check, practice): a "Now readable" line per kanji that went from unranked to ranked.
 * All text goes in through textContent. Needs the deferred 'unlock' group (loaded on demand) and v15-ui's words.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const api = () => root.V16WordUnlock || null;
  const ok = () => !!(api() && api().ready());
  function loaded() {
    const w = () => (root.V15UI && root.V15UI.loadWords ? Promise.resolve(root.V15UI.loadWords()).catch(() => null) : Promise.resolve());
    if (api()) return w().then(() => (ok() ? api() : null));
    if (root.V16Lazy && root.V16Lazy.load) return root.V16Lazy.load('unlock').then(w, () => null).then(() => (ok() ? api() : null));
    return Promise.resolve(null);
  }
  function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function ja(text) { const s = el('span', null, text); s.lang = 'ja'; return s; }
  const PAGE = 60;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function wordItem(x) {
    const li = el('li', 'v16wu-w');
    li.append(ja(x.w), ' ', el('span', 'v16wu-r', null));
    li.lastChild.append(ja(x.r));
    if (x.m) li.append(el('span', 'v16wu-m', ` ${x.m}`));
    return li;
  }

  function mount(host, startKanji) {
    const box = el('div', 'v16wu');
    host.append(box);
    let shown = PAGE;
    function draw() {
      box.replaceChildren();
      const w = api();
      if (!ok()) { box.append(el('p', 'v16wu-sum', 'Loading…')); return; }
      const s = w.summary();
      const head = el('p', 'v16wu-sum', `You can read ${s.readable} of ${s.total} words.`);
      head.setAttribute('role', 'status');
      box.append(head);
      if (!s.readable) box.append(el('p', 'v16wu-hint', 'Learn a few kanji and the words made only of kanji you know show up here.'));
      const next = w.nextBest(3) || [];
      if (next.length) {
        const sec = el('section', 'v16wu-next');
        sec.append(el('h3', null, 'Learn next'));
        const ul = el('ul', 'v16wu-nl');
        for (const n of next) {
          const li = el('li', 'v16wu-n');
          const t = el('div', 'v16wu-nt');
          const k = ja(n.k); k.className = 'v16wu-k';
          t.append(k, el('span', 'v16wu-c', ` +${plural(n.count, 'word', 'words')}`));
          const sm = el('div', 'v16wu-s');
          (n.sample || []).slice(0, 3).forEach((x, i) => { if (i) sm.append('、'); sm.append(ja(x.w)); });
          t.append(sm);
          const b = el('button', 'v16wu-go', `Learn ${n.k}`); b.type = 'button';
          b.setAttribute('aria-label', `Learn ${n.k} (+${plural(n.count, 'word', 'words')})`);
          b.addEventListener('click', () => { if (root.V16Views) root.V16Views.close(); if (startKanji) startKanji([n.k]); });
          li.append(t, b);
          ul.append(li);
        }
        sec.append(ul);
        box.append(sec);
      }
      if (root.V16ReadSentUI) box.append(root.V16ReadSentUI.section());   // RC12-readable-sentences-ui
      if (s.readable) {
        const list = w.list(0, shown) || [];
        const ul = el('ul', 'v16wu-list');
        ul.setAttribute('aria-label', 'Words you can read');
        for (const x of list) ul.append(wordItem(x));
        box.append(ul);
        if (list.length < s.readable) {
          const more = el('button', 'v16wu-more', `Show more (${s.readable - list.length} left)`); more.type = 'button';
          more.addEventListener('click', () => { shown += PAGE; draw(); const items = box.querySelectorAll('.v16wu-w'); const f = items[shown - PAGE]; if (f) { f.tabIndex = -1; f.focus(); } });
          box.append(more);
        }
      }
      if (root.V16LookPairsUI) box.append(root.V16LookPairsUI.section());   // RC13-lookalike-pairs-ui
    }
    function update() {
      shown = PAGE;
      draw();
      loaded().then((w) => { if (!w) return; draw(); try { w.markSeen(); } catch (e) { /* storage */ } });
    }
    return { update, unmount() { box.remove(); } };
  }

  // Result screens: fill the slot v15-ui left for newly ranked kanji.
  function fill(slot) {
    slot.dataset.done = '';
    const ks = [...(slot.dataset.k || '')];
    loaded().then((w) => {
      if (!w || !slot.isConnected) return;
      const rows = [];
      for (const k of ks) { const list = w.unlockedBy(k, 5) || []; if (list.length) rows.push([k, list]); }
      if (!rows.length) return;
      slot.append(el('p', 'v16wu-h', 'Now readable'));
      for (const [k, list] of rows) {
        const p = el('p', 'v16wu-row');
        const kk = ja(k); kk.className = 'v16wu-k';
        p.append(kk, ': ');
        list.forEach((x, i) => { if (i) p.append('、'); p.append(ja(x.w)); });
        slot.append(p);
      }
    });
  }
  function scan() { for (const s of doc.querySelectorAll('#v15 .v16wu-slot:not([data-done])')) fill(s); }
  function badge() { const n = ok() ? api().summary().newSinceSeen : 0; for (const b of doc.querySelectorAll('[data-v16view="words"] .v15-mbadge')) { b.replaceChildren(); if (n > 0) b.append(el('b', null, n > 99 ? '99+' : String(n))); } }
  function watch() {
    const h = doc.getElementById('v15');
    if (h && root.MutationObserver) { new root.MutationObserver(scan).observe(h, { childList: true }); scan(); return; }
    if (!h) setTimeout(watch, 500);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', watch); else watch();
  root.addEventListener('v16:unlock', badge);
  root.V16WordsUI = { mount, loaded, fill };
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * RC12-readable-sentences-ui (B4): Market research backlog #10, "mini graded reading … only known kanji, with TTS".
 * A "Sentences you can read" section in the Words view: R11's Tatoeba example sentences (the levels already loaded,
 * via the deferred 'sentences' group) in which EVERY kanji is known (rank > 0, V15.loadRanks, the same test as R28).
 * Shortest first, 5 at a time; each with Read aloud (ja voice, when speech is available), an English toggle and
 * the Tatoeba attribution and license links that R11 requires. Display only: no grading, no scheduling, no storage.
 * All text goes in through textContent; links are kept only when they are https URLs.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const PAGE = 5;
  const isKanji = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff々]/.test(ch);
  function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function loaded() {
    if (root.SentencesModel && root.CONTEXT_SENTENCES) return Promise.resolve(true);
    if (root.V16Lazy && root.V16Lazy.load) return root.V16Lazy.load('sentences').then(() => !!(root.SentencesModel && root.CONTEXT_SENTENCES), () => false);
    return Promise.resolve(false);
  }
  function knownFn() {
    let ranks = null;
    try { ranks = root.V15 && root.V15.loadRanks ? root.V15.loadRanks(root.localStorage) : null; } catch (e) { ranks = null; }
    const kanji = (ranks && ranks.kanji) || {};
    return (k) => !!(kanji[k] && kanji[k].rank > 0);
  }
  /** Every loaded sentence whose kanji are all known, de-duplicated by Tatoeba id, shortest first then by id. */
  function readable() {
    const M = root.SentencesModel, all = root.CONTEXT_SENTENCES || {};
    if (!M || typeof M.pool !== 'function') return [];
    const isKnown = knownFn(), seen = new Set(), out = [];
    for (const level of Object.keys(all)) {
      const data = all[level];
      if (!data || !data.kanji || !data.meta) continue;
      for (const k of Object.keys(data.kanji)) {
        if (!isKnown(k)) continue;
        for (const c of M.pool(data, k)) {
          if (!c || typeof c.ja !== 'string' || seen.has(c.jaId)) continue;
          const ks = [...c.ja].filter(isKanji);
          if (!ks.length || !ks.every(isKnown)) continue;
          seen.add(c.jaId);
          let at = null;
          try { at = M.attribution(data, c); } catch (e) { at = null; }
          out.push({ id: c.jaId, ja: c.ja, en: typeof c.en === 'string' ? c.en : '', at });
        }
      }
    }
    return out.sort((a, b) => a.ja.length - b.ja.length || a.id - b.id);
  }
  // RC14b: one speech helper (first IIFE's canSpeak / sayText, exported on V16Views).
  const canSpeak = () => root.V16Views.canSpeak();
  const say = (text) => root.V16Views.say(text);
  function safeUrl(u) { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; } }
  let uid = 0;
  function item(x) {
    const li = el('li', 'v16rs-i');
    const t = el('p', 'v16rs-ja', x.ja); t.lang = 'ja';
    li.append(t);
    const row = el('div', 'v16rs-acts');
    if (canSpeak()) {
      const b = el('button', 'v16rs-say', 'Read aloud'); b.type = 'button';
      b.addEventListener('click', () => say(x.ja));
      row.append(b);
    }
    const en = el('p', 'v16rs-en', x.en); en.hidden = true; en.id = `v16rs-en-${++uid}`;
    if (x.en) {
      const b = el('button', 'v16rs-tr', 'English'); b.type = 'button';
      b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', en.id);
      b.addEventListener('click', () => { en.hidden = !en.hidden; b.setAttribute('aria-expanded', String(!en.hidden)); });
      row.append(b);
    }
    li.append(row, en);
    if (x.at) {
      const a = el('p', 'v16rs-at');
      const links = (x.at.links || []).map((l) => [String(l.label || ''), safeUrl(l.url)]).filter((l) => l[0] && l[1]);
      a.append(el('span', null, x.at.text || ''));
      if (links.length) {
        a.append(' · ');
        links.forEach(([label, href], i) => {
          if (i) a.append(', ');
          const k = el('a', null, label); k.href = href; k.target = '_blank'; k.rel = 'noopener noreferrer';
          a.append(k);
        });
      }
      li.append(a);
    }
    return li;
  }
  /** A self-filling section for the Words view (empty while the sentences load). */
  function section() {
    const sec = el('section', 'v16rs');
    let shown = PAGE;
    function draw() {
      sec.replaceChildren(el('h3', null, 'Sentences you can read'));
      const list = readable();
      if (!list.length) {
        sec.append(el('p', 'v16rs-hint', 'Example sentences show up here once every kanji in them is one you know.'));
        return;
      }
      sec.append(el('p', 'v16rs-sum', `${list.length} example ${list.length === 1 ? 'sentence uses' : 'sentences use'} only kanji you know.`));
      const ul = el('ul', 'v16rs-list');
      ul.setAttribute('aria-label', 'Sentences you can read');
      list.slice(0, shown).forEach((x) => ul.append(item(x)));
      sec.append(ul);
      if (list.length > shown) {
        const more = el('button', 'v16rs-more', `More sentences (${list.length - shown} left)`); more.type = 'button';
        more.addEventListener('click', () => {
          shown += PAGE; draw();
          const f = sec.querySelectorAll('.v16rs-i')[shown - PAGE];
          if (f) { f.tabIndex = -1; f.focus(); }
        });
        sec.append(more);
      }
    }
    sec.append(el('h3', null, 'Sentences you can read'), el('p', 'v16rs-hint', 'Loading…'));
    loaded().then((ok) => { if (ok) draw(); else sec.remove(); });
    return sec;
  }
  root.V16ReadSentUI = { section, readable, loaded };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * RC13-lookalike-pairs-ui (B4, MARKET_RESEARCH #8 on-demand half): "Look-alikes to tell apart" in the Words view.
 * Kanji look-alike pairs from confusables.js (kind 'lookalike', not acceptEither, both kanji in the practice
 * catalog) where at least one is known (rank > 0). Both known first, then by the known one's rank order.
 * Each pair shows the two glyphs side by side, the distinguishing note, and "Practise both", which opens Practice
 * with the two chosen (the normal practice flow; grading and scheduling unchanged). textContent only.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  if (!doc) return;
  function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const PAGE = 5;
  const isKanji = (c) => /^[\u3400-\u4dbf\u4e00-\u9fff]$/.test(c);
  function knownFn() {
    let ranks = null;
    try { ranks = root.V15 && root.V15.loadRanks ? root.V15.loadRanks(root.localStorage) : null; } catch (e) { ranks = null; }
    const kanji = (ranks && ranks.kanji) || {};
    return (k) => !!(kanji[k] && kanji[k].rank > 0);
  }
  /** [{a, b, note, both}] — pairs with at least one known kanji, both in the practice catalog. */
  function pairs() {
    const C = root.CONFUSABLES, cat = root.PRACTICE_CATALOG && root.PRACTICE_CATALOG.kanji;
    if (!C || !Array.isArray(C.pairs) || !cat) return [];
    const isKnown = knownFn(), seen = new Set(), out = [];
    for (const p of C.pairs) {
      if (!p || p.kind !== 'lookalike' || p.acceptEither || !Array.isArray(p.chars) || p.chars.length !== 2) continue;
      const [a, b] = p.chars.map(String);
      if (!isKanji(a) || !isKanji(b) || a === b || !cat[a] || !cat[b]) continue;
      const key = [a, b].sort().join('');
      if (seen.has(key)) continue;
      const ka = isKnown(a), kb = isKnown(b);
      if (!ka && !kb) continue;
      seen.add(key);
      out.push({ a: ka ? a : b, b: ka ? b : a, note: typeof p.note === 'string' ? p.note : '', both: ka && kb });
    }
    return out.sort((x, y) => (y.both - x.both) || (x.a + x.b < y.a + y.b ? -1 : 1));
  }
  function practise(a, b) {
    const U = root.V15UI;
    if (!U || !U.actions || typeof U.actions.practiceKanji !== 'function') return;
    if (root.V16Views && root.V16Views.close) root.V16Views.close();
    U.actions.practiceKanji(a);
    if (U.state && U.state.pr && Array.isArray(U.state.pr.chosen) && !U.state.pr.chosen.includes(b)) U.state.pr.chosen.push(b);
    if (typeof U.render === 'function') U.render();
  }
  function item(x) {
    const li = el('li', 'v16lp-i');
    const g = el('p', 'v16lp-g');
    const ga = el('span', 'v16lp-k', x.a); ga.lang = 'ja';
    const gb = el('span', 'v16lp-k', x.b); gb.lang = 'ja';
    g.append(ga, el('span', 'v16lp-vs', 'vs'), gb);
    g.setAttribute('aria-label', `${x.a} versus ${x.b}`);
    li.append(g);
    if (x.note) li.append(el('p', 'v16lp-note', x.note));
    if (!x.both) li.append(el('p', 'v16lp-new', `${x.b} is new to you.`));
    const btn = el('button', 'v16lp-go', 'Practise both'); btn.type = 'button';
    btn.setAttribute('aria-label', `Practise ${x.a} and ${x.b}`);
    btn.addEventListener('click', () => practise(x.a, x.b));
    li.append(btn);
    return li;
  }
  function section() {
    const sec = el('section', 'v16lp');
    let shown = PAGE;
    function draw() {
      sec.replaceChildren(el('h3', null, 'Look-alikes to tell apart'));
      const list = pairs();
      if (!list.length) { sec.append(el('p', 'v16lp-hint', 'Kanji that look alike show up here once you know one of them.')); return; }
      sec.append(el('p', 'v16lp-sum', `${list.length} look-alike ${list.length === 1 ? 'pair' : 'pairs'} with kanji you know.`));
      const ul = el('ul', 'v16lp-list'); ul.setAttribute('aria-label', 'Look-alike pairs');
      list.slice(0, shown).forEach((x) => ul.append(item(x)));
      sec.append(ul);
      if (list.length > shown) {
        const more = el('button', 'v16lp-more', `More pairs (${list.length - shown} left)`); more.type = 'button';
        more.addEventListener('click', () => { shown += PAGE; draw(); const f = sec.querySelectorAll('.v16lp-i')[shown - PAGE]; if (f) { f.tabIndex = -1; f.focus(); } });
        sec.append(more);
      }
    }
    draw();
    return sec;
  }
  root.V16LookPairsUI = { section, pairs, practise };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * RC14-stroke-tint-ui (B4): after a writing attempt, a small "How each stroke went" card lists every stroke as a chip
 * (✓ solid ok / ✗ dashed miss / ! dotted near-miss) and every part (box.k.parts, from/to 0-based) the same way, plus a
 * plain-text summary in an aria-live region. Display only: it reads the verdicts the app already passes to
 * V15UI.onReject / onWrongKanji / onCelebrate, keeps them in memory (WeakMap per box) and never writes storage,
 * never calls V15.diagnoseWriting, and never touches the pad. Weak-spot stays the only record.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  if (!doc) return;
  let UI = null;
  const seen = new WeakMap();   // box → {miss: {n: 'miss'|'near'}, wrong}
  let card = null;

  function rec(box) {
    let r = seen.get(box);
    if (!r) { r = { miss: {}, wrong: false }; seen.set(box, r); }
    return r;
  }
  function strokeNo(box, v) {
    const n = box && box.pad ? box.pad.strokes.length + (v && v.redoFirst ? 0 : 1) : 1;
    const max = box && box.k ? box.k.strokes : n;
    return Math.min(Math.max(1, n), max || n);
  }
  function near(v) {
    try { return root.V15 && root.V15.classifyReject(v) === 'borderline'; } catch (e) { return false; }
  }
  /** {strokes:[{n, st}], parts:[{g, st}], text} for a box; st is 'ok' | 'near' | 'miss'. */
  function summary(box) {
    const r = seen.get(box) || { miss: {}, wrong: false };
    const k = box.k || {};
    const total = k.strokes || 0;
    const strokes = [];
    for (let n = 1; n <= total; n += 1) strokes.push({ n, st: r.miss[n] || 'ok' });
    const parts = (k.parts && k.parts.length > 1 ? k.parts : []).map((p) => {
      let st = 'ok';
      for (let i = p.from; i <= p.to; i += 1) {
        const s = r.miss[i + 1];
        if (s === 'miss') { st = 'miss'; break; }
        if (s === 'near') st = 'near';
      }
      return { g: String(p.g || '?'), st };
    });
    const bad = strokes.filter((s) => s.st !== 'ok');
    let text;
    if (r.wrong) text = 'That was a different kanji, so no stroke was judged.';
    else if (!bad.length) text = `All ${total} strokes were fine.`;
    else text = bad.map((s) => `Stroke ${s.n}: ${s.st === 'miss' ? 'missed' : 'nearly'}`).join('. ') + `. The other ${total - bad.length} were fine.`;
    return { kanji: String(k.k || ''), wrong: r.wrong, strokes, parts, text };
  }
  const MARK = { ok: '✓', near: '!', miss: '✗' };
  const WORD = { ok: 'fine', near: 'nearly', miss: 'missed' };
  function chip(label, st) {
    const c = doc.createElement('span');
    c.className = 'v16st-c v16st-' + st;
    c.dataset.st = st;
    const m = doc.createElement('b');
    m.setAttribute('aria-hidden', 'true');
    m.textContent = MARK[st];
    const t = doc.createElement('span');
    t.textContent = label;
    c.append(m, t);
    c.setAttribute('aria-label', `${label}: ${WORD[st]}`);
    return c;
  }
  function hide() { if (card) card.classList.remove('show'); }
  function show(box) {
    if (!box || !box.k || box.k.isWord) return;
    const s = summary(box);
    if (!card) {
      card = doc.createElement('div');
      card.id = 'v16st';
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');
      doc.body.appendChild(card);
    }
    card.textContent = '';
    const h = doc.createElement('div');
    h.className = 'v16st-h';
    h.textContent = `How each stroke went · ${s.kanji}`;
    const row = doc.createElement('div');
    row.className = 'v16st-row';
    if (!s.wrong) s.strokes.forEach((x) => row.append(chip(String(x.n), x.st)));
    const prow = doc.createElement('div');
    prow.className = 'v16st-row';
    if (!s.wrong) s.parts.forEach((x) => prow.append(chip(x.g, x.st)));
    const p = doc.createElement('p');
    p.className = 'v16st-sum';
    p.textContent = s.text;
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'v16st-x';
    x.textContent = 'Close';
    x.addEventListener('click', hide);
    card.append(h, row);
    if (prow.childNodes.length) card.append(prow);
    card.append(p, x);
    card.classList.add('show');
  }

  function install() {
    if (UI || !root.V15UI) return;
    UI = root.V15UI;
    wrapAll();
  }
  const wrap = (name, fn) => {
    const orig = UI[name];
    if (typeof orig !== 'function') return;
    UI[name] = function () {
      try { fn.apply(null, arguments); } catch (e) { /* display only */ }
      return orig.apply(this, arguments);
    };
  };
  function wrapAll() {
  wrap('onReject', (box, v) => {
    if (!box || !box.k) return;
    const r = rec(box);
    const n = strokeNo(box, v);
    const st = near(v) ? 'near' : 'miss';
    if (r.miss[n] !== 'miss') r.miss[n] = st;
    // Only when the miss ends the item (Practice / Level check); in a lesson the card waits for celebrate, so it
    // never sits over the pad while the learner is still writing.
    if (st === 'miss' && UI.state && UI.state.writing) setTimeout(() => show(box), 0);
  });
  wrap('onWrongKanji', (box) => { if (box && box.k) { rec(box).wrong = true; setTimeout(() => show(box), 0); } });
  wrap('onCelebrate', (k) => {
    const bs = typeof boxes !== 'undefined' ? boxes : null;   // eslint-disable-line no-undef
    const box = bs && bs.find((b) => b && (b.k === k || (b.k && b.k.src === k)) && !b.k.isPart);
    if (box) setTimeout(() => show(box), 0);
  });
  wrap('onBoxChange', hide);
  wrap('onStrokeStart', hide);
  }
  // v15-ui.js is injected after the load event, so wrap its hooks once that script has run.
  doc.addEventListener('load', (e) => { if (e.target && /v15-ui\.js$/.test(e.target.src || '')) install(); }, true);
  install();
  root.V16StrokeTint = { summary, show, hide, installed: () => !!UI };
})(typeof self !== 'undefined' ? self : this);
