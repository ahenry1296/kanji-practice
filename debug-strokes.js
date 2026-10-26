/**
 * debug-strokes.js: opt-in stroke capture for field bug reports (HOTFIX-debug-strokes).
 *
 * Open the app with ?debug=strokes. On every rejected or near-miss ('Almost') stroke this keeps the last stroke's
 * raw points (pad-normalised, as Pad.pt() records them), the pad's CSS size, and the verdict's reasons, and shows a
 * small 'Copy stroke data' button that copies that record as JSON to the clipboard.
 *
 * Without the flag this file does nothing: it adds no DOM, wraps nothing and changes no verdict.
 */
(function () {
  'use strict';

  /** True when the page URL asks for stroke debugging (?debug=strokes, also inside a comma list). */
  function debugStrokesEnabled(search) {
    const value = new URLSearchParams(search).get('debug') || '';
    return value.split(',').includes('strokes');
  }

  /** True for a near miss: the verdict v15-ui.js shows as 'Almost' / free retry (V15.classifyReject 'borderline'). */
  function isAlmost(verdict) {
    return !!(typeof V15 !== 'undefined' && V15.classifyReject && V15.classifyReject(verdict) === 'borderline');
  }

  /** The record copied to the clipboard for one judged stroke. */
  function strokeRecord(k, i, stroke, level, verdict, pad) {
    const canvas = pad && pad.cv;
    return {
      kanji: k && k.k,
      strokeIndex: i,
      level: level,
      pad: canvas ? { width: canvas.offsetWidth, height: canvas.offsetHeight } : null,
      points: (stroke.pts || []).map((p) => ({ x: p.x, y: p.y, p: p.p })),
      verdict: {
        ok: !!verdict.ok,
        almost: isAlmost(verdict),
        msg: verdict.msg || null,
        shape: verdict.shape || null,
        m: verdict.m || null,
        redoFirst: !!verdict.redoFirst,
        penLiftCurl: !!verdict.penLiftCurl,
      },
      at: new Date().toISOString(),
    };
  }

  /** The 'Copy stroke data' button, created once on first need. */
  function copyButton(state) {
    if (state.button) {
      return state.button;
    }
    const button = document.createElement('button');
    button.id = 'debugStrokesCopy';
    button.type = 'button';
    button.textContent = 'Copy stroke data';
    button.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;font:12px sans-serif;padding:4px 8px;';
    button.addEventListener('click', () => {
      const json = JSON.stringify(state.last, null, 1);
      navigator.clipboard.writeText(json).then(
        () => { button.textContent = 'Copied'; },
        () => { window.prompt('Stroke data', json); });
      setTimeout(() => { button.textContent = 'Copy stroke data'; }, 1500);
    });
    document.body.appendChild(button);
    state.button = button;
    return button;
  }

  /** Wrap the global checkStroke so every reject or near miss is kept; verdicts pass through unchanged. */
  function install() {
    if (typeof window.checkStroke !== 'function') {
      return;
    }
    const state = { last: null, button: null };
    const original = window.checkStroke;
    window.checkStroke = function (k, i, stroke, level, prev) {
      const rawPoints = stroke && stroke.pts ? stroke.pts.slice() : [];   // before any curl trim
      const verdict = original.apply(this, arguments);
      if (!verdict.ok || isAlmost(verdict)) {
        const pad = typeof boxes !== 'undefined' && boxes[cur] ? boxes[cur].pad : null;
        state.last = strokeRecord(k, i, { pts: rawPoints }, level, verdict, pad);
        copyButton(state);
      }
      return verdict;
    };
    window.DebugStrokes = { state: state };
  }

  if (typeof window !== 'undefined' && debugStrokesEnabled(window.location.search)) {
    window.addEventListener('DOMContentLoaded', install);
  }
  if (typeof module !== 'undefined') {
    module.exports = { debugStrokesEnabled: debugStrokesEnabled, strokeRecord: strokeRecord };
  }
})();
