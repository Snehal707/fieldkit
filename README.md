# FieldKit for Hermes Agent

**Observe anywhere. Understand more when connected. Act better next time.**

FieldKit is an offline fieldwork platform powered by Hermes. You record entries on your phone with no signal: forms,
photos, voice notes, GPS. Your own rules give an instant result on the phone. When you are back online, entries sync,
and Hermes answers what you ask about them. **Saving and syncing never trigger AI work; Hermes helps only when you ask.**

It works for any kind of work: inspections, research and data collection, client or site visits, surveys, personal
logs. Hermes builds your workspace from a short interview in chat, and changes it when you ask.

```text
Tell Hermes about your work → workspace on your phone → record offline → sync → ask Hermes → answer back on the entry
```

## Quick start
```bash
hermes plugins install Snehal707/fieldkit && hermes plugins enable fieldkit
```
Restart the Hermes dashboard (it serves FieldKit's API). Then, in Hermes (Mobile, chat or dashboard):

> "Set up FieldKit for my work."

Hermes gives you a link. Open it on your phone, sign in once, tap **Download everything for offline**, and add the app
to your home screen. To try it without your own work, say "Install the FieldKit examples" (three synthetic starter
workspaces). Details: [docs/INSTALL.md](docs/INSTALL.md).

## How it works

### 1. Set up a workspace (a few minutes, in chat)
Hermes asks **what the workspace is for**, then 5–8 questions chosen for that purpose: what each entry records, what
identifies an entry (participant, asset, client…), and only if your work has them, the decisions you make, your rules,
who you escalate to, your instruments. It shows a summary to confirm, then builds the workspace from your answers. No
web research is needed.
- Your rules are labelled **Your procedure**. Nothing is invented: work without decisions gets no decision scale.
- FieldKit checks every part Hermes writes and rejects anything inconsistent before it can be published.
- Optional: checking a rule against an official source. FieldKit re-reads the cited page or PDF and drops any quote it
  cannot find. Unsourced model knowledge never becomes a rule.

### 2. Record offline (on the phone)
- Forms with branching, validation, units, photos (compressed), voice notes, GPS, signatures; drafts save as you type.
- An instant on-phone result from your rules, decision guides that ask only what is missing, and an **On this phone**
  summary per workspace (entries, flagged by your rules, unfinished, waiting to sync). All calculated on the phone.
- **Questions for Hermes:** add them while filling in the form, or later with **Ask Hermes about this visit**
  (suggested questions or your own). They wait on the phone until the entry syncs.
- **Workspace Assistant:** explains your procedures and rules and answers from the entries on the phone, with sources.
  It never makes things up; anything it can't answer about an entry can be sent to Hermes.
- Optional offline packs: OCR (English, Hindi), English↔Hindi translation, speech-to-text, and "Question
  understanding" (118 MB) so the assistant understands questions by meaning in English and Hindi.

### 3. Sync
Entries and files upload when you are online, each checked by SHA-256, with no duplicates; conflicts are shown for you
to decide. An expired sign-in pauses the queue without losing anything. **Syncing only uploads.**

### 4. Ask Hermes
- **About one entry**, on the phone or in chat ("What do you think about my latest kitchen visit?", "What do the photos
  show?"): Hermes looks at that entry's answers, photos, voice notes (transcribed only now), your procedures and up to
  3 earlier entries of the same subject. The answer gives confidence, uncertainty and next steps, and comes back to
  the same entry, readable offline. It stays about that case; it never becomes a rule.
- **About many entries or a whole workspace** in chat ("summarise my 50 surveys", "which visits turned into quotes?"):
  Hermes reads the entries and does what you asked.
- **Act better next time:** every answer takes earlier entries of the same subject into account.

### 5. Change the workspace by chat
"Add a question about the door seal", "remove the GPS field", "change our rule", "change the description": Hermes
changes only what you asked, FieldKit shows a short summary of the changes, and Hermes publishes only after you
approve. The phone shows **Update available** with the changes. Old entries keep the questions and answers they were
recorded with, including removed ones. **"Undo my last workspace update"** restores the previous version as a new one.

## What's in the plugin

| Part | What it is |
|---|---|
| **Hermes tools and skills** | 20 tools and two skills (`fieldkit`, `fieldkit-workspace-builder`): interview, build, edit, undo and publish workspaces; answer questions about entries; read entries, sync status and conflicts. |
| **Phone app (PWA)** | Installable, works fully offline. Home, Workspace, Assistant, Sync, Settings. Served at `/dashboard-plugins/fieldkit/app_dist/index.html`. |
| **Dashboard tab** | Overview, Records (each entry with its questions and answers), Synchronization, Mobile Access (link and QR code). |

## Verification (honest)

Exact commands and results are in [docs/TESTING.md](docs/TESTING.md).

**On the owner's iPhone with the hosted Hermes (version 0.2.4, 2026-11-09, owner-reported):** offline recording, sync,
photos, voice notes, signatures, OCR, translation, speech-to-text, Saved Records across Safari and the Home Screen app,
the Hermes Mobile conversation, and the dashboard tab all worked.
**The 0.2.6 behaviour below has not yet been checked on the iPhone or the hosted Hermes.**

**On a local test Hermes v0.23.0 (real conversations via Nous Portal, phone-sized Chromium/WebKit), 0.2.6:**

| Area | Result |
|---|---|
| Workspace setup from the interview | Builds in about 2.5 min on average across 5 jobs; a solar business owner, a student research archive and a dairy checker each got a form that matches their work, with decisions only where real (the student and dairy builds were re-checked from the parts Hermes saved, after a provider stall and a memory limit cut the run short) |
| Syncing never triggers AI work | An entry with no question synced with no model call; with 2 questions, exactly 2 model calls |
| Questions about an entry | Asked offline (in the form and afterwards), answered after sync in 18–37 s, readable offline; Hermes used the photo, the voice note and the user's rule |
| Chat about an entry | "What do you think about my latest kitchen visit?" → assessment with uncertainty and a next step (44 s) |
| Editing by chat | Add a question and remove another → Hermes showed the changes and asked before publishing; the phone got "Update available"; an older entry offline still showed the removed question's answer |
| Undo | "Undo my last workspace update" → previous version republished as a new one; the phone updated; older entries stayed readable |
| Tests | 204 Python, 129 TypeScript; Chromium E2E 29 passed / 5 skipped; WebKit E2E passed; `hermes plugins validate` and `doctor` pass (20 tools) |

Earlier versions (0.2.4–0.2.5) were also checked for strict offline use, crash-safe sync, cross-device Saved Records,
SHA-256 file integrity and access control (every API route checks the signed-in user).

## Known limitations
- Approval before publishing relies on Hermes asking; FieldKit cannot see whether you replied in between.
- Answers about entries need Hermes' model; with a rate-limited provider, questions wait as the provider says. Use a
  paid main model on Hermes (free tiers are rate-limited).
- Phone languages: English and Hindi. Whisper tiny is English-only; Hindi speech-to-text needs a 250 MB pack.
- OCR can't read blurred, dark or handwritten text (it says so). The small translation model mistranslates some terms.
- Saved Records lists the newest 500 entries per account.
- iOS Home Screen apps have storage separate from Safari: sign in once inside the app.
- Uploads run while the app is open; there is no background upload from a closed app.
- Run FieldKit's Hermes on one machine with one persistent volume (data lives in
  `<HERMES_HOME>/plugin-data/fieldkit/data.db`). After updating FieldKit, restart the Hermes dashboard.
- Android Chrome is not yet tested.

## Docs
[ARCHITECTURE.md](ARCHITECTURE.md) · [docs/API.md](docs/API.md) · [docs/INSTALL.md](docs/INSTALL.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/SUBMISSION.md](docs/SUBMISSION.md) · [RESEARCH.md](RESEARCH.md) ·
[THIRD_PARTY.md](THIRD_PARTY.md)

MIT licensed. Demo content is synthetic.
