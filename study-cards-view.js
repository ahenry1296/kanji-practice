/*
 * study-cards-view.js — v16 R17 study cards (new file; Botfour decides where to show them).
 * Four renderers, each  StudyCards.<name>.mount(el, data, opts) → { unmount() }  (opts.renderGlyph: see glyphHtml):
 *   weakSpot        (R10 diagnosis)  'Weak spot: 寺, stroke 4' + stroke highlight → event kanji:practise-component {component, kanji, stroke}
 *   contrastDrill   (R7 look-alikes) both kanji, "which one is …?" → feedback → event kanji:contrast-answer {pair, chosen, correct}
 *   contextSentence (R11 sentences)  sentence + reading input → R5 partial credit → event kanji:sentence-answer {kanji, input, grade}
 *   leechNotice     (R8 leeches)     why + re-study steps → events kanji:leech-restudy {kanji, steps} / kanji:leech-dismiss {kanji}
 * Data: StudyCards.build(storage, {kanjiMap, now}) → {weakSpot, contrastDrill, contextSentence, leechNotice} (each data or null),
 * or the single builders StudyCards.weakSpot.data(...) etc. Builders only READ through V15; the cards never write storage:
 * the app listens for the events and calls V15 (e.g. gradeContext, completeContrast, startLeech re-study).
 * Missing data → a short plain fallback card. Meanings/readings are shown only when the data has them (never invented).
 * Events bubble from `el`. Styling: scoped to .sc-root, injected once as <style id="sc-style">; targets ≥ 44px; text ≥ 12px.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudyCards = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const EVENTS = Object.freeze({ practise: 'kanji:practise-component', contrast: 'kanji:contrast-answer',
    sentence: 'kanji:sentence-answer', restudy: 'kanji:leech-restudy', dismiss: 'kanji:leech-dismiss' });

  // Text pairs (tests/test_study_cards.js): ink/paper, faint/paper, white/accent, ink/panel.
  // SVG strokes are graphics (≥ 3:1): accent and sakura-deep on paper.
  const CSS = `
.sc-root{--sc-ink:var(--ink,#23261f);--sc-faint:var(--faint-ink,#7b715c);--sc-paper:var(--paper,#fdfaf5);
  --sc-accent:var(--matcha-deep,#5d7148);--sc-mark:var(--sakura-deep,#c7798a);--sc-panel:#efeadf;--sc-dim:#d8d1c2;
  font:400 14px var(--ui,Georgia,system-ui,sans-serif);color:var(--sc-ink);background:var(--sc-paper);
  padding:12px;border-radius:12px;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere}
.sc-root *{box-sizing:border-box}
.sc-root h3{font-size:16px;margin:0 0 8px}
.sc-root p{margin:6px 0}
.sc-root .sc-note{font-size:12px;color:var(--sc-faint)}
.sc-root button{font:inherit;color:var(--sc-ink);background:var(--sc-panel);min-height:44px;min-width:44px;cursor:pointer;
  border:2px solid transparent;border-radius:10px;padding:10px 16px;margin:4px 8px 4px 0}
.sc-root button.sc-primary{background:var(--sc-accent);color:#fff}
.sc-root button:disabled{cursor:default}
.sc-root .sc-big{font-size:48px;line-height:1.1}
.sc-root .sc-glyph mark{background:none;color:var(--sc-ink);border-bottom:4px solid var(--sc-mark)}
.sc-root svg{width:120px;height:120px;display:block}
.sc-root svg path{fill:none;stroke:var(--sc-dim);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.sc-root svg path.sc-comp{stroke:var(--sc-accent);stroke-width:4}
.sc-root svg path.sc-weak{stroke:var(--sc-mark);stroke-width:6}
.sc-root .sc-pair{display:flex;gap:12px;flex-wrap:wrap}
.sc-root .sc-pair button{flex:1 1 120px;display:flex;flex-direction:column;align-items:center;padding:8px}
.sc-root .sc-pair button[aria-pressed="true"]{border-color:var(--sc-accent)}
.sc-root .sc-pair .sc-info{font-size:12px;color:var(--sc-ink)}
.sc-root .sc-sentence{font-size:20px;line-height:1.6}
.sc-root .sc-sentence mark{background:var(--sc-panel);color:var(--sc-ink);border-bottom:3px solid var(--sc-mark);padding:0 2px}
.sc-root label{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:44px}
.sc-root input[type=text]{font:inherit;font-size:18px;min-height:44px;flex:1 1 140px;min-width:0;padding:4px 8px;color:var(--sc-ink);
  background:#fff;border:1px solid var(--sc-faint);border-radius:8px}
.sc-root .sc-feedback{min-height:20px;font-weight:600}
.sc-root .sc-feedback .sc-bad{text-decoration:underline wavy var(--sc-mark)}
.sc-root .sc-attr{font-size:12px;color:var(--sc-faint)}
.sc-root a{color:var(--sc-accent);display:inline-block;min-height:44px;line-height:44px;margin-right:8px}
.sc-root ol{margin:6px 0;padding-left:24px}
.sc-root :focus-visible{outline:3px solid var(--sc-accent);outline-offset:2px}`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lib = (opts, name) => (opts && opts[name]) || root[name] || null;
  const list = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : []);
  /** "time, hour" / "ジ · とき" from the data, or '' when the data has none. */
  const meaningOf = (e) => list(e && e.meanings).slice(0, 3).join(', ');
  const readingOf = (e) => list(e && e.on).concat(list(e && e.kun)).slice(0, 3).join(' · ');

  function injectCss(doc) {
    if (doc.getElementById('sc-style')) return;
    const s = doc.createElement('style'); s.id = 'sc-style'; s.textContent = CSS; doc.head.appendChild(s);
  }

  /**
   * Shared mount plumbing: scoped root class, one delegated click/submit handler, events bubbling from `el`.
   * render(state) → HTML; handlers[act](button, state) may change state and return true to re-render.
   */
  function makeCard(cls, render, handlers, onSubmit) {
    return function mount(el, data, opts = {}) {
      const doc = el.ownerDocument; const win = doc.defaultView || root;
      injectCss(doc);
      el.classList.add('sc-root', cls);
      const state = { data: data || null, opts };
      const emit = (name, detail) => el.dispatchEvent(new win.CustomEvent(name, { bubbles: true, detail }));
      const draw = () => { el.innerHTML = render(state); };
      const onClick = (e) => {
        const b = e.target.closest && e.target.closest('button[data-act]');
        if (b && el.contains(b) && !b.disabled && handlers[b.dataset.act] && handlers[b.dataset.act](b, state, emit)) draw();
      };
      const onSub = (e) => { e.preventDefault(); if (onSubmit && onSubmit(e.target, state, emit)) draw(); };
      el.addEventListener('click', onClick); el.addEventListener('submit', onSub);
      draw();
      return { unmount() {
        el.removeEventListener('click', onClick); el.removeEventListener('submit', onSub);
        el.innerHTML = ''; el.classList.remove('sc-root', cls);
      } };
    };
  }
  /**
   * Deferred (d): optional opts.renderGlyph(char, ctx) → HTML for ONE kanji/component glyph, e.g. an <svg> or an
   * <img> from component-glyphs.js for parts that fonts lack. ctx = {view, role}. With no renderer, or when it
   * throws or returns a non-string, the escaped character is used, exactly as before. The returned HTML is
   * inserted as-is, so the caller is responsible for it being safe.
   */
  function glyphHtml(opts, ch, ctx) {
    const fn = opts && opts.renderGlyph;
    if (typeof fn === 'function') {
      try { const h = fn(ch, ctx); if (typeof h === 'string') return h; } catch (e) { /* fall back to text */ }
    }
    return esc(ch);
  }
  const fallback = (title, text) => `<h3>${esc(title)}</h3><p class="sc-note">${esc(text)}</p>`;

  // ============ 1) weakSpot (R10) ============
  /** Top weak component → {component, kanji, stroke (1-based in component, or null), message, entry, map}. */
  function weakSpotData(storage, opts = {}) {
    const V = lib(opts, 'V15'); const DM = lib(opts, 'DiagnosisModel');
    const w = V && V.weakComponents ? V.weakComponents(storage, opts.now ?? Date.now())[0] : null;
    if (!w) return null;
    const kanji = (w.worstStroke && w.worstStroke.kanji) || w.kanji || null;
    const entry = kanji && opts.kanjiMap ? opts.kanjiMap[kanji] || null : null;
    return { component: w.g, kanji, stroke: w.worstStroke ? w.worstStroke.stroke : null, message: w.message,
      entry, map: entry && DM ? DM.componentMap(entry) : null };
  }

  /** SVG with the component's strokes (and its weak stroke) highlighted, or null without geometry. */
  function strokeSvg(d) {
    const paths = d.entry && Array.isArray(d.entry.paths) ? d.entry.paths : null;
    const comp = d.map && d.map.components.find((c) => c.g === d.component);
    if (!paths || !comp || paths.length !== d.map.strokeOwner.length) return null;
    const weak = d.stroke ? comp.kanjiStrokes[d.stroke - 1] : -1;
    const own = new Set(comp.kanjiStrokes);
    return `<svg viewBox="0 0 109 109" aria-hidden="true" focusable="false">${paths.map((p, i) =>
      `<path d="${esc(p)}" class="${i === weak ? 'sc-weak' : own.has(i) ? 'sc-comp' : ''}"/>`).join('')}</svg>`;
  }

  const weakSpot = {
    data: weakSpotData,
    mount: makeCard('sc-weakspot', ({ data: d, opts }) => {
      const G = (ch, role) => glyphHtml(opts, ch, { view: 'weakSpot', role });
      if (!d || !d.component) return fallback('Weak spot', 'No weak spots right now. Keep writing and they will show up here.');
      const svg = strokeSvg(d);
      const where = d.kanji ? ` in ${d.kanji}` : '';
      const alt = `${d.component}${where}${d.stroke ? `, stroke ${d.stroke} of this part highlighted` : ' highlighted'}`;
      const pic = svg ? `<figure role="img" aria-label="${esc(alt)}" style="margin:0">${svg}</figure>`
        : `<p class="sc-big sc-glyph" role="img" aria-label="${esc(alt)}">${opts.renderGlyph
          ? `${d.kanji ? G(d.kanji, 'kanji') + ' ' : ''}<mark>${G(d.component, 'component')}</mark>`   // custom glyphs can't be split
          : d.kanji && d.kanji.includes(d.component)
            ? esc(d.kanji).replace(esc(d.component), `<mark>${esc(d.component)}</mark>`) : `<mark>${esc(d.component)}</mark>`}</p>`;
      return `<h3>${esc(d.message || `Weak spot: ${d.component}`)}</h3>${pic}
<p class="sc-note">${d.kanji ? `Seen when writing ${esc(d.kanji)}. ` : ''}A short practice of this part usually fixes it.</p>
<button type="button" class="sc-primary" data-act="practise">Practise ${esc(d.component)}</button>`;
    }, {
      practise: (b, { data: d }, emit) => { emit(EVENTS.practise, { component: d.component, kanji: d.kanji, stroke: d.stroke }); return false; },
    }),
  };

  // ============ 2) contrastDrill (R7) ============
  /** Most urgent due drill → {target, lookalike, note, entries}. */
  function contrastData(storage, opts = {}) {
    const V = lib(opts, 'V15');
    const d = V && V.dueContrasts ? V.dueContrasts(storage, opts.now ?? Date.now())[0] : null;
    if (!d) return null;
    const km = opts.kanjiMap || {};
    return { target: d.target, lookalike: d.lookalike, note: d.note || null, entries: { [d.target]: km[d.target] || null, [d.lookalike]: km[d.lookalike] || null } };
  }
  /** Clue for one kanji from its own data: meaning first, else reading; null when the data has neither. */
  function clueOf(e) {
    const m = meaningOf(e); if (m) return { kind: 'means', text: m };
    const r = readingOf(e); return r ? { kind: 'is read', text: r } : null;
  }

  const contrastDrill = {
    data: contrastData,
    mount: makeCard('sc-contrast', (st) => {
      const d = st.data;
      if (!d || !d.target || !d.lookalike) return fallback('Look-alikes', 'No look-alike drill is due.');
      if (!st.round) {   // shuffled once per mount: which kanji is asked about, and the button order
        const rnd = typeof st.opts.random === 'function' ? st.opts.random : Math.random;
        const both = [d.target, d.lookalike].filter((k) => clueOf(d.entries && d.entries[k]));
        if (!both.length) return fallback('Look-alikes', `${d.target} / ${d.lookalike}: no meaning or reading in the data for this pair.`);
        const ask = both[Math.floor(rnd() * both.length)];
        st.round = { ask, clue: clueOf(d.entries[ask]), order: rnd() < 0.5 ? [d.target, d.lookalike] : [d.lookalike, d.target], chosen: null };
      }
      const r = st.round; const done = r.chosen !== null;
      const opt = (k) => {
        const e = d.entries && d.entries[k];
        const info = done ? `<span class="sc-info">${esc(meaningOf(e) || '—')}</span><span class="sc-info">${esc(readingOf(e) || '—')}</span>` : '';
        return `<button type="button" data-act="pick" data-k="${esc(k)}" aria-pressed="${r.chosen === k}"${done ? ' disabled' : ''}
  aria-label="${esc(k)}${done ? `: ${esc(meaningOf(e) || 'no meaning in data')}, ${esc(readingOf(e) || 'no reading in data')}` : ''}"><span class="sc-big" aria-hidden="true">${glyphHtml(st.opts, k, { view: 'contrastDrill', role: 'choice' })}</span>${info}</button>`;
      };
      const ok = r.chosen === r.ask;
      return `<h3>Which one ${esc(r.clue.kind)} “${esc(r.clue.text)}”?</h3>
<div class="sc-pair" role="group" aria-label="Choose a kanji">${r.order.map(opt).join('')}</div>
<p class="sc-feedback" aria-live="polite">${done ? (ok ? `✓ Right: ${esc(r.ask)}.` : `✗ That was ${esc(r.chosen)}. The answer is ${esc(r.ask)}.`) : ''}</p>
${done && d.note ? `<p class="sc-note">${esc(d.note)}</p>` : ''}`;
    }, {
      pick: (b, st, emit) => {
        if (st.round.chosen !== null) return false;
        st.round.chosen = b.dataset.k;
        emit(EVENTS.contrast, { pair: [st.data.target, st.data.lookalike], chosen: b.dataset.k, correct: b.dataset.k === st.round.ask });
        return true;
      },
    }),
  };

  // ============ 3) contextSentence (R11 + R5) ============
  /** Reading-in-context prompt for `kanji` (SentencesModel prompt object, read-only), or null. */
  function sentenceData(storage, opts = {}) {
    const V = lib(opts, 'V15');
    const k = opts.kanji || (V && V.contextDue ? (V.contextDue(storage, opts.now ?? Date.now())[0] || '').replace(/^ctx:/, '') : '');
    return k && V && V.contextPrompt ? V.contextPrompt(storage, k, { kanjiMap: opts.kanjiMap }) : null;
  }
  /** Romaji → hiragana with the app's own converter when it exists (index.html romajiToHiragana); else unchanged. */
  function toKana(text, opts) {
    const t = String(text || '').trim();
    const conv = (opts && opts.toKana) || (typeof root.romajiToHiragana === 'function' ? root.romajiToHiragana : null);
    const k = conv && /^[a-z]+$/i.test(t) ? conv(t.toLowerCase()) : '';
    return k || t;
  }

  const contextSentence = {
    data: sentenceData,
    toKana,
    mount: makeCard('sc-sentence', (st) => {
      const p = st.data;
      if (!p || !p.sentence) return fallback('Reading in context', 'No example sentence is loaded for this kanji yet.');
      const r = st.result; const PC = lib(st.opts, 'PartialCredit');
      let fb = '';
      if (r) {
        if (r.verdict === 'exact') fb = '✓ Correct.';
        else if (r.verdict === 'near') fb = `Almost: ${esc(r.reasons.map((x) => (PC && PC.LABELS[x]) || x).join(', '))}. Expected ${(r.segments || []).map((s) => (s.ok ? esc(s.text) : `<span class="sc-bad">${esc(s.text)}</span>`)).join('')}.`;
        else if (r.verdict === 'other-reading') fb = `That is another reading of ${esc(p.word)}; here it is ${esc(p.accepted.join(' / '))}.`;
        else fb = `✗ Not quite. It is read ${esc((p.accepted || p.readings || []).join(' / '))}.`;
        if (r.verdict !== 'wrong' && r.readingCertain === false) fb += ' (Any reading of this word was accepted.)';
      }
      const a = p.attribution || { text: '', links: [] };
      // fix2 (B2 QA): the source credit (.sc-attr) sits directly after the sentence it credits,
      // before the English note, the form and the feedback.
      return `<h3>Read the highlighted word</h3>
<p class="sc-sentence" lang="ja">${esc(p.before)}<mark>${esc(p.word)}</mark>${esc(p.after)}</p>
<p class="sc-attr">${esc(a.text)}<br>${(a.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener${/licenses/.test(l.url) ? ' license' : ''}">${esc(l.label)}</a>`).join('')}</p>
${p.en ? `<p class="sc-note" lang="en">${esc(p.en)}</p>` : ''}
<form><label for="sc-in">Reading of ${esc(p.word)} <input id="sc-in" type="text" lang="ja" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(st.input || '')}"${r ? ' readonly' : ''}></label>
<button type="submit" class="sc-primary"${r ? ' disabled' : ''}>Check</button></form>
<p class="sc-feedback" aria-live="polite">${fb}</p>`;
    }, {}, (form, st, emit) => {
      if (st.result) return false;
      const SM = lib(st.opts, 'SentencesModel'); const PC = lib(st.opts, 'PartialCredit');
      const raw = form.querySelector('#sc-in').value;
      if (!raw.trim() || !SM || !PC) return false;
      const input = toKana(raw, st.opts);
      st.input = input; st.result = SM.grade(st.data, input, PC);
      emit(EVENTS.sentence, { kanji: st.data.kanji, input, grade: st.result.grade, verdict: st.result.verdict });
      return true;
    }),
  };

  // ============ 4) leechNotice (R8) ============
  /** Oldest pending leech → {kanji, lapses, times, steps:[{kanji, kind, refresher, scored}], entries}. */
  function leechData(storage, opts = {}) {
    const V = lib(opts, 'V15');
    const l = V && V.leechList ? V.leechList(storage)[0] : null;
    if (!l) return null;
    const steps = V.leechRestudy ? V.leechRestudy(storage, l.kanji, opts.kanjiMap || {}) : [];
    const km = opts.kanjiMap || {};
    return Object.assign({}, l, { steps, entries: Object.fromEntries(steps.map((s) => [s.kanji, km[s.kanji] || null])) });
  }

  const leechNotice = {
    data: leechData,
    mount: makeCard('sc-leech', (st) => {
      const d = st.data;
      if (st.closed) return `<p class="sc-note" aria-live="polite">${esc(st.closed)}</p>`;
      if (!d || !d.kanji) return fallback('Tricky kanji', 'No kanji needs a re-study right now.');
      const step = (s) => {
        const m = meaningOf(d.entries && d.entries[s.kanji]);
        const what = s.kind === 'kanji' ? 'then recall the whole kanji (this one is scored)' : s.refresher ? 'quick refresher of this part' : 'learn this part';
        return `<li><span lang="ja">${glyphHtml(st.opts, s.kanji, { view: 'leechNotice', role: 'step' })}</span>${m ? ` (${esc(m)})` : ''}: ${what}</li>`;
      };
      return `<h3>${esc(d.kanji)} keeps slipping</h3>
