# Third-party components and asset provenance (0.3.1)

FieldKit commits **no compiled binaries, WebAssembly or model weights**. `scripts/postbuild-app.mjs` fails the
build if any ELF, Mach-O, PE or WASM file would ship.

## Bundled JavaScript (in `dashboard/app_dist`, `dashboard/dist`)
| Package | Version | License | Use |
|---|---|---|---|
| @huggingface/transformers | 4.3.1 | Apache-2.0 | On-device sentence translation |
| onnxruntime-web (JS only, `onnxruntime-web-use-extern-wasm` build) | 1.31.0-dev.20260914-8d85527a0 | MIT | Inference runtime used by Transformers.js |
| tesseract.js (incl. vendored `worker.min.js`) | 7.0.0 | Apache-2.0 | On-device OCR |
| idb | 8.0.4 | ISC | IndexedDB wrapper |
| wasm-feature-detect | 1.8.0 | Apache-2.0 | Picks the tesseract core variant (SIMD / relaxed SIMD) |
| qrcode-generator | 2.0.4 | MIT | QR code in the dashboard tab |

## Fetched on the device at setup time (pinned, from upstream, then cached)
| Asset | Pinned URL / revision | License | Integrity |
|---|---|---|---|
| ONNX Runtime WASM | `cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.{wasm,mjs}` | MIT | Versioned URL (npm registry content) |
| tesseract core | `cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/` | Apache-2.0 | Versioned URL |
| Tesseract language data | `cdn.jsdelivr.net/npm/@tesseract.js-data/{eng,hin}@1.0.0/4.0.0_best_int/` | Apache-2.0 | Versioned URL |
| OPUS-MT en→hi (ONNX) | `huggingface.co/Xenova/opus-mt-en-hi` @ `7aad72006a1588a9c3485ed6203aed99eebbc872` | Apache-2.0 (Helsinki-NLP) | SHA-256 of weights verified after download |
| OPUS-MT hi→en (ONNX) | `huggingface.co/Xenova/opus-mt-hi-en` @ `99853100ed9d932987a6816e8cf7b1b6742a6116` | Apache-2.0 (Helsinki-NLP) | SHA-256 of weights verified after download |

Pinned values are in `fieldkit_core/models.json`, which is also the catalog the phone reads.

**Network calls (disclosed per catalog rules):**
- The phone app contacts `huggingface.co` (and its CDN, `*.hf.co`) and `cdn.jsdelivr.net` **only** when the user installs a translation or OCR pack.
- The plugin backend makes no third-party calls and no model calls. Hermes analyses synced data only when the user asks.

## Demo content
`tests/fixtures/forms/*.json` are three synthetic example forms (Equipment inspection, Classroom observation, Crop health
survey) written for FieldKit. They were first released as CC0-1.0 examples. They are used by the tests and by
`tests/fixtures/seed.py`, and are illustrative only: not safety, medical or agronomic advice.

## Evaluation tools (`tests/eval`, not shipped)
- `sharp` (Apache-2.0) generates the synthetic photos in `tests/eval/make_ocr_photos.mjs`. It is installed in `node_modules` as a dependency of `@huggingface/transformers` (listed in `package-lock.json`). `package.json` does not declare it directly.

## Python
| Package | Constraint | License |
|---|---|---|
| jsonschema | `>=4.17,<5` | MIT |
| fastapi (provided by Hermes) | — | MIT |
