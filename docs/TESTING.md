# Testing FieldKit

All results below were produced on 2026-11-08/09 on Windows 11 with Hermes Agent **v0.23.0**, Python 3.11 and
Node 22. Anything not listed as run here is marked **unverified**.

## 1. Unit and API tests
```bash
uv venv .venv --python 3.11 && uv pip install --python .venv fastapi httpx pytest jsonschema pyyaml python-multipart
.venv/Scripts/python -m pytest            # 114 passed
npm ci --legacy-peer-deps && npm test     # 110 passed (vitest)
npm run typecheck
```

**Python** (`tests/python`):
- Engine against the shared vectors.
- Plugin API through FastAPI `TestClient`, with a stand-in auth gate that returns 401 when there is no session.
- Idempotent sync; resending identical content under a new key; 409 conflicts recorded and never overwritten; conflict resolution.
- Cross-user isolation for records, attachments and analysis.
- Attachment SHA-256 integrity, truncated uploads, MIME allowlist.
- Job retry with backoff, permanent failure and re-request; no double processing; schema-violating model output.
- The background worker processing a job automatically; report and follow-up persistence.
- Plugin registration matching `plugin.yaml`; every tool family through the real handlers.
- PWA file serving, the SPA fallback and path traversal.
- LLM calls go through **Hermes' real `agent.plugin_llm.PluginLlm`**, loaded from the installed Hermes source, using `make_plugin_llm_for_test` with an injected `sync_caller`. Only the provider round-trip is simulated.

**TypeScript** (`tests/app`, fake-indexeddb):
- The same condition and workflow vectors as Python, so both engines must agree.
- The sync state machine: ack → synced, network failure keeping the same idempotency key, 401 pause and resume, 409 conflict, 422 stopping retries but keeping the record, interrupted attachment upload then resume, report download.
- Offline Q&A in all three domains plus Hindi; unsupported-question detection; follow-ups and related topics.
- Dictionary exact, translation, prefix and fuzzy matches.

## 2. Hermes tooling
```bash
hermes plugins validate C:\path\to\FieldKit     # Validation passed (security scan: safe; declared tools match)
hermes plugins doctor  C:\path\to\FieldKit --ci # OK: 23 tool(s), 1 hook(s)
```

## 3. Integration against a real Hermes dashboard (throwaway home, nothing shared)
```bash
export HERMES_HOME=<scratch>/hermes-home         # contains plugins/fieldkit + config.yaml below
hermes dashboard --host 127.0.0.2 --port 9300 --isolated --no-open --skip-build
```
`config.yaml`: `plugins.enabled: [fieldkit]`, `plugins.entries.fieldkit.settings.public_url`, and
`dashboard.basic_auth.{username,password,secret,session_ttl_seconds: 120}`.
- Binding `127.0.0.2` turns on Hermes' real cookie auth gate while staying local to the machine.

Verified over HTTP:
- **Loading:** the plugin was discovered and registered (23 tools, 1 hook). `/api/dashboard/plugins` lists the FieldKit tab (`has_api: true`), and `/dashboard-plugins/fieldkit/dist/index.js` returns 200.
- **Auth gate:** without a session, `/api/plugins/fieldkit/records` and `/app/` return **401**. A bad password returns 401. After login, `/me` returns `demo` (basic provider).
- **PWA serving:** `/app/` returns `text/html`, `sw.js` returns `text/javascript`, the manifest returns `application/manifest+json`, and `precache.json` is served.
- **Analysis worker:** `/status` reported `analysis_mode: automatic`, `llm_available: true` and the worker running, so `register()` and `plugin_api.py` share a process.
  - The synced record's job was claimed automatically and sent to Hermes' real `ctx.llm`.
  - Hermes answered `AuxiliaryClientUnavailable: No LLM provider configured`, because the throwaway instance deliberately has no provider. The job stayed `pending` with backoff.

