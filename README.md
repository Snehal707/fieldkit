# FieldKit for Hermes Agent

**Create a workflow by talking to Hermes, run it on a phone with no internet, get local results immediately,
sync when you're back online, and have Hermes analyse it. You can discuss the result in Hermes Mobile and keep
the report readable offline.**

FieldKit is one Hermes plugin with three parts:

| Part | What it is |
|---|---|
| **Native plugin** | 23 Hermes tools plus a bundled skill. It creates, validates and publishes workflows; turns documents into knowledge packs; builds dictionaries; retrieves, analyses, compares and reports on synchronised records; and manages follow-ups, sync status and conflicts. |
| **Dashboard tab** | A *FieldKit* tab in the Hermes dashboard: workflows, knowledge, records (with photos and audio), reports and follow-ups, synchronisation, offline packs, and a phone QR code. |
| **Offline PWA** | An installable mobile app served by the plugin at `/api/plugins/fieldkit/app/`. It handles workflows with branching, validation, photos, GPS, audio and signatures; local findings; an offline assistant over knowledge packs; dictionaries; sentence translation; OCR; speech-to-text; read-aloud; a durable sync queue; and downloaded Hermes reports. |

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

Open the returned link on your phone, sign in, tap **Download for offline**, and add the app to your home screen.
Full instructions are in [docs/INSTALL.md](docs/INSTALL.md).

## What works offline (on the phone)
- Opening the app from the home screen after the browser is fully closed. A service worker caches the shell, and a 401 from an expired session still opens the cached app.
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

## What happens when you reconnect
- The outbox uploads records, then media.
  - Each upload has a stable idempotency key, and every file is checked against its SHA-256.
  - The server acknowledges each step, and revisions use optimistic concurrency.
  - Conflicts are shown for you to decide; nothing is silently overwritten.
- An expired Hermes session pauses the queue (nothing is lost) and asks you to sign in. The queue resumes afterwards.
- The server queues a durable analysis job. Hermes' own LLM (`ctx.llm`) produces a schema-validated report with issues, missing information, references, actions and follow-ups.
- The report is stored centrally. It is visible in the PWA (and downloadable for offline use), in the dashboard, and to Hermes Mobile through FieldKit tools.

## Verification status (honest)
See [docs/TESTING.md](docs/TESTING.md) for the exact commands and results.

| Area | Status |
|---|---|
| `hermes plugins validate` / `doctor --ci` (Hermes 0.23.0) | ✅ pass |
| Plugin loads in a real Hermes 0.23.0 dashboard; tab is listed; routes are auth-gated (401) | ✅ verified locally (throwaway `HERMES_HOME`) |
| Python tests (engine, API, sync, isolation, jobs, tools via Hermes' real `PluginLlm` with an injected caller) | ✅ 74 passed |
| TypeScript tests (shared engine vectors, sync state machine, Q&A, dictionary) | ✅ 58 passed |
| Real Chromium E2E: offline cold start, workflow, results, persistence, session-expiry recovery, idempotent sync | ✅ passed |
| Real Chromium E2E: offline en→hi translation and OCR after cold restart, with zero network requests | ✅ passed (translation quality on technical text is limited; see TESTING.md) |
| Automatic analysis worker reaches Hermes' real `ctx.llm` in the dashboard process | ✅ verified (no provider in the test instance, so the job was retried as designed) |
| A real model-generated report | ⏳ needs the hosted instance (not yet authorised) |
| Hermes Mobile conversation calling FieldKit tools | ⏳ needs the hosted instance |
| Android Chrome / iOS Safari devices | ⏳ needs your phones over HTTPS ([device checklist](docs/TESTING.md#device-checklist)) |

## Docs
[ARCHITECTURE.md](ARCHITECTURE.md) · [RESEARCH.md](RESEARCH.md) · [docs/API.md](docs/API.md) · [docs/INSTALL.md](docs/INSTALL.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/SUBMISSION.md](docs/SUBMISSION.md) · [THIRD_PARTY.md](THIRD_PARTY.md)

MIT licensed. Demo content is synthetic.
