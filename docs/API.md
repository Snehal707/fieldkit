# FieldKit plugin API

Base path: `/api/plugins/fieldkit/`.
- Every route needs a Hermes dashboard session (cookie), or the session token on a loopback dashboard.
- Without one, Hermes returns `401` before FieldKit runs.
- Records, attachments, reports, follow-ups and conflicts are scoped to the signed-in user. Another user's id returns `404`.

## Meta
| Method | Path | Notes |
|---|---|---|
| GET | `me` | `{user_id, display_name, provider}` |
| GET | `status` | `analysis_mode` (`automatic` \| `on-demand` \| `deferred`), `llm_available`, `worker`, `jobs`, `app_built`, `public_url`, `version`, `instance` `{machine, region, pid}` (machine = `FLY_MACHINE_ID` or host name), `store` `{store_id, created_at, path, records_for_you, last_received_at}`. `store_id` is a permanent random id kept inside the FieldKit database: two installs on the same account that see different ids are using different databases. `records_for_you` counts only the caller's records. |

## Workflows
| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `workflows` | `include_drafts=true` | `{workflows:[{id,title,domain,status,latest_version,published_version,…}]}` |
| GET | `workflows/{id}` | `version`, `draft=true` | Definition. Published by default; 404 if none is published |
| POST | `workflows/validate` | `{definition}` | `{problems:[{path,message}]}` |
| POST | `workflows` | `{definition, publish}` | `{workflow}` with a new version, or 422 `{problems}` |
| POST | `workflows/{id}/publish` | `{version?}` | `{workflow}` (owner only) |
| POST | `workflows/restore` | `{definition}` | `{restored, version}`. Puts back one exact version this Hermes lacks (its FieldKit data was reset or moved), from a copy a device downloaded. Validated like any workflow (422 `{problems}`); never overwrites an existing version (`restored:false`); 404 for a workflow owned by another user. |

## Packs
| Method | Path | Notes |
|---|---|---|
| GET | `packs` | `kind=` filter. Metadata includes `sha256` and `size` |
| GET | `packs/{id}` | Raw JSON body. Header `X-FieldKit-SHA256` must match the SHA-256 of the body |
| POST | `packs` | `{pack}`. Validated (knowledge \| dictionary \| classification \| model) |
| POST | `packs/from-document` | `{pack_id,title,document,domain?,language?}`. Deterministic chunking |
| DELETE | `packs/{id}` | Owner only |
| GET | `models` | Pinned upstream on-device model manifests and runtimes (metadata only) |

## Workspaces (0.2.5)
| Method | Path | Notes |
|---|---|---|
| GET | `workspaces` | Published workspaces. Instance-wide, like published workflows. `{workspaces:[…]}`. Starter workspaces are labelled `starter` |
| GET | `workspaces/{id}` | Optional `version` query. Returns `workspace_id`, `version`, `status`, `published_version`, `starter`, `manifest_pack`, `changelog`, `summary`, `title`, `profile`, `gaps`. An unknown id returns an error (the exact status code is not checked here) |

