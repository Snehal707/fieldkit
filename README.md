# FieldKit for Hermes Agent

**Observe anywhere. Understand more when connected. Act better next time.**

FieldKit is an offline fieldwork platform powered by Hermes. It is not an offline Google or an AI diagnosis tool. The
phone records and applies your own rules offline. Hermes answers questions about a visit when you ask.
Saving data is the default; Hermes helps only when you ask.

**Act better next time** means every answer uses earlier entries of the same subject.

Hermes does the parts that need internet access and judgement. It interviews you about your work, starting with what
the workspace is for, and builds the workspace from your answers. You can change it later in chat. FieldKit stores the
workspace, checks it, computes how well each item is evidenced, and runs it on the phone. Visits work the same way:
fill in a form offline, sync, and ask Hermes about a visit when you want an answer.

FieldKit is one Hermes plugin with three parts:

| Part | What it is |
|---|---|
| **Native plugin** | 20 Hermes tools plus two bundled skills (`fieldkit`, `fieldkit-workspace-builder`). They interview you, build, change, publish and undo workspaces; answer questions about a visit; and list and read records, reports, sync status and conflicts. |
| **Dashboard tab** | A *FieldKit* tab in the Hermes dashboard with four sections: Overview, Records (each visit with its questions and answers, and older reports if any), Synchronization, and Mobile Access (link and phone QR code). |
| **Offline PWA** | An installable mobile app served by the plugin at `/dashboard-plugins/fieldkit/app_dist/index.html`. Bottom bar: Home, Workspace, Assistant, Sync, Settings. It handles workflows with branching, validation, photos, GPS, audio and signatures; local findings; decision guides; the Workspace Assistant over workspace content, records and reports; questions for Hermes about a visit (kept offline until sync); your workspace and its "On this phone" summary; dictionaries; sentence translation; OCR; speech-to-text; a durable sync queue; older Hermes reports; connection diagnostics. |

It is **domain-independent**. Workflows, knowledge, dictionaries and classification rules are data, so a new
domain needs no code changes. The demo ships three unrelated domains with equal weight:
- **Education:** classroom observation.
- **Equipment maintenance:** equipment inspection.
- **Agriculture:** crop health survey.

```text
Set up (Hermes Mobile) → Download (PWA) → Work offline → Local results → Sync → Hermes answers questions (when asked) → Offline again
```

## Quick start
```bash
hermes plugins install Snehal707/fieldkit && hermes plugins enable fieldkit
```
Then, in Hermes (Mobile, chat or dashboard):

> "Install the FieldKit examples."
> "Set up FieldKit for my work."

Hermes returns a tappable app link once FieldKit knows its public `https` address. This is detected automatically
the first time the dashboard tab or the app is opened over https. Open the link on your phone, sign in, tap
**Download for offline**, and add the app to your home screen.
Full instructions are in [docs/INSTALL.md](docs/INSTALL.md).

## Workspaces (0.2.6)
To set up FieldKit for your job, ask Hermes:

> "Set up FieldKit for my work."

Hermes starts by asking what the workspace is for. Then it asks 5 to 8 follow-up questions chosen for that purpose
(research or data collection, inspections, business or client visits, personal logs, or anything else). Required: the
purpose, what each entry records, and your languages. Optional, and only if they apply: decisions, rules, escalation,
country or region, instruments and procedures. With no decisions there is no decision scale or guide; nothing is
invented. The form can name the field that identifies an entry (for example participant, asset or client), which
FieldKit uses to find earlier entries of the same subject. It shows you a brief to confirm, then builds the workspace
straight away. There is no up-front web research. Your own rules and documents are
labelled **Your procedure**. Checking a rule against official sources is optional and short. When it is used, FieldKit
re-fetches each cited web page and drops any quote it cannot find there. PDF sources are checked with Hermes' own
document extractor.

Every item is labelled by how well it is evidenced: **verified**, **supported**, **conflicting** (with a named
escalation), **your procedure**, **learned local practice**, or **unverified**. Unverified model knowledge can never
become a decision action, a threshold or a procedure. Hermes publishes the workspace only after you approve it, and
returns a link. Open the link on your phone and tap **Download everything for offline**. The three bundled examples
are starter workspaces, labelled synthetic.

