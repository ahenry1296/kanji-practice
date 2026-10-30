/**
 * fading-scaffolds.js — v16 R6: how much writing support to show, faded by demonstrated retrieval strength
 * (pure, no DOM/storage).
 *
 * Research basis:
 *  - Expertise reversal (Kalyuga et al. 2003): guidance that helps novices adds load and hurts once learners
 *    know the material, so support should shrink as competence grows.
 *  - Desirable difficulties / retrieval practice (Bjork 1994; Roediger & Karpicke 2006): producing a form
 *    unaided strengthens memory more than copying it, once retrieval is likely to succeed.
 *  - Heavy colour/stroke cues raised load and hurt L2 kanji recognition (Frontiers 2022, MARKET_RESEARCH §3).
 *  - Fade on evidence, restore on failure: after a lapse the learner is back in the novice zone (also
 *    expertise reversal), so one level of support returns until a clean recall.
 *
 * Levels (one writing box):
 *   0 'dots'        — full guide: stroke-start dots + stroke order (first exposures)
 *   1 'firstStroke' — only the first stroke's start dot/direction
 *   2 'none'        — blank box (component keywords still shown; see below)
 * Strength = FSRS stability in days (how long recall stays ≥90%). <1 day → 0, 1–7 days → 1, ≥7 days → 2.
 * Rank only sets a minimum (Gold → ≥1, Diamond → 2) so a high rank never shows full dots; only a fresh lapse
 * ('again' as the last grade) brings one level back, below that floor if needed.
 *
 * Component-first: components fade on their OWN strength, before the compound. A compound box keeps the
 * component keywords/equation visible ("木 + 木") until every part is itself at 'none'; showing the parts is
 * the radical-first cue, not stroke hand-holding. Hint-on-demand is always available (it caps the grade at
 * 'hard' as today).
 *
 * API (window.FadingScaffolds / require):
 *   levelFor({stability, phase, rank, lastGrade}) → {level: 0|1|2, name, dots, firstStroke, reason}
 *   forKanji(kanjiInput, partInputs[]) → {kanji: <levelFor>, parts: [<levelFor>...], showPartKeywords: boolean}
 *
 * Integration:
 *  - Botty (glue): build inputs from SchedulerModel card (stability, phase, last grade from undo/sched) and
 *    RankModel rank (0..4). Suggest `V15.scaffoldFor(storage, kanji)` returning forKanji(...) for v16int.
 *  - Botfour (UI): map level → guide() mode in makeBox: 0 → 'step' (dots), 1 → first stroke only, 2 → 'blank'.
 *    Use showPartKeywords for the part boxes/equation. Keep the "Hint" button at every level.
 *  - Relation to ProgressModel.fade (lesson flow length, 0..2): independent; this only controls per-box guides.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FadingScaffolds = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMES = ['dots', 'firstStroke', 'none'];
  /** Stability thresholds (days) for levels 1 and 2. */
  const THRESHOLDS = Object.freeze({ firstStroke: 1, none: 7 });
  /** Minimum level by rank (0 none, 1 bronze, 2 silver, 3 gold, 4 diamond). */
  const RANK_FLOOR = [0, 0, 0, 1, 2];

  function levelFor({ stability, phase, rank, lastGrade } = {}) {
    const S = Number(stability);
    let level = 0, reason = 'new';
    if (phase !== 'new' && Number.isFinite(S) && S > 0) {
      level = S >= THRESHOLDS.none ? 2 : S >= THRESHOLDS.firstStroke ? 1 : 0;
      reason = 'strength';
    }
    const r = Math.max(0, Math.min(4, Math.trunc(Number(rank)) || 0));
    if (RANK_FLOOR[r] > level) { level = RANK_FLOOR[r]; reason = 'rank'; }
    // A fresh lapse brings back one level of support, even below the rank floor (the learner just failed).
    if (lastGrade === 'again' && level > 0) { level -= 1; reason = 'lapse'; }
    return { level, name: NAMES[level], dots: level === 0, firstStroke: level === 1, reason };
  }

  function forKanji(kanjiInput, partInputs = []) {
    const parts = partInputs.map(levelFor);
    const kanji = levelFor(kanjiInput);
    // Component-first: a compound may not fade past its weakest part (parts are learned, and faded, first).
    const weakest = parts.length ? Math.min(...parts.map((p) => p.level)) : 2;
    const k = kanji.level > weakest
      ? { level: weakest, name: NAMES[weakest], dots: weakest === 0, firstStroke: weakest === 1, reason: 'parts' }
      : kanji;
    return { kanji: k, parts, showPartKeywords: parts.some((p) => p.level < 2) || k.level < 2 };
  }

  return { NAMES, THRESHOLDS, RANK_FLOOR, levelFor, forKanji };
});
