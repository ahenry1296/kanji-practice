# 漢字練習 — Kanji Practice (iPad Safari)

Single-page, no-build web app for practising kanji with Apple Pencil. It has three drill levels (guided, faint, memory), word boxes, and spaced review.

## Structure
```
index.html            app: CSS (palette in :root) + one script organised in labelled sections:
                      CONFIG · STORAGE · UTILITIES · STROKE CHECKING · DATA ACCESS · STATE ·
                      RENDERING · LEVELS/FLOW · ANIMATIONS · INPUT/PEN · SET PICKER · SERVICE WORKER+INIT
data.js               generated data (window.KANJI_DATA) — do not hand-edit
sw.js                 offline cache (cache-first)
manifest.webmanifest, icons/   home-screen install
tools/                data generator + Playwright tests
deploy/               exact copy for GitHub Pages (static hosting)
screens/              screenshots
```
The data flow is described in the header comment at the top of the script in index.html.

## Run locally
`python3 -m http.server 8000` → open http://localhost:8000/ (the service worker only registers over http(s); opening the file directly also works).

## Editing CONFIG
Every tunable setting is in `CONFIG` at the top of the script, and each one has a comment:
- tolerances (`CHECK.strict` / `CHECK.memory` / `CHECK.ADAPT`)
- `MISSES_FOR_HINT`
- word-box reps (`WORD`)
- `CLEAN_TARGET`
- `SCHEDULE_DAYS`
- timings (`FLASH_MS`, `SLIDE_*`, `WORD_BREAK_MS`, `COMBINE`)

To check your changes, run `tools/test_regression.py` and `tools/test_accuracy.py`.

## How data.js is generated
No reading or meaning is typed by hand. Everything comes from the sources below.
1. Put the sources in `tools/src/` (or set `KANJI_SRC`):
   - `kanjidic2-en-3.6.2.json` and `jmdict-eng-common-3.6.2.json` from jmdict-simplified 3.6.2+20261012204142
   - `kvgsrc/kanjivg-70a0b7ae/` (KanjiVG at commit 70a0b7ae)
   - `n5.csv` (old JLPT 4 list)
2. `python3 tools/fetch_jisho.py`: caches Jisho pages. They are only used for the KangXi radical number, which names the parts.
3. `python3 tools/words_lookup.py`: resolves the lessons in `tools/lessons.py` against JMdict and writes `work/lessons.json`.
4. `python3 tools/gen_data.py build`: writes `data.js`.

Re-running the steps with the pinned sources reproduces the current data.js byte for byte.

## Service worker version rule
**Whenever any cached file changes (index.html, data.js, icons, manifest), bump `VERSION` in sw.js** (for example kanji-v4 → kanji-v5). If you don't, iPads keep serving the old cached copy. Then copy the app files to deploy/.

## Sources and licences
- **KanjiVG** © Ulrich Apel, CC BY-SA 3.0 (https://kanjivg.tagaini.net). The stroke paths in data.js are derived from KanjiVG and are shared under the same licence.
- **KANJIDIC2** and **JMdict** © Electronic Dictionary Research and Development Group (EDRDG), CC BY-SA 4.0 (https://www.edrdg.org/edrdg/licence.html). They are used via jmdict-simplified (https://github.com/scriptin/jmdict-simplified).
- Jisho.org is used only to look up radical numbers during generation.
