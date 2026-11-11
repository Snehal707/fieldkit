# Testing FieldKit

Earlier test logs, including removed features, are in the git history.

> **Current version: 0.3.2.** FieldKit collects and syncs. It never calls a model. Workspaces are set up, edited and
> undone by Hermes conversation, and Hermes publishes only after the user says yes. Hermes has 12 tools and reads
> entries, photos and voice notes with its own tools when asked.

Each section gives its own date and version.

## 1. Unit and API tests

```bash
uv venv .venv --python 3.11 && uv pip install --python .venv fastapi httpx pytest jsonschema pyyaml python-multipart
.venv/Scripts/python -m pytest            # 118 passed
npm ci --legacy-peer-deps && npm test     # 126 passed (vitest)
npm run typecheck                         # clean
```

**Python** (`tests/python`):
- Engine against the shared vectors.
- Plugin API through FastAPI `TestClient`, with a stand-in auth gate that returns 401 when there is no session.
- Idempotent sync. Resending identical content under a new key is safe.
- 409 conflicts are recorded and never overwritten. Conflict resolution works.
- Cross-user isolation for records and attachments.
- Attachment SHA-256 integrity, truncated uploads, MIME allowlist.
- Paging through the whole account.
- Plugin registration matches `plugin.yaml`. Every tool runs through the real handler.
- Skills name only registered tools.
- PWA file serving, the SPA fallback and path traversal.

**TypeScript** (`tests/app`, fake-indexeddb):
- The condition and workflow vectors, shared with Python, so both engines must agree.
- The sync state machine: ack leads to synced; a network failure keeps the same idempotency key; 401 pauses and resumes; 409 is a conflict; 422 stops retries but keeps the record; an interrupted attachment upload resumes.
- Offline submission commits the record and its queue entry in one IndexedDB transaction. A captive-portal 200 or an ack for another record is rejected.
- Backup, drafts, storage, migration, paging, form language, media quality and the offline summary.

## 2. Hermes tooling

Use a temporary `HERMES_HOME` so nothing is shared with a real install.

```bash
export HERMES_HOME=<scratch>/hermes-doctor-home    # temporary
hermes plugins validate .                          # Validation passed (security scan: safe; declared tools match)
hermes plugins doctor . --ci                       # 12 tools, 0 hooks
```

Result on 0.3.2 with Hermes Agent v0.23.1: `hermes plugins validate .` passed, and `hermes plugins doctor . --ci`
reported 12 tools and 0 hooks.

## 3. Integration against a real Hermes dashboard (throwaway home, nothing shared)

```bash
export HERMES_HOME=<scratch>/hermes-home         # contains plugins/fieldkit + config.yaml below
hermes dashboard --host 127.0.0.2 --port 9300 --isolated --no-open --skip-build
```

`config.yaml`: `plugins.enabled: [fieldkit]`, `plugins.entries.fieldkit.settings.public_url`, and
`dashboard.basic_auth.{username,password,secret,session_ttl_seconds: 120}`.
- Binding `127.0.0.2` turns on Hermes' real cookie auth gate while staying local to the machine.

Verified over HTTP (2026-11-08, Hermes v0.23.0):
- **Loading:** the plugin was discovered and registered. `/api/dashboard/plugins` lists the FieldKit tab (`has_api: true`), and `/dashboard-plugins/fieldkit/dist/index.js` returns 200.
- **Auth gate:** without a session, `/api/plugins/fieldkit/records` and `/app/` return **401**. A bad password returns 401. After login, `/me` returns `demo` (basic provider).
- **PWA serving:** `/app/` returns `text/html`, `sw.js` returns `text/javascript`, the manifest returns `application/manifest+json`, and `precache.json` is served.

## 4. Browser end-to-end (real Chromium, real Hermes)

```bash
FIELDKIT_E2E_PASS=<password> npm run test:e2e                                # full suite, Chromium
FIELDKIT_E2E_BROWSER=webkit FIELDKIT_E2E_PASS=<password> npm run test:e2e   # same suite on Safari's engine (not iOS)
FIELDKIT_E2E_MODELS=1 FIELDKIT_E2E_PASS=<password> npm run test:e2e -- models.spec.ts
FIELDKIT_E2E_PASS=<password> FIELDKIT_E2E_DATA_DIR=<HERMES_HOME>/plugin-data/fieldkit npm run test:e2e -- accounts.spec.ts
```

**Results**
- **Chromium, full suite (0.3.2):** 37 passed, 0 failed.
- **WebKit, full suite (0.3.1, commit 5d77969, 2026-11-11):** 31 passed, 6 skipped, 0 failed. The 6 skips need Playwright `route()` to block service-worker traffic, which WebKit does not support.

