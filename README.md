# FieldKit for Hermes Agent

**Create a workflow by talking to Hermes, run it on a phone with no internet, get local results immediately,
sync when you're back online, and have Hermes analyse it. You can discuss the result in Hermes Mobile and keep
the report readable offline.**

FieldKit is one Hermes plugin with three parts:

| Part | What it is |
|---|---|
| **Native plugin** | 23 Hermes tools plus a bundled skill. It creates, validates and publishes workflows; turns documents into knowledge packs; builds dictionaries; retrieves, analyses, compares and reports on synchronised records; and manages follow-ups, sync status and conflicts. |
| **Dashboard tab** | A *FieldKit* tab in the Hermes dashboard: workflows, knowledge, records (with photos and audio), reports and follow-ups, synchronisation, offline packs, and a phone QR code. |
| **Offline PWA** | An installable mobile app served by the plugin at `/dashboard-plugins/fieldkit/app_dist/index.html`. It handles workflows with branching, validation, photos, GPS, audio and signatures; local findings; an offline assistant over knowledge packs; dictionaries; sentence translation; OCR; speech-to-text; read-aloud; a durable sync queue; downloaded Hermes reports; connection diagnostics. |

It is **domain-independent**. Workflows, knowledge, dictionaries and classification rules are data, so a new
domain needs no code changes. The demo ships three unrelated domains with equal weight:
- **Education:** classroom observation.
- **Equipment maintenance:** equipment inspection.
- **Agriculture:** crop health survey.

```text
Create (Hermes Mobile) → Download (PWA) → Work offline → Local results → Sync → Hermes analysis → Reports → Offline again
```

## Quick start
```bash
hermes plugins install Snehal707/fieldkit && hermes plugins enable fieldkit
```
Then, in Hermes (Mobile, chat or dashboard):

> "Install the FieldKit examples."
> "Create an equipment inspection workflow with troubleshooting instructions and photographs, in English and Hindi."

Hermes returns a tappable app link once FieldKit knows its public `https` address. This is detected automatically
the first time the dashboard tab or the app is opened over https. Open the link on your phone, sign in, tap
**Download for offline**, and add the app to your home screen.
Full instructions are in [docs/INSTALL.md](docs/INSTALL.md).

## What works offline (on the phone)
- Opening the app from the home screen after the browser is fully closed. A service worker caches the shell. The app is launched from Hermes' public plugin-asset address, so even with an expired Hermes session (or no service worker) it opens normally and offers **Sign in**, returning to FieldKit afterwards; on-device data never needs a login.
- Running workflows with:
  - every input type: text, number, date, time, yes/no, single and multiple choice, photos (compressed), GPS (with manual fallback), audio notes, signatures and instructions;
  - conditional questions, required-if rules, constraints and drafts that save as you type.
- An immediate Results page:
  - validation, answers, local findings (rules, keywords, scores, decision trees), relevant references, explanations, media and GPS;
  - a clear *"Saved locally. Pending synchronization."* label. Local findings are never presented as Hermes analysis.
- The offline assistant and knowledge browser. Retrieval answers come with a source, and the assistant says when a question isn't covered.
- Dictionary search (exact, translation, prefix and fuzzy matches).
- Sentence translation English→Hindi and Hindi→English (OPUS-MT, on device).
- OCR in English and Hindi (tesseract.js).
- Speech-to-text (Whisper tiny).
- Read-aloud with local voices only.
- Previously downloaded Hermes reports.
- A header that shows the device network, Hermes reachability, records awaiting confirmation and "N not submitted" drafts. Tap the status pill for connection diagnostics.

## What happens when you reconnect
- The outbox uploads records, then media.
  - Each upload has a stable idempotency key, and every file is checked against its SHA-256.
  - The server acknowledges each step, and revisions use optimistic concurrency.
  - Conflicts are shown for you to decide; nothing is silently overwritten.
- An expired Hermes session pauses the queue (nothing is lost) and asks you to sign in. The queue resumes afterwards.
- The server queues a durable analysis job. Hermes' own LLM (`ctx.llm`) produces a schema-validated report with issues, missing information, references, actions and follow-ups.
- Photos are analysed through a separate vision model when one is configured (the `fieldkit_vision` slot). With a text-only default model, the report says "Photos not analysed".
- The report is stored centrally. It is visible in the PWA (and downloadable for offline use), in the dashboard, and to Hermes Mobile through FieldKit tools.

