/*
 * settings-view.js — v16 R16 settings screen (new file; Botfour decides where to mount it).
 *   const v = SettingsView.mount(el, { storage: localStorage });   → { update(), unmount(), loadImportText(text, name) }
 * Every setting goes through the existing V15 API (no new storage keys):
 *   retention + smoothing   → V15.schedSettings / setSchedSettings          (key sched:settings)
 *   vacation                → V15.vacationStatus / startVacation / endVacation, V15.backlogPlan (key vacation)
 *   new kanji/day + budget  → V15.loadSettings / setLoadSettings            (key load:settings)
 *   export                  → V15.exportProgress (JSON) / exportCsv (CSV) → Blob + <a download>
 *   import                  → V15.checkImport (preview) → V15.importProgress(mode merge|replace)
 *   restore backup          → V15.restoreImportBackup (key export:backup, written by importProgress)
 *   reading font (RC16)     → V15.readingFontSetting / setReadingFont / readingFontAvailable (key v16:reading-font, R31)
 *   about                   → SentencesModel.credits(data) + data.meta.sources (license names/links come from the data)
 * Destructive actions (merge/replace import, restore, ending a vacation that shifts review dates) open an inline
 * confirm panel with Confirm / Cancel; nothing is written until Confirm.
 * Listens for window 'v16:vacation-off' (a review ended the vacation) and re-renders.
 * Styling: scoped to .st-root, injected once as <style id="st-style">; targets ≥ 44px; labels ≥ 12px.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SettingsView = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // Text pairs (tests/test_settings_view.js): ink/paper, faint-ink/paper, white/accent, ink/panel (errors are bold ink, not a new colour).
  const CSS = `
.st-root{--st-ink:var(--ink,#23261f);--st-faint:var(--faint-ink,#7b715c);--st-paper:var(--paper,#fdfaf5);
  --st-accent:var(--matcha-deep,#5d7148);--st-panel:#efeadf;
  font:400 14px var(--ui,Georgia,system-ui,sans-serif);color:var(--st-ink);background:var(--st-paper);
  padding:12px;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere}
.st-root *{box-sizing:border-box}
.st-root h2{font-size:20px;margin:0 0 8px} .st-root h3{font-size:16px;margin:16px 0 6px}
.st-root section{border-top:1px solid var(--st-panel);padding:4px 0 8px}
.st-root label{display:flex;align-items:center;gap:8px;min-height:44px;flex-wrap:wrap}
.st-root input[type=range]{flex:1 1 160px;min-height:44px;accent-color:var(--st-accent)}
.st-root input[type=checkbox],.st-root input[type=radio]{width:24px;height:24px;margin:10px;accent-color:var(--st-accent)}
.st-root input[type=number]{font:inherit;width:88px;min-height:44px;padding:4px 8px;color:var(--st-ink);background:#fff;border:1px solid var(--st-faint);border-radius:8px}
.st-root input[type=file]{font:inherit;min-height:44px;max-width:100%}
.st-root button{font:inherit;color:var(--st-ink);background:var(--st-panel);min-height:44px;min-width:44px;cursor:pointer;
  border:0;border-radius:10px;padding:10px 16px;margin:4px 8px 4px 0}
.st-root button.st-primary{background:var(--st-accent);color:#fff}
.st-root button:disabled{opacity:.6;cursor:default}
.st-root .st-note,.st-root .st-small{font-size:12px;color:var(--st-faint);margin:2px 0}
.st-root .st-confirm,.st-root .st-preview{background:var(--st-panel);border-radius:10px;padding:8px 12px;margin:8px 0}
.st-root .st-confirm .st-note,.st-root .st-preview .st-note{color:var(--st-ink)} /* faint is < 4.5:1 on the panel */
.st-root .st-err{color:var(--st-ink);font-weight:600}
.st-root .st-credits{white-space:pre-wrap;font-size:12px}
.st-root a{color:var(--st-accent);display:inline-block;min-height:44px;line-height:44px}
.st-root :focus-visible{outline:3px solid var(--st-accent);outline-offset:2px}`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function injectCss(doc) {
    if (doc.getElementById('st-style')) return;
    const s = doc.createElement('style'); s.id = 'st-style'; s.textContent = CSS; doc.head.appendChild(s);
  }

  /** Default download: Blob + temporary <a download>. Tests pass opts.download instead. */
  function blobDownload(doc, name, text, type) {
    const win = doc.defaultView;
    const url = win.URL.createObjectURL(new win.Blob([text], { type }));
    const a = doc.createElement('a'); a.href = url; a.download = name; a.hidden = true;
    doc.body.appendChild(a); a.click(); a.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 0);
  }

  /** Keys the import would change that already exist with a different value (read-only). */
  function conflictsOf(storage, EM, text) {
    if (!EM) return null;
    const v = EM.validate(text);
    if (!v.ok || !v.data) return null;
    return Object.keys(v.data.keys).filter((k) => { const cur = storage.getItem(k); return cur !== null && cur !== v.data.keys[k]; }).length;
  }

  // ---------- section renderers (pure: state in, HTML out) ----------

  function retentionHtml(s) {
    const pct = Math.round(s.retention * 100);
    return `<section aria-labelledby="st-h-ret"><h3 id="st-h-ret">Review strength</h3>
