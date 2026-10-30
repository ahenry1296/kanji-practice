/*
 * components-view.js — v16 R15 component explorer (new file; Botfour decides where to mount it).
 *   const v = ComponentsView.mount(el, { storage: localStorage, kanjiMap: DATA.kanji, pairs });
 *   → { update(), select(component), unmount() }
 * Grid of components (V15.componentFamilies) → family list for the chosen one (kanji + status) → "Learn this
 * family" calls V15.pickNewLesson(storage, [], {mode:'family', component, ...}) and dispatches on `el`:
 *   CustomEvent('kanji:family-lesson', {bubbles:true, detail:{component, lesson}})   // lesson = pickNewLesson result
 * Botfour decides how to start the lesson. The view itself never writes storage.
 * Styling: scoped to .cv-root, injected once as <style id="cv-style">; targets ≥ 44px; labels ≥ 12px.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComponentsView = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const EVENT = 'kanji:family-lesson';
  const STATUS_TEXT = { unseen: 'unseen', learning: 'learning', mature: 'mature' };
  // Text pairs (tests/test_views.js): ink/paper, faint-ink/paper, white/accent (button), ink/chip (small text on chips uses ink).
  const CSS = `
.cv-root{--cv-ink:var(--ink,#23261f);--cv-faint:var(--faint-ink,#7b715c);--cv-paper:var(--paper,#fdfaf5);
  --cv-accent:var(--matcha-deep,#5d7148);--cv-chip:#efeadf;
  font:400 14px var(--ui,Georgia,system-ui,sans-serif);color:var(--cv-ink);background:var(--cv-paper);
  padding:12px;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere}
.cv-root *{box-sizing:border-box}
.cv-root h2{font-size:20px;margin:0 0 8px} .cv-root h3{font-size:16px;margin:12px 0 6px}
.cv-root .cv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;margin:0;padding:0;list-style:none}
.cv-root button{font:inherit;color:var(--cv-ink);min-height:44px;min-width:44px;cursor:pointer;border-radius:10px}
.cv-root .cv-comp{width:100%;background:var(--cv-chip);border:2px solid transparent;padding:4px;display:flex;flex-direction:column;align-items:center}
.cv-root .cv-comp[aria-pressed="true"]{border-color:var(--cv-accent)}
.cv-root .cv-glyph{font-size:24px;line-height:1.2}
.cv-root .cv-small,.cv-root .cv-note{font-size:12px;color:var(--cv-faint)}
.cv-root .cv-comp .cv-small,.cv-root .cv-list .cv-small{color:var(--cv-ink)} /* faint is < 4.5:1 on chips */
.cv-root .cv-list{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.cv-root .cv-list li{min-width:64px;padding:6px 8px;background:var(--cv-chip);border-radius:8px;text-align:center}
.cv-root .cv-list .cv-k{font-size:24px;display:block}
.cv-root .cv-learn{background:var(--cv-accent);color:#fff;border:0;padding:10px 16px;margin-top:10px}
.cv-root .cv-learn:disabled{opacity:.6;cursor:default}
.cv-root :focus-visible{outline:3px solid var(--cv-accent);outline-offset:2px}`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** CDP codes have no glyph; show the meaning instead (never an invented one). */
  const glyphOf = (f) => (/^CDP-/.test(f.component) ? '?' : f.component);

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
  function injectCss(doc) {
    if (doc.getElementById('cv-style')) return;
    const s = doc.createElement('style'); s.id = 'cv-style'; s.textContent = CSS; doc.head.appendChild(s);
  }

  function gridHtml(fams, selected, opts) {
    return `<ul class="cv-grid">${fams.map((f) => {
      const label = `${f.meaning || f.component}: ${f.kanji.length} kanji, ${f.counts.unseen} unseen`;
      return `<li><button type="button" class="cv-comp" data-comp="${esc(f.component)}" aria-pressed="${f.component === selected}" aria-label="${esc(label)}">
  <span class="cv-glyph" aria-hidden="true">${opts && opts.renderGlyph ? glyphHtml(opts, f.component, { view: 'components', role: 'family' }) : esc(glyphOf(f))}</span><span class="cv-small" aria-hidden="true">${f.kanji.length}</span></button></li>`;
    }).join('')}</ul>`;
  }

  function familyHtml(f, opts) {
    const unseen = f.counts.unseen;
    return `<section aria-labelledby="cv-h-fam"><h3 id="cv-h-fam">${esc(f.component)} — ${f.meaning ? esc(f.meaning) : '<span class="cv-note">no meaning in the data</span>'}</h3>
<p class="cv-small">${f.counts.mature} mature, ${f.counts.learning} learning, ${unseen} unseen</p>
<ul class="cv-list">${f.kanji.map((e) => `<li aria-label="${esc(`${e.k}, ${e.level || 'no level'}, ${STATUS_TEXT[e.status]}`)}"><span class="cv-k" aria-hidden="true">${glyphHtml(opts, e.k, { view: 'components', role: 'kanji' })}</span><span class="cv-small" aria-hidden="true">${esc(e.level || '')} · ${STATUS_TEXT[e.status]}</span></li>`).join('')}</ul>
<button type="button" class="cv-learn" data-learn="${esc(f.component)}" ${unseen ? '' : 'disabled'} aria-label="Learn this family: ${unseen} unseen kanji with ${esc(f.component)}">Learn this family</button>
</section>`;
  }

  /**
   * Mount into `el`. opts: {storage, V15, kanjiMap, catalog, pairs, size (5), minSize (2), renderGlyph (see glyphHtml)}.
   * Returns {update, select, unmount}.
   */
  function mount(el, opts = {}) {
    const doc = el.ownerDocument;
    const V = opts.V15 || root.V15;
    const storage = opts.storage || root.localStorage;
    const dataOpts = { kanjiMap: opts.kanjiMap, catalog: opts.catalog };
    let selected = null;
    injectCss(doc);
    el.classList.add('cv-root');

    const update = () => {
      const fams = V.componentFamilies(storage, Object.assign({ minSize: opts.minSize || 2 }, dataOpts));
      const fam = selected ? V.componentFamily(storage, selected, dataOpts) : null;
      el.innerHTML = `<h2>Components</h2>
<p class="cv-small">Pick a component to see every kanji that uses it.</p>
${gridHtml(fams, selected, opts)}${fam ? familyHtml(fam, opts) : ''}`;
    };
    const select = (g) => { selected = g; update(); };
    const learn = (g) => {
      const lesson = V.pickNewLesson(storage, [], Object.assign({ mode: 'family', component: g, pairs: opts.pairs || [], size: opts.size || 5 }, dataOpts));
      el.dispatchEvent(new (doc.defaultView.CustomEvent)(EVENT, { bubbles: true, detail: { component: g, lesson } }));
      return lesson;
    };
    const onClick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button');
      if (!b || !el.contains(b)) return;
      if (b.dataset.comp) select(b.dataset.comp);
      else if (b.dataset.learn) learn(b.dataset.learn);
    };
    el.addEventListener('click', onClick);
    update();
    return { update, select, learn, unmount: () => { el.removeEventListener('click', onClick); el.innerHTML = ''; el.classList.remove('cv-root'); } };
  }

  return { EVENT, CSS, mount };
});