## 4. Browser end-to-end (real Chromium, real Hermes)
```bash
FIELDKIT_E2E_PASS=<password> npm run test:e2e            # offline.spec.ts
FIELDKIT_E2E_MODELS=1 FIELDKIT_E2E_PASS=<password> npm run test:e2e -- models.spec.ts
```
`offline.spec.ts` (**passed**):
- **Online setup:** sign in → service worker controls the page → download the workflow and its packs → Home shows "Ready to work offline" → **browser closed**.
- **Cold start with the network disabled:**
  - The app opens from the service worker.
  - The assistant answers "Explain common reasons for equipment vibration" with its source, and refuses "What is the capital of Peru?".
  - The dictionary finds `bearing → बेयरिंग`.
- **Workflow, offline:**
  - Choosing "vibration" reveals the conditional question; vibration is 9.2 and the guard answer is No.
  - GPS is captured (geolocation permission), and the "Explain / help" panel runs.
  - The workflow completes and the Results page shows "Saved locally. Pending synchronization.", the local findings (safety guard problem, vibration above alarm level) and the local label.
- **Browser closed and reopened offline:** the record and its results persist.
- **Online, session cookies deleted:**
  - Navigation still opens the cached app.
  - The app-wide banner says "Sign in to Hermes to continue syncing", and the queue shows "Waiting (1)".
- **Signed in again:** sync resumes and the server holds **exactly one** record (also after a forced re-sync), `sync_status: complete`.
  - Answers, local findings and GPS round-trip intact. The Results page shows "Saved to Hermes — confirmed" and the Hermes analysis status separately.

`login.spec.ts` (**passed**, 0.1.1):
- Signed out, Home offers **Sign in** → Hermes' own login page with `next=/dashboard-plugins/fieldkit/return.html` → username and password entered → the browser lands back in **FieldKit** (not the dashboard) and shows "Signed in as …".
- Home then offers **Download all 3 workflow(s)**; one tap leads to "Ready to work offline" with 3 workflows downloaded.

`unreachable.spec.ts` (**passed**, 0.1.3):
- **Network "up" (`navigator.onLine` true) but Hermes not reachable:**
  - A captive portal answers every API call with `200 text/html`, then connections are refused.
  - The header shows "no Hermes connection" and "1 awaiting confirmation". The Pending Sync screen says "Hermes: Not reachable", and the server has no such record (404).
- **When the outage lifts:** the record is confirmed **once** (revision 1), and the header shows "all confirmed" and "Hermes reachable".

`strict-offline.spec.ts` (**passed**, 0.1.4). Network cut for the page **and** the service worker; the server is checked by an independent online client:
- **A (browser offline):**
  - An inspection blocked by validation is shown as **"1 not submitted"** with a banner that stays on screen. The header never shows "all confirmed".
  - A valid offline record is saved and queued in IndexedDB before any request (inspected directly).
  - The header never shows "all confirmed" while offline, and the server has no record (404).
  - **Zero** requests reached the network, including app assets.
  - The record survives a full browser restart.
  - After reconnecting it **syncs automatically with no user action**, and `received_at` is after `completed_at`.
- **B (`navigator.onLine` = true, every request blocked):** no "all confirmed", no stale "Hermes reachable", server 404; it syncs automatically once unblocked.
- **Defect found by A:** Hermes sends `Vary: Origin`. The app's CORS module/style requests carry `Origin`, so the service worker's precache lookups missed, and offline launch silently depended on the evictable HTTP cache. Fixed with `ignoreVary` for FieldKit's own app files.

`lifecycle.test.ts` (vitest, 0.1.3):
- True offline submission: the record and its queue entry commit in one IndexedDB transaction.
- Reconnect.
- A captive-portal 200, or an ack for a different record, is rejected.
- A failed photo upload keeps the record "received" and counted.
- A non-FieldKit attachment response is rejected.
- A 422 counts as needing attention.
- The counter counts records, not queue entries.

`models.spec.ts` (translation and OCR):
- **Online:** installing *English → Hindi translation* downloads the pinned ONNX weights (~110 MB), runs a self-test, and **verifies size and SHA-256 of the cached weights** ("pinned files verified"). *OCR — English* also installs and runs.
- **Offline result:** see "Model results" below.

