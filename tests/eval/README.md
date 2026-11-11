# Offline model evaluation (OCR and translation)

These scripts measure how accurate FieldKit's optional on-device packs are: OCR and translation. They were
written while fixing OCR and translation problems found on a real iPhone (see [docs/TESTING.md](../../docs/TESTING.md)).

**Notes on these results**
- All test material is **synthetic**: `sharp` makes the photos and the sentences were written by the maintainers. No
  real user data is used.
- Each sentence has **one hand-written reference**. Scores are a guide, not a benchmark.
- Results come from **desktop CPUs**. Translation was measured in Node with the same ONNX files the app
  downloads, not in a browser. OCR was run in Chromium and WebKit.
- These scores were measured on desktop, not on the phone. OCR and translation themselves were checked on the owner's
  iPhone.

## What each script does

| File | What it does |
|---|---|
| `make_ocr_photos.mjs` | Makes synthetic iPhone-style photos with `sharp`: 4032×3024, EXIF orientation 6, 2° skew, uneven light, sensor noise and blur. Variants: `page` (large print), `small` (ordinary 10–11 pt print) and `dim` (small print, indoor light, more noise and shake). Writes `<lang>_<variant>.jpg` and `ocr_text.json`. |
| `ocr_harness.ts` | The browser side of the OCR test. It runs FieldKit's OCR preparation and tesseract.js code (bundled with esbuild). |
| `ocr_run.mjs` | Opens the bundled harness in Chromium or WebKit (Playwright), runs each photo through each mode, and prints the character error rate (CER). |
| `translation_set.json` | 16 general and 7 dictionary-term sentence pairs (English↔Hindi). One hand-written reference each. |
| `translation_eval.mjs` | Runs OPUS-MT (Transformers.js in Node) on the set and scores it with chrF. Mode `plain` is the plain model. Mode `fieldkit` uses `app/src/translate_prep.ts` (terminology from `translation_terms.json`, Hindi punctuation, and a plain retranslation when a term placeholder is lost). |

## How to run

**Requirements:** Node 22.18 or later (the scripts import TypeScript files directly), `npm ci --legacy-peer-deps`, and
network access on the first run to download the pinned model files.

### OCR
```bash
node tests/eval/make_ocr_photos.mjs <dir>
npx esbuild tests/eval/ocr_harness.ts --bundle --format=iife --outfile=<dir>/bundle.js
node tests/eval/ocr_run.mjs <dir> <dir>/bundle.js chromium|webkit [modes] [variants]
```
`modes` defaults to `old-field,old-tool,new-tool,new-field` and `variants` to `page,small,dim`. Use `chromium` or
`webkit` for the browser. The Playwright browsers must be installed.

### Translation
```bash
node tests/eval/translation_eval.mjs <cacheDir> '[{"dir":"en-hi","mode":"plain"},{"dir":"en-hi","mode":"fieldkit"}]'
```
`dtype` defaults to `q8`. Add `"dir":"hi-en"` for Hindi to English.

### OCR (character error rate, lower is better)

| Case | Before (old code) | After (new code) |
|---|---|---|
| Large print | 0–1.3% | 0% (Chromium and WebKit) |
| Ordinary small print (the iPhone symptom: old confidence 20–46%) | 78–89% | OCR screen: 2.3–2.7% English, 2.0–4.6% Hindi. Photo-field path: 3.8–4.6% English, 4.6–7.2% Hindi. Confidence about 90% |
| Dim room with heavy shake | not measured | 72–94%. Still poor: the app reports the text as unreliable and asks for a retake. About 3–8 s on desktop |

The browser breakdown for the small-print rows is not separated in these results.

### Translation (chrF, higher is better)

| Direction and set | Plain (before) | `fieldkit` (after) |
|---|---|---|
| en→hi, general | 41.5 | 47.9 |
| en→hi, dictionary-term sentences | 30.8 | 49.6 |
| hi→en, general | 61.2 | 62.1 |
| hi→en, dictionary-term sentences | 48.9 | 63.7 |

The dictionary-term rows use `translation_terms.json`. In the app, term protection applies only on a phone that still
has a dictionary pack from before 0.3; Hindi sentence endings and sentence splitting apply to every translation.

Other measurements: fp32 en→hi scored 44.6 against 41.5 for q8, at four times the download. NLLB-600M (895 MB) and
M2M100 (632 MB) are too large for a phone web app, so OPUS-MT stays. Transformers.js 4.3.1 beam search is effectively
greedy.
