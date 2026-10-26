# Kanji app v15g

Base: v15f-stage. sw.js `VERSION = 'kanji-v15g'`.

## Included
1. **v15f**: raw-ink overlay, v15-ui hooks and everything else that isn't grading are unchanged.
2. **HOTFIX-v15d.6** (kanji-data `patches/HOTFIX-v15d.6.patch`, commit 6e6b029, sha1 31e1fed6de19b83da4f04b250424fb6bb6847b92). Includes v15d.4 and v15d.5, and also the v15d.2 ruleGate change that the d.5 build was missing.
   - ウ#3 fix: a bend rule fails only if it fails on the ink as drawn *and* on the curl-trimmed ink (`ruleGate`, `ruleFailures`, `curlTrimmedInk`).
   - Lost pen pointerup: the open pen stroke is committed and judged on the next pen pointerdown (`Pad.down`).
   - The first-length check is skipped when stroke 2 is a dot (`rejudgeFirstStroke`).
   - On hook-dropped, the curl is cut at the nearest turn (`curlRetry`, nearest).
   - v15d.6: if a hook-dropped stroke still fails both curl retries, there is a third retry that thins out the jitter first (`curlRetry` thin, `hook-curl.js` `thinJitter`). On full replay, hook-dropped rejects went from about 120 to 14-19.
3. **No pill-reflow fix.** The previous stage that had it is kept at `v15g-stage.pill-v1`.

## How it was applied
- The previous v15g build is kept as `v15g-stage.d5-bad`. Its git merge-file result was missing the v15d.2 ruleGate, ruleFailures and curlTrimmedInk (kd-hotfix port/d5/V15G_MERGE_CHECK.md).
- The reference is live+d.6: the patch applied cleanly with -p1 to the live base `/tmp/d4p/a`, in `/tmp/d6p/b`.
- index.html is live+d.6's index.html with v15f's non-grading hunks added back. Those are the raw-ink overlay (`showRawInk`, `clearRawInk`, `Pad.drawRawInk`, `RAW_INK_COLOR`, and its calls in reject, focus, Pad.down, undo/clear and the buttons) and the `V15UI.onStrokeStart` hook.
- A per-function check (`/tmp/d6p/fncheck.py`) covered all 49 functions and constants that d.6 touches. 47 are byte-identical to live+d.6. `Pad.down` and `focus` differ only by the v15f UI calls, and are identical once those are removed.
- hook-curl.js, debug-strokes.js and sw.js are byte-identical to live+d.6. d.6's sw.js already has VERSION `kanji-v15g`.