**Offline and sync** (`offline.spec.ts`, `strict-offline.spec.ts`, `unreachable.spec.ts`, `login.spec.ts`):
- **Online setup:** sign in, the service worker controls the page, download a workflow, and Home shows "Ready to work offline". The browser can then be closed.
- **Cold start, network disabled:** the app opens from the service worker. A workflow with a conditional question and GPS completes, and Results shows "Saved locally. Pending synchronization." The record persists after the browser is closed and reopened offline.
- **Network cut for the page and the service worker:**
  - An inspection blocked by validation shows "1 not submitted", and the header never shows "all confirmed".
  - A valid offline record is queued in IndexedDB before any request.
  - **Zero** requests reach the network, including app assets.
  - The record survives a full browser restart. After reconnecting, it syncs with no user action.
- **Network "up" but Hermes unreachable:** a captive portal answers API calls with `200 text/html`, and the header shows "no Hermes connection". When the outage lifts, the record is confirmed **once**.
- **Session cookies deleted, online:** navigation still opens the cached app, and the banner says "Sign in to Hermes to continue syncing". After signing in, the server holds **exactly one** record, also after a forced re-sync.
- **Sign-in:** signed out, Home offers **Sign in**. The Hermes login page returns the browser to FieldKit, showing "Signed in as …". Home then offers to download the workspaces for offline use.
- Hermes sends `Vary: Origin`. FieldKit's own app files are cached with `ignoreVary`, so an offline launch does not depend on the browser's HTTP cache.

**Saved Records** is described in its own section below.

## Model results (`models.spec.ts`)

First run on 2026-11-08 with Hermes v0.23.0. Passed again offline on the 0.3.2 build (2026-11-11) in Chromium and WebKit.

- **Online install:** English→Hindi translation downloads the pinned ONNX weights (~110 MB), runs a self-test, and verifies the size and SHA-256 of the cached weights ("pinned files verified"). OCR English loads and runs its self-test.
- **Browser closed, then reopened with the network disabled:**
  - **Translation:** "The pump is vibrating and the bearing is hot." → `पंप और भालू गर्म है.` This is real Hindi output computed on the device, but the **quality is limited**. "bearing" comes out as *bear* (the animal), and "vibrating" is dropped. That is a known weakness of the small OPUS-MT model on technical text.
  - **OCR:** a rendered label returned exactly `FIELDKIT OFFLINE 42`.
  - **Network proof:** every off-origin request was answered from FieldKit's own cache (`fieldkit-upstream-v1`: ONNX Runtime `.mjs` and `.wasm`, tesseract core, `eng.traineddata.gz`) or from Transformers.js' model cache. Nothing reached the network.
- Hindi→English and Hindi OCR use the same code paths and pinned manifests. They were **not run end-to-end** (download time).

**Build and cache notes found by these runs:**
- Transformers.js 4.3.1 requests `tokenizer_config.json` at revision `main`, which breaks offline reloads. FieldKit pins `remotePathTemplate` to the pinned revision.
- ONNX Runtime uses the external-WASM build. Otherwise Vite emits a 26 MB WASM file, and the binary guard rejects it.
- The OCR core is cached by FieldKit and passed to tesseract as a `blob:` URL, so offline OCR does not depend on the browser's evictable HTTP cache.

## Media, OCR and translation

Accuracy numbers come from synthetic material, not real users' recordings or photos. The scripts and how to run them are in [tests/eval/README.md](../tests/eval/README.md).

- **Photos:** decoded with EXIF orientation. Stored at up to 2048 px, JPEG quality 0.85 (was 1600 px, quality 0.8). Previews copy the stored file into a Blob of the right type and check its SHA-256 against the value recorded at capture. If the device copy is unreadable and Hermes has the file, Hermes' verified copy is shown and the device copy is repaired. A file that cannot be shown gives a plain message.
- **Voice notes:** recorded as one complete file (no 1-second slices). MP4/AAC on Apple devices, WebM elsewhere. Only formats the device can play back are used.
- **Voice notes on Hermes:** Hermes transcribes a voice note only when asked, with its own tool. On 0.3.0 (2026-11-10), a synthetic spoken WAV came back word for word after 108 s. FieldKit made no model call.
- **OCR preparation:**
  - Root cause: every photo was downscaled to 1800 px, and single-block layout mode read only the heading on unevenly lit photos.
  - Now: OCR at 3000 px on the long side, after illumination flattening and contrast stretch. Page-segmentation mode 3 (automatic layout) at 300 dpi.
  - A flattened pass and a plain pass both run, and the one with more confident text is kept. A low-resolution orientation probe runs only when the result is weak. Edge marks and texture are filtered at word level.
  - Each result gets a verdict (good, check or poor). Poor or uncertain results advise "retake closer, in good light".

