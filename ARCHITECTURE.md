# FieldKit architecture (0.3.1)

FieldKit is an offline observation collection and synchronisation plugin for Hermes. One repository, three parts, one
database. FieldKit never calls a model: it has no model client, runs no background worker, registers no hooks and
makes no outbound calls from the server. Hermes reads synchronised data when the user asks.

```text
 Hermes chat (Mobile, chat or dashboard) ──▶ Hermes agent ──tools and skills──▶ FieldKit plugin (Python)
                                                                                  │ fieldkit_core
 Hermes dashboard ── /api/plugins/fieldkit/ (plugin_api.py, auth-gated) ◀──────────┤  SQLite:
   │ FieldKit tab (dashboard/dist)                                                 │  <HERMES_HOME>/plugin-data/fieldkit/data.db
   └── /dashboard-plugins/fieldkit/app_dist/  → phone app (PWA, public static)
 Phone: installed PWA ── IndexedDB + Cache API
```

The phone never talks to Hermes Mobile. Both reach the same Hermes instance: chat through the agent and FieldKit's
tools, the phone through the authenticated plugin API.

## Components

### A. Hermes plugin (`__init__.py`, `fieldkit_core/`)
- `register(ctx)` binds the settings, registers 12 tools, two skills (`fieldkit` and `fieldkit-workspace-builder`) and
  one session note (`fieldkit.workspace`, which lists the user's workspaces). It opens no database and starts no thread.
- `runtime.py` holds the plugin setting `public_url` and the address users last reached FieldKit at, used for phone links.
- `db.py` is the SQLite store (`plugin_db("fieldkit")`). It applies seven migrations in order (each one adds to the last), per-user scoping,
  idempotent sync, optimistic concurrency, conflicts, workspace versions, read-only questions and reports, and audit events.
- `engine.py` checks a form against its JSON Schema, evaluates conditions as data, works out which fields are visible and
  required, checks values, and cleans answers. Conditions and forms are data only; nothing is run as code. The phone's
  `engine.ts` is checked against the same vectors (`tests/vectors`).
- `forms.py` defines the field types, repairs common shape mistakes (for example `select` becomes `single_choice`, and
  plain option strings become `{value, label}`), reports field-aware condition errors (for example "a number field
  compared with text"), and writes the format Hermes reads with `fieldkit_workspace_format`.
- `workspace.py` validates workspace bundles, stores drafts and versions, publishes them, and produces the plain-language
  change summary.
- `workspace_tools.py` and `tools.py` hold the tool schemas and handlers. Each handler returns JSON with `ok`.
- `media.py` types each attachment by the form field it answers (photo, voice note or signature), counts them, checks
  SHA-256 against the stored file, and makes a readable copy with the right file extension for Hermes' own tools.

### B. Dashboard tab (`dashboard/`)
- `manifest.json` adds the tab. `src/index.ts` is bundled by esbuild into the IIFE `dist/index.js`.
- Four tabs: **Overview** (version, record counts, workspaces, recent records), **Records** (answers, attachments; for
  entries from before 0.3, the earlier findings, questions and report, read-only), **Synchronization** (devices, conflicts)
  and **Mobile Access** (link and QR code).
- `plugin_api.py` is the REST API (see [docs/API.md](docs/API.md)). It is mounted by Hermes at `/api/plugins/fieldkit/`.

### C. Phone app (`app/` → `dashboard/app_dist/`)
- A Vite build with relative URLs and hash routing, so the document path is always `…/fieldkit/app_dist/index.html`.
- Bottom bar: **Home**, **Workspace**, **Records** (Saved Records), **Sync** (Pending Sync), **Settings**. Other screens:
  new entry (`#/run/<id>`), entry (`#/results/<id>`), entries from another device (`#/remote/<id>`, read-only), Translate,
  Scan text, Offline Packs and Connection diagnostics.
- `db.ts` is the IndexedDB store, at version 5. Stores: `settings`, `workflows` (with earlier form versions kept, so each
  entry shows the questions it was recorded with), `packs`, `models`, `drafts`, `records`, `attachments` (Blobs),
  `outbox`, `reports`, `remote` (offline copies of other devices' entries, kept apart from this device's own records)
  and `questions`.
- `engine.ts` is the phone's form engine, the twin of `engine.py`.
- `workspace.ts` installs a workspace on the phone: its manifest pack `ws-<id>` and the form versions it lists, each
  SHA-256 checked. Update detection shows **Update available** when a newer version is published.
- `packs.ts` downloads forms and workspace manifests (SHA-256 checked) and the optional OCR and translation packs.
- `intel.ts` runs the optional offline tools: sentence translation (Transformers.js 4.3.1 with ONNX Runtime Web, WASM
  backend) and OCR (tesseract.js 7.0.0). `ocr_prep.ts` prepares photos for OCR. `translate_prep.ts` keeps terms from dictionary packs installed
  before 0.3 (if any) when translating. Start-up frees the files of removed packs (see Data from earlier versions).
- `media.ts` stores photos (compressed to up to 2048 px JPEG), voice notes, signatures and GPS. Files stay on the phone
  until the server confirms each file's SHA-256.
- `results.ts` turns a finished entry into a local record and queues it for sync.
- `sync.ts` is the durable outbox (see below).
- `storage.ts` reports how the browser keeps the phone's data and asks for protection. `netlog.ts` keeps the last 150
  requests for Connection diagnostics, on the device only.
- `device.ts` gives each browser or Home Screen app a readable device name.

### D. Service worker (`app/public/sw.js`)
- Scoped to `/dashboard-plugins/fieldkit/app_dist/`. It precaches the app shell (`precache.json` is generated after the
  build), so the app opens with no network.
- Navigations are network-first with a 3.5 s timeout. A 401, a redirect or being offline returns the cached shell, and
  the app offers **Sign in** when needed.
- API traffic is never cached. Pinned runtime files (ONNX Runtime, tesseract core and language data) are cache-first.

## Entries and sync
1. The phone saves an entry in IndexedDB, with its outbox operation, in one transaction. Each operation has a stable
   idempotency key, kept across retries.
2. `POST sync/records` runs in one transaction: idempotency check, validation (the form version must exist and the
   attachments must be declared), then store the record and its revision, then acknowledge. Sync never starts processing.
3. Each `PUT attachments/{id}` is checked against its declared SHA-256. When the last file is stored the record is `complete`.
4. Responses on the phone:
   - 401: the queue pauses and the sign-in banner shows. Nothing is dropped.
   - 409: a conflict is recorded for the user to resolve. The server never overwrites silently.
   - 422, 404, 413, 415: the record is kept, retries stop, and the reason is shown.
   - Network failure or 5xx: exponential backoff.
   - A response that is not a real FieldKit acknowledgement is rejected, so a captive portal cannot confirm a record.
5. Restore: if Hermes lacks a form version the phone has (for example after its data was reset), the phone sends it back
   with `POST workflows/restore`. The same id and version are never overwritten.

**Synchronised never means processed.** Syncing only uploads. Saved Records lists every entry of the account across
devices, page by page.

## Workspaces and forms
A workspace is a user's work turned into forms. Hermes sets it up in a chat, following the `fieldkit-workspace-builder`
skill: it asks what the workspace is for, which languages (English, Hindi) and what each entry records, then drafts one or
more forms.

```text
Set up by chat: purpose, languages, forms (fieldkit-workspace-builder)
  → fieldkit_draft_workspace: a validated draft version (an invalid draft is stored so it can be fixed, never published)
  → user approves → fieldkit_publish_workspace (user_approved=true): each form becomes a form version,
    and the manifest pack ws-<id> lists them
  → phone: #/workspace/<id> → Download everything for offline
  → entries are recorded with the form version they were made with, then synced
  → change by chat → new draft → change summary (changes_since_published) → user approves → new published version
  → phone shows Update available
  → fieldkit_undo_workspace_update → the earlier version is republished as a new version
```

Rules:
- Every change is a new version. Publishing needs the user's approval (`user_approved`).
- Undo republishes an earlier version as a new one. Nothing is deleted.
- Entries keep the form version and answers they were made with, including answers to questions that were later removed.
- A workspace can refer to a form that already exists by its id (`workflow_refs`), so one form can serve several workspaces.
- Workspace validation runs on each draft and again on publish.

Approval before publishing relies on Hermes asking the user. FieldKit cannot see whether the user replied in between.

## Records and workspaces
Each entry records the workspace it was made in. The server accepts the phone's value only when that workspace is
published and contains the entry's form (in its published or earlier published versions). Otherwise it stores the only
published workspace that contains the form, or none. An edit never clears a stored workspace. Records synced before this
rule are filled in only when exactly one published workspace contains their form, and each change is audited as
`record.workspace_repaired`.

## Data from earlier versions
All tables and migrations are kept, so no data is removed. The tables `jobs`, `reports`, `followups`, `learning_events`,
`candidates`, `source_pages`, `photo_descriptions`, `workspace_builds`, `workspace_briefs` and `questions` keep the rows
written before 0.3, and no code writes new rows to them. Old reports, questions and answers, and the on-phone findings
stay readable: the phone shows them under "From an earlier FieldKit version", the dashboard shows them read-only, and
`fieldkit_get_record` returns them under `from_earlier_fieldkit_versions`. Workspace versions with research parts
(sources, evidence, guides, decision scales, knowledge, vocabulary, intents, gaps, traceability) stay readable and can
be undone to; the next edit drops those parts from the new version, and the change summary lists them. On the phone,
the offline assistant's vectors and its learning queue were removed from IndexedDB at version 5. Entries, files, drafts
and answers were not touched.

## Security
- Every API route sits behind Hermes' auth gate. The phone's shell is public and holds no data.
- Records, attachments, questions, reports and conflicts are filtered by `owner_user_id`. Another user's id returns `404`,
  never `403`, so existence does not leak.
- Hermes tools act as the instance owner. Hermes is single-tenant: its operator owns every entry synced to it.
- Published forms and workspaces are shared across the instance. Only the owner can change them.
- Attachments: MIME allowlist, 15 MB cap, SHA-256 must match the declared value, and files are stored per user.
- Forms are JSON data with `additionalProperties: false`. Unknown keys are rejected. Conditions are evaluated as data.
- The phone uses a Content Security Policy. No credentials appear in frontend code; cookies are handled by Hermes.

## Known limits
- **iOS Safari:** an installed app has its own storage, separate from Safari, so the user signs in once inside the app.
  There is no Background Sync; uploads run while the app is open.
- **Hermes OAuth sessions** last 15 minutes with no refresh token. Expiry pauses the queue and never drops data; the user
  taps **Sign in**.
- **Photos and voice notes** are read only by the user's Hermes agent, with its own vision and speech-to-text tools.
  FieldKit does not read them.