### Model results (`models.spec.ts` — **passed**)
- **Online install:** English→Hindi translation reported "pinned files verified": the size and SHA-256 of the cached ONNX weights matched `models.json`. OCR English loaded and ran its self-test.
- **Browser closed, then reopened with the network disabled:**
  - **Translation** "The pump is vibrating and the bearing is hot." → `पंप और भालू गर्म है.` This is real Hindi output computed on the device, but the **quality is limited**: "bearing" was rendered as *bear* (the animal) and "vibrating" was dropped. That's a known weakness of the small OPUS-MT model on technical text. Domain dictionaries cover technical terms.
  - **OCR** of a rendered label returned exactly `FIELDKIT OFFLINE 42`.
  - **Network proof:** every off-origin request was answered from FieldKit's own cache (`fieldkit-upstream-v1`: ONNX Runtime `.mjs` + `.wasm`, tesseract core, `eng.traineddata.gz`) or Transformers.js' model cache. Nothing reached the network.
- Hindi→English, Hindi OCR and Whisper speech-to-text use the same code paths and pinned manifests but **were not run end-to-end here** (download time).

Bugs found by these runs and fixed:
- `controllerchange` reloaded the page on first install.
- The sign-in URL pointed to `/api/login`.
- The Pending Sync screen didn't react to a 401 that arrived after it rendered; the banner is now app-wide.
- Transformers.js 4.3.1 requests `tokenizer_config.json` at revision `main` instead of the pinned revision, which breaks offline reloads. Worked around by pinning `remotePathTemplate`.
- Vite emitted ONNX Runtime's 26 MB WASM file; the external-WASM build is now used and the binary guard enforces it.
- The OCR core, loaded by `importScripts` in tesseract's worker, bypassed the service worker, so offline OCR silently depended on the browser's evictable HTTP cache. FieldKit now caches the pinned core itself and passes a `blob:` URL. The service worker also stores opaque responses for pinned URLs.

## Feature audit (2026-11-09, v0.1.5)

