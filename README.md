# FieldKit for Hermes Agent

**Hermes builds a researched, evidence-labelled offline workspace for your job. Your phone helps you decide with no
internet, using decision guides and a grounded assistant. Hermes analyses your records into decision-focused reports,
and the workspace improves from verified outcomes.**

Hermes does the parts that need internet access and judgement. It interviews you about your work, researches the
rules and procedures from reliable sources, and builds the workspace. FieldKit stores the workspace, checks it,
computes how well each item is evidenced, and runs it on the phone. Workflows, records and reports still work the
same way: create a workflow, run it offline, sync, and read the analysis.

FieldKit is one Hermes plugin with three parts:

| Part | What it is |
|---|---|
| **Native plugin** | 35 Hermes tools plus two bundled skills (`fieldkit`, `fieldkit-workspace-builder`). It creates, validates and publishes workflows and workspaces; turns documents into knowledge packs; builds dictionaries; retrieves, analyses, compares and reports on synchronised records; and manages follow-ups, learning candidates, sync status and conflicts. |
| **Dashboard tab** | A *FieldKit* tab in the Hermes dashboard: workflows, knowledge, records (with photos and audio), reports and follow-ups, synchronisation, offline packs, and a phone QR code. |
| **Offline PWA** | An installable mobile app served by the plugin at `/dashboard-plugins/fieldkit/app_dist/index.html`. It handles workflows with branching, validation, photos, GPS, audio and signatures; local findings; decision guides; a grounded offline assistant over workspace content, records and reports; your workspace; dictionaries; sentence translation; OCR; speech-to-text; read-aloud; a durable sync queue; downloaded Hermes reports; connection diagnostics. |

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

## Workspaces (0.2.5)
To set up FieldKit for your job, ask Hermes:

> "Set up FieldKit for my work."

Hermes interviews you about your job: your responsibilities and the decisions each one needs, your tools,
instruments and procedures, your region and country, your languages, and who to escalate to. It shows you a brief
to confirm. Then it researches with its own web search and page reader, and quotes the exact clause with where it
appears. FieldKit re-fetches each cited web page and drops any quote it cannot find there. PDF sources are not
checked automatically.

Every item is labelled by how well it is evidenced: **verified**, **supported**, **conflicting** (with a named
escalation), **your procedure**, **learned local practice**, or **unverified**. Unverified model knowledge can never
become a decision action, a threshold or a procedure. Hermes publishes the workspace only after you approve it, and
returns a link. Open the link on your phone and tap **Download everything for offline**. The three bundled examples
are starter workspaces, labelled synthetic.

Since 0.2.6, setup is fast: Hermes builds the workspace straight from the interview (your own rules and documents,
shown on the phone as "Your procedure") in about two minutes, with no up-front web research. Checking a rule against
official sources is optional and short. FieldKit checks every part and repairs obvious shape mistakes; quotes from web
sources are checked in the background, and publishing waits until they finish.

The workspace improves from your team's verified outcomes: a follow-up check answered on a later inspection counts
as evidence. Hermes proposes changes, and nothing changes until you confirm. An accepted change creates a new,
validated workspace version with a changelog, and the phone shows **Update available**.

## What works offline (on the phone)
- Opening the app from the home screen after the browser is fully closed. A service worker caches the shell. The app is launched from Hermes' public plugin-asset address, so even with an expired Hermes session (or no service worker) it opens normally and offers **Sign in**, returning to FieldKit afterwards; on-device data never needs a login.
- Running workflows with:
  - every input type: text, number, date, time, yes/no, single and multiple choice, photos (compressed), GPS (with manual fallback), audio notes, signatures and instructions;
  - conditional questions, required-if rules, constraints and drafts that save as you type.
- An immediate Results page:
  - validation, answers, local findings (rules, keywords, scores, decision trees), relevant references, explanations, media and GPS;
  - a clear *"Saved locally. Pending synchronization."* label. Local findings are never presented as Hermes analysis.
