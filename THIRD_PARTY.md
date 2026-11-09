# Third-party components and asset provenance

FieldKit commits **no compiled binaries, WebAssembly or model weights**. `scripts/postbuild-app.mjs` fails the
build if any ELF, Mach-O, PE or WASM file would ship.

## Bundled JavaScript (in `dashboard/app_dist`, `dashboard/dist`)
| Package | Version | License | Use |
|---|---|---|---|
| @huggingface/transformers | 4.3.1 | Apache-2.0 | On-device translation and speech-to-text |
| onnxruntime-web (JS only, `onnxruntime-web-use-extern-wasm` build) | 1.31.0-dev.20260914-8d85527a0 | MIT | Inference runtime used by Transformers.js |
| tesseract.js (incl. vendored `worker.min.js`) | 7.0.0 | Apache-2.0 | On-device OCR |
| idb | 8.0.4 | ISC | IndexedDB wrapper |
| wasm-feature-detect | 1.8.0 | Apache-2.0 | Picks the tesseract core variant (SIMD / relaxed SIMD) |
| minisearch | 7.2.0 | MIT | Offline full-text search |
| qrcode-generator | 2.0.4 | MIT | QR code in the dashboard tab |

## Fetched on the device at setup time (pinned, from upstream, then cached)
| Asset | Pinned URL / revision | License | Integrity |
|---|---|---|---|
| ONNX Runtime WASM | `cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.{wasm,mjs}` | MIT | Versioned URL (npm registry content) |
| tesseract core | `cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/` | Apache-2.0 | Versioned URL |
| Tesseract language data | `cdn.jsdelivr.net/npm/@tesseract.js-data/{eng,hin}@1.0.0/4.0.0_best_int/` | Apache-2.0 | Versioned URL |
| OPUS-MT en→hi (ONNX) | `huggingface.co/Xenova/opus-mt-en-hi` @ `7aad72006a1588a9c3485ed6203aed99eebbc872` | Apache-2.0 (Helsinki-NLP) | SHA-256 of weights verified after download |
| OPUS-MT hi→en (ONNX) | `huggingface.co/Xenova/opus-mt-hi-en` @ `99853100ed9d932987a6816e8cf7b1b6742a6116` | Apache-2.0 | SHA-256 verified |
| Whisper tiny (ONNX, English; fp32 `encoder_model.onnx`, 8-bit `decoder_model_merged_quantized.onnx`) | `huggingface.co/Xenova/whisper-tiny` @ `5332fcc35e32a33b86612b9a57a89be7906102b1` | Apache-2.0 (OpenAI) | SHA-256 verified |
| Whisper small (ONNX, Hindi and English; 8-bit) | `huggingface.co/Xenova/whisper-small` @ `2d67713f236afa48a18992566e7647f6ca848e13` | Apache-2.0 (OpenAI) | SHA-256 verified |

**Network calls (disclosed per catalog rules):**
- The PWA contacts `huggingface.co` (and its CDN `*.hf.co`) and `cdn.jsdelivr.net` **only** when the user installs an on-device model pack.
- Analysis goes through Hermes' own `ctx.llm`, with the user's configured provider.
- Voice-note transcription on the server (0.2.4) uses Hermes' own speech-to-text (`tools.transcription_tools.transcribe_audio`). That may be a local engine or a cloud provider, if the Hermes operator configured one. It can be turned off with the `voice_transcription` setting.

## Demo content
`examples/*` are synthetic workflows, knowledge and glossaries written for FieldKit (CC0-1.0). They are illustrative only: not safety, medical or agronomic advice.

## Evaluation tools (`tests/eval`, not shipped)
- Windows' built-in voices (en-US, en-IN, hi-IN) are used by `tests/eval/tts.ps1` only to generate local test audio. The audio is not distributed.
- `sharp` generates the synthetic photos in `tests/eval/make_ocr_photos.mjs`. It is installed in `node_modules` as a dependency of `@huggingface/transformers` (listed in `package-lock.json`). `package.json` does not declare it directly.

## Python
| Package | Constraint | License |
|---|---|---|
| jsonschema | `>=4.17,<5` | MIT |
| fastapi (provided by Hermes) | — | MIT |