Real Hermes v0.23.0 (throwaway instance) + Playwright on **Chromium** and **WebKit** (Safari's engine, not iOS itself).

| Feature | Chromium | WebKit | Real iPhone |
|---|---|---|---|
| Saved Records across devices, one account, two isolated profiles (`accounts`) | ✅ | ✅ | ⏳ |
| Offline workflow, saved & queued, restart, auto-sync on reconnect (`strict-offline` A) | ✅ | ✅ | ✅ (rec_6b0da392e6284a70ae1bd33b, received 41 s after completion) |
| Network "up" but nothing reachable (`strict-offline` B) | ✅ | n/a (Playwright cannot block SW traffic in WebKit) | ✅ (user test) |
| Offline OCR (eng), pinned core from FieldKit cache (`models`) | ✅ | ✅ | ⏳ |
| Offline translation en→hi, SHA-256 verified weights (`models`) | ✅ | ✅ | ⏳ |
| Voice note record → save → offline Whisper transcription (`voice`) | ✅ (fake mic; accuracy not asserted) | n/a (no fake mic) | ⏳ |
| Downloaded Hermes report readable offline after cold restart (`reports`) | ✅ | ✅ | ⏳ |
| Dashboard tab in the real Hermes SPA, all 7 sections + definition view (`dashboard`) | ✅ | ✅ | ⏳ (hosted) |
| Real AI report (text-only fallback, GLM 5.3) | — | — | ✅ (hosted) |
| Hermes Mobile calling FieldKit tools | — | — | ⏳ |
| hi→en translation, Hindi OCR | ⏳ (same code path, not run) | ⏳ | ⏳ |

Run the extra suites:
```bash
FIELDKIT_E2E_PASS=<pw> FIELDKIT_E2E_DATA_DIR=<HERMES_HOME>/plugin-data/fieldkit npm run test:e2e -- reports.spec.ts dashboard.spec.ts
FIELDKIT_E2E_MODELS=1 FIELDKIT_E2E_PASS=<pw> npm run test:e2e -- voice.spec.ts models.spec.ts
FIELDKIT_E2E_BROWSER=webkit FIELDKIT_E2E_PASS=<pw> npm run test:e2e        # same suites on Safari's engine
FIELDKIT_E2E_PASS=<pw> FIELDKIT_E2E_DATA_DIR=<HERMES_HOME>/plugin-data/fieldkit npm run test:e2e -- accounts.spec.ts
```

### Saved Records across devices (`accounts.spec.ts`, 0.2.0)
Two isolated browser profiles signed into the same Hermes account:
- One Saved Records list with no duplicates, readable source names and availability badges; Download all works.
- Offline cold start: kept copies are readable, including the report. Records that were not downloaded show "Needs internet" and cannot be opened.
- A record saved offline syncs automatically on reconnect and appears on the other client.
- Both clients show the same Account ID. The Device ID appears only under Advanced.
- Another account on the same browser does not see the offline copies.

Results this run:
- **Chromium:** 16 passed, 3 skipped. The model and voice specs need `FIELDKIT_E2E_MODELS=1` (large downloads) and were not run this time.
- **WebKit:** 14 passed, 5 skipped. The same 3 skipped, plus two that `route()` cannot run under WebKit.

### Saved Records load errors (`records-errors.spec.ts`, 0.2.1)
Regression test for the 0.2.0 iPhone bug: Saved Records said "Offline" and "No records yet" while Hermes was reachable. The cause was that any failed request hid the account's records, even a 404 on the optional `devices` endpoint from a Hermes dashboard still running the 0.1.9 FieldKit router. The bug was reproduced with the 0.2.0 app against the real 0.1.9 server code (`GET records` returned 200 and `GET devices` 404). The fix was verified the same way in Chromium and WebKit: all of the account's records were listed, with "Hermes is running the FieldKit 0.1.9 server, but this app is 0.2.x. Restart the Hermes dashboard…".

The spec checks:
- The old server (404 on `devices`): records are still listed, with a restart message and no "Offline".
- A 500 on `records`: "HTTP 500" and Try again, never "No records yet" or "Offline", and the remembered list is labelled with its date.
- A network failure while online: "Can't reach Hermes".
- A 401: a sign-in prompt.
- A real offline state: "Offline" plus the remembered list.

The four simulated-failure cases use `route()`, so they run in Chromium only.

Results (0.2.1):
- **Chromium:** 22 passed, 3 skipped.
- **WebKit:** 16 passed, 9 skipped.

Two unrelated tests failed once each across these runs and passed on every re-run: `login.spec` (Chromium) and `settings.spec › storage state: protected` (WebKit).

### Records Hermes lost (`restore.spec.ts`, 0.2.2)
Regression test for the 0.2.1 iPhone report: Safari listed its records ("Available offline", confirmed by Hermes), while a new Home Screen app on the same account (same Account ID and sign-in method) showed none.

Reproduced on the test Hermes:
1. Install A synced two records.
2. Hermes was restarted on a fresh data store (the original moved aside, not deleted), as a new machine or replaced volume would be.
3. A fresh install B showed 0 records, with the same account.
4. A showed "Hermes doesn't have 2 record(s) from this device".
5. After **Upload again**, Hermes had 2 records for the account and B listed both.

The spec reproduces the same state in one run. It removes one record, and the uniquely named workflow it used, from the test database. It then checks:
- the fresh install doesn't list the record;
- A detects it;
- Upload again restores the exact workflow version and the record;
- B lists it once;
- both installs report the same data store.

It cleans up after itself. Results:
- **`restore.spec`:** passes on Chromium and WebKit.
- **Full suite (0.2.2):** Chromium 23 passed, 3 skipped; WebKit 17 passed, 9 skipped; no failures.

The intermittent WebKit `settings.spec › storage state: protected` failure was a test-harness bug. The init script overrode `persisted()` on the `navigator.storage` instance, which WebKit can replace after a garbage collection. It now patches the prototype. Before the fix, a forced-GC reproduction failed every time; after it, the reproduction passes.

### App-wide audit (`audit.spec.ts`, 0.2.3)
Checks each audit fix against the real test Hermes:
- **Home:** the Saved Records tile shows the account's total and how many records are available offline. After an offline cold start it still shows both, from the remembered list.
- **Sign-in on a new install:** a new install opening a Hermes link while signed out is asked to sign in, not told its session expired.
- **Retrying rejected records:** a record Hermes rejected because it lacked the workflow shows "Hermes didn't accept this record" and **Try again**. That first puts the workflow version back, and the record is then accepted. Before, such records stayed stuck with no retry.
- **Safe removal:** for a record Hermes no longer has, "Remove from device" isn't offered, and "Free up space" keeps it.
- **Backup import:** importing a backup with an unsent record queues it, and Hermes receives it.

Unit tests cover retrying a rejected record, and report refresh continuing past a record Hermes doesn't have.

Test-harness fixes found during the full runs:
- `login.spec` now waits out Hermes' login rate limit (HTTP 429) on the form, as `auth.ts` does for the API.
- `ui.spec` uses an always-present input.

Results (0.2.3):
- **Chromium:** 26 passed, 3 skipped.
- **WebKit:** 20 passed, 9 skipped.
- No failures on either.

### Real-iPhone findings (`media.spec.ts` + tests/eval, 0.2.4)
Offline testing on a real iPhone found the problems below. Each was reproduced or measured, fixed, and checked again on desktop engines. The owner then re-tested 0.2.4 on the iPhone with the Hermes mobile app and reported everything working (2026-11-09). All accuracy numbers come from synthetic test material, not real users' recordings or photos. The scripts and how to run them are in [tests/eval/README.md](../tests/eval/README.md).

**Root causes and fixes**
- **OCR (poor reading, 20–32% confidence, gibberish):**
  - Every photo was downscaled to 1800 px, and photo fields stored only a 1600 px copy. Ordinary print fell below the text size Tesseract needs.
  - tesseract.js defaults to page-segmentation mode 6 ("one uniform block"). On unevenly lit photos, layout analysis classed shaded body text as a picture and read only the heading.
  - Fixes: EXIF-aware decoding; OCR at 3000 px on the long side; illumination flattening and contrast stretch; PSM 3 (automatic layout) at 300 dpi; a flattened pass and a plain pass, keeping whichever recovers more confident text; a low-resolution orientation probe only when the result is weak; word-level filtering of edge marks and texture; a verdict (good, check or poor) with "retake closer, in good light" advice.
  - Photos are now stored at up to 2048 px JPEG, quality 0.85 (was 1600 px, quality 0.8).
- **Speech to text (poor voice transcription):**
  - Whisper tiny cannot write Hindi. It romanises or translates it, or loops ("5th year, 5th year…"), even with the Hindi language applied correctly.
  - The 8-bit encoder hurt English.
  - Fixes: trimming of leading and trailing silence; level normalisation; a repetition guard (`no_repeat_ngram_size` 4); a length cap based on duration; collapsing of residual loops; "No speech detected" for silent recordings.
  - The tiny pack is now version 2 (English only: fp32 encoder, 8-bit decoder, 63.6 MB; was 41 MB). Installed copies show an **Update** button and keep working until updated.
  - New optional pack `stt-whisper-small` (Hindi and English, 249 MB, slower). Hindi transcription uses it and otherwise says the Hindi pack is needed.
  - Translate's microphone now transcribes in the translation's source language. It used the app language before, which was a bug.
- **Translation (weak offline translation):**
  - Dictionary-guided terminology from installed dictionary packs: terms are replaced with placeholders that the model copies, then the dictionary translation is inserted. If the model drops a placeholder, the sentence is retranslated plainly.
  - Hindi danda punctuation; a line-preserving sentence split; the Translate screen lists the dictionary terms used.
- **Photo thumbnail and audio playback errors on Results:**
  - Each preview now copies the stored file into an in-memory Blob of the right type, and checks it against the SHA-256 recorded at capture. If the device copy is unreadable or damaged and Hermes has the file, Hermes' verified copy is shown and the device copy is repaired.
  - A file that can't be shown or played gives a plain message.
  - Metadata updates (OCR text, transcripts) and the post-upload "uploaded" flag no longer re-store the IndexedDB-backed Blob.
  - Recording uses MP4/AAC on Apple devices and WebM elsewhere, and only formats the device can play back. Recording is one complete file (no 1-second slices).
  - Results shows per-kind counts, field names and upload status. Transcripts are editable. Signatures show their time.
  - Records from other devices (`#/remote`) load photos, voice notes and signatures on demand from Hermes (needs internet, hash-verified).
  - **Honesty:** the exact iOS mechanism could not be reproduced on desktop WebKit. The fixes target the known iOS causes (IndexedDB-backed Blob object URLs, WebM playback).
- **Signatures, linking and analysis (the server side):**
  - A signature PNG was counted as a photo ("2 photo(s) attached but NOT analysed") and sent to the vision model.
  - Attachments are now classified by the workflow field they answer: photo, voice note (`audio`) or signature. Only photos go to the vision model, and counts are per kind.
  - Voice notes use the phone's transcript if present. Otherwise Hermes transcribes them after upload (dashboard process, Hermes' own `tools.transcription_tools.transcribe_audio`). The transcript, or the reason there is none, is stored on the attachment (DB migration v3: `transcript`, `transcript_source`, `transcript_error`, `transcribed_at`).
  - The analysis includes transcripts and lists an untranscribed voice note under `missing_information` with the reason.
  - Reports gain an `attachments` block. Integrity is recomputed from the stored file. No server file paths appear in reports.
  - Plugin setting `voice_transcription` (default `true`; environment variable `FIELDKIT_VOICE_TRANSCRIPTION=false`) turns Hermes-side transcription off.