<label for="st-ret">Target recall: <output id="st-ret-out" for="st-ret">${pct}%</output></label>
<input id="st-ret" type="range" min="80" max="95" step="1" value="${pct}" aria-describedby="st-ret-help" style="width:100%">
<p id="st-ret-help" class="st-note">Higher means you remember more, but you get more reviews each day. Lower means fewer reviews, but you forget more often. Changes apply to future reviews only.</p>
<label><input id="st-smooth" type="checkbox"${s.smoothing ? ' checked' : ''}> Smooth the review load (spread busy days out)</label></section>`;
  }

  function vacationHtml(vs, plan, pending) {
    const state = vs.active ? `On for ${plural(vs.days, 'day')}.` : 'Off.';
    return `<section aria-labelledby="st-h-vac"><h3 id="st-h-vac">Vacation mode</h3>
<p aria-live="polite">Vacation mode: <strong id="st-vac-state">${state}</strong></p>
<p class="st-note">While on, nothing new is scheduled. Doing any review ends it automatically and moves your review dates later by the days you were away, so you come back to no pile-up.${plan.overdue ? ` Right now ${plural(plan.overdue, 'review')} ${plan.overdue === 1 ? 'is' : 'are'} overdue: about ${plural(plan.daysToClear, 'day')} to clear at your daily budget.` : ''}</p>
${pending && pending.kind === 'vacation-off' ? '' : `<button type="button" data-act="${vs.active ? 'vacation-off' : 'vacation-on'}" aria-pressed="${vs.active}">${vs.active ? 'Turn vacation off' : 'Turn vacation on'}</button>`}</section>`;
  }

  function loadHtml(ls) {
    return `<section aria-labelledby="st-h-load"><h3 id="st-h-load">Daily load</h3>
