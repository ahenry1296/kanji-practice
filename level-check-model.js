/*
 * level-check-model.js — quiz the studied kanji (rank >= 1) and apply rank-model transitions
 * (spec: TEST_MODELS.md, Level check; a correct answer passes the next stage). Pure functions.
 * Browser: window.LevelCheckModel (load rank-model.js and reading-answer.js first). Node: require('./level-check-model.js').
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const RankModel = isNode ? require('./rank-model.js') : root.RankModel;
  const ReadingAnswer = isNode ? require('./reading-answer.js') : root.ReadingAnswer;
  const api = factory(RankModel, ReadingAnswer);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LevelCheckModel = api;
})(typeof self !== 'undefined' ? self : this, function (RankModel, ReadingAnswer) {
  'use strict';

  /** Default number of kanji per check. */
  const DEFAULT_SIZE = 20;
  /** Result outcomes and the rank-model event each one applies (correct: see eventFor). */
  const OUTCOME_EVENT = {
    correct: { type: 'pass' },
    readingMiss: { type: 'readingMiss' },
    writingBorderline: { type: 'writingBorderline' },
    writingClearFail: { type: 'writingClearFail' },
    wrongKanji: { type: 'wrongKanji' },
    override: { type: 'override' },
  };

  /**
   * Kanji to quiz: studied (rank >= 1), optionally only those listed in `only` (e.g. one level's kanji),
   * lowest rank first, then by code point; at most `size`. Each item says which kind of question to ask:
   * reading below silver, writing from silver up (writing unlocked). With readingWords ({kanji: words}) each reading
   * item carries its drill word (irregular skipped, common first).
   */
  function selectKanji(rankState, { size = DEFAULT_SIZE, only = null, readingWords = null } = {}) {
    const allowed = only ? new Set(only) : null;
    return Object.keys(rankState.kanji || {})
      .map((k) => ({ kanji: k, rank: RankModel.getKanji(rankState, k).rank }))
      .filter((x) => x.rank >= RankModel.RANK.bronze && (!allowed || allowed.has(x.kanji)))
      .sort((a, b) => a.rank - b.rank || (a.kanji < b.kanji ? -1 : a.kanji > b.kanji ? 1 : 0))
      .slice(0, size)
      .map((x) => ({ kanji: x.kanji, rank: x.rank, kind: x.rank >= RankModel.RANK.silver ? 'writing' : 'reading' }))
      .map((x) => (readingWords && x.kind === 'reading'
        ? Object.assign(x, { word: ReadingAnswer.drillWord(readingWords[x.kanji] || []) }) : x));
  }

  /**
   * v16 R30 (V16_PLAN #6, "interleaved sets ... in review and the level check"; F4 Rohrer & Taylor 2007):
   * reorder a selected check so it is interleaved instead of blocked. selectKanji sorts by rank then code point,
   * so a check is all reading items, then all writing items, in code-point order. Interleaving puts each item's
   * look-alike right after it (contrast, like PracticeModel.mixedReview), then a kanji sharing a component with the
   * previous one (休 then 体), and otherwise alternates reading and writing. Ties keep selectKanji's order.
   * Order only: the same items (same objects, no new fields) and one item per kanji, so applyResults gives exactly
   * the same rank changes. Deterministic (no randomness), so a resumed check and tests are stable.
   * @param {object[]} items selectKanji output
   * @param {{pairs?: {chars: string[]}[], componentsOf?: (k: string) => string[]}} opts pairs = CONFUSABLES.pairs
   * @returns {object[]} the same items, reordered
   */
  /** a < b comparing arrays of numbers element by element (first difference decides). */
  function lexLess(a, b) {
    for (let n = 0; n < a.length; n += 1) if (a[n] !== b[n]) return a[n] < b[n];
    return false;
  }
  function interleave(items, { pairs = [], componentsOf = () => [] } = {}) {
    const partners = new Map();   // kanji -> Set of look-alikes
    for (const p of pairs) {
      const cs = (p && p.chars) || [];
      for (const a of cs) for (const b of cs) if (a !== b) { if (!partners.has(a)) partners.set(a, new Set()); partners.get(a).add(b); }
    }
    const parts = new Map(items.map((x) => [x.kanji, new Set(componentsOf(x.kanji) || [])]));
    const isPair = (a, b) => partners.has(a.kanji) && partners.get(a.kanji).has(b.kanji);
    const sharesPart = (a, b) => [...parts.get(a.kanji)].some((c) => parts.get(b.kanji).has(c));
    const pool = items.map((x, i) => ({ x, i }));
    const out = [];
    while (pool.length) {
      const prev = out[out.length - 1];
      let pick = 0, best = null;
      pool.forEach(({ x, i }, j) => {
        // lower is better: look-alike of prev, shares a component with prev, other kind than prev, original order
        const key = prev ? [isPair(prev, x) ? 0 : 1, sharesPart(prev, x) ? 0 : 1, x.kind === prev.kind ? 1 : 0, i] : [0, 0, 0, i];
        if (!best || lexLess(key, best)) { best = key; pick = j; }
      });
      out.push(pool.splice(pick, 1)[0].x);
    }
    return out;
  }

  /** Outcome of a typed reading answer for a reading item: 'correct' or 'readingMiss' (ReadingAnswer matcher). */
  function readingOutcome(item, answer) {
    return item.word && ReadingAnswer.readingMatches(answer, item.word) ? 'correct' : 'readingMiss';
  }

  /**
   * The rank-model event for an outcome on a record: correct = pass of the record's next stage
   * (rank-model gates writing at silver and ignores a pass beyond diamond); null for unknown outcomes.
   */
  function eventFor(record, outcome) {
    const event = OUTCOME_EVENT[outcome];
    if (!event) return null;
    return outcome === 'correct' ? { type: 'pass', stage: RankModel.nextStage(record) } : event;
  }

  /**
   * Apply results [{kanji, outcome}] in order through rank-model; unknown outcomes and unstudied kanji are skipped.
   * A correct answer raises a kanji only when RankModel.canCheckPromote(record, now) (one tier per 12 hours) and
   * stamps the raise with now. Otherwise (capped) the answer still counts as a clean recall: clearFails and retry are
   * reset, while rank and stamp are kept, and the change carries capped: true.
   * Drops are never limited. now defaults to the clock (ms since the epoch).
   * Returns {state, changes: [{kanji, outcome, from, to, capped?}]}.
   */
  function applyResults(rankState, results, { now = Date.now() } = {}) {
    let state = rankState;
    const changes = [];
    for (const { kanji, outcome } of results) {
      const record = RankModel.getKanji(state, kanji);
      const event = eventFor(record, outcome);
      if (!event || record.rank < RankModel.RANK.bronze) continue;
      const from = record.rank;
      if (event.type === 'pass') {
        if (event.stage && !RankModel.canCheckPromote(record, now)) {
          const kept = RankModel.sanitizeRecord(Object.assign({}, record, { clearFails: 0, retry: false }));
          state = Object.assign({}, state, { kanji: Object.assign({}, state.kanji, { [kanji]: kept }) });
          changes.push({ kanji, outcome, from, to: from, capped: true });
          continue;
        }
        event.checkAt = now;
      }
      state = RankModel.applyToState(state, kanji, event);
      changes.push({ kanji, outcome, from, to: RankModel.getKanji(state, kanji).rank });
    }
    return { state, changes };
  }

  return { DEFAULT_SIZE, OUTCOME_EVENT, eventFor, selectKanji, interleave, readingOutcome, applyResults };
});