**What each E2E test checks** (`tests/e2e/media.spec.ts`, Chromium and WebKit)
- Photo: an EXIF-rotated photo is stored upright.
- Voice note: recorded with Chromium's fake microphone only. Its accuracy is not asserted.
- Drawn signature: saved.
- Results loads every file with no error and shows the correct counts.
- Each file on Hermes is byte-identical (SHA-256) and linked to the same inspection and field.
- A deliberately damaged device copy is restored from Hermes.
- The real analysis pipeline, with the LLM round-trip stubbed, counts 1 photo, not 2.
- The downloaded report shows the signature as intact and viewable.
- A second install opens the record and views the signature from Hermes.
- A second E2E test checks real Hermes speech-to-text. It needs `FIELDKIT_E2E_SPEECH_WAV` and `FIELDKIT_E2E_SPEECH_TEXT`.

**Results**
- pytest: 114 passed (10 new in `tests/python/test_media_evidence.py`).
- vitest: 110 passed (19 new in `tests/app/media_quality.test.ts`). `npm run typecheck` is clean.
- `media.spec.ts`: Chromium passed (full suite 28 passed, 3 skipped). WebKit passed without the voice-note step (full suite 22 passed, 9 skipped). The spoken-voice-note test passed in both runs: Hermes transcribed "Water is leaking from the pump seal near the outlet valve." and "The safety guard on the conveyor belt is missing and needs replacement." from synthetic speech.
- Real Hermes speech-to-text, local Hermes v0.23.0 (inside its dashboard process): an uploaded synthetic English voice note ("The motor bearing is making a grinding noise and the housing feels hot.") was transcribed exactly, stored with source `hermes`, and appeared in the analysis prompt. The fake microphone's beep correctly gave "no speech recognised".

