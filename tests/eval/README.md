# Offline model evaluation (0.2.4)

These scripts measure how accurate FieldKit's on-device models are: OCR, speech to text and translation. They were
written for the real-iPhone findings in [docs/TESTING.md](../../docs/TESTING.md).

**Honesty notes**
- All test material is **synthetic**: Windows' built-in voices read the sentences, and `sharp` makes the photos. No
  real user data is used, and the audio and photos are not distributed.
- Each sentence has **one hand-written reference**. Scores are a guide, not a benchmark.
- Results come from **desktop CPUs**. Speech and translation were measured in Node with the same ONNX files the app
  downloads, not in a browser. OCR was run in Chromium and WebKit.
- **None of these results were measured on an iPhone.** Speed and memory on a phone are unverified.
- Synthetic voices are cleaner than real people. Real-world accuracy is unverified.

## What each script does

| File | What it does |
|---|---|
| `tts.ps1` | Windows only. Reads `stt_sentences.json` with Windows' built-in voices (en-US Zira, en-IN Ravi, hi-IN Kalpana and Hemant) and writes 16 kHz WAV files. |
| `stt_sentences.json` | 8 English and 6 Hindi reference sentences for speech to text. |
| `stt_eval.mjs` | Runs Whisper (Transformers.js in Node, `onnxruntime-node`) on the WAV files. Reports English WER and Hindi CER, for clean audio and for "phone" audio (quiet, 12 dB SNR noise, 1.5 s / 2 s of silence padding). Mode `fieldkit` applies the app's own `app/src/audio_prep.ts`. Mode `none` is the old behaviour. |
| `make_ocr_photos.mjs` | Makes synthetic iPhone-style photos with `sharp`: 4032×3024, EXIF orientation 6, 2° skew, uneven light, sensor noise and blur. Variants: `page` (large print), `small` (ordinary 10–11 pt print) and `dim` (small print, indoor light, more noise and shake). Writes `<lang>_<variant>.jpg` and `ocr_text.json`. |
| `ocr_harness.ts` | The browser side of the OCR test. It runs FieldKit's OCR preparation and tesseract.js code (bundled with esbuild). |
| `ocr_run.mjs` | Opens the bundled harness in Chromium or WebKit (Playwright), runs each photo through each mode, and prints the character error rate (CER). |
| `translation_set.json` | 16 general and 7 dictionary-term sentence pairs (English↔Hindi). One hand-written reference each. |
| `translation_eval.mjs` | Runs OPUS-MT (Transformers.js in Node) on the set and scores it with chrF. Mode `plain` is the plain model. Mode `fieldkit` uses `app/src/translate_prep.ts` (dictionary terminology from `examples/*/dictionary.json`, Hindi punctuation, and a plain retranslation when a term placeholder is lost). |
| `assistant_set.json` | Synthetic assistant questions in English and Hindi, written by the maintainers. Each question has its expected intent or entry. Some are held out, and the `fresh_*` sets were written after the intent cues were tuned. |
| `assistant_eval.mjs` | Scores the offline assistant's retrieval and intent matching for each embedding model you pass, using Transformers.js in Node. It also measures how well the off-topic threshold (0.29) separates in-scope from off-topic questions. |

## How to run

**Requirements:** Node 22.18 or later (the scripts import TypeScript files directly), `npm ci --legacy-peer-deps`, and
network access on the first run to download the pinned model files. `tts.ps1` needs Windows.

### Speech to text
```bash
powershell -File tests/eval/tts.ps1 -Out <dir> -Json tests/eval/stt_sentences.json
node tests/eval/stt_eval.mjs <dir> '[{"model":"Xenova/whisper-tiny","dtype":{"encoder_model":"fp32","decoder_model_merged":"q8"},"revision":"5332fcc35e32a33b86612b9a57a89be7906102b1"}]' fieldkit <cacheDir>
```
Use `none` instead of `fieldkit` to measure the old behaviour without FieldKit's audio preparation. To test Hindi,
add a config for `Xenova/whisper-small` at revision `2d67713f236afa48a18992566e7647f6ca848e13` with `"dtype":"q8"`.

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

### Assistant (0.2.5)
`assistant_eval.mjs` imports the app's TypeScript, so bundle it first, then run it with a cache directory and the model ids to compare:
```bash
npx esbuild tests/eval/assistant_eval.mjs --bundle --platform=node --format=esm --external:@huggingface/transformers --external:minisearch --outfile=tests/eval/.assistant_eval.bundle.mjs && node tests/eval/.assistant_eval.bundle.mjs <cacheDir> Xenova/paraphrase-multilingual-MiniLM-L12-v2
```
Without model ids, the script compares `Xenova/multilingual-e5-small` and `Xenova/paraphrase-multilingual-MiniLM-L12-v2`.

## Results (0.2.4, synthetic material, desktop)

### OCR (character error rate, lower is better)

| Case | Before (old code) | After (new code) |
|---|---|---|
| Large print | 0–1.3% | 0% (Chromium and WebKit) |
| Ordinary small print (the iPhone symptom: old confidence 20–46%) | 78–89% | OCR screen: 2.3–2.7% English, 2.0–4.6% Hindi. Photo-field path: 3.8–4.6% English, 4.6–7.2% Hindi. Confidence about 90% |
| Dim room with heavy shake | not measured | 72–94%. Still poor: the app reports the text as unreliable and asks for a retake. About 3–8 s on desktop |

The browser breakdown for the small-print rows is not separated in these results.

### Speech to text

| Model | English WER, clean | English WER, phone | Hindi CER, clean | Hindi CER, phone |
|---|---|---|---|---|
| Old tiny q8 (v1 pack, before) | 2.1% | 8.9% | unusable | unusable |
| New tiny v2 with FieldKit preparation | 1.6% | 3.7% | English only | English only |
| Whisper small q8 with preparation | 1.6% | 2.6% | 18.3% | 30.9% |

Whisper tiny cannot write Hindi. It romanises or translates it, or repeats phrases, even with the Hindi language set.

### Translation (chrF, higher is better)

| Direction and set | Plain (before) | `fieldkit` (after) |
|---|---|---|
| en→hi, general | 41.5 | 47.9 |
| en→hi, dictionary-term sentences | 30.8 | 49.6 |
| hi→en, general | 61.2 | 62.1 |
| hi→en, dictionary-term sentences | 48.9 | 63.7 |

Other measurements: fp32 en→hi scored 44.6 against 41.5 for q8, at four times the download. NLLB-600M (895 MB) and
M2M100 (632 MB) are too large for a phone web app, so OPUS-MT stays. Transformers.js 4.3.1 beam search is effectively
greedy.

## Results (0.2.5, assistant, synthetic material, desktop)

| Method | Retrieval top-1 en / hi | Intent top-1 en / hi |
|---|---|---|
| Keyword search (the 0.2.4 assistant) | 47% / 0% | – |
| `Xenova/multilingual-e5-small` | 74% / 92% | 76% / 91% |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (chosen, Apache-2.0, 118 MB) | 89% / 92% (top-3: 100% / 100%) | 81% / 82% |

- With word cues added to the meaning match, intent was 90.5% (en) / 90.9% (hi) on the set the cues were tuned on, and
  91% / 89% on fresh questions written afterwards. Fresh retrieval top-1 was 80% / 67% (8 questions).
- Off-topic separation: every in-scope question scored at least 0.36 similarity, and every off-topic question at most
  0.22. The threshold is 0.29.

The set is small and was written by the maintainers. Treat these numbers as a guide. None of them were measured on a phone.
