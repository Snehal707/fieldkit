# Testing FieldKit


> **Current behaviour (0.3.0), in short.** FieldKit collects and syncs; it never calls a model. Workspaces are set up,
> edited and undone by Hermes conversation, and Hermes publishes only after the user approves. Hermes has 12 tools and
> reads entries, photos and voice notes with its own tools when asked. The sections below are a dated log, and later
> sections replace earlier ones. The latest results are in "Final audit and fixes (2026-11-11, commit 5d77969)" at the end.
>
> Sections before 0.3.0 describe removed features (assistant, decision guides, reports, questions, speech-to-text).

All results below were produced on 2026-11-08/09 on Windows 11 with Hermes Agent **v0.23.0**, Python 3.11 and
Node 22. Anything not listed as run here is marked **unverified**.

## 1. Unit and API tests
```bash
uv venv .venv --python 3.11 && uv pip install --python .venv fastapi httpx pytest jsonschema pyyaml python-multipart
.venv/Scripts/python -m pytest            # 117 passed
npm ci --legacy-peer-deps && npm test     # 126 passed (vitest)
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
2. **Workspace:** set one up by chat (or use a synthetic starter workspace on a test Hermes), open it, and tap **Download everything for offline**.
3. **Offline Packs (optional):** install English→Hindi translation and OCR English (Hindi→English and OCR Hindi if needed).
4. Install the PWA:
   - Android: menu → Install app.
   - iOS: Share → Add to Home Screen. Open the installed app and sign in again inside it.
5. Home: Offline readiness marks the app, workspace and packs as ready.
6. Turn on airplane mode. Swipe the app away completely, then reopen it from the home screen.
7. Use Translate ("The pump is vibrating."), and Scan text on a printed label or Extract text on a photo inside a form.
8. Record an entry in the workspace's form:
   - Photo: camera opens, and the thumbnail appears.
   - Voice note: record and play back.
   - GPS: accuracy is shown.
   - Signature.
   - Complete it, and check the entry.
9. Swipe the app away, reopen it offline, and check that the entry and its files are still there.
10. Turn airplane mode off. If asked, sign in. Check Pending Sync is empty.
11. Dashboard → FieldKit → Records: the entry is there with its photo and audio.
12. In Hermes chat, ask about the entry. Hermes reads it, and its photo and voice note, with its own tools.

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

### Phase D: reports that help decide (0.2.5)
- **Report v2** (`fieldkit_core/decision.py`, `analysis.py`): a decision on the workspace's scale (or the default
  stop / act soon / monitor / no action) with rationale, honest confidence, deadline and escalation; issues that cite
  record evidence (field, attachment, local finding, previous record, follow-up check) and interpret it; ordered next
  actions with who, by when and **how to verify it worked**, marked as from a workspace guide/knowledge entry or as an AI
  suggestion; what is uncertain and how to resolve it; differences from the phone's findings; checks for next time;
  translations for the workspace's other languages.
- **Enforced after the model answers:** issues without record evidence, restated answers, actions without a check,
  citations of guides/knowledge that are not in the workspace (only verified/supported entries are offered), a
  critical/high decision without escalation, and "high" confidence with a decisive unknown are problems. Hermes gets
  **one repair pass**; anything left is shown on the report and triggers review.
- Next actions and checks become follow-up tasks that say how to verify them. Older (v1) readers still get
  `suggested_actions` and `followups`.
- **Phone:** the report leads with the decision, then actions (with "How to do this offline" for guide-backed steps),
  why, what is uncertain and checks for next time, with a language switch. **The next inspection of the same subject asks
  the previous report's checks** (Done / Not done / Can't check + reading); the answers travel with the new record.
- Tests: `tests/python/test_decision_reports.py` (15), `tests/e2e/decision.spec.ts`. pytest 166 passed; Chromium E2E
  30 passed / 3 skipped.

### Phase E: the offline assistant understands (0.2.5)
- **Model choice by measurement** (`tests/eval/assistant_eval.mjs`, `tests/eval/assistant_set.json`, written by us; synthetic):
  | Method | Retrieval top-1 en / hi | Intent top-1 en / hi |
  |---|---|---|
  | Keyword search (the 0.2.4 assistant) | 47% / 0% | – |
  | `Xenova/multilingual-e5-small` | 74% / 92% | 76% / 91% |
  | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (chosen, Apache-2.0, 118 MB) | 89% / 92% (top-3: 100% / 100%) | 81% / 82% |
  With word cues added to meaning: intent 90.5% / 90.9% on the set the cues were tuned on, and **91% / 89% on fresh
  questions written afterwards**; fresh retrieval top-1 80% / 67% (8 questions). Off-topic separation: every in-scope
  question ≥ 0.36 similarity, every off-topic one ≤ 0.22 (threshold 0.29).
- **Design** (`app/src/assistant*.ts`, `guides.ts`): intent by meaning + cues; follow-ups and references ("issue 2",
  "what about the seal?", "दूसरी समस्या") from dialogue state; workspace terms linked in both languages; routing to the
  report (explain issue with the record's values, why, what next, is it safe, summary), decision guides (filled from the
  record, asking only what is missing, typed answers, outcome with each action's evidence status), the dictionary, cited
  requirements, earlier records of the same subject, or knowledge. Answers come only from that content, with citations,
  evidence status and uncertainty; nothing is generated. Below the support threshold it says "not covered" and queues a
  **knowledge gap** for Hermes. Voice (Whisper) and photo text (OCR) feed the same pipeline. Without the model it falls
  back to content-word search (labelled "Basic search").
- **Phone:** chat with Translate, Read aloud and 👍/👎 per answer; "Ask about this report" from Results and remote
  records; decision guides at `#/guide/<workspace>/<guide>` (report actions and workspace page link there).