**OCR accuracy** (character error rate, CER; synthetic iPhone-style photos: 4032×3024, EXIF orientation 6, 2° skew, uneven light, noise, blur)

| Case | Before | After |
|---|---|---|
| Large print | 0–1.3% | 0% (Chromium and WebKit) |
| Ordinary small print (the iPhone symptom: old confidence 20–46%) | 78–89% | OCR screen: 2.3–2.7% English, 2.0–4.6% Hindi. Photo-field path: 3.8–4.6% English, 4.6–7.2% Hindi. Confidence about 90% |
| Dim room with heavy camera shake | not measured | 72–94%: still poor. The app says the text is unreliable and asks for a retake. About 3–8 s on desktop |

**Translation accuracy** (Node, OPUS-MT, chrF; 16 general and 7 dictionary-term sentence pairs, one hand-written reference each)

| Direction and set | Plain (before) | With FieldKit pipeline (after) |
|---|---|---|
| en→hi, general | 41.5 | 47.9 |
| en→hi, dictionary-term sentences | 30.8 | 49.6 |
| hi→en, general | 61.2 | 62.1 |
| hi→en, dictionary-term sentences | 48.9 | 63.7 |

- The dictionary-term rows apply only to dictionary packs already on a phone. Version 0.3.0 removed dictionary packs from the product, so new phones do not get them.
- General quality is still limited by the small model. Larger precision did not help (en→hi fp32 44.6 vs q8 41.5, at 4× the download). NLLB-600M (895 MB) and M2M100 (632 MB) are too large for a phone web app, so OPUS-MT stays.
- Beam search is effectively greedy in Transformers.js 4.3.1.