## Saved Records across your devices
- Saved Records is one list for your whole signed-in Hermes account, across all devices. Each browser and each iPhone Home Screen app keeps its own offline storage, so each one counts as a device.
- Each record appears once. If a record exists both on this device and on Hermes, this device's copy is shown.
- Each record shows an availability badge: **Available offline** (saved here or downloaded), **Needs internet** (only on Hermes), or **Waiting to sync** (saved here, not yet confirmed by Hermes). Records from other devices show the device name, such as "From iPhone · Safari".
- **Make available offline** and **Download all for offline** store a record and its Hermes report in a separate read-only store on the device. **Remove offline copy** deletes only that copy; the record stays on Hermes. Offline copies refresh automatically when the record or its report changes on Hermes.
- The last list seen from Hermes is remembered. Offline, records that need internet are listed but cannot be opened.
- On a shared browser, offline copies and the remembered list are tied to the Hermes account. Another account never sees them.
- If the list can't be loaded, Saved Records says why: offline, can't reach Hermes, signed out, a server error with its HTTP status, or a Hermes dashboard still running an older FieldKit server (restart the dashboard after updating). It never shows "No records yet" for a failed load.
- **After updating FieldKit on a hosted Hermes, restart the Hermes dashboard process** as well as the gateway. Plugin API routes are mounted by the dashboard, so until it restarts, the new app talks to the old server code.

## Verification status (honest)
See [docs/TESTING.md](docs/TESTING.md) for the exact commands and results. Anything not listed as verified below is pending.

### Verified on iPhone (real device, hosted Hermes v0.23.0)

| Area | Status |
|---|---|
| Offline inspection | Completed with no internet, saved locally, shows "1 awaiting confirmation" |
| Automatic sync | After reconnecting, record `rec_6b0da392e6284a70ae1bd33b` was received 41 s after completion; all 11 answers and the photo uploaded |
| Automatic AI report | Generated automatically (GLM 5.3, text-only fallback) |
| Automatic photo analysis | Runs through the configurable `fieldkit_vision` model slot |
| Sign-in and plugin lifecycle | Sign-in returns to FieldKit; plugin install, enable and update work without a restart |

### Verified in Chromium + WebKit (WebKit is Safari's engine, not iOS itself; real Hermes v0.23.0)

| Area | Status |
|---|---|
| Offline OCR (English) and English↔Hindi translation | Work after a cold restart with no network; model files verified by SHA-256 on install |
| Offline speech-to-text (Whisper) | Verified in Chromium only (WebKit cannot simulate a microphone) |
| Downloaded Hermes reports | Readable offline after a cold restart |
| Dashboard tab | Works inside the real Hermes dashboard, all 7 sections |
| Strict offline | No request leaves the device while offline; record survives restart; auto-sync on reconnect with no user action |
| Install buttons | Switch to "Reinstall" immediately |
| Update notice | Compact, never overlaps content (320 px screen, keyboard open) |
| Saved Records across devices (two isolated profiles, same Hermes account) | One list with no duplicates, readable device names, badges, Download all, offline cold start, offline-saved record auto-syncs on reconnect and appears on the other client, same Account ID on both, Device ID only under Advanced, another account on the same browser sees no copies |

### Automated tests and security checks

| Area | Status |
|---|---|
| Tests | 100 Python tests, 87 TypeScript tests, 11 Playwright E2E suites; every one of the 23 Hermes tools has a test |
| Simulated Hermes Mobile conversation | Covered by a test: create, publish, app link, sync, process jobs, get record and report, compare and save report, follow-up, sync status, conflict resolution (simulated, not a real device conversation) |
| Security | `hermes plugins validate` security scan: safe. `npm audit`: 0 vulnerabilities. `pip-audit`: 0 known vulnerabilities |
| Access control | Every API route checks the signed-in user; the app page is public and contains no data. v0.1.7 fixed a cross-user leak where `GET /jobs` listed other users' jobs |

### Pending

| Area | Status |
|---|---|
| OCR, translation and speech-to-text on iPhone | Pending |
| real iPhone check of the unified Saved Records (Safari + Home Screen app) | Pending |
| Offline reports on iPhone | Pending |
| Full Hermes Mobile conversation on a real device | Pending (needs the hosted instance and owner's permission) |
| Hosted dashboard tab click-through | Pending |
| Android Chrome | Pending |
| Connection diagnostics screen, app-link auto-detection and `public_url` | Pending |
| Deferred analysis (`fieldkit_process_pending_jobs`, `retry_failed`, cron job) | Pending |
| `hermes plugins doctor . --ci` | Pass (v0.1.7: 23 tools, 1 hook) |

### Known limitations
- The small OPUS-MT model mistranslates some technical terms (for example "bearing" → "bear").
- Whisper tiny's Hindi accuracy is limited.
- iOS PWAs have separate storage from Safari. Sign in once inside the installed app.
- Uploads run while the app is open. There is no background upload from a closed app.
- Hermes OAuth sessions last 15 minutes. Sync pauses and asks you to sign in; nothing is lost.

## Docs
[ARCHITECTURE.md](ARCHITECTURE.md) · [RESEARCH.md](RESEARCH.md) · [docs/API.md](docs/API.md) · [docs/INSTALL.md](docs/INSTALL.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/SUBMISSION.md](docs/SUBMISSION.md) · [THIRD_PARTY.md](THIRD_PARTY.md)

MIT licensed. Demo content is synthetic.
