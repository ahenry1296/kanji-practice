/*
 * reading-answer.js — reading-answer matching and drill-word choice shared by practice-model.js and
 * level-check-model.js (spec: READING_WORDS.md, "Answer matching"). Pure functions.
 * Browser: window.ReadingAnswer. Node: require('./reading-answer.js').
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReadingAnswer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LONG_MARK = 'ー';
  /** Vowel of each hiragana (small kana included; っ and ん have none). */
  const VOWEL_ROWS = {
    あ: 'あかさたなはまやらわがざだばぱぁゃゎ',
    い: 'いきしちにひみりぎじぢびぴぃ',
    う: 'うくすつぬふむゆるぐずづぶぷぅゅゔ',
    え: 'えけせてねへめれげぜでべぺぇ',
    お: 'おこそとのほもよろをごぞどぼぽぉょ',
  };
  const VOWEL_OF = {};
  for (const [vowel, row] of Object.entries(VOWEL_ROWS)) for (const kana of row) VOWEL_OF[kana] = vowel;
  /** Long ー after an o- or e-row kana is usually written う / い in hiragana words (とーきょー = とうきょう). */
  const LONG_ALSO = { お: 'う', え: 'い' };

  /** NFKC (full/half width), drop every space (ASCII and full-width), katakana → hiragana. ー is kept. */
  function toHiraganaKeepLong(text) {
    const s = String(text == null ? '' : text).normalize('NFKC').replace(/\s+/gu, '');
    return Array.from(s).map((c) => {
      const code = c.codePointAt(0);
      return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : c;
    }).join('');
  }

  /** Normalized reading: toHiraganaKeepLong, then each ー becomes the preceding kana's vowel (らーめん → らあめん). */
  function normalizeReading(text) {
    let out = '';
    for (const c of toHiraganaKeepLong(text)) {
      const prev = out.slice(-1);
      out += c === LONG_MARK && VOWEL_OF[prev] ? VOWEL_OF[prev] : c;
    }
    return out;
  }

  /** Every spelling an input may stand for: ー as the vowel, and after o/e rows also as う / い (at most 64). */
  function inputForms(text) {
    let forms = [''];
    for (const c of toHiraganaKeepLong(text)) {
      forms = forms.flatMap((f) => {
        const vowel = VOWEL_OF[f.slice(-1)];
        if (c !== LONG_MARK || !vowel) return [f + c];
        return LONG_ALSO[vowel] ? [f + vowel, f + LONG_ALSO[vowel]] : [f + vowel];
      }).slice(0, 64);
    }
    return forms;
  }

  /** Readings accepted for a word {r, alts}: the reading and every JMdict variant, normalized. */
  function acceptedReadings(word) {
    return Array.from(new Set([word.r].concat(word.alts || []).map(normalizeReading)));
  }

  /** True when the answer matches the word's reading or any listed variant (after normalization). */
  function readingMatches(answer, word) {
    const accepted = new Set(acceptedReadings(word));
    const forms = inputForms(answer);
    return forms[0] !== '' && forms.some((f) => accepted.has(f));
  }

  /**
   * Words usable in a per-kanji reading drill, best first: irregular (ateji/gikun) words skipped, common before
   * uncommon (order otherwise kept). If every word is irregular, the full list is the fallback.
   */
  function drillWords(words) {
    const regular = (words || []).filter((w) => !w.irregular);
    const pool = regular.length ? regular : (words || []).slice();
    return pool.filter((w) => w.common !== false).concat(pool.filter((w) => w.common === false));
  }

  /** The n-th drill word (cycling), or null when the kanji has no words. */
  function drillWord(words, n = 0) {
    const pool = drillWords(words);
    return pool.length ? pool[n % pool.length] : null;
  }

  /** {kanji: words} merged over every level of READING_WORDS ({levels: {N5: {kanji: [...]}}}). */
  function wordsByKanji(readingWordsData) {
    return Object.assign({}, ...Object.values((readingWordsData && readingWordsData.levels) || {}));
  }

  return { wordsByKanji, normalizeReading, inputForms, acceptedReadings, readingMatches, drillWords, drillWord };
});
