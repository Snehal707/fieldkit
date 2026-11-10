# FieldKit architecture

One Hermes plugin repository, three integrated components, one database.

```text
 Hermes Mobile app ──conversation──▶ Hermes Agent ──tools──▶ FieldKit plugin (Python)
                                          │                    │  register(ctx): 20 tools, 2 skills, hook
                                          │ ctx.llm            │  fieldkit_core: engine, db, packs, analysis
                                          ▼                    ▼
                              Hermes dashboard ── /api/plugins/fieldkit/ (FastAPI router, auth-gated)
                                 │  FieldKit tab                │
                                 │  (dashboard/dist IIFE)       ├── /dashboard-plugins/fieldkit/app_dist/  → FieldKit PWA (public static, SW-scoped)
                                 │                              └── SQLite: <HERMES_HOME>/plugin-data/fieldkit/data.db
                                 ▼
                     Phone: FieldKit PWA (installed) ── IndexedDB + Cache API ── on-device models
```

The PWA never talks to Hermes Mobile. Both talk to the same Hermes instance: Mobile through the agent
and FieldKit tools, the PWA through the authenticated plugin API.

## Components

### A. Native plugin (`__init__.py`, `fieldkit_core/`)
- `register(ctx)` binds `ctx.llm` and plugin config into `fieldkit_core.runtime`, registers the 20 tools
  (`tools.py` and `workspace_tools.py`; code for retired tools stays but is not registered), the bundled skills (`skills/fieldkit/SKILL.md` and
  `skills/fieldkit-workspace-builder/SKILL.md`), a system prompt section (`fieldkit.workspace`), and adds an
  `on_session_start` hook. It does no I/O.
- `engine.py` is the deterministic workflow engine: JSON-Schema validation, condition AST, visibility and
  requiredness, field validation and classification (rules, keywords, scores, decision trees). Nothing is
  evaluated as code.
- `db.py` is the SQLite store, using `plugin_db("fieldkit")`. It handles migrations, per-user scoping,
  idempotent sync, optimistic concurrency, conflicts, durable jobs, reports and audit events.
- `packs.py` validates packs, chunks documents and provides BM25 retrieval for grounding analysis.
- `analysis.py` handles report generation (earlier version; no report is started by sync or in 0.2.6). It builds a grounded context (answers, local findings,
  knowledge passages, up to 2 photos) → `ctx.llm.complete_structured` with `REPORT_SCHEMA` → normalises
  and stores the report. It also generates workflows and knowledge entries.
- `questions.py` (0.2.6) answers a question about one visit from that record's evidence and stores the answer on the visit. The worker and `fieldkit_process_pending_jobs` run it; `fieldkit_ask_about_record` answers at once.
- `runtime.py` holds the process-wide LLM handle and the background worker, a daemon thread running under
  a copied contextvars context.

### B. Dashboard tab (`dashboard/`)
- `manifest.json` adds a tab at `/fieldkit`. `src/index.ts` is bundled by esbuild into the IIFE
  `dist/index.js`, which uses `SDK.React`, `SDK.components` and `SDK.fetchJSON`.
- Four tabs: Overview, Records (each visit with its questions and answers, and older reports if any),
  Synchronization (devices and conflicts, no analysis-jobs table), and Mobile Access (link and QR code).
- `plugin_api.py` is the REST API (see `docs/API.md`) and serves the legacy authenticated PWA route under `/app/`.

### C. Offline PWA (`app/` → `dashboard/app_dist/`)
- Vite build with relative URLs and hash routing, so the document path is always `…/fieldkit/app_dist/index.html`.
- `public/sw.js`, the service worker, is scoped to `/dashboard-plugins/fieldkit/app_dist/`. The app is served from Hermes' public plugin-asset path, outside the `/api` login gate, so a launch with an expired session opens the cached app and offers Sign in instead of Hermes' raw 401 JSON.
  - It precaches the shell (`precache.json` is generated after the build).
  - Navigations are network-first with a 3.5 s timeout. A 401, a redirect or being offline returns the cached shell.
  - API traffic is never cached.
  - Pinned jsDelivr runtime files are cache-first.
