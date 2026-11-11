# Third-party components and asset provenance (0.3.2)

FieldKit commits **no compiled binaries, WebAssembly or model weights**. `scripts/postbuild-app.mjs` fails the build if
any ELF, Mach-O, PE or WebAssembly file would ship.

## Shipped JavaScript
Bundled into `dashboard/app_dist` (phone app) and `dashboard/dist` (dashboard tab). Versions are pinned in `package.json`.

| Package | Version | License | Use |
|---|---|---|---|
| @huggingface/transformers | 4.3.1 | Apache-2.0 | Offline sentence translation (optional pack) |
| onnxruntime-web, JavaScript only (`onnxruntime-web-use-extern-wasm` build) | 1.31.0-dev.20260914-8d85527a0 | MIT | Runtime used by Transformers.js |
| tesseract.js, with its `worker.min.js` in `dashboard/app_dist/vendor/tesseract` | 7.0.0 | Apache-2.0 | Offline OCR (optional pack) |
| idb | 8.0.4 | ISC | IndexedDB wrapper |
| wasm-feature-detect | 1.8.0 | Apache-2.0 | Picks the tesseract core variant (SIMD or relaxed SIMD) |
| qrcode-generator | 2.0.4 | MIT | QR code in the dashboard tab |

The dashboard tab uses React and UI components from the Hermes dashboard itself; FieldKit does not bundle them.

## Downloaded to the phone only when the user installs a pack
Pinned in `fieldkit_core/models.json`, which is also the catalog the phone reads. Files come from their official
upstream hosts and are cached on the device.

| Pack | Files | License | Integrity |
|---|---|---|---|
| English → Hindi translation | `huggingface.co/Xenova/opus-mt-en-hi` @ `7aad72006a1588a9c3485ed6203aed99eebbc872` (quantized ONNX, about 110 MB) | Apache-2.0 (Helsinki-NLP OPUS-MT) | SHA-256 of each file checked after download |
| Hindi → English translation | `huggingface.co/Xenova/opus-mt-hi-en` @ `99853100ed9d932987a6816e8cf7b1b6742a6116` (quantized ONNX, about 110 MB) | Apache-2.0 (Helsinki-NLP OPUS-MT) | SHA-256 of each file checked after download |
| Translation runtime | `cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/` (WebAssembly) | MIT | Exact npm version in the URL |
| OCR English, OCR Hindi | `cdn.jsdelivr.net/npm/@tesseract.js-data/{eng,hin}@1.0.0/4.0.0_best_int/` | Apache-2.0 (tessdata_best) | Exact npm version in the URL |
| OCR runtime | `cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/` (WebAssembly) | Apache-2.0 | Exact npm version in the URL |

## Network calls
- The phone app contacts `huggingface.co` (and its file hosts `*.hf.co`) and `cdn.jsdelivr.net` **only** when the user
  installs a translation or OCR pack. Everything else goes to the user's own Hermes.
- The plugin backend makes no third-party calls and no model calls.

## Python
| Package | Constraint | License | Use |
|---|---|---|---|
| jsonschema | `>=4.17,<5` | MIT | Form validation |
| fastapi | provided by Hermes | MIT | Plugin API |

## Not shipped (development and tests only)
- Build: vite, esbuild, typescript. Tests: vitest, fake-indexeddb, @playwright/test, pytest, httpx.
- `sharp` (Apache-2.0) makes the synthetic OCR test photos in `tests/eval/make_ocr_photos.mjs`. It is installed as a
  dependency of `@huggingface/transformers`.

## Test data
`tests/fixtures/forms/*.json` are three synthetic forms (equipment inspection, classroom observation, crop health
survey) written for FieldKit's tests, released under CC0-1.0. They are illustrative only, not safety, medical or
agronomic advice.