**OCR accuracy** (character error rate, CER; synthetic iPhone-style photos: 4032×3024, EXIF orientation 6, 2° skew, uneven light, noise, blur)

| Case | Before | After |
|---|---|---|
| Large print | 0–1.3% | 0% (Chromium and WebKit) |
| Ordinary small print (reproduces the iPhone symptom: old confidence 20–46%) | 78–89% | OCR screen: 2.3–2.7% English, 2.0–4.6% Hindi. Photo-field path: 3.8–4.6% English, 4.6–7.2% Hindi. Confidence about 90% |
| Dim room with heavy camera shake | not measured | 72–94%: still poor. The app says the text is unreliable and asks for a retake. About 3–8 s on desktop |

Browser breakdown for the small-print rows is not separated in these results.

**Speech-to-text accuracy** (Node, same ONNX files; 8 English and 6 Hindi sentences read by Windows voices; "phone" = quiet, 12 dB SNR noise, silence padding)

| Model | English WER, clean | English WER, phone | Hindi CER, clean | Hindi CER, phone |
|---|---|---|---|---|
| Old tiny q8 (before) | 2.1% | 8.9% | unusable | unusable |
| New tiny v2 with FieldKit preparation | 1.6% | 3.7% | not applicable (English only) | not applicable |
| Whisper small q8 with preparation | 1.6% | 2.6% | 18.3% | 30.9% |