Setup is fast. In local tests with real conversations, a build took about 2.5 minutes on average (about 4.3 minutes
for five jobs in total). FieldKit checks every part and repairs obvious shape mistakes; quotes from web sources are
checked in the background, and publishing waits until they finish.

Older workspaces may contain `report_policy.after_sync`; it is accepted and ignored.

### Changing a workspace by chat
Ask Hermes, for example "add a question…", "remove the GPS field", "change the description" or "change our rule".
Hermes changes only what you asked for and builds the workspace. FieldKit returns a short change summary, and Hermes
asks before it publishes. Publishing creates a new, validated version. The change summary becomes its changelog, and
the phone shows **Update available**. Old records keep their original version and answers.

"Undo my last workspace update" republishes the previous version as a new version, and phones get it as an update. An
explicit undo request counts as your approval. If the request is unclear, Hermes previews the change first.

FieldKit cannot see whether you replied to Hermes' approval question, so the approval steps rely on Hermes following
its instructions.

## What works offline (on the phone)
- Opening the app from the home screen after the browser is fully closed. A service worker caches the shell. The app is launched from Hermes' public plugin-asset address, so even with an expired Hermes session (or no service worker) it opens normally and offers **Sign in**, returning to FieldKit afterwards; on-device data never needs a login.
- Running workflows with:
  - every input type: text, number, date, time, yes/no, single and multiple choice, photos (compressed), GPS (with manual fallback), audio notes, signatures and instructions;
  - conditional questions, required-if rules, constraints and drafts that save as you type.
- An immediate Results page:
  - validation, answers, local findings (rules, keywords, scores, decision trees), relevant references, explanations, media and GPS;
  - a clear *"Saved locally. Pending synchronization."* label. Local findings are never presented as Hermes analysis.
- Your workspace (once downloaded): profile, workflows, decision guides, evidence summary, sources and gaps.
- Earlier form versions. Each visit is shown with the questions it was recorded with. Answers to removed questions remain.
- An **On this phone** summary on each workspace page: records saved (and today), records flagged by your rules with the worst severity, unfinished records, records waiting to sync, and Hermes reports. It is calculated on the phone, with no AI.
- Decision guides, which run offline. They ask only for what is missing and show the outcome with the evidence status of each action.
- The **Workspace Assistant** answers from your procedures, rules and the visits saved on the phone, with citations and evidence status. It answers from the workspace of the workflow or visit in use, and an "Answering from" picker appears when several workspaces are downloaded. When a visit has no Hermes answer yet, "what first", "why" and "is it safe" questions about it are answered from the on-phone result. For a question about a visit, it can send the question to Hermes ("Ask Hermes about this visit"). Anything it cannot answer is saved for Hermes. Nothing is generated. It understands questions by meaning in English and Hindi when the optional "Question understanding" pack is installed (118 MB); without it, the assistant uses basic word search.
- A knowledge browser. Retrieval answers come with a source.
- Dictionary search (exact, translation, prefix and fuzzy matches).
- Sentence translation English→Hindi and Hindi→English (OPUS-MT, on device). Terms from installed dictionary packs are used in the translation, and the Translate screen lists the dictionary terms it used.
- OCR in English and Hindi (tesseract.js). Photos keep their orientation (EXIF) and are read at high resolution with lighting correction. Each result gets a reliability verdict (good, check or poor). When the text is poor, the app says so and asks you to retake the photo closer, in good light.
- Speech-to-text in English with the Whisper tiny pack (version 2, about 64 MB). Hindi speech-to-text needs the optional Whisper small pack (about 250 MB, slower).
- Read-aloud with local voices only.
- Older Hermes reports, if any.
- A header that shows the device network, Hermes reachability, records awaiting confirmation and "N not submitted" drafts. Tap the status pill for connection diagnostics.

## What happens when you reconnect
- The outbox uploads records, then media.
  - Each upload has a stable idempotency key, and every file is checked against its SHA-256.
  - The server acknowledges each step, and revisions use optimistic concurrency.
  - Conflicts are shown for you to decide; nothing is silently overwritten.
