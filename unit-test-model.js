/*
 * unit-test-model.js — whole-set test over one READING_TESTS unit (spec: TEST_MODELS.md, Unit test).
 * Pure functions. Browser: window.UnitTestModel. Node: require('./unit-test-model.js').
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UnitTestModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Pass mark: share of the unit's questions answered correctly (TEST_MODELS.md, justification). */
  const PASS_MARK = 0.8;

  /** The unit {unit, kanji, questions} of a level by 1-based number, or null. */
  function getUnit(tests, level, unitNumber) {
    return ((tests.levels || {})[level] || []).find((u) => u.unit === unitNumber) || null;
  }

  /**
   * Score a whole unit. answers maps kanji → the hiragana the learner chose or typed; a missing answer is a miss.
   * Returns {total, score, ratio, misses: [{kanji, w, expected, given}], passed}.
   */
  function scoreUnit(unit, answers) {
    const misses = [];
    for (const q of unit.questions) {
      const given = Object.prototype.hasOwnProperty.call(answers, q.kanji) ? answers[q.kanji] : null;
      if (given !== q.answer) misses.push({ kanji: q.kanji, w: q.w, expected: q.answer, given });
    }
    const total = unit.questions.length;
    const score = total - misses.length;
    const ratio = total ? score / total : 0;
    return { total, score, ratio, misses, passed: total > 0 && ratio >= PASS_MARK };
  }

  return { PASS_MARK, getUnit, scoreUnit };
});
