/**
 * tips-data.js — v16 R19: one-time learner tips and the "What's new in v16" list (data only, no DOM/storage).
 * Exposes window.TIPS_DATA; also CommonJS for tests.
 *
 * Every number below was read from the code, not guessed (re-check here if the code changes):
 *   retention 0.9 default, settable 0.80–0.95 ......... v15-integration.js SCHED_DEFAULTS + schedSettings clamp
 *   learning steps 10 min / 4 h / 1 day ............... scheduler-model.js LEARNING_STEPS_MS
 *   leech at 4 lapses, again after 2 more ............. leech-model.js LEECH_LAPSES / REPEAT_LAPSES
 *   weak spot: score ≥ 2, errors halve after 7 days ... diagnosis-model.js WEAK_THRESHOLD / HALF_LIFE_DAYS
 *   vacation: dates shifted, streak kept, ends on the first review ... v15-integration.js endVacation / R3
 *   backup reminder after 7 study days without export .. data-safety.js REMIND_DAYS
 *   persistent storage asked once after the first lesson data-safety.js requestPersistOnce (R18)
 *   near miss (long vowel, voicing, small っ/ゃゅょ) = "hard" partial-credit.js
 *
 * `shipped` = can the learner actually see/use this in the app today without more UI work?
 *   true  → works now (automatic behaviour, or its UI is already wired).
 *   false → logic is built but needs Botfour's UI mounting; the UI must NOT show this tip / item until it is wired
 *           (TipsModel.nextTip and whatsNewList hide shipped:false by default).
 * Tip text rules (checked by tests/test_tips.js): unique ids, title ≤ 40 chars, 1–3 sentences, body ≤ 320 chars.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TIPS_DATA = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Tips. `when` = the UI moments (nextTip context.event) at which the tip fits; order = priority. */
  const TIPS = [
    { id: 'spacing', shipped: true, when: ['first-review', 'review'],
      title: 'Why reviews are spaced out',
      body: 'A new kanji comes back after 10 minutes, then 4 hours, then 1 day. After that the gaps grow as your memory gets stronger, so each review lands just before you would forget.' },
    { id: 'near-miss', shipped: true, when: ['reading-near-miss'],
      title: 'Near misses still count',
      body: 'If a reading is right except for a long vowel, voicing (は/ば), a small っ or a small ゃゅょ, it counts as "hard" rather than a miss. The kanji still moves forward, just a smaller step than a perfect answer.' },
    { id: 'persistence', shipped: true, when: ['lesson-complete'],
      title: 'Keeping your progress safe',
      body: 'After your first lesson we ask your browser to keep this app’s data instead of clearing it to save space. Some browsers, especially Safari on iPhone, may still clear it, so an exported backup file is the only copy that is truly safe.' },
    { id: 'retention', shipped: true, when: ['settings'],
      title: 'Your retention target',
      body: 'Reviews are timed so that you still remember about 90% of kanji when they come up. You can choose from 80% to 95%: higher means more reviews, lower means fewer reviews but more forgetting.' },
    { id: 'leech', shipped: true, when: ['leech'],
      title: 'What a “leech” is',
      body: 'A kanji you have forgotten 4 times is a leech: drilling it again rarely helps. Instead we rebuild it from its parts, and it is only flagged again after 2 more misses.' },
    { id: 'weak-spot', shipped: true, when: ['diagnosis'],   // R24: v16-weakspot.js fires v16:diagnosis on a new weak spot
      title: 'How weak-spot feedback works',
      body: 'Every stroke you write is matched to its part and its stroke type, like a hook or a turn. A part or stroke type becomes a weak spot only after enough tries with clearly more misses than usual, and old misses count half as much after a week.' },
    { id: 'vacation', shipped: true, when: ['settings', 'vacation-off'],
      title: 'Vacation mode',
      body: 'Pause reviews while you are away. Your due dates move forward by the days you paused and your streak is kept, so you do not come back to a pile. Vacation ends by itself when you do your next review.' },
    { id: 'backup', shipped: true, when: ['backup-reminder', 'settings'],
      title: 'Back up your progress',
      body: 'Your progress is stored only in this browser. Export a backup file now and then; we remind you after 7 days of study without one.' },
    { id: 'family-lessons', shipped: true, when: ['components'],
      title: 'Learning kanji in families',
      body: 'Kanji that share a part, like 持 and 時, are easier to learn together. A family lesson teaches the shared part first, then the kanji built from it.' },
    // R23 follow-up (rc6): Botfour's #9 requeue and #8 part writing are in rc6; tips-model.js shows these on the DOM moment
    { id: 'retry-requeue', shipped: true, when: ['retry'],
      title: 'Missed kanji come back',
      body: 'A kanji you miss comes back at least 5 items later, up to 2 more times. These retries are practice only, so they do not change its review schedule.' },
    { id: 'part-writing', shipped: true, when: ['component-write'],
      title: 'Writing one part on its own',
      body: 'After you answer a kanji you are still learning, you may be asked to write its least-practised part on its own. This step is practice only; tap Skip to go straight on.' },
    { id: 'context-sentences', shipped: true, when: ['sentence'],
      title: 'Example sentences',
      body: 'Some kanji come with a short example sentence so you see the word in use. Each sentence shows its source and license next to it.' },
  ];

  /**
   * What's new in v16, in plain user language. `patches` = files in kanji-team/patches that built it (verified by
   * tests/test_tips.js when that folder is reachable). `by` = the bot whose patch it is.
   */
  const WHATS_NEW = [
    { id: 'fsrs', shipped: true, by: 'Botfive/Botty', patches: ['botfive-v16-01-fsrs.patch', 'botfive-v16-01b-fsrs.patch', 'V16-RC-logic.patch'],
      text: 'Smarter review timing: each kanji now gets its own schedule based on how well you know it.' },
    { id: 'learning-steps', shipped: true, by: 'Botthree/Botty', patches: ['V16-INT.patch', 'V16-RC-logic.patch'],
      text: 'New kanji come back after 10 minutes, 4 hours and 1 day before longer gaps begin.' },
    { id: 'smoothing', shipped: true, by: 'Botfive', patches: ['botfive-v16-04-retention-smoothing.patch'],
      text: 'Reviews are spread more evenly across days, so you get fewer heavy days.' },
    { id: 'near-miss', shipped: true, by: 'Botfive', patches: ['botfive-v16-R5-partial-credit.patch'],
      text: 'A reading that is only off by a long vowel, voicing or a small kana now counts as “hard”, not wrong.' },
    { id: 'component-hooks', shipped: true, by: 'team', patches: ['V16-W-index.patch'],
      text: 'Hooks are now checked when you write a part on its own, not only in the full kanji.' },
    { id: 'data-safety', shipped: true, by: 'Botfive', patches: ['botfive-v16-R18-safety.patch'],
      text: 'Better protection for your progress: the app asks the browser to keep it, and a failed save is retried, not lost.' },
    // ---- R23: wired in the rc5 UI (settings, stats, parts, study cards, lesson picker, writing guide) ----
    { id: 'retention-setting', shipped: true, by: 'Botfive', patches: ['botfive-v16-04-retention-smoothing.patch', 'botfive-v16-R16-settings.patch'],
      text: 'Choose how much you want to remember (80–95%).' },
    { id: 'vacation', shipped: true, by: 'Botfive', patches: ['botfive-v16-05-vacation-backlog.patch', 'botfive-v16-port-03-05.patch'],
      text: 'Vacation mode pauses reviews and keeps your streak.' },
    { id: 'streak', shipped: true, by: 'Botfive/Botty', patches: ['botfive-v16-02-streak.patch', 'V16-INT.patch'],
      text: 'A daily streak and goal, with a streak freeze for a missed day.' },
    { id: 'load-budget', shipped: true, by: 'Botfive', patches: ['botfive-v16-03-load-budget.patch'],
      text: 'Set a daily time budget; new kanji slow down when reviews would pile up.' },
    { id: 'fading-scaffolds', shipped: true, by: 'Botfive', patches: ['botfive-v16-R6-fading-scaffolds.patch'],
      text: 'Writing guides fade as you get stronger, so you write more from memory.' },
    { id: 'look-alikes', shipped: true, by: 'Botfive/Botthree', patches: ['botfive-v16-R7-contrast.patch', 'DATA-confusables-v1.patch'],
      text: 'Look-alike kanji you mix up are practised side by side.' },
    { id: 'leech', shipped: true, by: 'Botfive', patches: ['botfive-v16-R8-leech.patch'],
      text: 'Kanji you keep forgetting are rebuilt from their parts.' },
    { id: 'export', shipped: true, by: 'Botfive', patches: ['botfive-v16-R9-export.patch', 'botfive-v16-R16-settings.patch'],
      text: 'Export and import your progress as a file.' },
    { id: 'weak-spots', shipped: true, by: 'Botfive', patches: ['botfive-v16-R10-diagnosis.patch', 'botfive-v16-R10-glue.patch'],
      text: 'Writing feedback points to the exact part and stroke that went wrong.' },
    { id: 'sentences', shipped: true, by: 'Botfive', patches: ['botfive-v16-R11-sentences.patch', 'botfive-v16-R11-glue.patch', 'botfive-v16-R17-cards.patch'],
      text: 'Example sentences for kanji, with their source shown.' },
    { id: 'stats', shipped: true, by: 'Botfive', patches: ['botfive-v16-R12-stats.patch', 'botfive-v16-R13-timing.patch'],
      text: 'Progress stats: how much you remember, upcoming reviews and time studied.' },
    { id: 'families', shipped: true, by: 'Botfive', patches: ['botfive-v16-R14-components.patch', 'botfive-v16-lesson-picker.patch'],
      text: 'Browse kanji by shared parts and learn a whole family together.' },
    // ---- R23 follow-up: Botfour's #9 / #8 ports are in rc6 (patch files live in kanji-review/patches) ----
    { id: 'retry-requeue', shipped: true, by: 'Botfour', patches: ['V16-9-requeue-ui.patch'],
      text: 'Missed items come back later in the same session.' },
    { id: 'part-writing', shipped: true, by: 'Botfour', patches: ['V16-8-component-ui.patch'],
      text: 'Practise writing a single part of a kanji on its own.' },
  ];

  return { TIPS, WHATS_NEW, LIMITS: { title: 40, body: 320, sentences: 3, whatsNew: 120 } };
});