- Your workspace (once downloaded): profile, workflows, decision guides, evidence summary, sources and gaps.
- Decision guides, which run offline. They ask only for what is missing and show the outcome with the evidence status of each action.
- The offline assistant answers only from workspace content, records and reports, with citations and evidence status. It says when a question isn't covered and keeps that question for Hermes. Nothing is generated. It understands questions by meaning in English and Hindi when the optional "Question understanding" pack is installed (118 MB); without it, the assistant uses basic word search.
- Follow-up checks. The next inspection of the same subject asks the previous report's checks (Done, Not done or Can't check).
- A knowledge browser. Retrieval answers come with a source.
- Dictionary search (exact, translation, prefix and fuzzy matches).
- Sentence translation English→Hindi and Hindi→English (OPUS-MT, on device). Terms from installed dictionary packs are used in the translation, and the Translate screen lists the dictionary terms it used.
- OCR in English and Hindi (tesseract.js). Photos keep their orientation (EXIF) and are read at high resolution with lighting correction. Each result gets a reliability verdict (good, check or poor). When the text is poor, the app says so and asks you to retake the photo closer, in good light.
- Speech-to-text in English with the Whisper tiny pack (version 2, about 64 MB). Hindi speech-to-text needs the optional Whisper small pack (about 250 MB, slower).
- Read-aloud with local voices only.
- Previously downloaded Hermes reports.
- A header that shows the device network, Hermes reachability, records awaiting confirmation and "N not submitted" drafts. Tap the status pill for connection diagnostics.

## What happens when you reconnect
- The outbox uploads records, then media.
  - Each upload has a stable idempotency key, and every file is checked against its SHA-256.
  - The server acknowledges each step, and revisions use optimistic concurrency.
  - Conflicts are shown for you to decide; nothing is silently overwritten.
- An expired Hermes session pauses the queue (nothing is lost) and asks you to sign in. The queue resumes afterwards.
- The server queues a durable analysis job. Hermes' own LLM (`ctx.llm`) produces a decision-focused report: a decision with its rationale, confidence and deadline; issues that cite the record's evidence; ordered next actions, each with a way to verify it; what is uncertain; and checks for the next inspection. FieldKit checks the report after the model answers and asks for one repair. Any problem left is shown on the report and sends it for review.
- Unanswered offline questions and your feedback are uploaded as learning events. They are never treated as evidence.
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
- If Hermes no longer has records this device saved and Hermes confirmed (its FieldKit data was reset or moved, or the host answered from a different machine), Saved Records says so and offers **Upload again**. That re-uploads them to the signed-in account, photos included, and first puts back the exact workflow version they were made with. It never runs automatically, so a shared browser can't push one account's records into another.
- **Run FieldKit's Hermes on one machine with one persistent volume.** FieldKit keeps its data in SQLite at `<HERMES_HOME>/plugin-data/fieldkit/data.db`. With several machines (each with its own volume), or a volume that is replaced on redeploy, different installs can reach different data. Settings → Advanced shows the **Hermes data store** id, the machine, and your record count, so you can compare installs.
- **After updating FieldKit on a hosted Hermes, restart the Hermes dashboard process** as well as the gateway. Plugin API routes are mounted by the dashboard, so until it restarts, the new app talks to the old server code.

