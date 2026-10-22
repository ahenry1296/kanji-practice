/*
 * placement-model.js — placement test over PLACEMENT_POOLS (spec: TEST_MODELS.md, Placement).
 * Pure functions; the state is a plain object and every call returns a new one.
 * Browser: window.PlacementModel (load rank-model.js first). Node: require('./placement-model.js').
 */
(function (root, factory) {
  const RankModel = typeof module === 'object' && module.exports ? require('./rank-model.js') : root.RankModel;
  const api = factory(RankModel);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlacementModel = api;
})(typeof self !== 'undefined' ? self : this, function (RankModel) {
  'use strict';

  const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
  /** Questions asked per level, spread evenly over the level's pool (pool order = lesson bands). */
  const QUESTIONS_PER_LEVEL = 10;
  /** Share of correct answers in a level needed to move up. */
  const PASS_RATIO = 0.8;
  /** Misses in one level that end the test: with 10 questions, 3 misses make 80 % unreachable. */
  const MAX_MISSES_PER_LEVEL = Math.round(QUESTIONS_PER_LEVEL * (1 - PASS_RATIO)) + 1;

  /** Kanji asked for one level: every (pool size / QUESTIONS_PER_LEVEL)-th pool entry, so every band is sampled. */
  function questionsFor(pools, level) {
    const pool = ((pools.levels || {})[level] || {}).kanji || [];
    const n = Math.min(QUESTIONS_PER_LEVEL, pool.length);
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(pool[Math.floor((i * pool.length) / n)].c);
    return out;
  }

  /** Start a test at N5. */
  function start(pools) {
    return { level: 'N5', queue: questionsFor(pools, 'N5'), asked: 0, correct: 0, misses: 0,
             answers: [], passedLevels: [], finished: false, stopReason: null };
  }

  /** Next question {level, kanji}, or null when the test is finished. */
  function nextQuestion(state) {
    return state.finished ? null : { level: state.level, kanji: state.queue[state.asked] };
  }

  /** Record the answer to the current question and advance (moving up a level or stopping as needed). */
  function answer(pools, state, correct) {
    if (state.finished) return state;
    const kanji = state.queue[state.asked];
    const s = Object.assign({}, state, {
      asked: state.asked + 1,
      correct: state.correct + (correct ? 1 : 0),
      misses: state.misses + (correct ? 0 : 1),
      answers: state.answers.concat([{ level: state.level, kanji, correct: Boolean(correct) }]),
    });
    if (s.misses >= MAX_MISSES_PER_LEVEL) return Object.assign(s, { finished: true, stopReason: 'misses' });
    if (s.asked < s.queue.length) return s;
    if (s.correct / s.queue.length < PASS_RATIO) return Object.assign(s, { finished: true, stopReason: 'below80' });
    const passedLevels = s.passedLevels.concat([s.level]);
    const next = LEVELS[LEVELS.indexOf(s.level) + 1];
    if (!next) return Object.assign(s, { passedLevels, finished: true, stopReason: 'top' });
    return Object.assign(s, { passedLevels, level: next, queue: questionsFor(pools, next), asked: 0, correct: 0, misses: 0 });
  }

  /**
   * Result: estimated level = the level being worked on when the test ended (the first level not passed,
   * or N1 when everything passed); passedLevels; known = kanji answered correctly, in order.
   */
  function result(state) {
    return { finished: state.finished, estimatedLevel: state.level, passedLevels: state.passedLevels.slice(),
             known: state.answers.filter((a) => a.correct).map((a) => a.kanji), stopReason: state.stopReason };
  }

  /** Mark every known kanji at least bronze; never lowers a rank and keeps all other kanji (safe to retake). */
  function applyResult(rankState, res) {
    const kanji = Object.assign({}, rankState.kanji);
    for (const k of res.known) {
      const record = RankModel.getKanji(rankState, k);
      if (record.rank < RankModel.RANK.bronze) kanji[k] = Object.assign({}, record, { rank: RankModel.RANK.bronze });
    }
    return { version: RankModel.STATE_VERSION, kanji };
  }

  return { LEVELS, QUESTIONS_PER_LEVEL, PASS_RATIO, MAX_MISSES_PER_LEVEL,
           questionsFor, start, nextQuestion, answer, result, applyResult };
});
