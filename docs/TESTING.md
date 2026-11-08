# Testing FieldKit

All results below were produced on 2026-11-08/09 on Windows 11 with Hermes Agent **v0.23.0**, Python 3.11 and
Node 22. Anything not listed as run here is marked **unverified**.

## 1. Unit and API tests
```bash
uv venv .venv --python 3.11 && uv pip install --python .venv fastapi httpx pytest jsonschema pyyaml python-multipart
.venv/Scripts/python -m pytest            # 74 passed
npm ci --legacy-peer-deps && npm test     # 58 passed (vitest)
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
  - Answers, local findings and GPS round-trip intact. The Results page shows "Synchronised — durably received by Hermes" and the Hermes analysis status separately.

`login.spec.ts` (**passed**, 0.1.1):
- Signed out, Home offers **Sign in** → Hermes' own login page with `next=/dashboard-plugins/fieldkit/return.html` → username and password entered → the browser lands back in **FieldKit** (not the dashboard) and shows "Signed in as …".
- Home then offers **Download all 3 workflow(s)**; one tap leads to "Ready to work offline" with 3 workflows downloaded.

`unreachable.spec.ts` (**passed**, 0.1.3):
- **Network "up" (`navigator.onLine` true) but Hermes not reachable:**
  - A captive portal answers every API call with `200 text/html`, then connections are refused.
  - The header shows "no Hermes connection" and "1 awaiting confirmation". The Pending Sync screen says "Hermes: Not reachable", and the server has no such record (404).
- **When the outage lifts:** the record is confirmed **once** (revision 1), and the header shows "all confirmed" and "Hermes reachable".

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

## 5. Not yet verified (needs your hardware or permission)
- A real model-generated report (needs a provider; it would run on the hosted instance).
- Hermes Mobile conversations invoking FieldKit tools against the hosted instance.
- Android Chrome and iOS Safari: installation, offline reopen, camera, microphone, GPS, OCR/translation memory use.
- OAuth (Nous) 15-minute expiry with real redirects inside an installed PWA. Locally only the basic provider was tested; the return page works the same for any provider because the target is a plain `next` path.

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