<label for="st-new">New kanji per day (max) <input id="st-new" type="number" inputmode="numeric" min="0" max="50" step="1" value="${ls.newPerDayMax}"></label>
<label for="st-min">Study budget, minutes per day <input id="st-min" type="number" inputmode="numeric" min="5" max="240" step="1" value="${ls.minutesPerDay}"></label>
<p class="st-note">New kanji pause on days your reviews already fill the budget.</p></section>`;
  }

  function dataHtml(ui, hasBackup) {
    const p = ui.preview;
    let preview = '';
    if (p) {
      preview = `<div class="st-preview" role="status" aria-live="polite"><p><strong>${esc(p.name)}</strong></p>${p.ok
        ? `<p class="st-note">${plural(p.summary.kanji, 'kanji record')}, ${plural(p.summary.keys, 'item')} in total${p.summary.exportedAt ? `, exported ${esc(String(p.summary.exportedAt).slice(0, 10))}` : ''}.</p>
<p class="st-note">${p.conflicts == null ? '' : `${plural(p.conflicts, 'item')} differ from what is on this device.`}</p>
${p.warnings.length ? `<ul class="st-note">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<fieldset style="border:0;padding:0;margin:0"><legend>How to import</legend>
<label><input type="radio" name="st-mode" value="merge"${ui.mode === 'merge' ? ' checked' : ''}> Merge: keep the newer progress for each kanji</label>
<label><input type="radio" name="st-mode" value="replace"${ui.mode === 'replace' ? ' checked' : ''}> Replace: this device's progress becomes the file's</label></fieldset>
<button type="button" class="st-primary" data-act="import">Import…</button>`
        : `<p class="st-err">This file can't be imported:</p><ul class="st-err">${p.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`}
<button type="button" data-act="clear-preview">Close preview</button></div>`;
    }
    return `<section aria-labelledby="st-h-data"><h3 id="st-h-data">Your data</h3>
<button type="button" data-act="export-json">Download progress (JSON)</button><button type="button" data-act="export-csv">Download kanji list (CSV)</button>
<p class="st-note">JSON restores everything on another device. CSV is a spreadsheet of your kanji (rank, next review, stability, lapses).</p>
<label for="st-file">Import a progress file <input id="st-file" type="file" accept=".json,application/json"></label>
${preview}
<button type="button" data-act="restore"${hasBackup ? '' : ' disabled'}>Undo last import</button>
<p class="st-note">${hasBackup ? 'Puts back your progress exactly as it was before the last import.' : 'No import backup on this device.'}</p>
${ui.message ? `<p role="status" aria-live="polite">${esc(ui.message)}</p>` : ''}</section>`;
  }

  /** Inline confirm panel (Confirm / Cancel); nothing is written until Confirm. */
  function confirmHtml(pending) {
    if (!pending) return '';
    return `<div class="st-confirm" role="alertdialog" aria-labelledby="st-cf-t" aria-describedby="st-cf-d">
<p id="st-cf-t"><strong>${esc(pending.title)}</strong></p><p id="st-cf-d" class="st-note">${esc(pending.text)}</p>
<button type="button" class="st-primary" data-act="confirm">${esc(pending.okLabel)}</button><button type="button" data-act="cancel">Cancel</button></div>`;
  }

  /**
   * RC16 reading-font settings (Botfive; R31-reading-font.md, B4 ORDER.rc16-reading-font.md). Mode select Off / Fixed /
   * Vary; for Fixed a face picker that lists only the faces this device has (V15.readingFontAvailable). If it has none,
   * a note says the app font is used. Display only: same setting as B4's Reading font box in v16-views.js (ids differ:
   * st-rf-* here, v16-rf-* there). Labels come from V15.READING_FACES (app data, but escaped anyway).
   * No duplicate controls: when B4's box (.v16-rfont, v16-views.js settingsWithFont) shares this view's parent pane, this
   * section is not rendered, so the in-app pane shows one Reading font control; standalone SettingsView shows this one.
   */
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function readingFontHtml(V, st, avail) {
    const opt = (v, label, cur) => `<option value="${escHtml(v)}"${v === cur ? ' selected' : ''}>${escHtml(label)}</option>`;
    const modes = [['off', 'Off'], ['fixed', 'Fixed'], ['vary', 'Vary']].map(([v, l]) => opt(v, l, st.mode)).join('');
    let faceRow = '';
    if (st.mode === 'fixed') {
      faceRow = avail.length
        ? `<label for="st-rf-face">Font <select id="st-rf-face">${avail.map((f) => opt(f, V.READING_FACES[f].label, st.face)).join('')}</select></label>`
        : '<p class="st-note" id="st-rf-none">This device has none of the extra fonts, so the app font is used.</p>';
    }
    return `<section aria-labelledby="st-h-rf"><h3 id="st-h-rf">Reading font</h3>
<p class="st-note">The font of the kanji in reading questions. Vary rotates fonts on review kanji. Answers and reviews stay the same.</p>
<label for="st-rf-mode">Reading font <select id="st-rf-mode">${modes}</select></label>${faceRow}</section>`;
  }
  /** True when B4's Reading font box is a direct child of this view or of its parent (B4's place() moves it between them). */
  const hasB4ReadingFont = (el) => !!(el.querySelector(':scope > .v16-rfont') || (el.parentNode && el.parentNode.querySelector(':scope > .v16-rfont')));
  /** Faces available on this device, in READING_FACES order. */
  const readingFaces = (V, doc) => Object.keys(V.READING_FACES).filter((f) => V.readingFontAvailable(f, doc));

  function aboutHtml(data, SM) {
    if (!data || !data.meta || !Array.isArray(data.meta.sources)) return `<section aria-labelledby="st-h-about"><h3 id="st-h-about">About</h3><p class="st-note">Credits load with the example sentences.</p></section>`;
    const credits = SM && SM.credits ? SM.credits(data) : '';
    const links = data.meta.sources.map((s) => `<li>${esc(s.name)}: <a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.url)}</a> — license <a href="${esc(s.licenseUrl)}" rel="noopener license" target="_blank">${esc(s.license)}</a></li>`).join('');
    return `<section aria-labelledby="st-h-about"><h3 id="st-h-about">About</h3>
