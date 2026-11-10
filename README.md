# FieldKit for Hermes Agent

**Record offline. Sync when back online. Ask your Hermes agent about what you recorded.**

FieldKit is an offline observation collection and synchronisation plugin for Hermes. You describe your work to Hermes in a
chat, and Hermes builds the forms. On your phone you fill in the forms with no signal: text, numbers, choices, photos,
voice notes, GPS and signatures. When you are back online, the entries and their files upload to Hermes. Then you ask
Hermes about them.

FieldKit is not an assistant, a research tool or a decision system. It never calls a model. Hermes does any analysis,
with its own tools, when you ask.

```text
Set up by chat → record offline → sync (upload only) → ask your Hermes agent
```

## Quick start
```bash
hermes plugins install Snehal707/fieldkit && hermes plugins enable fieldkit
```
Restart the Hermes dashboard. Then, in Hermes (Mobile, chat or dashboard):

> "Set up FieldKit for my work."

Hermes asks what you record, shows you a summary, and publishes the workspace after you approve. It returns a link. Open
the link on your phone, sign in once, tap **Download everything for offline**, and add the app to your home screen.
Details: [docs/INSTALL.md](docs/INSTALL.md).

## How it works

### 1. Set up by chat
Hermes asks what the workspace is for, which languages you use (English or Hindi), and what each entry records. A
workspace has one or more **forms**. Each form has questions of these types: text, multiline text, number, date, time,
checkbox, single choice, multiple choice, photo, audio (voice note), GPS, signature and instruction.

- Questions can be required, or shown only when a condition holds. They can have validation rules and units.
- A form can name the field that identifies what an entry is about (a site, a person, an asset). Earlier entries of the
  same subject can then be found.
- Notes and issues are ordinary fields.
- FieldKit checks every form Hermes writes. It repairs common shape mistakes (for example "select" becomes a single
  choice) and reports precise errors for conditions.

### 2. Record offline (phone)
- Forms with conditions, validation, units, photos (compressed), voice notes, GPS and signatures. Drafts save as you type.
- Each entry keeps the form version it was made with.
- Optional tools, installed from **Offline Packs**: **Scan text** (OCR in English or Hindi; also **Extract text** on a
  photo inside a form) and **Translate** (English ↔ Hindi).

### 3. Sync (upload only)
Entries and files upload when the app is open and the phone is online. Each file is checked by SHA-256, and a resend
never creates a duplicate. If an entry was changed on two devices, a conflict is shown for you to resolve. An expired
sign-in pauses the queue without losing anything. **Syncing only uploads. Nothing is processed.**

### 4. Ask your Hermes agent
Hermes reads what you synced through FieldKit's tools: entries (filtered by workspace, form, subject or date), one entry
with its answers and the earlier entries of the same subject, and its photos, voice notes and signatures as local files.
Hermes looks at photos and listens to voice notes with its own tools, when you ask. For example:
- "What do the photos from the kitchen visit show?"
- "Summarise my surveys from last month."
- "Is this inspection worse than the last one for this pump?"

### 5. Edit and undo by chat
Ask for a change: "Add a question about the door seal", "remove the GPS field", "change the purpose". Hermes changes only what
you asked, shows the changes, and asks "Publish these changes?". Each change is a new version, and Hermes publishes only
after you approve. The phone then shows **Update available** with the changes.

Entries keep the questions and answers they were recorded with, including questions that were later removed.
**"Undo my last workspace update"** republishes the previous version as a new version.

## What's in the plugin

| Part | What it is |
|---|---|
| **Hermes tools** | 12 tools (see [docs/API.md](docs/API.md)): set up, change, publish and undo workspaces; read entries, attachments, sync status and conflicts; the phone link. |
| **Skills** | `fieldkit` (find and read entries; Hermes analyses them with its own tools) and `fieldkit-workspace-builder` (set up, change and undo workspaces). |
| **Session note** | One short note in each new Hermes session that lists your workspaces. |
| **Phone app (PWA)** | Installable, works offline. Bottom bar: Home, Workspace, Records, Sync, Settings. Served at `/dashboard-plugins/fieldkit/app_dist/index.html`. |
| **Dashboard tab** | Overview, Records (answers and attachments), Synchronization (devices and conflicts), Mobile Access (link and QR code). |
| **Setting** | `public_url` only (optional). |

The plugin registers no hooks, runs no background worker and never calls a model.

## Verification (honest)

Exact commands and results are in [docs/TESTING.md](docs/TESTING.md).

**Local test only.** Hermes Agent v0.23.0 on a local machine, with real conversations (model `openai/gpt-5.4-mini` via
Nous), 2026-11-10. This was **not** the hosted Hermes and **not** the owner's iPhone.
- Unit tests: 88 Python and 100 TypeScript. Typecheck clean. `hermes plugins validate` passed. `hermes plugins doctor --ci`: 12 tools, 0 hooks.
- Browser end-to-end tests (Playwright): Chromium 27 passed, 2 skipped; WebKit 19 passed, 8 skipped. Two WebKit failures passed on rerun after a fix.
- Setup by chat, edit and undo by chat, and asking about a synced visit with a photo all worked with the new tools.
- Copies of two databases from earlier real-Hermes runs opened with 0.3: no row counts changed, and all old entries, reports
  and workspace versions stayed readable.

**Owner's iPhone with the hosted Hermes, version 0.2.4 (2026-11-09, owner-reported):** offline recording, sync, media
(photos, voice notes and signatures) and Saved Records worked. That collection code is unchanged in 0.3, so this still
applies to it. The 0.3 changes (workspaces by chat, the phone's new screens and the removed tools) have not yet been
checked on the iPhone or the hosted Hermes.

## Known limitations
- Hermes must run on one machine with one persistent volume. Data lives in `<HERMES_HOME>/plugin-data/fieldkit/data.db`.
- After `hermes plugins update fieldkit`, restart the Hermes dashboard **and** any running Hermes gateway. A running gateway keeps the old plugin code loaded.
- iOS Home Screen apps have storage separate from Safari: sign in once inside the app.
- Uploads run only while the app is open. There is no background upload from a closed app.
- Saved Records lists the newest 500 entries per account.
- Photos and voice notes are analysed only by your Hermes agent, with its own vision and speech-to-text tools. Configure those tools in Hermes. With a text-only main model, configure a vision model (see [docs/INSTALL.md](docs/INSTALL.md)).
- Approval before publishing relies on Hermes asking. FieldKit cannot see whether you replied in between.
- OCR cannot read blurred, dark or handwritten text, and the app says so. The small translation model mistranslates some technical terms: check important wording.
- Phone languages: English and Hindi.
- Android Chrome is not yet tested.

## Docs
[ARCHITECTURE.md](ARCHITECTURE.md) · [docs/API.md](docs/API.md) · [docs/INSTALL.md](docs/INSTALL.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/SUBMISSION.md](docs/SUBMISSION.md) · [RESEARCH.md](RESEARCH.md) ·
[THIRD_PARTY.md](THIRD_PARTY.md)

MIT licensed. Demo content is synthetic.