- Bugs found by the tests and fixed: a guide took a free-text sentence as a numeric reading (input types are now inferred
  from the guide's conditions); a weak intent match answered an off-topic question ("yesterday" ≈ "last time"); basic mode
  matched on "what/the".
- Tests: `tests/app/assistant.test.ts` (13), `tests/e2e/assistant.spec.ts` (real model, offline after a cold restart:
  paraphrase starts the right guide, typed answers, evidenced outcome, Hindi understood, off-topic refused and queued,
  no network requests) — **passed in Chromium and WebKit**. vitest 124, pytest 166, Chromium 29 passed / 5 skipped,
  WebKit 23 passed / 11 skipped.

### Phase F: learning that tells suggestions, feedback and verified outcomes apart (0.2.5)
- **Inputs kept apart** (`fieldkit_core/learning.py`): AI suggestions (report actions) are never evidence; user feedback
  (👍/👎 on answers, "Did this report help you decide?") can only flag content for review; **verified outcomes** come only
  from follow-up checks answered on a later inspection and are derived on Hermes from the synced record (a phone cannot
  submit them directly); unanswered offline questions are knowledge gaps.
- **Candidates:** gaps are clustered into research candidates; ≥3 consistent verified outcomes (≥80% worked, distinct
  records) propose a "local practice", labelled "Learned from your team's verified outcomes (worked in k of n)"; negative
  feedback proposes a review. Each needs the user's confirmation; accepting a practice creates a validated new workspace
  version with a changelog; rejected candidates are never proposed again. The evidence status `local_practice` is
  recomputed by FieldKit and refused if the outcomes don't add up.
- **Tools (3 new, 32 total):** `fieldkit_propose_workspace_changes`, `fieldkit_list_learning`, `fieldkit_decide_candidate`
  (`user_confirmed`). The onboarding prompt mentions open candidates and unanswered questions. Schedule it with a Hermes
  cron job if wanted: `hermes cron create "every 24h" "Call fieldkit_propose_workspace_changes for my FieldKit workspaces
  and tell me what needs a decision." --skill fieldkit-workspace-builder` (not verified here).
- **Phone:** queued events upload after each sync (`POST learning/events`, idempotent); the workspace page shows
  "Update available" with the changelog.
- Tests: `tests/python/test_plugin.py::test_learning_loop_through_tools` (AI suggestion alone → nothing; 2 outcomes → nothing;
  can't-check never counts; 3 → candidate; helpful feedback → nothing; clustering; confirmation required; rejection
  remembered; accept → valid v2 → publish), `test_local_practice_needs_real_outcomes`, `test_learning_events_api`
  (phones can't submit outcomes; idempotent; outcomes extracted on sync), `tests/app/sync.test.ts` (upload once),
  `tests/e2e/learning.spec.ts` (offline gap + 👎 → Hermes after sync → candidates → practice published as v2 → phone
  update labelled) — passed in Chromium and WebKit. pytest 170, vitest 126, Chromium E2E 30 passed / 5 skipped.

### 0.2.5 final run (all phases)
- pytest **170 passed**; vitest **126 passed**; typecheck clean; `hermes plugins validate` passed; `hermes plugins doctor . --ci`:
  32 tools, 1 hook; `npm audit`: 0 vulnerabilities.
- Playwright (35 tests in 20 files) against the local Hermes v0.23.0: **Chromium 30 passed / 5 skipped, WebKit 24 passed / 11
  skipped, no failures.** Skipped: the model-download tests (`FIELDKIT_E2E_MODELS=1`; the assistant one was run separately and
  passed in both engines), the spoken-audio test (needs a WAV), and tests WebKit cannot run (fake microphone, `route()` with a
  service worker).
- Found while running: after hundreds of runs the throwaway test instance held 504 records, and two tests failed in WebKit
  because Saved Records loads at most **500 records per account** and lost-record detection pauses when the list is not
  complete (behaviour since 0.2.2). The full suite passed on a fresh test database (the old one was kept, renamed). This
  is a real limit for very large accounts and is listed in the README's known limitations.
  *Historic: this limit was removed in commit 91be7e3. Saved Records now pages through the whole account (`GET records`
  takes `offset`).*

### 0.2.6: workspace builder fix
- **Part-by-part build:** `fieldkit_start_workspace_build`, `fieldkit_add_workspace_parts` (with `dry_run`),
  `fieldkit_workspace_build_status`. `fieldkit_build_workspace` takes `workspace_id` or the older `brief_id` and `bundle`.
- **Schemas** (`fieldkit_core/workspace_schema.py`): per-part JSON Schemas (Draft 2020-12), a valid example per part,
  repairs of unambiguous shape mistakes (reported as `fixed_automatically`), cross-reference and type checks.
  `validate_bundle` runs the same checks, so publishing is as strict.
- **Background quote checks:** pages fetched by a 6-worker pool, cached in memory and in `source_pages` (migration v5).
  Publishing is refused while a check is pending. PDFs are checked too, with Hermes' own document extractor
  (`tools.read_extract`); a scanned PDF with a garbled text layer can give an `approximate` match (every number must
  still match exactly), which is reported for checking by eye. `fieldkit_get_workspace` is compact unless
  `include_bundle` is set.
- **Phone packaging:** guide questions that read a workflow field carry that field's label, all its options and the
  matching input (`workspace.phone_guides`).
- **Tests:**
  - `tests/python/test_workspace_schema.py` (16 tests): schemas, examples, repairs, item errors with paths and hints,
    cross-references, type checks, bounded and cached page checks, PDF checks, approximate matches in scanned text,
    guide keys written inside `nodes`, phone guide packaging.
  - `tests/python/test_plugin.py`: a part-by-part tool flow test (start, add parts, dry run, status, build, publish).
  - `tests/python/conftest.py`: clears the page cache between tests.
- **Results:** pytest **191 passed**; vitest **128 passed**; typecheck clean. `hermes plugins validate .` passed;
  `hermes plugins doctor . --ci`: fieldkit 0.2.6, **35 tools, 1 hook**.
- **Real Hermes conversation (0.2.6, 2026-11-10).** Local throwaway Hermes v0.23.0 logged into Nous Portal (model
  `x-ai/grok-4.7`, web search and extract through the Nous Tool Gateway). The tester played a milk-collection-centre
  checker near Pune. Not run on the hosted Hermes.
  1. *Interview:* Hermes asked about duties, decisions, instruments, SOPs, rules, languages, escalation and
     connectivity; saved the brief; showed the summary; built nothing until the tester confirmed.
  2. *Research and build (same chat):* `fieldkit_start_workspace_build`, schemas per part, web search/extract, then
     parts added one by one: 5 sources (FSSAI x2, BIS, NDDB x2), 10 evidence items, decision policy, 1 workflow
     (14 fields), 1 guide (21 nodes), 4 knowledge entries, 6 vocabulary terms, 4 intents, 5 gaps, traceability.
     Every FieldKit call took 0.01-0.04 s. One item was rejected (the guide: `title`/`start`/`workflow_id` written
     inside `nodes`); Hermes fixed it from the error and hint and resubmitted. First `fieldkit_build_workspace`:
     **valid, 0 errors** (0.04 s). Hermes then showed an honest review (verified / supported / gaps) and asked
     before publishing. The model provider returned "at capacity" several times; the turn recovered.
  3. *New chat (resume):* "I'm back... double-check the quotes". Hermes called `fieldkit_workspace_build_status`,
     found the saved build and continued. With PDF checks enabled, the rebuild fetched and extracted all 5 PDFs in
     15 s: 17 of 19 quotes found; the 2 BIS quotes were not found (scanned 1982 PDF with a garbled text layer), so
     that claim dropped to unverified. Hermes found a clean reprint of the same method (Andhra Pradesh milk rules,
     labelled as not a Maharashtra rule), quoted it, and rebuilt: version 4 valid, 20 of 20 quotes found,
     8 verified, 2 supported, 0 unverified, 6 gaps.
  4. *Publish:* on "Yes, publish it", Hermes called `fieldkit_publish_workspace` with `user_approved` and returned the
     app link.
  5. *Phone (WebKit, offline after download):* the published workspace downloaded in one tap; its guide ran offline
     to "Re-test once" for cow milk with fat 3.0 %. This step found the phone packaging bug above (raw field id and a
     single option shown); fixed and re-checked.
  The quotes in this run come from public regulator and standards pages; they are not committed to the repository.
- **Fast setup (0.2.6, after the dairy run took ~17 min).** The research-first build spent ~12.5 min in 37 model calls
  (context grew to ~127k tokens of page text) and ~4.3 min in 17 web calls; FieldKit itself took 0.4 s. Setup now builds
  from the interview: the user's stated rules are a `user_statement` source and their documents `user_document`, both
  shown as "Your procedure"; Hermes adds every part in one `fieldkit_add_workspace_parts(parts={...})` call; web research
  is optional, targeted and short (skill sections 4-5).
- **Real Hermes conversation, fast setup (2026-11-10, same local Hermes + Nous, `x-ai/grok-4.7`).** A cotton farmer
  group (FPO) coordinator in Jalna, Maharashtra. Interview: 52 s + 85 s (Hermes asked for their decisions, records and
  their own rules, and refused to guess what a "problem plot" is). Build turn, from "Yes, build it" to the review
  message: **140 s**, with **0 web calls**; all ten parts in **one** add call, nothing rejected, first build valid
  (5 rules as "Your procedure", 0 shown as verified, 2 gaps such as "no whitefly threshold given: ask the KVK"). Publish:
  16 s. On the phone (WebKit, offline after download) the guide asked three yes/no questions and reached "Spray now",
  citing "Your procedure" and telling the worker to ask the KVK for product and dose (no dose given).
- **Setup time across jobs (2026-11-10, same local Hermes + Nous, `x-ai/grok-4.7`, scripted answers).** Build turn
  (from "Yes, build it" to the review message) and total Hermes time including the interview: ASHA worker 204 s / 339 s,
  electrical safety inspector 152 s / 242 s, student water survey 143 s / 272 s, restaurant food safety 98 s / 159 s,
  cotton FPO 140 s / 277 s: **average build ~2.5 min, total ~4.3 min**; every first build valid, no web calls, every rule
  "Your procedure", no doses. A lawyer conversation stalled in the model (no response) and was not completed.
- **Field trial of those workspaces (2026-11-10, Chromium, phone viewport, one device with 4 workspaces and the
  question-understanding pack; temporary script, not committed).** Per workspace: fill a realistic visit offline in the
  real form, read the on-phone result, ask the offline assistant 4 questions, sync, wait for the real Hermes report,
  then ask 2 questions about the visit offline.
  - Times: pack install 43-48 s (once); filling + on-phone result ~4.4 s (automated); sync 0.2 s; assistant answers
    0.1-0.4 s; real Hermes reports: 61 s (ASHA) and 326 s (electrical, after a rate-limit wait).
  - Reports were written by Hermes' auxiliary model for plugins (`stepfun/step-3.7-flash:free` on this install), which
    Nous Portal rate-limited (HTTP 429, retry_after 30-57 min). Found: FieldKit used to burn its 3 attempts in ~100 s
    and mark the reports failed. Fixed: a rate limit waits as told without using an attempt and the record stays
    pending (re-run: deferred jobs completed or stayed "waiting", none failed). Which model plugins use is a Hermes
    setting (`auxiliary` config), not FieldKit's.
  - Offline assistant, first run: 10 of 16 workspace questions right; it mixed workspaces (a kitchen "pest" question
    opened the pregnancy guide), missed an existing rule, and answered record questions with "not covered" while the
    report was missing. Fixed: answers come from the workspace of the workflow or visit in use (with an "Answering
    from" picker when several are downloaded); "what to do" questions also search the user's own rules; without a
    report, "what first / why / is it safe" answer from the on-phone result, labelled as such; "by when" with a report
    uses its actions. Re-run: 13 of 16 right, 8 of 8 record questions answered. Still open: a Hindi transliteration
    ("पेस्ट" for pest) was not understood, and "write me a poem" gets a translation hint instead of a refusal.

### 0.2.6: modes, offline summary, plain UI (2026-11-10)
- **Report model.** The local test Hermes had no main model configured, so plugin reports fell back to a free model
  that Nous rate-limited. With `model: {default: openai/gpt-5.4-mini, provider: nous}` a real report arrived in
  **57 s** (decision "stop", 4 concrete actions). That model added an extra top-level key once, which Hermes rejects;
  FieldKit now retries once with the exact schema error (`tests/python/test_rate_limit.py`).
- **After-sync mode per workspace** (`report_policy.after_sync`: save / summarize / analyze): only `analyze` creates
  automatic report jobs; a "save" record can still be analysed on request; `fieldkit_list_records(include_answers)`
  lets Hermes summarise many records (`tests/python/test_after_sync.py`).
- **Offline workspace summary** ("On this phone": records, today, flagged by worst severity, unfinished, waiting to
  sync, reports), calculated on the phone (`tests/app/local_summary.test.ts`).
- **UI review** from phone-size screenshots: Home leads with "Record: <workflow>", readiness and tools folded when
  ready; the workspace page shows "Record a visit" and guides first, gaps as "Not covered yet", sources folded under
  "Where your rules come from"; workflow titles instead of ids; "Offline Assistant" renamed "Workspace Assistant" with
  a one-line description; the knowledge pack source no longer says "Researched by Hermes" for the user's own rules.
- **Results:** pytest 194 passed; vitest 129 passed; typecheck clean; doctor 35 tools, 1 hook; E2E spot checks
  `workspace.spec` and `login.spec` passed in Chromium (full suites not re-run for these changes).

### 0.2.6: sync only by default; questions about a visit (2026-11-10)
- Syncing never triggers AI work by default; a workspace can opt in with `report_policy.after_sync: analyze`, and the
  plugin setting `review_every_record: true` restores the old behaviour for everything.
- Questions about one visit (phone DB v4, server migration v6 `questions`): asked online or offline, queued with the
  workspace, record and photos, sent after the visit syncs, answered by FieldKit's worker from that record's evidence,
  returned to the same visit and readable offline. Never a learning event or a workspace rule. Hermes chat sees them
  with `fieldkit_list_questions` (36 tools).
- **Real Hermes + phone-sized offline browser** (local test Hermes, model `openai/gpt-5.4-mini` via Nous, the
  electrical workspace a real Hermes conversation built): visit with a photo recorded offline; one suggested and one
  own question asked offline and shown as "saved on this phone"; sync 0.2 s with **no report job**
  (`not_requested`); both questions on Hermes in 2.3 s with workspace id and photo id; **both answers on the phone after
  37 s**, readable offline. Hermes saw the photo (described the burn mark on MCC-14 and what it cannot tell) and answered
  "Can it stay in service until tomorrow?" with "No", citing the user's stop-and-isolate rule. Real Hermes chat then
  listed the questions and answers and summarised the visit (64 s, `fieldkit_list_records`, `fieldkit_list_questions`).
- **Results:** pytest 199 passed; vitest 130 passed; typecheck clean; Chromium E2E 30 passed, 5 skipped.

### 0.2.6 final: Hermes strictly on demand (2026-11-10)
Supersedes the after-sync modes and the `review_every_record` setting described above: both are removed. Saving or
syncing never triggers AI work (no report, no question, no speech-to-text; `report_policy.after_sync` in older
workspaces is accepted and ignored). The phone's "Ask Hermes to analyze this record" button is removed. Interaction:
questions about a visit (while filling in the form or afterwards, online or offline), and the Hermes chat
(`fieldkit_ask_about_record`, 37 tools).
- **Real Hermes + offline phone-sized Chromium, two Hermes-built workspaces, real photo and recorded voice note**
  (local test Hermes, `openai/gpt-5.4-mini` via Nous): an observation-only electrical visit synced with no question
  and no AI work; a kitchen visit with a photo, a voice note, a question written in the form and a suggested question
  asked offline; repeated sync left exactly 2 questions; **during the whole run Hermes made exactly 2 model calls (one
  per question)**; the voice note was transcribed by Hermes only while answering (8 s after the question arrived), not
  on upload; both answers on the phone in **18 s** (32 s in an earlier run), readable offline, grounded in the reading,
  the photo, the user's rule and the transcript; a question on the electrical visit landed on the electrical workspace.
  One model glitch seen once: a stray Chinese word in an English answer.
- **Real Hermes chat:** "What do you think about my latest kitchen food-safety visit?" → Hermes called
  `fieldkit_list_records` then `fieldkit_ask_about_record` (after adding a system-prompt hint; without it, it answered
  from the record list only) and gave an assessment with uncertainty and a next step (44 s).
- Retries: rate-limited and schema-mismatch questions are covered by tests (`test_questions.py`, `test_rate_limit.py`),
  not forced on the real provider.
- **Results:** pytest 201 passed; vitest 130 passed; typecheck clean; Chromium E2E 30 passed, 5 skipped.

### 0.2.6 final: cleanup, purpose-first interview, editing by chat (2026-11-10)
- **Cleanup:** Hermes sees 20 tools (18 retired: standalone workflows/packs, structured reports, follow-ups, learning
  loop; code kept for existing data). Phone: Workspace in the bottom bar, fewer Home tiles, older-report section only
  when a report exists, earlier form versions kept so old visits show their own questions. Dashboard: 4 tabs, visits
  show their questions and answers.
- **Editing by chat, real Hermes (local test Hermes, `openai/gpt-5.4-mini` via Nous):** "add a yes/no question 'Fridge
  door seal intact?' and remove the 'Pest signs' question" → Hermes started a build on the existing workspace (no
  interview), changed the form, its rule and the guide, built, and asked "Publish these changes?" (171 s). FieldKit's
  change summary: added question, removed question (old records keep it), removed rule, changed guide. "Yes, publish"
  → version 2 (19 s). Phone: "Update available: version 2"; new form had the door-seal question and no pest question;
  a visit recorded before, opened offline, still showed "Pest signs seen: Yes". "Undo my last workspace update" (new
  chat, 41 s) → version 3 = version 1; phone showed "Update available: version 3 — Undo: back to version 1"; old visit
  still readable. Hermes ran the undo without a separate confirmation (an explicit undo now counts as approval; it
  must list what changed back). Approval steps rely on Hermes following instructions. The Hermes CLI printed the app
  link as a local path; FieldKit's tool returned the correct http link.
- **Purpose-first interviews, real Hermes:** solar business owner (adaptive questions, correct summary, valid build
  with their real decisions and 2 rules); student research archive (first run: guessed a form, offered Marathi and
  invented a "needs review/finalized" decision scale; after fixes Hermes asked before drafting, offered English or
  Hindi only and summarised 12 fields with no decisions; FieldKit now rejects a decision scale when no task has
  decisions); dairy regression (correct summary). Student and dairy builds failed on language shapes Hermes sent
  (`{"en": "English", ...}`, `{"primary": [...]}`); FieldKit now normalises them, and the same Hermes-generated parts
  rebuild valid (student: no decisions, 12 fields; dairy: accept/re-test/reject, 7 fields). One dairy model call took
  801 s (provider stall). The second interview run was stopped by the machine's memory limit before the final builds;
  those builds were re-checked from the saved parts, not in a new conversation.
- **Results:** pytest 204 passed; vitest 130 passed; typecheck clean; validate passed; doctor 20 tools, 1 hook;
  Chromium E2E 30 passed / 5 skipped; WebKit E2E 23 passed / 11 skipped plus `media.spec` re-run passed after a test
  fix.

## iPhone fixes (2026-11-10): question routing, workspace on records, standard applicability

Local test Hermes v0.23.0 only: **not the hosted Hermes and not a real iPhone**. The main model is `z-ai/glm-5.3:US` via Nous (text-only, to match the hosted setup) unless a row says otherwise. Behaviour is described in [API.md](API.md) and [INSTALL.md](INSTALL.md).

| Check | Result |
|---|---|
| Photos sent to the text-only main model, before the slot | `400 This model does not support image inputs`. Hermes' vision tool described the photo for one question (auto-picked `stepfun/step-3.7-flash:free`). The other question hit that model's rate limit and was answered from text, and the answer said so |
| Vision slot: `auxiliary.fieldkit_vision` = nous `google/gemini-3.6-flash`, Chromium at phone size | Photo, recorded voice note, a question written in the form and one asked later, all offline. Both answers after sync in 42 s; route `vision_slot`; `photos_seen` 1; photo text read correctly; readable offline |
| Same slot, WebKit with an iPhone user agent | Photo, no voice note. Answers in 30 s; route `vision_slot` |
| Workspace on records | Record started offline from the workspace page carried `blr-kitchen-food-safety` on the phone, on the server record and on both questions |
| Retry | Model endpoint returning HTTP 404: question failed after 3 attempts (118 s). Phone showed each route's NotFoundError 404 and **Ask again**. After the config was fixed, Ask again → answered in 28 s |
| Rate limit | Real 429 (retry after about 100 s) on the vision model: the question waited without using an attempt, then was answered |
| Historical repair | Copies of two databases from earlier real-Hermes runs: 96 of 96 and 167 of 167 records got their workspace; 0 ambiguous; no other column changed; second run repaired 0 |
| Dairy correction by chat | Hermes changed the rule and guide to the union's 8.3% SNF rule (re-test once, then reject); kept FSSAI as "Reference only — governs milk sold to consumers"; recorded a gap for the missing buffalo rule instead of inventing one; showed the change list and asked before publishing (116 s). After "Yes, publish it", version 2 was published (11 s), validation clean |
| Unit tests | 224 Python, 132 TypeScript |

**NOT verified:** the hosted Hermes and the owner's iPhone. The hosted dairy workspace correction still has to be done by the owner in chat.

## 0.3.0 cleanup (2026-11-10)

**What changed.** Removed from the product: the Workspace Assistant, decision guides, knowledge and dictionary packs, the
Reports list, on-phone speech-to-text and read-aloud, "Ask Hermes about this visit" questions, rule findings, analysis jobs,
follow-ups, the learning loop, the example-install tool and route, and the standalone workflow and pack authoring routes.
Hermes has 12 tools. All tables and migrations are kept. IndexedDB v5 drops only the assistant's vector cache and the
learning queue; entries, files, drafts and answers are untouched.

**Results** (local test Hermes v0.23.0, Windows 11, model `openai/gpt-5.4-mini` via Nous):

| Check | Result |
|---|---|
| Unit tests | 88 Python, 100 TypeScript; typecheck clean |
| Hermes tooling | `hermes plugins validate` passed; `hermes plugins doctor --ci`: 12 tools, 0 hooks |
| Browser E2E, Chromium | 27 passed, 2 skipped (the model-download and update-notice tests need extra environment variables) |
| Browser E2E, WebKit | 19 passed, 8 skipped, 2 failures. Both passed on rerun after a fix: the workspace update banner timing was fixed in code, and the accounts test passed on rerun |
| Setup by chat | Oral-history workspace (participant code, date, village, consent signature, audio, photos, notes; subject = participant code): drafted in 70 s, published after approval in 20 s, using only the new tools |
| Edit by chat | Added "Language of the interview" (Hindi, Marathi, English): the change was shown and Hermes asked "Publish these changes?" (18 s); published after yes (13 s) |
| Undo by chat | "Undo my last workspace update" restored the earlier content as version 3 (16 s) |
| Ask about a synced visit | Kitchen visit: Hermes called `fieldkit_list_records`, `fieldkit_get_record`, `fieldkit_get_attachment` twice and its own `vision_analyze`, and described the photo correctly. FieldKit made no model call |
| Old data | Copies of two databases from earlier real-Hermes runs opened with 0.3.0: row counts unchanged (records, attachments, reports, workspace versions, revisions); 96 of 96 and 167 of 167 entries readable; 33 and 73 old reports shown; 8 of 8 workspaces readable; all published versions still valid |
| Size | Phone main bundle about 130 KB (plus the lazily loaded translation runtime). `fieldkit_core/*.py`: 2,438 lines, down from 6,659 at the last commit (measured 2026-11-10) |

**NOT verified:** the hosted Hermes, the owner's iPhone, and Android. Everything in the table ran against a local test
Hermes only. The owner's 0.2.4 iPhone run (offline recording, sync, media and Saved Records) is recorded in section 5; the
collection code is unchanged in 0.3.0.

## 0.3.0 release verification (2026-11-10, final code)

All on a local test Hermes v0.23.0 (Windows 11, model `openai/gpt-5.4-mini` via Nous), phone-sized browsers.

| Check | Result |
|---|---|
| Unit tests | 90 Python, 100 TypeScript; typecheck clean; `hermes plugins validate` passed; `doctor --ci`: 12 tools, 0 hooks |
| Full WebKit suite (final build, one run) | 21 passed, 0 failed, 8 skipped (6 network-blocking tests WebKit can't run under a service worker, which run in Chromium; 2 model-download tests, run separately below) |
| Full Chromium suite (final build) | 27 passed, 0 failed, 2 skipped (model-download tests, run separately below) |
| Offline OCR and translation | Packs installed online, then a cold start with the network off: OCR read "FIELDKIT OFFLINE 42" and en→hi translation ran on the device, in Chromium and WebKit. The small model still renders "bearing" as "bear" (known limitation) |
| Hermes transcribes a synced voice note | A spoken WAV synced through the real API (stored, no transcript from FieldKit). Asked to transcribe it, Hermes called `fieldkit_get_record`, `fieldkit_get_attachment` and its own `transcribe` tool, and returned the sentence word for word (108 s). FieldKit made no model call |
| Workspace association | Phone entries carry their workspace (E2E: entries made offline from the workspace page; API sync of a voice-note entry); unit tests cover a valid claim, a wrong claim, ambiguity (never guessed) and repair of old entries |
| Account isolation | API tests: another user cannot read, overwrite, list or download a user's entries, files, reports or questions; E2E: two installs of one account share one record list without duplicates |
| Signatures optional | A form without a signature shows no signature pad; a form with a required signature cannot be completed unsigned. Both completed offline in one workspace and synced (Chromium and WebKit); the signature file arrived intact with its time. A draft that would drop a published signature field is flagged; unrelated edits keep it. The builder skill adds a signature only when the user asks |
| Existing data | Copies of three earlier databases (two real-Hermes test runs and the test store before the 0.2.6 fixes): row counts unchanged; 167/167, 96/96 and 201/201 entries readable; 73, 33 and 83 old reports shown; 35/35, 24/24 and 45/45 stored files readable through `fieldkit_get_attachment`; all workspaces readable. On the live test store, the answers of all 7 entries with 0.2.6 questions are shown |
| No leftovers | No unused Python functions; the two list routes (`GET /workflows`, `GET /packs`) the phone fetched and discarded were removed; the model catalog offers only OCR and translation; the phone bundle carries no assistant code (Whisper/embedding strings exist only inside the translation library) |

**Defects found and fixed in this pass**
- Phone form: when a choice was saved slowly (seen in WebKit), the form re-rendered while the user was typing in
  another field and the cursor left the field, so further typing was lost (1 in 6 WebKit runs lost a note). The form
  now keeps focus and cursor position on such re-renders. 10 of 10 repeated WebKit runs passed afterwards.
- The two unused list routes above.
- Test fixes (not product changes): waits for the workspace update and for "download all" to finish, OCR screen render,
  scroll position for the update-notice geometry.

**NOT verified (separate from the local results above):** the hosted Hermes (it still runs an earlier FieldKit until the
owner updates it), the owner's iPhone with 0.3.0 (Safari and the Home Screen app), Hermes Mobile, Android, and real
speech or photos from a phone camera. The owner's 0.2.4 iPhone run covered offline recording, sync, media and Saved
Records; that collection code is unchanged apart from the focus fix above.

### Close-up photos on iPhone (2026-11-11)

**Reported:** photos taken through FieldKit were blurry at close distance; the Camera app was sharp.
**Cause (from code and public reports; not reproduced on a device here):** the photo field used only
`<input type="file" accept="image/*" capture="environment">`, which opens iOS's camera sheet. FieldKit sets no focus,
zoom or lens. That sheet does not switch to the ultra-wide (macro) lens the way the Camera app does, and Pro iPhones'
main camera cannot focus closer than about 15-20 cm. Compression (2048 px, JPEG 0.85) applies at every distance and is
unchanged.
**Change:** photo fields and Scan text now offer "Take photo" (unchanged) and "Choose from Photos" (same input without
`capture`), so a close-up taken with the Camera app can be attached. Same compression, storage, offline capture and sync;
a library photo is stored with `source: "photo_library"` and its file time as `taken_at`.
**Verified locally:** a library photo attached offline, synced, stored and marked `photo_library` (Chromium and WebKit);
the camera path and offline OCR unchanged. **Not verified:** on the owner's iPhone (the camera sheet and Photos picker
only exist on the device).

## Final audit and fixes (2026-11-11, commit 5d77969)

Run on a disposable local test Hermes v0.23.1 (Windows 11, model `openai/gpt-5.4-mini` via Nous), phone-sized browsers.
This was not the hosted Hermes and not the owner's iPhone.

| Check | Result |
|---|---|
| Unit tests | 117 Python (pytest, with the 0.3.1 skill check); 126 TypeScript (vitest, 15 files); typecheck clean |
| `hermes plugins validate .` | Passed |
| `hermes plugins doctor . --ci` | 12 tools, 0 hooks |
| Browser E2E, Chromium | 37 passed, 0 failed |
| Browser E2E, WebKit | 31 passed, 6 skipped, 0 failed. The 6 skipped tests need Playwright `route()` to block service-worker traffic, which WebKit does not support |

**Audit (synthetic data).** 40 real chat conversations built 39 workspaces across many professions. 1,272 synthetic
entries with 1,599 files were synced from simulated phones. Every entry's answers and every file's SHA-256 on Hermes
matched what the phones sent: 1,272 of 1,272 entries and 1,599 of 1,599 files.

**Retests after the fixes, in real Hermes conversations:**
- The phone link opens the workspace.
- A sync conflict is identified by form, subject, date and the answers that differ. Hermes resolves only the conflict the
  user named, and asks which one next instead of resolving all.
- A new checklist request without the word "FieldKit" starts the workspace interview.
- Publishing a form whose identifying question is GPS is refused, and Hermes asks for a short identifier.

**Phone.** The owner tested commit 35f9ab8 on a real iPhone with the hosted Hermes and the Hermes mobile app (2026-11-11)
and reported everything working. Commits after 35f9ab8 (Back button and faster navigation, backup import and export
checks, audit fixes) are verified only on the local test Hermes and in browsers. Android Chrome is not tested.

**Hosted Hermes.** Commit 5d77969 (2026-11-11, owner-reported) was deployed to the hosted Hermes and checked there: all
12 tools registered, workspace links open the workspace, and existing data stayed intact. The phone-app changes made
after 35f9ab8 (the Back button and faster navigation, backup import and export checks, readable records from other
devices, the workspace preview before download) have **not yet been checked on a real iPhone**.

**Skills against the registered tools.** Both skill files and the session note name only the 12 registered tools; the removed `fieldkit_save_workspace_brief` and `fieldkit_build_workspace` appear only in the historic sections of this file. `test_skills_and_session_note_name_only_registered_tools` now fails if a skill names a tool that is not registered.

**Saved Records.** The list pages through the whole account. `GET records` takes `offset` and returns `total` and
`next_offset`. `fieldkit_list_records` reads every matching entry page by page.

**NOT verified:** the phone-app changes after 35f9ab8 on a real iPhone, and Android Chrome. 0.3.1 (version bump,
"Export data" wording, a test that skills name only registered tools) adds no new behaviour.

### 0.3.2: approval, normal ranges and links (2026-11-11)

Three Hermes behaviours seen in real conversations on the local test Hermes, fixed in the builder skill, the
`fieldkit_publish_workspace` description, the form rules and the link result:
- Hermes published when the user asked to *see* the forms. Now it shows every form and question, asks "Publish this?"
  and publishes only on a yes to that question.
- A normal range ("should be 2 to 6 °C") became a hard min/max, so an out-of-range reading could not be saved. Now a
  normal, safe or expected range goes into the question's help text ("Normal: 2-8 °C"); min/max only for values that
  cannot occur ("can't be negative" became min 0; "moisture 0 to 100 %" became 0-100).
- Hermes once wrote the link as `C:/dashboard-plugins/...` from the bare `path` returned next to the full `url`. Now a
  known address returns only the full `url`, publishing builds the link like `fieldkit_get_app_link`, and the skills say
  to copy the `url` exactly.

Retested in 9 real conversations (gateway restarted on the new code): approval waited for an explicit yes in all of
them (including "show me the forms" and "add a field, then show me again"); every number field followed the range rule;
after the link fix, all 4 links given were the full `http://.../#/workspace/<id>` link. On 0.3.2: Python 118 passed, TypeScript 126, typecheck clean, validate + doctor (12 tools, 0 hooks), Chromium full suite 37 passed.