<p class="st-credits">${esc(credits)}</p><ul>${links}</ul></section>`;
  }

  // ---------- mount ----------

  function mount(el, opts = {}) {
    const doc = el.ownerDocument; const win = doc.defaultView || root;
    const V = opts.V15 || root.V15;
    const storage = opts.storage || win.localStorage;
    const EM = opts.ExportModel || root.ExportModel || (typeof require === 'function' ? require('./export-model.js') : null);
    const SM = opts.SentencesModel || root.SentencesModel;
    const now = () => (typeof opts.now === 'function' ? opts.now() : (opts.now ?? Date.now()));
    const tz = opts.tzOffsetMin == null ? {} : { tzOffsetMin: opts.tzOffsetMin };
    const creditsData = () => opts.creditsData || ((win.CONTEXT_SENTENCES || root.CONTEXT_SENTENCES || {}).N5) || null;
    const download = opts.download || ((name, text, type) => blobDownload(doc, name, text, type));
    const ui = { pending: null, preview: null, importText: null, mode: 'merge', message: '' };

    injectCss(doc);
    el.classList.add('st-root');

    function update() {
      const vs = V.vacationStatus(storage, now());
      el.innerHTML = `<h2>Settings</h2>${confirmHtml(ui.pending)}${retentionHtml(V.schedSettings(storage))}