**Translation accuracy** (Node, OPUS-MT, chrF; 16 general and 7 dictionary-term sentence pairs, one hand-written reference each)

| Direction and set | Plain (before) | With FieldKit pipeline (after) |
|---|---|---|
| en→hi, general | 41.5 | 47.9 |
| en→hi, dictionary-term sentences | 30.8 | 49.6 |
| hi→en, general | 61.2 | 62.1 |
| hi→en, dictionary-term sentences | 48.9 | 63.7 |

General quality is still limited by the small model. For example, "bearing" is fixed only when a dictionary has the term. Larger precision did not help (en→hi fp32 44.6 vs q8 41.5, at 4× the download). NLLB-600M (895 MB) and M2M100 (632 MB) are too large for a phone web app, so OPUS-MT stays.

## 5. Verification on real devices, and what is still open
**Verified by the owner on a real iPhone with the hosted Hermes and the Hermes mobile app (0.2.4, 2026-11-09, owner-reported):**
everything was checked and reported working, including the Hermes Mobile conversation with FieldKit tools, real model-generated
reports, OCR, translation, speech-to-text, photos, voice notes and signatures (the thumbnail and playback errors are gone),
offline reports and Saved Records across Safari and the Home Screen app.

**Still open:**
- Android Chrome.
- Scheduled analysis through a Hermes cron job.
- Measured error rates on real people's speech and real photos: the numbers above use synthetic voices and photos. Dim, shaky photos are still poor, and handwriting is not supported.

## Device checklist
Run on each phone over HTTPS:
1. Open the app link and sign in.
2. **Offline Packs:** download *Equipment inspection*; install English→Hindi, OCR English and Speech to text.
3. Install the PWA:
   - Android: menu → Install app.
   - iOS: Share → Add to Home Screen. Open the installed app and sign in again inside it.
4. Home: Offline readiness shows ✔ for the app, workflows and packs.
5. Turn on airplane mode. Swipe the app away completely, then reopen it from the home screen.
6. Use the assistant ("equipment vibration"), the dictionary ("bearing"), Translate ("The pump is vibrating."), and Scan text on a printed label.
7. Run the workflow:
   - Photo: camera opens, and the thumbnail appears.
   - Voice note: record, play back and transcribe.
   - GPS: accuracy is shown.
   - Signature.
   - Complete it, and check the Results page.
8. Swipe the app away, reopen it offline, and check that the record and results are still there.
9. Turn airplane mode off. If asked, sign in. Check Pending Sync is empty and the Results page says *Synchronised*.
10. Dashboard → FieldKit → Records: the record is there with its photo and audio.
11. After analysis, open Results and tap **Download report**. Turn airplane mode on again, and check the report is still readable.

Record: device model, OS and browser version, which steps passed, timings for translation and OCR, and any memory errors.

### Phase A: example rules and "needs review" calibration (0.2.5)
Found on the hosted Hermes: all 7 real inspections were flagged "requires review", and for pump PMP-0045 (rust and a
water leak written in the notes) the phone said "Low risk, continue routine monitoring" while Hermes' report said the
local score was inconsistent with the evidence.
- **Example rules:** the equipment inspection now reads rust, corrosion and leaks from the notes, the voice-note transcript
  and photo text (English and Hindi keywords), scores them, and its recommended action has a "Repair within 7 days and
  re-inspect" step. The PMP-0045 answers now give Medium risk and that action (`tests/python/test_phase_a.py`, and the
  same case in `tests/app/engine.test.ts` for the phone's engine). The crop survey also flags spots, lesions, blight and rot.
