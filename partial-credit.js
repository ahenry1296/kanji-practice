/**
 * partial-credit.js — v16 R5: partial credit for near-miss readings (pure, no DOM/storage).
 *
 * Why: a learner who types こうこ for こうこう or はなひ for はなび has retrieved the word and its kanji; only a
 * phonological detail (long vowel, voicing/rendaku, small っ, small ゃゅょ) is off. Treating that as a total
 * failure ("Again") resets memory strength the learner actually has and is a top complaint (WaniKani forum,
 * MARKET_RESEARCH #5). FSRS's "Hard" grade means "recalled, with difficulty": stability still grows, but less.
 * So: exact → 'good', near miss → 'hard' (with the differing characters highlighted), anything else → 'again'.
 * Near misses are still shown as wrong-in-detail, so the correct form is retrieved/attended to (error feedback).
 *
 * API (window.PartialCredit / require):
 *   grade(answer, accepted) → {verdict:'exact'|'near'|'wrong', grade:'good'|'hard'|'again',
 *                              reasons:['long-vowel'|'voicing'|'sokuon'|'small-kana'], expected, segments}
 *     accepted: a reading string or an array of accepted readings (kana; katakana is folded to hiragana).
 *     segments: [{text, ok}] over `expected`, ok=false for characters the answer got wrong (for highlighting).
 *   isNoCredit(answer, expected) → true for listed minimal pairs (おばさん/おばあさん): graded 'wrong'.
 *   looseKey(text) → comparison key with all four tolerated details removed (exported for tests/tools).
 *
 * Integration (Botty / v16 glue, onReadingResult): call grade() only when ReadingAnswer.readingMatches() is
 * false. verdict 'near' → schedule FSRS 'hard' (not a lapse; no rank drop; does not count as a clean recall).
 * Hook for Botfour: on 'near' render segments with ok=false in the error colour and a line such as
 * "Almost: long vowel" (reasons → labels below). Hints already used keep their own rule (a hint caps at 'hard').
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PartialCredit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Short UI labels for reasons (English UI). */
  const LABELS = { 'long-vowel': 'long vowel', voicing: 'voicing (゛/゜)', sokuon: 'small っ', 'small-kana': 'small ゃゅょ' };

  // Voiced/semi-voiced kana → plain kana (が→か, ぱ→は, ゔ→う). Covers rendaku (はなび vs はなひ).
  const VOICED = 'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゔ';
  const PLAIN = 'かきくけこさしすせそたちつてとはひふへほはひふへほう';
  const SMALL = { 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'ゎ': 'わ' };

  // Vowel of each kana, so a following vowel/ー that lengthens it can be dropped.
  const ROWS = ['あかさたなはまやらわがざだばぱゃ', 'いきしちにひみりぎじぢびぴ', 'うくすつぬふむゆるぐずづぶぷゅゔ',
    'えけせてねへめれげぜでべぺ', 'おこそとのほもよろをごぞどぼぽょ'];
  const VOWEL = {};
  'aiueo'.split('').forEach((v, i) => { for (const ch of ROWS[i]) VOWEL[ch] = v; });
  const VOWEL_KANA = { 'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o' };

  /** Katakana → hiragana, strip spaces/punctuation. ー is kept (it is a long-vowel mark). */
  function toHira(text) {
    return String(text || '').normalize('NFKC').replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[\s・.,、。'"-]/g, '');
  }

  // The four tolerated details, each as a string transform (applied to hiragana).
  const RULES = {
    voicing: (s) => s.replace(/./g, (c) => { const i = VOICED.indexOf(c); return i < 0 ? c : PLAIN[i]; }),
    'small-kana': (s) => s.replace(/[ゃゅょぁぃぅぇぉゎ]/g, (c) => SMALL[c]),
    sokuon: (s) => s.replace(/っ/g, ''),
    'long-vowel': (s) => {
      let out = '';
      for (const c of s) {
        const prev = VOWEL[out[out.length - 1]] || VOWEL_KANA[out[out.length - 1]];
        const v = c === 'ー' ? prev : VOWEL_KANA[c];
        // Drop ー, a repeated vowel (かあ), おう (こう) and えい (せい): they only lengthen the previous kana.
        if (prev && v && (v === prev || (prev === 'o' && v === 'u') || (prev === 'e' && v === 'i'))) continue;
        out += c;
      }
      return out;
    },
  };
  // Order matters: un-voice and enlarge first so the vowel table sees plain kana.
  const ORDER = ['voicing', 'small-kana', 'sokuon', 'long-vowel'];
  const apply = (s, names) => ORDER.filter((n) => names.includes(n)).reduce((acc, n) => RULES[n](acc), s);

  /**
   * Long-vowel minimal pairs: both forms are real, different words, so a long-vowel slip between them is a wrong
   * word, not a detail (おばさん aunt / おばあさん grandmother). Unordered pairs, hiragana. Extend as data grows.
   */
  const NO_CREDIT_PAIRS = [
    ['おばさん', 'おばあさん'], ['おじさん', 'おじいさん'], ['ここ', 'こうこう'], ['ここ', 'こうこ'], ['しゅじん', 'しゅうじん'],
    ['びょういん', 'びよういん'], ['え', 'ええ'], ['いえ', 'いいえ'], ['とり', 'とおり'], ['ゆき', 'ゆうき'],
    ['くろ', 'くろう'], ['しょじょ', 'しょうじょ'], ['ちず', 'ちいず'], ['きた', 'きいた'], ['せき', 'せいき'],
    ['かど', 'かどう'], ['よる', 'よおる'], ['じゆう', 'じゅう'], ['きて', 'きって'], ['おと', 'おっと'],
    ['さか', 'さっか'], ['いた', 'いった'], ['かこ', 'かっこ'],
  ];
  const NO_CREDIT = new Set(NO_CREDIT_PAIRS.flatMap(([a, b]) => [a + '|' + b, b + '|' + a]));
  /** True when answer and expected are a listed minimal pair (then: 'wrong', never 'near'). */
  function isNoCredit(answer, expected) { return NO_CREDIT.has(toHira(answer) + '|' + toHira(expected)); }

  function looseKey(text) { return apply(toHira(text), ORDER); }

  /** Character-level LCS over `expected`: segments marked ok where the answer has the same character in order. */
  function segments(answer, expected) {
    const a = [...answer], e = [...expected];
    const L = Array.from({ length: e.length + 1 }, () => new Array(a.length + 1).fill(0));
    for (let i = e.length - 1; i >= 0; i--) for (let j = a.length - 1; j >= 0; j--)
      L[i][j] = e[i] === a[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    const push = (ch, ok) => { const last = out[out.length - 1]; if (last && last.ok === ok) last.text += ch; else out.push({ text: ch, ok }); };
    while (i < e.length) {
      if (j < a.length && e[i] === a[j]) { push(e[i], true); i++; j++; }
      else if (j < a.length && L[i][j + 1] >= L[i + 1][j]) j++;
      else { push(e[i], false); i++; }
    }
    return out;
  }

  /** Which tolerated details were needed: rule r is a reason if the forms still differ with every rule except r. */
  function reasonsFor(ans, exp) {
    return ORDER.filter((r) => { const others = ORDER.filter((x) => x !== r); return apply(ans, others) !== apply(exp, others); });
  }

  function grade(answer, accepted) {
    const list = (Array.isArray(accepted) ? accepted : [accepted]).map(toHira).filter(Boolean);
    const ans = toHira(answer);
    const wrong = { verdict: 'wrong', grade: 'again', reasons: [], expected: list[0] || '', segments: list[0] ? segments(ans, list[0]) : [] };
    if (!ans || !list.length) return wrong;
    if (list.includes(ans)) return { verdict: 'exact', grade: 'good', reasons: [], expected: ans, segments: [{ text: ans, ok: true }] };
    for (const exp of list) {
      // A 1-kana reading has no room for a "detail" error: か for が is just a different answer.
      if ([...exp].length < 2) continue;
      if (isNoCredit(ans, exp)) continue;   // a real different word (minimal pair) → no partial credit
      if (looseKey(ans) === looseKey(exp)) {
        return { verdict: 'near', grade: 'hard', reasons: reasonsFor(ans, exp), expected: exp, segments: segments(ans, exp) };
      }
    }
    return wrong;
  }

  return { LABELS, NO_CREDIT_PAIRS, isNoCredit, grade, looseKey, toHira };
});