${vacationHtml(vs, V.backlogPlan(storage, now(), tz), ui.pending)}${loadHtml(V.loadSettings(storage))}
${V.readingFontSetting && !hasB4ReadingFont(el) ? readingFontHtml(V, V.readingFontSetting(storage), readingFaces(V, doc)) : ''}
${dataHtml(ui, storage.getItem(EM ? EM.BACKUP_KEY : 'export:backup') !== null)}${aboutHtml(creditsData(), SM)}`;
      const cf = el.querySelector('.st-confirm [data-act="cancel"]'); if (cf && cf.focus) cf.focus();
    }

    /** Show the read-only preview of an import file (no writes). */
    function loadImportText(text, name = 'file') {
      const c = V.checkImport(text);
      ui.importText = c.ok ? text : null;
      ui.preview = { name, ok: c.ok, errors: c.errors || [], warnings: c.warnings || [], summary: c.summary, conflicts: c.ok ? conflictsOf(storage, EM, text) : null };
      ui.message = ''; update();
    }

    /** Ask before a destructive action; `run` is called only on Confirm. */
    function ask(kind, title, text, okLabel, run) { ui.pending = { kind, title, text, okLabel, run }; update(); }

    // B5 polish: file names use the learner's local (JST) day; toISOString() alone gives the UTC day, which is
    // yesterday from 00:00 to 08:59 JST. tzOffsetMin (minutes east of UTC) overrides the runtime offset in tests.
    const day = () => {
      const t = now();
      const off = opts.tzOffsetMin == null ? -new Date(t).getTimezoneOffset() : opts.tzOffsetMin;
      return new Date(t + off * 60e3).toISOString().slice(0, 10);
    };
    const actions = {
      'vacation-on': () => { V.startVacation(storage, now()); update(); },
      'vacation-off': () => {
        const vs = V.vacationStatus(storage, now());
        const off = () => { const r = V.endVacation(storage, now(), tz); ui.message = r.days ? `Vacation off: ${plural(r.shifted, 'review')} moved ${plural(r.days, 'day')} later.` : 'Vacation off.'; };
        if (vs.days < 1) { off(); update(); return; }          // same day: endVacation changes nothing else
        ask('vacation-off', 'Turn vacation off?', `Your review dates will move ${plural(vs.days, 'day')} later and your streak is kept.`, 'Turn off', off);
      },
      'export-json': () => download(`kanji-progress-${day()}.json`, V.exportProgress(storage, now()), 'application/json'),
      'export-csv': () => download(`kanji-progress-${day()}.csv`, V.exportCsv(storage), 'text/csv'),
      'clear-preview': () => { ui.preview = null; ui.importText = null; update(); },
      import: () => {
        const mode = ui.mode; const text = ui.importText;
        ask('import-' + mode, mode === 'replace' ? 'Replace your progress?' : 'Merge this file?',
          mode === 'replace' ? 'Progress on this device is replaced by the file. A backup is kept so you can undo.'
            : 'Newer progress from the file is added to this device. A backup is kept so you can undo.',
          mode === 'replace' ? 'Replace' : 'Merge', () => {
            const r = V.importProgress(storage, text, { mode });
            ui.preview = null; ui.importText = null;
            ui.message = r.ok ? `Imported (${mode}): ${plural(r.written, 'item')} written, ${r.removed} removed. Reload the app to see it.` : `Import failed: ${r.errors.join('; ')}`;
          });
      },
      restore: () => ask('restore', 'Undo the last import?', 'Your progress goes back to exactly how it was before that import.', 'Undo import', () => {
        ui.message = V.restoreImportBackup(storage) ? 'Previous progress restored. Reload the app to see it.' : 'No backup found.';
      }),
      confirm: () => { const p = ui.pending; ui.pending = null; if (p) p.run(); update(); },
      cancel: () => { ui.pending = null; update(); },
    };

    function onClick(e) {
      const b = e.target.closest && e.target.closest('button[data-act]');
      if (b && el.contains(b) && !b.disabled && actions[b.dataset.act]) actions[b.dataset.act]();
    }
    function onInput(e) {   // live label only; the value is saved on 'change'
      if (e.target.id === 'st-ret') { const o = el.querySelector('#st-ret-out'); if (o) o.textContent = e.target.value + '%'; }
    }
    function onChange(e) {
      const t = e.target;
      if (t.id === 'st-ret') V.setSchedSettings(storage, { retention: Number(t.value) / 100 });
      else if (t.id === 'st-smooth') V.setSchedSettings(storage, { smoothing: t.checked });
      else if (t.id === 'st-new') V.setLoadSettings(storage, { newPerDayMax: Math.round(Number(t.value)) });
      else if (t.id === 'st-min') V.setLoadSettings(storage, { minutesPerDay: Math.round(Number(t.value)) });
      else if (t.id === 'st-rf-mode') {   // RC17 F7: a mode change never writes a face; only a pick in #st-rf-face does
        V.setReadingFont(storage, { mode: t.value });   // (readingFontFor already falls back to an available face)
      } else if (t.id === 'st-rf-face') V.setReadingFont(storage, { face: t.value });
      else if (t.name === 'st-mode') { ui.mode = t.value === 'replace' ? 'replace' : 'merge'; return; }
      else if (t.id === 'st-file') {
        const f = t.files && t.files[0]; if (!f) return;
        const r = new win.FileReader(); r.onload = () => loadImportText(String(r.result), f.name); r.readAsText(f); return;
      } else return;
      update();   // show the sanitized value actually saved
    }
    const onVacationOff = () => update();

    el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('change', onChange);
    win.addEventListener('v16:vacation-off', onVacationOff);
    update();
    return {
      update, loadImportText,
      unmount() {
        el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); el.removeEventListener('change', onChange);
        win.removeEventListener('v16:vacation-off', onVacationOff);
        el.innerHTML = ''; el.classList.remove('st-root');
      },
    };
  }

  return { CSS, mount };
});
