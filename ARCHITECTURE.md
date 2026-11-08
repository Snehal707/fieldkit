# FieldKit architecture

One Hermes plugin repository, three integrated components, one database.

```text
 Hermes Mobile app ──conversation──▶ Hermes Agent ──tools──▶ FieldKit plugin (Python)
                                          │                    │  register(ctx): 23 tools, skill, hook
                                          │ ctx.llm            │  fieldkit_core: engine, db, packs, analysis
                                          ▼                    ▼
                              Hermes dashboard ── /api/plugins/fieldkit/ (FastAPI router, auth-gated)
                                 │  FieldKit tab                │
                                 │  (dashboard/dist IIFE)       ├── /app/  → FieldKit PWA (static, SW-scoped)
                                 │                              └── SQLite: <HERMES_HOME>/plugin-data/fieldkit/data.db
                                 ▼
                     Phone: FieldKit PWA (installed) ── IndexedDB + Cache API ── on-device models
```

The PWA never talks to Hermes Mobile. Both talk to the same Hermes instance: Mobile through the agent
and FieldKit tools, the PWA through the authenticated plugin API.

## Components

### A. Native plugin (`__init__.py`, `fieldkit_core/`)
- `register(ctx)` binds `ctx.llm` and plugin config into `fieldkit_core.runtime`, registers the 23 tools
  (`tools.py`) and the bundled skill (`skills/fieldkit/SKILL.md`), and adds an `on_session_start` hook.
  It does no I/O.
- `engine.py` is the deterministic workflow engine: JSON-Schema validation, condition AST, visibility and
  requiredness, field validation and classification (rules, keywords, scores, decision trees). Nothing is
  evaluated as code.
- `db.py` is the SQLite store, using `plugin_db("fieldkit")`. It handles migrations, per-user scoping,
  idempotent sync, optimistic concurrency, conflicts, durable jobs, reports, follow-ups and audit events.
- `packs.py` validates packs, chunks documents and provides BM25 retrieval for grounding analysis.
- `analysis.py` handles generation and analysis. It builds a grounded context (answers, local findings,
  knowledge passages, up to 2 photos) → `ctx.llm.complete_structured` with `REPORT_SCHEMA` → normalises
  and stores the report. It also generates workflows and knowledge entries.
- `runtime.py` holds the process-wide LLM handle and the background worker, a daemon thread running under
  a copied contextvars context.

### B. Dashboard tab (`dashboard/`)
- `manifest.json` adds a tab at `/fieldkit`. `src/index.ts` is bundled by esbuild into the IIFE
  `dist/index.js`, which uses `SDK.React`, `SDK.components` and `SDK.fetchJSON`.
- Sections: Overview, Workflows, Knowledge, Records (with media), Reports and follow-ups,
  Synchronization (devices, conflicts, jobs), Offline Packs, and Mobile Access (link and QR code).
- `plugin_api.py` is the REST API (see `docs/API.md`) and serves the PWA files under `/app/`.

### C. Offline PWA (`app/` → `dashboard/app_dist/`)
- Vite build with relative URLs and hash routing, so the document path is always `…/fieldkit/app/`.
- `public/sw.js`, the service worker, is scoped to `/api/plugins/fieldkit/app/`.
  - It precaches the shell (`precache.json` is generated after the build).
  - Navigations are network-first with a 3.5 s timeout. A 401, a redirect or being offline returns the cached shell.
  - API traffic is never cached.
  - Pinned jsDelivr runtime files are cache-first.
- IndexedDB (`db.ts`) has these stores: settings, workflows, packs, models, drafts, records, attachments
  (Blobs), outbox, reports.
- `sync.ts` is the durable outbox.
  - Idempotency keys are stable across retries.
  - Records are sent before attachments, with SHA-256 per file.
  - Behaviour by response:
    - 401: pause and show the sign-in banner.
    - 409: mark a conflict.
    - 4xx: stop retrying, keep the record and surface the error.
    - Network failure or 5xx: exponential backoff.
  - Reports are downloaded for offline reading.
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

**Synchronised never means analysed.** The Results page shows the two states separately. Local findings and
the Hermes report are shown in separate, labelled sections, and the original local findings are copied into
the report as `local_findings`.

## Processing after sync

1. `POST /sync/records`, in one transaction: idempotency check → validate → store record and revision →
   declare attachments → if no media is outstanding, enqueue an `analyze` job → acknowledge.
2. Each `PUT /attachments/{id}` is verified by SHA-256. The last one marks the record `complete` and enqueues the job.
3. Workers claim jobs atomically (`pending` → `processing`). Each job is retried up to 3 attempts with
   exponential backoff, then marked `failed`. Stale `processing` jobs are recovered after 15 minutes.
4. Three paths can drain the queue:
   - the background worker, in any process where `ctx.llm` exists (verified to be the dashboard process in v0.23.0);
   - the `fieldkit_process_pending_jobs` tool, called by Hermes or by a Hermes cron job;
   - `fieldkit_analyze_record` on demand.
5. The report is stored, follow-ups are created, and the record's `analysis_status` becomes `completed` or `requires_review`.
   - `requires_review` is set when the model says so, or when the workflow has `review_required` and there
     is any high or critical issue.

## Security

- Every route sits behind the Hermes auth gate. Records, attachments, reports, follow-ups and conflicts are
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
- **Marathi translation** has no verified browser model yet.