- An expired Hermes session pauses the queue (nothing is lost) and asks you to sign in. The queue resumes afterwards.
- Syncing uploads records and attachments. It never starts AI work, a report or an answer. Hermes transcribes a voice note with no phone transcript only when someone asks about its visit.
- Earlier versions (before 0.2.6) wrote a structured AI report automatically after sync. Sync no longer starts one. See [Earlier-version features](#earlier-version-features).
- Photos go to a separate vision model when one is configured (the `fieldkit_vision` slot).
- Older reports, written before 0.2.6, are stored centrally. They are visible in the PWA (and downloadable for offline use), in the dashboard, and to Hermes through `fieldkit_get_report`.

## Questions about a visit (0.2.6)
- While filling in a form, add one or more questions under **Questions for Hermes (optional)**. Afterwards, open the visit and tap **Ask Hermes about this visit**. Suggested questions (for example "What should I do next?" and "What do the photos show?") are offered, and you can write your own.
- It works offline. Questions are kept on the phone with the visit, its workspace and its photos, and are sent after the visit syncs.
- A queued question is the request. After sync, FieldKit's worker answers it from that visit's evidence: answers, photos, voice-note transcripts (made by Hermes speech-to-text if the phone had none), on-phone findings, the workspace's procedures, and up to 3 earlier visits of the same subject.
- The answer (with confidence, uncertainty, what it was based on and next steps) returns to the same visit and can be read offline.
- Answers are about that visit only. They never become workspace rules or learning events.
- If the model provider rate-limits the request, the question waits as the provider says and stays queued.
- In Hermes chat, ask about one visit. `fieldkit_ask_about_record` looks at the evidence itself, answers at once, and saves the answer on that visit for the phone. `fieldkit_list_questions` shows queued and answered questions.
- Ask about several visits or a whole workspace ("summarise my 50 surveys", "which sites turned into quotes?"): Hermes reads their answers with `fieldkit_list_records` (`include_answers`, filtered by `workspace_id`) and looks at individual visits with `fieldkit_ask_about_record` when their photos or voice notes matter.

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
- Analysis: only photos are sent to the vision model. Signatures are no longer counted as photos. For a voice note, the phone's transcript is used if there is one. Otherwise Hermes transcribes the voice note only when someone asks about its visit (never when it is uploaded), using the speech-to-text provider the Hermes operator configured. That may be a local engine or a cloud provider, if the operator set one up. The transcript, or the reason there is none, is stored with the record.
- Operators can turn Hermes-side transcription off with the plugin setting `voice_transcription: false` (or the environment variable `FIELDKIT_VOICE_TRANSCRIPTION=false`). It is on by default.
- Older reports (before 0.2.6) have an **Evidence** section: a summary, the voice-note transcripts and where each came from, each signature with its time, an integrity check against the stored file, and a **Show signature** button.
- Records from other devices (shown as "From …") load their photos, voice notes and signatures from Hermes on demand. This needs internet, and each file is checked against its SHA-256.
- **Verified on the owner's iPhone with 0.2.4** (photos, voice notes, signatures, Results, reports). The exact iOS cause of the original broken thumbnail and audio error was never reproduced on desktop WebKit; the fixes target the known causes (files stored in IndexedDB shown through object URLs, and WebM playback), and the owner confirmed both problems are gone on the iPhone.

## Verification status (honest)
See [docs/TESTING.md](docs/TESTING.md) for the exact commands and results. Anything not listed as verified below is pending.

### Verified on iPhone (real device, hosted Hermes v0.23.0)

These results are for 0.2.4 and earlier. Nothing from 0.2.5 or 0.2.6 is verified on the owner's iPhone or the hosted Hermes yet.

| Area | Status |
|---|---|
| Offline inspection | Completed with no internet, saved locally, shows "1 awaiting confirmation" |
| Automatic sync | After reconnecting, record `rec_6b0da392e6284a70ae1bd33b` was received 41 s after completion; all 11 answers and the photo uploaded |
| Automatic AI report (before 0.2.6) | Generated automatically after sync (GLM 5.3, text-only fallback). Since 0.2.6, sync does not start a report |
| Automatic photo analysis (before 0.2.6) | Ran through the configurable `fieldkit_vision` model slot |
| Sign-in and plugin lifecycle | Sign-in returns to FieldKit; plugin install, enable and update work without a restart |
| Full Hermes Mobile conversation (0.2.4, owner-reported, 2026-11-09) | Owner checked FieldKit end to end through the Hermes mobile app on iPhone and reported everything working |
| OCR, translation and speech-to-text on iPhone (0.2.4, owner-reported, 2026-11-09) | Working on the owner's iPhone. The accuracy numbers in this README come from synthetic test material, not from these device checks |
| Photos, voice notes, signatures, Results and Evidence on iPhone (0.2.4, owner-reported, 2026-11-09) | The broken photo thumbnail and audio playback error are gone; signatures and voice notes reach Hermes and the reports |
| Offline reports on iPhone (owner-reported, 2026-11-09) | Working |
| Saved Records across Safari and the Home Screen app (owner-reported, 2026-11-09) | Working |
| FieldKit dashboard tab on the hosted Hermes (owner-reported, 2026-11-09) | All 8 sections visible; analysis automatic with the LLM available (before 0.2.6); 7 records complete, 7 jobs completed, 0 conflicts; reports cite the photo and the inspector's voice note |

### Verified in Chromium + WebKit (WebKit is Safari's engine, not iOS itself; real Hermes v0.23.0)

| Area | Status |
|---|---|
| Offline OCR (English) and English↔Hindi translation | Work after a cold restart with no network; model files verified by SHA-256 on install |
| Offline speech-to-text (Whisper) | Verified in Chromium only (WebKit cannot simulate a microphone) |
| OCR, speech-to-text and translation accuracy (0.2.4, synthetic test material, see [tests/eval/README.md](tests/eval/README.md)) | OCR: Chromium and WebKit. Speech-to-text and translation: measured in Node with the same ONNX files, not in a browser. The features were then checked working on the owner's iPhone; the error rates themselves were not measured on a phone |
| Photos, voice notes, signatures and Evidence (`media.spec.ts`, 0.2.4; real Hermes v0.23.0) | Chromium: passed (voice note via fake microphone). WebKit: passed (photo and signature; WebKit has no fake microphone). Real Hermes speech-to-text of uploaded spoken voice notes: passed on the local test Hermes in both runs |
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
| Example rules, safe upgrades and calibrated review (Phase A) | Verified on the local test Hermes: `equipment-inspection` and `crop-health-survey` published as v2 |
| Workspace model, evidence rules and publishing (Phase B) | Covered by tests (pytest) and the Chromium E2E run |
| Hermes builds the workspace (Phase C) | Chromium E2E: publish, link, one-tap download, offline cold restart. `hermes plugins validate` passed. A real Hermes interview with live web research is **not verified** |
| Decision-focused reports (Phase D) | Covered by pytest and Chromium E2E (`decision.spec.ts`) |
| Offline assistant understands (Phase E) | Verified with the real model after a cold restart with no network, in Chromium and WebKit (`assistant.spec.ts`) |
| Learning from verified outcomes (Phase F) | Verified in Chromium and WebKit (`learning.spec.ts`): offline question and a "not helpful" vote, sent to Hermes after sync, candidates, practice published as v2, phone update labelled |

### Verified locally for 0.2.6 (local test Hermes, not the owner's iPhone or hosted Hermes)

Not yet verified on the owner's iPhone or on the hosted Hermes.

| Area | Status |
|---|---|
| Fast workspace setup from the interview | Real conversations on a local test Hermes: average build about 2.5 minutes, about 4.3 minutes for 5 jobs (ASHA worker, electrical inspector, student survey, restaurant food safety, cotton farmer group) |
| Saving and syncing never trigger AI work | Verified on a local test Hermes: an observation-only visit synced with no model call |
| Questions about a visit (queued offline, answered after sync) | Verified locally on a local test Hermes: answers back on the phone in 32–37 s; Hermes read the photo and used the voice-note transcript and the user's own rule |
| Chat question about one visit (`fieldkit_ask_about_record`) | Verified locally on a local test Hermes: "What do you think about my latest kitchen food-safety visit?" called `fieldkit_ask_about_record` and gave an assessment with uncertainty and a next step (44 s) |
| Report rate-limit handling (earlier reports) | A rate-limited report waited and stayed pending (observed in a local field trial; one deferred report then completed). With `openai/gpt-5.4-mini` via Nous, a real report took 57 s |
| Editing a workspace by chat | Verified on a local test Hermes (real conversation, `openai/gpt-5.4-mini` via Nous): "add 'Fridge door seal intact?', remove 'Pest signs'" changed the form, rule and guide, and Hermes asked "Publish these changes?" (171 s). FieldKit's summary listed the 4 changes. Publish took 19 s. The phone showed "Update available: version 2", with the door-seal question and no pest question. An older visit read offline still showed "Pest signs seen: Yes" |
| Undo my last workspace update | Verified on a local test Hermes: "Undo my last workspace update" (41 s) republished version 1 as version 3. The phone showed "Update available: version 3 — Undo: back to version 1". The older visit stayed readable |

### Automated tests and security checks

| Area | Status |
|---|---|
| Tests (0.2.6) | 202 Python tests, 130 TypeScript tests, Chromium E2E 30 passed and 5 skipped (per-browser results in [docs/TESTING.md](docs/TESTING.md)). The guard `test_every_registered_tool_is_exercised_by_tests` checks the registered Hermes tools |
| Simulated Hermes Mobile conversation | Covered by a test (not re-checked against the 0.2.6 tool list). The real conversation was also checked on the owner's iPhone with 0.2.4 (see above) |
| Security | `hermes plugins validate` security scan: safe. `npm audit`: 0 vulnerabilities. `pip-audit`: 0 known vulnerabilities |
| Access control | Every API route checks the signed-in user; the app page is public and contains no data. v0.1.7 fixed a cross-user leak where `GET /jobs` listed other users' jobs |

### Pending

| Area | Status |
|---|---|
| Android Chrome | Pending |
| Scheduled analysis via a Hermes cron job | Removed from the 0.2.6 story (earlier version) |
| 0.2.6 workspace editing and undo on the owner's iPhone and the hosted Hermes | Pending |
| `hermes plugins doctor . --ci` | Pass (0.2.6 final: 20 tools, 1 hook; `hermes plugins validate` passed) |
| 0.2.5 workspaces, reports, assistant and learning on iPhone and the hosted Hermes | Pending |
| A full builder conversation with live web research on the hosted Hermes | Pending (done on a local test Hermes logged into Nous, see below) |
| Real Hermes builder conversations, local test Hermes + Nous Portal (`x-ai/grok-4.7`) | Verified 2026-11-10: dairy (research, resume in a new chat, publish) and a cotton farmer group (fast setup: build turn 140 s, no web calls); both guides run offline on the phone ([docs/TESTING.md](docs/TESTING.md)) |

### Known limitations
- Saved Records loads the newest 500 records per account; with more, older ones are not listed and the "Hermes doesn't have these records" check pauses.
- The small OPUS-MT model mistranslates some technical terms (for example "bearing" → "bear"). Dictionary terms help when an installed dictionary has the term, but general quality is still limited.
- Whisper tiny is English-only; Hindi needs the 250 MB Whisper small pack (about 18–31% character errors on synthetic speech).
- OCR cannot read blurred or dark photos. It says so and asks for a retake. Handwriting is not supported.
- iOS PWAs have separate storage from Safari. Sign in once inside the installed app.
- Uploads run while the app is open. There is no background upload from a closed app.
- Hermes OAuth sessions last 15 minutes. Sync pauses and asks you to sign in; nothing is lost.
- The Workspace Assistant answers only from your procedures, rules, workspace content, records and reports. It never generates an answer, and it refuses off-topic questions.
- A question about a visit needs Hermes' model to answer. It stays queued until then, and a rate-limited question waits as the provider says.
- The "Question understanding" pack is 118 MB. Without it, the assistant uses basic word search.
- Workspace approval steps rely on Hermes asking before it publishes. FieldKit cannot see whether you replied in between.

## Earlier-version features (not in the 0.2.6 story)
Removed from the product story in 0.2.6. Older data stays readable where noted, and the code is kept for existing data.
- Automatic structured AI reports. Older reports stay viewable in the PWA, the dashboard and through `fieldkit_get_report`.
- Follow-up checks and follow-up tasks.
- The learning loop: learning candidates, and local practice from verified outcomes.
- Standalone workflows and knowledge or dictionary packs. Workspaces build these as parts.
- Scheduled cron analysis.
- The transcribe-on-upload setting. It was removed; voice notes are transcribed only when someone asks about the visit.
- Tools retired from Hermes in 0.2.6 are listed in [docs/API.md](docs/API.md#hermes-tools).

## Docs
[ARCHITECTURE.md](ARCHITECTURE.md) · [RESEARCH.md](RESEARCH.md) · [docs/API.md](docs/API.md) · [docs/INSTALL.md](docs/INSTALL.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/SUBMISSION.md](docs/SUBMISSION.md) · [THIRD_PARTY.md](THIRD_PARTY.md)

MIT licensed. Demo content is synthetic.