Workspaces are built and published by Hermes through the workspace tools (see [Hermes tools](#hermes-tools)).
The phone opens them at `#/workspace/<id>`, the link Hermes returns.

**`report_policy.after_sync` (0.2.6).** Each workspace sets what happens when its records sync:
- `save`: records only, no AI analysis unless the user asks on a record.
- `summarize`: no per-record reports. Summaries, counts and comparisons are asked of Hermes in chat.
- `analyze`: a report for every record.

Workspaces without the setting, and workflows outside a workspace, use `analyze`.

## Learning (0.2.5)
`POST learning/events`
```json
{"device_id": "dev_…",
 "events": [{"kind": "knowledge_gap", "idempotency_key": "lev_…", "workspace_id": "ws-…", "ref_type": "question",
             "ref_id": "…", "payload": {"text": "…"}, "created_at": "2026-11-10T09:00:00"}]}
```
- `kind` is `knowledge_gap` or `user_feedback` only. A phone cannot send `verified_outcome` or AI suggestions.
  Verified outcomes are derived on Hermes from follow-up checks in synced records.
- `idempotency_key` is required and makes each event idempotent. `workspace_id`, `ref_type`, `ref_id` and `created_at` are optional.
- Up to 200 events per request. Each payload is limited to 8000 characters of JSON.

**Response:** `{"saved": n, "duplicates": n, "rejected": [ids]}`. `rejected` lists events that were invalid (unknown kind, no idempotency key, or too large).

## Sync
`POST sync/records`
```json
{"idempotency_key": "idk_…", "device_id": "dev_…",
 "record": {"id": "rec_…", "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0,
            "answers": {…}, "local_results": {…}, "created_local_at": "…", "completed_at": "…",
            "attachments": [{"id": "att_…", "field_id": "photos", "mime": "image/jpeg", "size": 123, "sha256": "…"}]}}
```

**200 response:**
```json
{"record_id", "revision", "received_at", "sync_status": "received|complete", "analysis_status", "analysis_job_id", "attachments_needed": [ids]}
```
The same `idempotency_key` returns the stored response with `duplicate: true`. Identical content re-sent under a new key is acknowledged without creating a new revision.

**Error responses:**
- `409 {conflict:{conflict_id, record_id, base_revision, server_revision, server_answers}}`: the stale base revision is recorded and never overwrites.
- `422`: invalid record or unknown workflow version.
- `404`: the record id belongs to another user.

**Related routes:**
- `PUT attachments/{id}`: the raw body with `Content-Type` set to an allowed image/audio type, ≤ 15 MB. The SHA-256 must equal the declared value (422 otherwise). Repeating an upload is idempotent.
- `GET attachments/{id}`: returns the file, with an `X-FieldKit-SHA256` header.
- Voice notes uploaded without a transcript from the phone are transcribed by Hermes after the upload finishes (0.2.4). The work runs in the background in the dashboard process, one at a time, and never blocks or fails the upload. It uses Hermes' own speech-to-text (`tools.transcription_tools.transcribe_audio`), which is the service Hermes uses for voice messages. That service may be a local engine or a cloud provider, depending on the Hermes operator's configuration. The transcript, or the reason there isn't one, is stored on the attachment. Turn this off with the `voice_transcription` setting (see below).
- `GET sync/status`: per-user counts, outstanding attachments, open conflicts, devices and jobs.
- `GET sync/conflicts`; `POST sync/conflicts/{id}/resolve` with `{resolution: keep_server|use_client|merge, merged_answers?}`.

## Devices
| Method | Path | Body | Result |
|---|---|---|---|
| GET | `devices` | | `{devices:[{id,label,first_seen,last_seen}]}`. The signed-in user's devices only |
| POST | `devices` | `{device_id, label}` | Registers or renames this user's device. `device_id` must match `dev_<4-40 letters/digits>`, otherwise 422. Control characters are stripped from `label`; max 80 characters |

## Records, analysis, reports
| Method | Path | Notes |
|---|---|---|
| GET | `records` | `workflow_id`, `analysis_status`, `limit`. Summaries include `workflow_title` |
| GET | `records/{id}` | Full record, including attachment metadata. Each attachment has `kind` (`photo`, `audio` for a voice note, or `signature`), `field_label`, and `signed_at` (signatures). Voice notes also have `transcript`, `transcript_source` (`device` or `hermes`) and `transcript_error` (why there is no transcript). The record has `attachment_counts` (`{photo, audio, signature}`) and `attachment_summary` (for example "1 photo · 1 voice note"). |
| POST | `records/{id}/analyze` | Queues (or re-queues a failed or completed) durable job |
| GET | `records/{id}/report` | Latest report version. The PWA downloads this for offline use |
| GET | `reports`, `reports/{id}` | |
| GET/POST | `followups`, `followups/{id}` | `{title, detail?, record_id?, due_date?}`; `{status: open\|done}` |
| GET | `jobs` | Recent jobs, counts and analysis mode |
| POST | `examples/install` | Synthetic demo workflows and packs. Idempotent |

**Follow-up checks in records (0.2.5).** A record made for a subject that has a previous report carries
`local_results.followup_checks`: a list of `{id, what, how, result, value?}`, where `result` is `done`, `not_done` or
`cannot_check`, and `value` is the reading if one was given. Answers travel with the record. Only `done` and
`not_done` count toward a verified outcome; `cannot_check` is stored but never counts. Hermes turns the answers into
verified-outcome events when it syncs the record.

## PWA
The app is served publicly at `/dashboard-plugins/fieldkit/app_dist/index.html`, outside Hermes' `/api` login gate. The page contains no data; every data call below still requires sign-in.

`GET /api/plugins/fieldkit/app/{path}` remains as the legacy authenticated address. It serves `dashboard/app_dist`:
- `index.html`, `sw.js` and `manifest.json` are sent with `no-cache`; hashed assets are immutable.
- Unknown extension-less paths fall back to `index.html`.
- Path traversal returns 404.

## Report schema (stored, `source: "hermes"`)
`summary, issues[{title,severity,evidence,field_ids}], missing_information[], references[], suggested_actions[{action,priority}], followups[{title,detail,due_date}], requires_review, review_reason, workflow, observations, local_findings, available_references, attachments, report_id, version, record_revision, generated_at, generated_by, provider, model`.

**`attachments` block (0.2.4):**
- `counts` (`{photo, audio, signature}`) and `summary` (text, for example "1 photo · 1 voice note · 1 signature").
- `voice_notes`: `{attached, transcribed, from_device, from_hermes}`.
- `signatures`: `[{attachment_id, field_label, signed_at, stored}]`.
- `evidence`: one entry per attachment, `{attachment_id, kind, field_id, field_label, mime, size, sha256, stored, integrity, url}`, plus:
  - `signed_at` for signatures;
  - `transcript`, `transcript_source` and `transcript_error` for voice notes;
  - `ocr_text` for photos that have OCR text.
- `integrity` is `intact`, `mismatch`, `missing` or `not_uploaded`. It is recomputed from the stored file at report time.
- `url` is a relative `attachments/<id>` path. Reports never contain server file paths.

Photos are sent to the vision model only; signatures are never sent as photos.

**Report v2 (0.2.5).** `schema_version: 2` is set on new reports. Report v1 fields (`suggested_actions`, `followups`)
are still written for older readers. The v2 fields are:
- `decision`: `{outcome, rationale, confidence (high | medium | low), deadline_days?, escalate_to?}`. `outcome` is an id
  from the workspace's decision scale (default: `stop`, `act_soon`, `monitor`, `no_action`).
- `issues[]`: as in v1, plus `interpretation` and `evidence_refs[{kind, ref, quote?}]`. `kind` is one of `answer`,
  `photo`, `photo_text`, `voice_quote`, `measurement`, `local_finding`, `previous_record`, `followup_check`, `reference`.
  Also `guidance_refs[]`.
- `next_actions[]`: `{order, action, who, by_when_days, guide_id?, entry_id?, verify_by, origin}`. `origin` is `guide`,
  `knowledge` or `ai_suggestion`.
- `uncertainty[]`: `{unknown, impact?, how_to_resolve}`.
- `differences_from_local_findings[]`: `{local, hermes, why}`.
- `follow_up_verification[]`: `{what, how, due_in_days?}`. These checks are asked on the next inspection.
- `translations`: keyed by language code, each with `summary`, `rationale`, `next_actions[]`, `issues[]`.
- `quality`: `{problems[], repaired}`, from the deterministic checks run after the model answers.
- `review_triggers[]`: why the report needs review. Empty means it does not.

## Hermes tools
`fieldkit_create_workflow`, `fieldkit_validate_workflow`, `fieldkit_publish_workflow`, `fieldkit_list_workflows`,
`fieldkit_get_workflow`, `fieldkit_get_app_link`, `fieldkit_create_knowledge_pack`, `fieldkit_create_dictionary_pack`,
`fieldkit_list_knowledge_packs`, `fieldkit_search_knowledge`, `fieldkit_list_records`, `fieldkit_get_record`,
`fieldkit_analyze_record`, `fieldkit_generate_report`, `fieldkit_save_report`, `fieldkit_get_report`, `fieldkit_list_reports`,
`fieldkit_create_followup`, `fieldkit_list_followups`, `fieldkit_get_sync_status`, `fieldkit_resolve_conflict`,
`fieldkit_process_pending_jobs`, `fieldkit_install_examples`.

Workspaces and learning (0.2.5, 9 tools):
Workspace build tools (0.2.6, 3 new):
- `fieldkit_start_workspace_build`: starts or resumes a build for a confirmed brief. When the workspace exists, it starts from the latest version.
- `fieldkit_add_workspace_parts`: adds, replaces or removes items of one part. `dry_run` validates without saving. Each item is checked against its part's schema.
- `fieldkit_workspace_build_status`: shows a build's progress, so a new chat can resume it.

Workspaces and learning (0.2.5, 9 tools):
- `fieldkit_workspace_format`: takes `part` (`sources`, `evidence`, `report_policy`, `workflows`, `guides`, `knowledge`, `vocabulary`, `intents`, `gaps` or `traceability`) and returns that part's JSON Schema, a valid example and its rules. The evidence rules FieldKit enforces are included.
- `fieldkit_save_workspace_brief`: saves the interview result. An incomplete brief cannot be confirmed.
- `fieldkit_build_workspace`: takes `workspace_id` (assembles the parts saved for the build) or the older `brief_id` and `bundle`. Validates and stores a draft. Quote checks run in the background: the call waits at most 20 s and reports `checks_pending`. Cited web pages are re-fetched and quotes that are not on them are dropped. PDFs are checked with Hermes' own document extractor. Private, loopback and metadata addresses are never fetched.
- `fieldkit_publish_workspace`: publishes a valid draft. Requires `user_approved`. Refused while any quote check is pending.
- `fieldkit_get_workspace`, `fieldkit_list_workspaces`: read workspace versions and their research report.
- `fieldkit_propose_workspace_changes`: turns learning events into candidates (research gaps, local practices, reviews).
- `fieldkit_list_learning`: learning events and candidates.
- `fieldkit_decide_candidate`: accepts or rejects a candidate. Requires `user_confirmed`. An accepted candidate creates a validated new workspace version with a changelog.

With these, FieldKit has 35 Hermes tools (32 in 0.2.5, 23 before 0.2.5).

**`fieldkit_list_records` `include_answers` (0.2.6).** Set `include_answers: true` to get each record's answers in the result. Use it for summaries, counts, trends and comparisons across records, which is how the `summarize` mode is used. Without it, the result lists record summaries only.

All tools return a JSON string `{ok: true, …}` or `{ok: false, error}`. They act as the instance owner.

`fieldkit_get_record` returns the same attachment fields as `GET records/{id}` (0.2.4): `kind`, `field_label`, `signed_at`, transcript fields, `attachment_counts` and `attachment_summary`.

## Plugin settings
| Setting | Default | Environment variable | Effect |
|---|---|---|---|
| `voice_transcription` | `true` | `FIELDKIT_VOICE_TRANSCRIPTION=false` | When on, Hermes transcribes voice notes that have no phone transcript (see `attachments/{id}` above). When off, each untranscribed voice note's `transcript_error` says that transcription is turned off, and the analysis lists those voice notes under missing information. |