<p>You have forgotten ${esc(d.kanji)} ${d.lapses} time${d.lapses === 1 ? '' : 's'}${d.times > 1 ? ', and it has needed a re-study before' : ''}. Reviewing it the same way again rarely helps; re-learning its parts one by one usually does. Your review history is kept.</p>
${d.steps && d.steps.length ? `<p>Re-study plan:</p><ol>${d.steps.map(step).join('')}</ol>` : ''}
<button type="button" class="sc-primary" data-act="restudy">Start re-study</button><button type="button" data-act="dismiss">Dismiss</button>`;
    }, {
      restudy: (b, st, emit) => { emit(EVENTS.restudy, { kanji: st.data.kanji, steps: st.data.steps || [] }); st.closed = 'Re-study started.'; return true; },
      dismiss: (b, st, emit) => { emit(EVENTS.dismiss, { kanji: st.data.kanji }); st.closed = "Dismissed. This kanji's re-study card won't come back."; return true; },
    }),
  };

  /** All four card datas at once (each null when there is nothing to show). Read-only. */
  function build(storage, opts = {}) {
    return { weakSpot: weakSpotData(storage, opts), contrastDrill: contrastData(storage, opts),
      contextSentence: sentenceData(storage, opts), leechNotice: leechData(storage, opts) };
  }

  /**
   * Deferred (b): make the leech card's Dismiss permanent. The cards themselves stay read-only; this one listener
   * (on the document, where the bubbling kanji:leech-dismiss event ends up) stores the dismissal through
   * V15.dismissLeech, so it survives reloads and is included in the v16: export. Returns a function that removes it.
   */
  function persistDismiss(doc, storage, V15) {
    if (!doc || !doc.addEventListener || !storage) return () => {};
    const on = (e) => {
      const V = V15 || (root && root.V15);   // the app's global V15 unless one is passed (tests)
      const k = e && e.detail && e.detail.kanji;
      if (V && V.dismissLeech && k) V.dismissLeech(storage, k);
    };
    doc.addEventListener(EVENTS.dismiss, on);
    return () => doc.removeEventListener(EVENTS.dismiss, on);
  }
  // In the app: install once at load, on the page's own storage.
  if (root && root.document && !root.__scPersistDismiss) {
    let ls = null;
    try { ls = root.localStorage; } catch (e) { ls = null; }   // storage may be blocked (private mode)
    if (ls) root.__scPersistDismiss = persistDismiss(root.document, ls);
  }

  return { EVENTS, CSS, build, weakSpot, contrastDrill, contextSentence, leechNotice, persistDismiss };
});
