/*
 * stats-view.js — v16 R15 progress screen (new file; Botfour decides where to mount it).
 *   const v = StatsView.mount(el, { storage: localStorage });   // → { update(), unmount() }
 * Data: V15.stats(storage, {now, tzOffsetMin}) (read-only; see stats-model.js). This view never writes storage.
 * Styling: scoped to .sv-root, injected once as <style id="sv-style">; colours only from v16-theme / index.html
 * :root variables with fallbacks (text pairs ≥ 4.5:1, tested), labels ≥ 12px, charts have text alternatives.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StatsView = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // Text colour pairs used below (checked by tests/test_views.js): ink/paper, faint-ink/paper, ink/track (small text on the track uses ink).
  const CSS = `
.sv-root{--sv-ink:var(--ink,#23261f);--sv-faint:var(--faint-ink,#7b715c);--sv-paper:var(--paper,#fdfaf5);
  --sv-bar:var(--matcha-deep,#5d7148);--sv-bar2:var(--matcha,#b5c99a);--sv-track:#efeadf;
  font:400 14px var(--ui,Georgia,system-ui,sans-serif);color:var(--sv-ink);background:var(--sv-paper);
  padding:12px;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere}
.sv-root *{box-sizing:border-box}
.sv-root h2{font-size:20px;margin:0 0 8px}
.sv-root h3{font-size:16px;margin:16px 0 6px}
.sv-root .sv-note,.sv-root .sv-small{font-size:13px;color:var(--sv-faint)}
.sv-root .sv-chart{display:flex;align-items:flex-end;gap:2px;height:96px;margin:0;padding:0;list-style:none}
.sv-root .sv-chart li{flex:1 1 0;min-width:0;background:var(--sv-bar);border-radius:2px 2px 0 0}
.sv-root .sv-axis{display:flex;justify-content:space-between;font-size:12px;color:var(--sv-faint)}
.sv-root .sv-row{display:flex;flex-wrap:wrap;gap:12px}
.sv-root .sv-stat{flex:1 1 120px;background:var(--sv-track);border-radius:10px;padding:8px 10px}
.sv-root .sv-stat .sv-small{color:var(--sv-ink)} /* faint is < 4.5:1 on the track tint */
.sv-root .sv-stat b{display:block;font-size:20px}
.sv-root .sv-lv{margin:6px 0}
.sv-root .sv-lvbar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--sv-track)}
.sv-root .sv-lvbar span{display:block;height:100%}
.sv-root .sv-mature{background:var(--sv-bar)} .sv-root .sv-learning{background:var(--sv-bar2)}
.sv-root ul.sv-weak{padding-left:18px;margin:0}
.sv-root .sv-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x) => (x === null || x === undefined ? '—' : Math.round(x * 100) + '%');

  function injectCss(doc) {
    if (doc.getElementById('sv-style')) return;
    const s = doc.createElement('style'); s.id = 'sv-style'; s.textContent = CSS; doc.head.appendChild(s);
  }

  /** Bar chart: bars are aria-hidden; the figure carries a text summary and a screen-reader list. */
  function chart(label, rows, valueOf, textOf) {
    const max = Math.max(1, ...rows.map(valueOf));
    const bars = rows.map((r) => `<li style="height:${Math.round((valueOf(r) / max) * 100)}%"></li>`).join('');
    const total = rows.reduce((a, r) => a + valueOf(r), 0);
    return `<figure role="group" aria-label="${esc(label)}" style="margin:0">
  <ul class="sv-chart" aria-hidden="true">${bars}</ul>
  <div class="sv-axis" aria-hidden="true"><span>${esc(rows[0].day.slice(5))}</span><span>${esc(rows[rows.length - 1].day.slice(5))}</span></div>
  <figcaption class="sv-small">${esc(label)}: ${esc(textOf(total))} in total, peak ${esc(textOf(max === 1 && !total ? 0 : max))}.</figcaption>
  <ul class="sv-sr">${rows.map((r) => `<li>${esc(r.day)}: ${esc(textOf(valueOf(r)))}</li>`).join('')}</ul>
</figure>`;
  }

  function levelRow(name, L) {
    const w = (n) => (L.total ? (n / L.total) * 100 : 0).toFixed(1);
    const text = `${name}: ${L.mature} mature, ${L.learning} learning, ${L.unseen} unseen of ${L.total}`;
    return `<div class="sv-lv"><div class="sv-small">${esc(text)}</div>
  <div class="sv-lvbar" role="img" aria-label="${esc(text)}"><span class="sv-mature" style="width:${w(L.mature)}%"></span><span class="sv-learning" style="width:${w(L.learning)}%"></span></div></div>`;
  }

  /** Whole screen as HTML for one stats object (pure; exported for tests). */
  function render(s) {
    const r = s.retention, k = s.streak;
    const actual7 = r.last7.actual, actual30 = r.last30.actual;
    const minutes = (sec) => `${Math.round(sec / 60)} min`;
    return `<h2>Progress</h2>
<section aria-labelledby="sv-h-f"><h3 id="sv-h-f">Reviews due (30 days)</h3>
${chart('Reviews due per day, today includes overdue', s.forecast, (x) => x.due, (n) => `${n} reviews`)}</section>
<section aria-labelledby="sv-h-r"><h3 id="sv-h-r">Retention</h3><div class="sv-row">
  <div class="sv-stat"><span class="sv-small">Target</span><b>${pct(r.target)}</b></div>
  <div class="sv-stat"><span class="sv-small">Last 7 days (${r.last7.reviews} reviews)</span><b>${pct(actual7)}</b></div>
  <div class="sv-stat"><span class="sv-small">Last 30 days (${r.last30.reviews} reviews)</span><b>${pct(actual30)}</b></div>
</div>${actual30 === null && r.note ? `<p class="sv-note">${esc(r.note)}</p>` : ''}</section>
<section aria-labelledby="sv-h-s"><h3 id="sv-h-s">Streak</h3><div class="sv-row">
  <div class="sv-stat"><span class="sv-small">Current</span><b>${k.current} day${k.current === 1 ? '' : 's'}</b></div>
  <div class="sv-stat"><span class="sv-small">Best</span><b>${k.best} day${k.best === 1 ? '' : 's'}</b></div>
  <div class="sv-stat"><span class="sv-small">Freezes</span><b>${k.freezes}</b></div>
</div>${k.atRisk ? '<p class="sv-note">Study today to keep your streak.</p>' : ''}</section>
<section aria-labelledby="sv-h-l"><h3 id="sv-h-l">JLPT levels</h3>
${s.levels ? Object.keys(s.levels).map((n) => levelRow(n, s.levels[n])).join('') : `<p class="sv-note">${esc(s.levelsNote || 'Level data not loaded yet.')}</p>`}</section>
<section aria-labelledby="sv-h-w"><h3 id="sv-h-w">Weak components</h3>
${s.weak.length ? `<ul class="sv-weak">${s.weak.map((w) => `<li>${esc(w.message || w.g)}</li>`).join('')}</ul>` : '<p class="sv-note">No weak components found.</p>'}</section>
<section aria-labelledby="sv-h-t"><h3 id="sv-h-t">Time studied</h3>
${s.timePerDay ? chart('Active study time per day, last 30 days', s.timePerDay, (x) => x.seconds, minutes) : ''}
<p class="sv-note">${esc(s.timeNote)}</p></section>`;
  }

  /**
   * Mount into `el`. opts: {storage (localStorage), V15 (window.V15), statsOpts (passed to V15.stats)}.
   * update() re-reads stats and re-renders; unmount() empties el and removes the root class.
   */
  function mount(el, opts = {}) {
    const doc = el.ownerDocument;
    const V = opts.V15 || root.V15;
    const storage = opts.storage || root.localStorage;
    injectCss(doc);
    el.classList.add('sv-root');
    el.setAttribute('aria-live', 'polite');
    const update = () => { el.innerHTML = render(V.stats(storage, opts.statsOpts || {})); };
    update();
    return { update, unmount: () => { el.innerHTML = ''; el.classList.remove('sv-root'); el.removeAttribute('aria-live'); } };
  }

  return { CSS, render, mount };
});