**What `media.spec.ts` checks** (Chromium and WebKit; the voice-note step uses Chromium's fake microphone, and its accuracy is not asserted):
- An EXIF-rotated photo is stored upright.
- Each file on Hermes is byte-identical (SHA-256) and linked to the same visit and field.
- A deliberately damaged device copy is restored from Hermes.
- A drawn signature is saved and viewable, including from a second install.

## Saved Records (`accounts.spec.ts`, `records-errors.spec.ts`, `restore.spec.ts`)

The simulated-failure cases use `route()`, so they run in Chromium only.

- **One list across devices:** records from all of the account's devices, with no duplicates, readable source names and availability badges. "Download all" works. The list pages through the whole account (`GET records` takes `offset` and returns `total` and `next_offset`). Both devices show the same Account ID. The Device ID appears only under Advanced.
- **Offline:** kept copies stay readable. Records that were not downloaded show "Needs internet" and cannot be opened. A record saved offline syncs on reconnect and appears on the other device. Another account on the same browser does not see the offline copies.
- **Load errors are shown clearly:**
  - A 404 on the optional `devices` endpoint does not hide the records. A message asks to restart the Hermes dashboard.
  - HTTP 500 shows "HTTP 500" and **Try again**, never "No records yet" or "Offline". The remembered list is labelled with its date.
  - A network failure while online shows "Can't reach Hermes".
  - A 401 shows a sign-in prompt.
  - A real offline state shows "Offline" with the remembered list.
- **Records Hermes lost can be restored:** when a device holds records that Hermes no longer has, it says "Hermes doesn't have N record(s) from this device". **Upload again** restores the exact workflow version and the records. A new install of the same account then lists them once. The spec removes one record from the test database, checks detection and restore, and cleans up after itself.

## Real devices

**Owner, real iPhone (2026-11-11):** the owner tested everything on a real iPhone with the hosted Hermes and the Hermes Agent mobile app (iOS), and it all works. This covers Safari and the Home Screen app, offline recording, sync, photos, voice notes, signatures, OCR, translation, Saved Records, and the Hermes chat with FieldKit tools.

**Hosted Hermes:** commit 5d77969 (2026-11-11) was checked there. All 12 tools registered, workspace links open the workspace, and existing data stayed intact.

**Close-up photos (2026-11-11):** photo fields offer "Choose from Photos" as well as "Take photo", so a close-up taken with the Camera app can be attached. Verified locally in Chromium and WebKit, and checked by the owner on the iPhone.

**Note:** the accuracy numbers in this file come from synthetic photos and text. Dim, shaky photos are still read poorly,
and handwriting is not supported.

## Device checklist

Run on each phone over HTTPS:
1. Open the app link and sign in.
2. **Workspace:** set one up by chat (or use a synthetic starter workspace on a test Hermes), open it, and tap **Download everything for offline**.
3. **Offline Packs (optional):** install English→Hindi translation and OCR English (Hindi→English and OCR Hindi if needed).
4. Install the PWA:
   - iOS: Share → Add to Home Screen. Open the installed app and sign in again inside it.
5. Home says **Ready to work offline**. Tap it to see each check (app, workspace, packs).
6. Turn on airplane mode. Swipe the app away completely, then reopen it from the home screen.
7. Use Translate ("The pump is vibrating."), and Scan text on a printed label or Extract text on a photo inside a form.
8. Record an entry in the workspace's form:
   - Photo: camera opens, and the thumbnail appears.
   - Voice note: record and play back.
   - GPS: accuracy is shown.
   - Signature.
   - Complete it, and check the entry.
9. Swipe the app away, reopen it offline, and check that the entry and its files are still there.
10. Turn airplane mode off. If asked, sign in. Check that Pending Sync is empty.
11. Dashboard → FieldKit → Records: the entry is there with its photo and audio.
12. In Hermes chat, ask about the entry. Hermes reads it, and its photo and voice note, with its own tools.

Record: device model, OS and browser version, which steps passed, timings for translation and OCR, and any memory errors.

## Final audit and fixes (2026-11-11, commit 5d77969)

Run on a disposable local test Hermes v0.23.1 (Windows 11, model `openai/gpt-5.4-mini` via Nous), with phone-sized browsers.

| Check | Result |
|---|---|
| Unit tests | 117 Python (pytest, with the 0.3.1 skill check); 126 TypeScript (vitest, 15 files); typecheck clean |
| `hermes plugins validate .` | Passed |
| `hermes plugins doctor . --ci` | 12 tools, 0 hooks |
| Browser E2E, Chromium | 37 passed, 0 failed |
| Browser E2E, WebKit | 31 passed, 6 skipped, 0 failed (see section 4) |

**Audit (synthetic data).** 40 real chat conversations built 39 workspaces across many professions. 1,272 synthetic entries with 1,599 files were synced from simulated phones. Every entry's answers and every file's SHA-256 on Hermes matched what the phones sent: 1,272 of 1,272 entries and 1,599 of 1,599 files.

**Retests after the fixes, in real Hermes conversations:**
- The phone link opens the workspace.
- A sync conflict is identified by form, subject, date and the answers that differ. Hermes resolves only the conflict the user named, and asks which one to handle next.
- A new checklist request without the word "FieldKit" starts the workspace interview.
- Publishing a form whose identifying question is GPS is refused, and Hermes asks for a short identifier.

**Phone.** The owner tested commit 35f9ab8 on a real iPhone with the hosted Hermes and the Hermes mobile app (2026-11-11) and reported everything working. The owner then tested again on the iPhone, including the later changes (Back button and faster navigation, backup import and export checks, audit fixes). All working.

**Hosted Hermes.** Commit 5d77969 was deployed to the hosted Hermes and checked there (owner-reported): all 12 tools registered, workspace links open the workspace, and existing data stayed intact.

**Skills against the registered tools.** Both skill files name only the 12 registered tools. `test_skills_and_session_note_name_only_registered_tools` fails if a skill names a tool that is not registered.

Version 0.3.1 (version bump, "Export data" wording, and the skill-name test) adds no new behaviour.

## 0.3.2: approval, normal ranges and links (2026-11-11)

Three Hermes behaviours seen in real conversations on the local test Hermes were fixed in the builder skill, the `fieldkit_publish_workspace` description, the form rules and the link result:
- Hermes published when the user asked to *see* the forms. Now it shows every form and question, asks "Publish this?", and publishes only on a yes to that question.
- A normal range ("should be 2 to 6 °C") became a hard min/max, so an out-of-range reading could not be saved. Now a normal, safe or expected range goes into the question's help text ("Normal: 2-8 °C"). Min/max is used only for values that cannot occur ("can't be negative" became min 0; "moisture 0 to 100 %" became 0-100).
- Hermes once wrote the link as `C:/dashboard-plugins/...` from the bare `path` returned next to the full `url`. Now a known address returns only the full `url`, publishing builds the link like `fieldkit_get_app_link`, and the skills say to copy the `url` exactly.

Retested in 9 real conversations (gateway restarted on the new code): approval waited for an explicit yes in all of them, including "show me the forms" and "add a field, then show me again". Every number field followed the range rule. After the link fix, all 4 links given were the full `http://.../#/workspace/<id>` link.

On 0.3.2: Python 118 passed, TypeScript 126, typecheck clean, `hermes plugins validate .` and `doctor . --ci` (12 tools, 0 hooks), Chromium full suite 37 passed.