- IndexedDB (`db.ts`) has these stores: settings, workflows, packs, models, drafts, records, attachments
  (Blobs), outbox, reports, and questions (added in IndexedDB v4, 0.2.6; existing stores are kept).
- The phone keeps earlier form versions, so each visit is shown with the questions it was recorded with.
- The bottom bar is Home, Workspace, Assistant, Sync and Settings.
- `sync.ts` is the durable outbox.
  - Idempotency keys are stable across retries.
  - Records are sent before attachments, with SHA-256 per file.
  - Behaviour by response:
    - 401: pause and show the sign-in banner.
    - 409: mark a conflict.
    - 4xx: stop retrying, keep the record and surface the error.
    - Network failure or 5xx: exponential backoff.
  - Older reports are downloaded for offline reading.
- `knowledge.ts` provides MiniSearch Q&A with a support threshold and dictionary lookup (exact,
  translation, prefix and fuzzy matches).
- `intel.ts` covers translation and speech-to-text (Transformers.js with ONNX Runtime Web, WASM backend,
  1 thread), OCR (tesseract.js) and text-to-speech (local voices only).
- `results.ts` builds the local results at completion. `views_*.ts` contain the screens.

## Result model

| Field | Local (phone) | Server |
|---|---|---|
| ids | `id` (stable, client-generated), `workflow_id`, `workflow_version`, `device_id` | same; `owner_user_id` from the Hermes session |
| content | `answers`, `local_results` (findings, references, explanations, `source:"local"`) | `answers`, `local_results`, `record_revisions` |
| sync | `sync_status` (local→pending→syncing→received→synced; conflict, error), `server_revision`, `server_ack` | `revision`, `sync_status` (`received` = record stored with media outstanding, `complete` = everything durable) |
| analysis | `analysis_status`, `analysis_job_id`, `report_id`, `report_version`, `report_downloaded_at` | `jobs` (UNIQUE kind+record+revision), `reports` (UNIQUE record+version) |

`analysis_status` is one of: `not_requested`, `pending`, `processing`, `completed`, `failed`, `requires_review`.

**Synchronised never means analysed.** The Results page shows the two states separately. Local findings and,
for older visits, a Hermes report are shown in separate, labelled sections. Earlier reports copied the original
local findings into the report as `local_findings`.

## Processing after sync

1. `POST /sync/records`, in one transaction: idempotency check → validate → store record and revision →
   declare attachments → acknowledge. Sync never enqueues an analysis job.
2. Each `PUT /attachments/{id}` is verified by SHA-256. The last one marks the record `complete`.
3. Workers claim jobs atomically (`pending` → `processing`). Each job is retried up to 3 attempts with
   exponential backoff, then marked `failed`. Stale `processing` jobs are recovered after 15 minutes.
4. Two paths can drain the queue:
   - the background worker, in any process where `ctx.llm` exists (verified to be the dashboard process in v0.23.0);
   - the `fieldkit_process_pending_jobs` tool, called by Hermes.