## Photos, voice notes and signatures (0.2.4)
- Every photo, voice note and signature is checked against the SHA-256 recorded when it was captured. If the copy on the device is unreadable or damaged and Hermes has the file, FieldKit shows Hermes' verified copy and repairs the device copy.
- A file that can't be shown or played gives a plain message instead of a broken icon or an audio error.
- Results shows how many of each kind were captured (for example "1 photo · 1 voice note · 1 signature"), the field each one answers, and its upload status. Transcripts can be edited, and each signature shows when it was signed.
- Voice notes are recorded as MP4/AAC on Apple devices and WebM elsewhere, using only formats the device can play back.
- Analysis: only photos are sent to the vision model. Signatures are no longer counted as photos. For a voice note, the phone's transcript is used if there is one. Otherwise Hermes transcribes the voice note after upload, using the speech-to-text provider the Hermes operator configured. That may be a local engine or a cloud provider, if the operator set one up. The transcript, or the reason there is none, is stored with the record. Transcripts are included in the analysis, and a voice note without one is listed under missing information with the reason.
- Operators can turn Hermes-side transcription off with the plugin setting `voice_transcription: false` (or the environment variable `FIELDKIT_VOICE_TRANSCRIPTION=false`). It is on by default.
- Reports have an **Evidence** section: a summary, the voice-note transcripts and where each came from, each signature with its time, an integrity check against the stored file, and a **Show signature** button.
- Records from other devices (shown as "From …") load their photos, voice notes and signatures from Hermes on demand. This needs internet, and each file is checked against its SHA-256.
- **Verified on the owner's iPhone with 0.2.4** (photos, voice notes, signatures, Results, reports). The exact iOS cause of the original broken thumbnail and audio error was never reproduced on desktop WebKit; the fixes target the known causes (files stored in IndexedDB shown through object URLs, and WebM playback), and the owner confirmed both problems are gone on the iPhone.

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
| Full Hermes Mobile conversation (0.2.4, owner-reported, 2026-11-09) | Owner checked FieldKit end to end through the Hermes mobile app on iPhone and reported everything working |
| OCR, translation and speech-to-text on iPhone (0.2.4, owner-reported, 2026-11-09) | Working on the owner's iPhone. The accuracy numbers in this README come from synthetic test material, not from these device checks |
| Photos, voice notes, signatures, Results and Evidence on iPhone (0.2.4, owner-reported, 2026-11-09) | The broken photo thumbnail and audio playback error are gone; signatures and voice notes reach Hermes and the reports |
| Offline reports on iPhone (owner-reported, 2026-11-09) | Working |
| Saved Records across Safari and the Home Screen app (owner-reported, 2026-11-09) | Working |
| FieldKit dashboard tab on the hosted Hermes (owner-reported, 2026-11-09) | All 8 sections visible; analysis automatic with the LLM available; 7 records complete, 7 jobs completed, 0 conflicts; reports cite the photo and the inspector's voice note |

### Verified in Chromium + WebKit (WebKit is Safari's engine, not iOS itself; real Hermes v0.23.0)

| Area | Status |
|---|---|
| Offline OCR (English) and English↔Hindi translation | Work after a cold restart with no network; model files verified by SHA-256 on install |
| Offline speech-to-text (Whisper) | Verified in Chromium only (WebKit cannot simulate a microphone) |
| OCR, speech-to-text and translation accuracy (0.2.4, synthetic test material, see [tests/eval/README.md](tests/eval/README.md)) | OCR: Chromium and WebKit. Speech-to-text and translation: measured in Node with the same ONNX files, not in a browser. The features were then checked working on the owner's iPhone; the error rates themselves were not measured on a phone |
| Photos, voice notes, signatures and Evidence (`media.spec.ts`, 0.2.4; real Hermes v0.23.0) | Chromium: passed (voice note via fake microphone). WebKit: passed (photo and signature; WebKit has no fake microphone). Real Hermes speech-to-text of uploaded spoken voice notes: passed on the local Hermes in both runs |
| Downloaded Hermes reports | Readable offline after a cold restart |
| Dashboard tab | Works inside the real Hermes dashboard, all 7 sections |
| Strict offline | No request leaves the device while offline; record survives restart; auto-sync on reconnect with no user action |
| Install buttons | Switch to "Reinstall" immediately |
| Update notice | Compact, never overlaps content (320 px screen, keyboard open) |
| Saved Records across devices (two isolated profiles, same Hermes account) | One list with no duplicates, readable device names, badges, Download all, offline cold start, offline-saved record auto-syncs on reconnect and appears on the other client, same Account ID on both, Device ID only under Advanced, another account on the same browser sees no copies |

### Verified locally for 0.2.5 (throwaway Hermes v0.23.0, not the owner's iPhone or hosted Hermes)

Details and commands for each phase are in [docs/TESTING.md](docs/TESTING.md) (Phase A to Phase F).