- **Safe upgrades:** an installed example moves to the new version only if it is unchanged from the old bundled version
  (content hash); edited examples are never touched; old records keep their workflow version. Verified on the local Hermes
  (`equipment-inspection` and `crop-health-survey` published v2).
- **Calibration:** a report needs review only for a high/critical finding (from Hermes or the phone's rules) or when Hermes
  states a reason (conflicting evidence, a decisive gap, a required sign-off). The reasons are stored as `review_triggers`.
  A routine leak inspection with a clear repair action is no longer flagged.
- Results: pytest 129 passed, vitest 112 passed, Chromium E2E 28 passed / 3 skipped (model downloads).

### Phase B: workspace model, evidence rules and publishing (0.2.5)
`fieldkit_core/workspace.py`, DB migration v4 (additive), `tests/python/test_workspace_model.py` (19 tests, fixture
`tests/python/workspace_fixtures.py`, whose quotes are illustrative test text, not real regulation wording).
- Source tiers come from the declared type **checked against the domain**: a forum is excluded even if it claims to be a
  government source; a "government" page on a non-government domain is downgraded to tier 2.
- Evidence status is **computed by FieldKit**, never taken from the model: verified (tier-1 quote that applies, or two
  independent tier-2 publishers), supported, conflicting, user_procedure, unverified.
- Unverified model knowledge cannot become a decision-guide action, a rule threshold, or a procedure/troubleshooting
  entry (rejected); it may only be labelled background. Conflicting evidence must name an escalation.
- Decision guides are validated as executable graphs (start, reachability, cycles, dead ends, unknown fields/slots,
  decisions on the report policy's scale). Every stated responsibility must be served by a workflow, guide or entry.
- Publishing creates normal workflows plus `ws-<id>` (workspace), `ws-<id>-knowledge` and `ws-<id>-dictionary` packs, so
  existing sync, SHA-256 checks and update detection apply. Invalid drafts are stored but cannot be published.
- The three bundled examples are now also starter workspaces, labelled synthetic. Existing workflows, records and phones
  are unchanged. Results: pytest 148 passed; Chromium E2E 27 passed / 4 skipped.

### Phase C: Hermes builds the workspace (0.2.5)
- **Onboarding:** `ctx.register_system_prompt_section("fieldkit.workspace")` tells every new Hermes session whether the
  user has a workspace yet (offer to build one) or summarises the built ones (verified / conflicting / gaps).
- **Skill** `fieldkit-workspace-builder`: interview (responsibilities and the decisions each needs, tools, procedures,
  region, languages, escalation) → confirmed brief → research with Hermes' own `web_search` and `web_extract`, quoting the
  exact clause with its location → build → research report → publish only with the user's approval.
- **Tools (6 new, 29 total):** `fieldkit_workspace_format`, `fieldkit_save_workspace_brief` (incomplete briefs cannot be
  confirmed), `fieldkit_build_workspace` (refuses an unconfirmed brief; **re-fetches web pages and drops quotes that are not
  on the page**; PDFs marked not checked; private/loopback/metadata addresses are never fetched), `fieldkit_publish_workspace`
  (requires `user_approved`), `fieldkit_get_workspace`, `fieldkit_list_workspaces`.
- **Phone:** `#/workspace/<id>` (the link Hermes returns) shows the role, responsibilities, workflows, decision guides,
  evidence summary, sources and gaps, with **Download everything for offline**; Home shows "Your workspace".
- Tests: `tests/python/test_plugin.py` (builder flow through the tools, excerpt check, unsafe URLs), `tests/e2e/workspace.spec.ts`
  (publish → link → one-tap download → offline cold restart). pytest 151 passed; Chromium E2E 28 passed / 4 skipped;
  `hermes plugins validate` passed; `doctor --ci`: 29 tools, 1 hook.
- Not verifiable here: a real Hermes conversation that runs the interview and live web research (needs the hosted Hermes).
