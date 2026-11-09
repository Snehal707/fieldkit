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

## Hermes tools
`fieldkit_create_workflow`, `fieldkit_validate_workflow`, `fieldkit_publish_workflow`, `fieldkit_list_workflows`,
`fieldkit_get_workflow`, `fieldkit_get_app_link`, `fieldkit_create_knowledge_pack`, `fieldkit_create_dictionary_pack`,
`fieldkit_list_knowledge_packs`, `fieldkit_search_knowledge`, `fieldkit_list_records`, `fieldkit_get_record`,
`fieldkit_analyze_record`, `fieldkit_generate_report`, `fieldkit_save_report`, `fieldkit_get_report`, `fieldkit_list_reports`,
`fieldkit_create_followup`, `fieldkit_list_followups`, `fieldkit_get_sync_status`, `fieldkit_resolve_conflict`,
`fieldkit_process_pending_jobs`, `fieldkit_install_examples`.

All tools return a JSON string `{ok: true, …}` or `{ok: false, error}`. They act as the instance owner.

`fieldkit_get_record` returns the same attachment fields as `GET records/{id}` (0.2.4): `kind`, `field_label`, `signed_at`, transcript fields, `attachment_counts` and `attachment_summary`.

## Plugin settings
| Setting | Default | Environment variable | Effect |
|---|---|---|---|
| `voice_transcription` | `true` | `FIELDKIT_VOICE_TRANSCRIPTION=false` | When on, Hermes transcribes voice notes that have no phone transcript (see `attachments/{id}` above). When off, each untranscribed voice note's `transcript_error` says that transcription is turned off, and the analysis lists those voice notes under missing information. |