| Area | Status |
|---|---|
| Example rules, safe upgrades and calibrated review (Phase A) | Verified on the local Hermes: `equipment-inspection` and `crop-health-survey` published as v2 |
| Workspace model, evidence rules and publishing (Phase B) | Covered by tests (pytest) and the Chromium E2E run |
| Hermes builds the workspace (Phase C) | Chromium E2E: publish, link, one-tap download, offline cold restart. `hermes plugins validate` passed. A real Hermes interview with live web research is **not verified** |
| Decision-focused reports (Phase D) | Covered by pytest and Chromium E2E (`decision.spec.ts`) |
| Offline assistant understands (Phase E) | Verified with the real model after a cold restart with no network, in Chromium and WebKit (`assistant.spec.ts`) |
| Learning from verified outcomes (Phase F) | Verified in Chromium and WebKit (`learning.spec.ts`): offline question and a "not helpful" vote, sent to Hermes after sync, candidates, practice published as v2, phone update labelled |

### Automated tests and security checks

| Area | Status |
|---|---|
| Tests | 191 Python tests, 128 TypeScript tests, 20 Playwright E2E spec files (per-browser results in [docs/TESTING.md](docs/TESTING.md)). Every one of the 35 Hermes tools has a test (guard: `test_every_registered_tool_is_exercised_by_tests`) |
| Simulated Hermes Mobile conversation | Covered by a test: create, publish, app link, sync, process jobs, get record and report, compare and save report, follow-up, sync status, conflict resolution. The real conversation was also checked on the owner's iPhone (see above) |
| Security | `hermes plugins validate` security scan: safe. `npm audit`: 0 vulnerabilities. `pip-audit`: 0 known vulnerabilities |
| Access control | Every API route checks the signed-in user; the app page is public and contains no data. v0.1.7 fixed a cross-user leak where `GET /jobs` listed other users' jobs |

### Pending

| Area | Status |
|---|---|
| Android Chrome | Pending |
| Scheduled analysis via a Hermes cron job | Pending |
| `hermes plugins doctor . --ci` | Pass (0.2.6: 35 tools, 1 hook; `hermes plugins validate` passed) |
| 0.2.5 workspaces, reports, assistant and learning on iPhone and the hosted Hermes | Pending |
| A full builder conversation with live web research on the hosted Hermes | Pending (done on a local Hermes logged into Nous, see below) |
| Real Hermes builder conversations, local Hermes + Nous Portal (`x-ai/grok-4.7`) | Verified 2026-11-10: dairy (research, resume in a new chat, publish) and a cotton farmer group (fast setup: build turn 140 s, no web calls); both guides run offline on the phone ([docs/TESTING.md](docs/TESTING.md)) |

### Known limitations
- Saved Records loads the newest 500 records per account; with more, older ones are not listed and the "Hermes doesn't have these records" check pauses.
- The small OPUS-MT model mistranslates some technical terms (for example "bearing" → "bear"). Dictionary terms help when an installed dictionary has the term, but general quality is still limited.
- Whisper tiny is English-only; Hindi needs the 250 MB Whisper small pack (about 18–31% character errors on synthetic speech).
- OCR cannot read blurred or dark photos. It says so and asks for a retake. Handwriting is not supported.
- iOS PWAs have separate storage from Safari. Sign in once inside the installed app.
- Uploads run while the app is open. There is no background upload from a closed app.
- Hermes OAuth sessions last 15 minutes. Sync pauses and asks you to sign in; nothing is lost.
- The offline assistant answers only from workspace content, records and reports. It never generates an answer, and it refuses off-topic questions.
- The "Question understanding" pack is 118 MB. Without it, the assistant uses basic word search.
- Local-practice learning needs at least 3 consistent verified outcomes (at least 80% worked, from distinct records). Until then, no practice is proposed.

## Docs
[ARCHITECTURE.md](ARCHITECTURE.md) · [RESEARCH.md](RESEARCH.md) · [docs/API.md](docs/API.md) · [docs/INSTALL.md](docs/INSTALL.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/SUBMISSION.md](docs/SUBMISSION.md) · [THIRD_PARTY.md](THIRD_PARTY.md)

MIT licensed. Demo content is synthetic.