5. Earlier versions (before 0.2.6) stored the report, created follow-ups and set the record's `analysis_status` to `completed` or `requires_review`. Sync does not start this now.
   - `requires_review` is set only when there is a review trigger (`review_triggers`): a high or critical finding
     (from Hermes or the phone's local rules), Hermes' own flag with a stated reason, a critical decision, or a
     report that still fails a quality check after the repair pass.
   - A provider rate limit (HTTP 429 or `retry_after`) makes the job wait as long as the provider asks. The record
     stays `pending` and is not marked failed. A model reply with extra keys that do not match the report schema is
     retried once with the exact error.

Jobs are created by a question about a visit (queued on the phone, then answered after sync). Sync never creates one. `fieldkit_list_records` with `include_answers` reads stored answers and does not call the model.
Older workspaces may contain `report_policy.after_sync`; it is accepted and ignored.

## Questions about a visit (0.2.6)

- The phone keeps a question with its visit (IndexedDB `questions` store). After the visit syncs, the question is sent
  with `POST /records/{id}/questions`. The call is idempotent on the phone's id and owner-checked. DB migration v6 adds
  the `questions` table (additive only).
- A queued question is the request. The worker (or `fieldkit_process_pending_jobs`) answers it from the record's
  evidence: answers, photos, voice-note transcripts, on-phone findings, the workspace's procedures and up to 3 earlier
  visits of the same subject.
- A provider rate limit makes the question wait as told and stay queued. Other errors retry with backoff; after 3
  attempts the question is marked `failed`.
- The answer is stored on the visit and returned by `GET /records/{id}/questions`, so it is readable offline.
- Answers are about that visit only. They never become workspace rules, decision actions or learning events.
- `fieldkit_ask_about_record` answers in the Hermes chat at once and saves the answer on the same visit.

## Workspaces and evidence (0.2.5; editing and undo in 0.2.6)

A workspace is the user's job turned into an offline kit: workflows, decision guides, knowledge, vocabulary and a
report policy. Hermes builds it. FieldKit validates it, computes its evidence status and runs it on the phone.

```text
Interview (Hermes, skill fieldkit-workspace-builder): purpose first, then 5–8 follow-up questions for that purpose
  → fieldkit_save_workspace_brief (the user confirms the brief; incomplete briefs are refused)
  → optional source check (Hermes' web_search and web_extract; quotes copied with their location; 0.2.6: not run by default)
  → fieldkit_start_workspace_build → fieldkit_add_workspace_parts → fieldkit_build_workspace: parts validated,
    source tiers checked against domains, web pages re-fetched and quotes dropped if not found,
    evidence status computed by FieldKit
  → review of the research report → fieldkit_publish_workspace (requires user_approved)
  → normal workflows + packs ws-<id>, ws-<id>-knowledge, ws-<id>-dictionary (SHA-256, update detection)
  → phone: #/workspace/<id> → download everything for offline → decision guides, assistant, visits
  → visits synced → questions about a visit answered by Hermes when asked
  → change by chat ("add a question", "change our rule") → build → change summary (changes_since_published)
    → user approves → fieldkit_publish_workspace = new version with the summary as its changelog
    → phone shows "Update available"
  → fieldkit_undo_workspace_update → previous version republished as a new version
```

Earlier versions (0.2.5) also ran a learning loop (`fieldkit_propose_workspace_changes`, `fieldkit_decide_candidate`,
verified outcomes from follow-up checks). That loop is not part of the 0.2.6 story.

| Module | Role |
|---|---|
| `fieldkit_core/workspace.py` | Bundle and brief validation, source tiers, evidence status, decision guide graph checks, excerpt checks, publishing as workflows and packs, starter workspaces, the onboarding prompt text |
| `fieldkit_core/workspace_schema.py` | Per-part JSON Schemas and examples, repairs of unambiguous shape mistakes (`normalize`), item checks with paths and hints, cross-reference and type checks (0.2.6) |
| `fieldkit_core/workspace_tools.py` | The workspace and build tools (schemas and handlers), including the build tools from 0.2.6 |
| `fieldkit_core/decision.py` | Decision scale, report v2 schema additions, deterministic report checks, follow-ups from next actions (earlier-version reports) |
| `fieldkit_core/learning.py` | Learning events (idempotent per key), verified outcomes from follow-up checks, candidate clustering, confirmation rules (earlier version) |
| `app/src/workspace.ts` | Installs and lists workspaces on the phone, with SHA-256 checked packs; the on-phone summary counts (0.2.6, no AI) |
| `app/src/guides.ts` | Runs decision guides offline (typed answers, outcome with each action's evidence status) |
| `app/src/assistant.ts`, `assistant_core.ts`, `assistant_intents.ts`, `views_assistant.ts` | Workspace Assistant (grounded): intent by meaning and cues, dialogue state, retrieval, answers with citations, knowledge gaps |
| `app/src/followups.ts` | Follow-up checks asked by the next inspection of the same subject (earlier version) |
| `app/src/learning.ts` | Queue of learning events, uploaded after each sync (earlier version) |
| `fieldkit_core/questions.py` | Questions about one visit (0.2.6): validation, answering from the record's evidence, worker queue |
| `app/src/questions.ts` | Questions about one visit on the phone (0.2.6): kept offline with the visit, sent after sync, answers shown on the visit |

Rules that do not depend on the model:
- The evidence status (verified, supported, conflicting, your procedure, learned local practice, unverified) is
  computed by FieldKit. Unverified model knowledge cannot become a decision-guide action, a rule threshold or a
  procedure.
- A workspace change is published only after the user approves it (`fieldkit_publish_workspace`, `user_approved`).
  Undo republishes the previous version as a new version.
- Earlier learning loop: learning inputs stayed apart, AI suggestions were never evidence, and a candidate needed the
  user's confirmation.

The phone and Hermes exchange only through the plugin API: `GET workspaces`, `GET workspaces/{id}`,
and `POST` and `GET records/{id}/questions` (see [docs/API.md](docs/API.md)).

## Building in parts and background quote checks (0.2.6)

A single build call used to re-fetch every quoted page in turn and receive the whole workspace as one JSON argument,
which timed out. Now:
- `fieldkit_start_workspace_build` starts or resumes a build for a confirmed brief. `fieldkit_workspace_build_status`
  shows where a build stands, so a new chat can resume it.
- `fieldkit_add_workspace_parts` adds, replaces or removes items of one part (sources, evidence, workflows, guides and
  so on). Each item is checked against its schema when it is saved. Unambiguous shape mistakes are repaired and listed
  as `fixed_automatically`.
- `fieldkit_build_workspace` assembles the saved parts into a draft. Publishing applies the same checks.
- Builds are stored server-side. DB migration v5 is additive only and adds the tables `workspace_builds` and `source_pages`.
- Quote checks run in a background pool of 6 workers: at most 25 s per page, 2 MB cap, and redirects to non-public hosts
  are refused. Pages are cached in memory and in `source_pages` for 3 days; errors are retried after 10 minutes. A build
  call waits at most 20 s and reports `checks_pending`. Publishing is refused while any quote check is pending. A page
  with almost no readable text (for example, script-rendered) is marked not checked, not not found.

## Security

- Every API route sits behind the Hermes auth gate. The PWA shell is public and contains no data. Records, attachments, questions, reports and conflicts are
  filtered by `owner_user_id`. Another user's record id returns 404, never 403, so existence doesn't leak.
- Published workflows and packs are shared across the instance. Only the owner (or the instance owner via
  Hermes tools) can modify them.
- Attachments: MIME allowlist, 15 MB cap, SHA-256 must match the declared value, and files are stored per user.
- The PWA uses a CSP. No credentials appear in frontend code; cookies are HttpOnly and handled by Hermes.
- LLM output is schema-validated and never executed. Workflow definitions are JSON with
  `additionalProperties: false`, so unknown fields such as `script` are rejected.

## Known limits (honest)

- **iOS Safari:**
  - An installed PWA has its own storage, separate from Safari, so the user signs in once inside the installed app.
  - There's no Background Sync; uploads run while the app is open.
- **Background Sync** (Chromium) only wakes an open window. FieldKit never claims uploads from a fully closed app.
- **Hermes OAuth sessions last 15 minutes with no refresh token.** Expiry pauses the queue and never drops data;
  the user taps Sign in.
- **Workspace approval** relies on Hermes asking the user before it publishes. FieldKit cannot see whether the user
  replied in between.
