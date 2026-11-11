# FieldKit plugin API (0.3.0)

Base path: `/api/plugins/fieldkit/`.
- Every route needs a Hermes dashboard session (cookie), or the session token on a loopback dashboard.
- Without one, Hermes returns `401` before FieldKit runs.
- Records, attachments, questions, reports and conflicts are scoped to the signed-in user. Another user's id returns `404`.
- Forms are called **workflows** in the route names. Workspaces are groups of forms.

## Meta
| Method | Path | Result |
|---|---|---|
| GET | `me` | `{user_id, display_name, provider}` |
| GET | `status` | `{plugin, version, instance: {machine, region, pid}, store, app_built, public_url}`. `store` is `{store_id, created_at, path, records_for_you, last_received_at}`. `store_id` is a random id kept inside the database: two installs on the same account that see different ids use different databases. `records_for_you` counts only the caller's records. |

## Forms (workflows)
| Method | Path | Query / body | Result |
|---|---|---|---|
| GET | `workflows/{id}` | `version`, `draft=true` | The form definition. Published by default; `404` if none is published |
| POST | `workflows/restore` | `{definition}` | `{restored, version}`. Puts back one exact form version that this Hermes lacks (for example after its data was reset), from the copy a phone downloaded. Validated like any form (`422` with `{problems}`). Never overwrites an existing version (`restored: false`). Never touches another user's form. |

## Packs and model catalog
| Method | Path | Query / notes |
|---|---|---|
| GET | `packs/{id}` | The raw JSON body, with header `X-FieldKit-SHA256` (must match the SHA-256 of the body) |
| GET | `models` | The pinned upstream on-device model catalog (metadata only). The phone downloads the files from their upstream hosts. |

## Workspaces
| Method | Path | Query / result |
|---|---|---|
| GET | `workspaces` | `{workspaces: [...]}`: published workspaces, instance-wide. Each has `id`, `title`, `latest_version`, `published_version`, `starter` (true for example workspaces) and `updated_at`. |
| GET | `workspaces/{id}` | `version` optional. Returns `workspace_id`, `version`, `status`, `published_version`, `starter`, `manifest_pack`, `changelog`, `summary`, `title`, `profile`. `404` for an unknown id. |

The phone opens a workspace at `#/workspace/<id>`. Hermes returns that link when a workspace is published. Workspaces are built and changed by Hermes through the tools below.

## Sync
`POST sync/records`
```json
{"idempotency_key": "idk_…", "device_id": "dev_…",
 "record": {"id": "rec_…", "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0,
            "answers": {…}, "workspace_id": "…", "created_local_at": "…", "completed_at": "…",
            "attachments": [{"id": "att_…", "field_id": "photos", "mime": "image/jpeg", "size": 123, "sha256": "…"}]}}
```

**200 response:**
```json
{"record_id", "revision", "received_at", "sync_status": "received|complete", "attachments_needed": [ids], "workspace_id"}
```
- `sync_status` is `received` while files are outstanding and `complete` when every declared file is stored. Syncing never starts any processing.
- The same `idempotency_key` returns the stored response with `duplicate: true`.
- A stale `base_revision` with identical content is acknowledged without a new revision.

**Workspace on a record.** `record.workspace_id` is the workspace the phone recorded the entry in. The server stores it only if it is a published workspace whose published or earlier published versions contain the record's form. Otherwise it stores the only published workspace that contains the form, or none. When the phone's value was not used, the response includes `workspace_note`. An edit without a workspace never clears a stored one. When the store first opens, a record with no workspace gets one only if exactly one published workspace contains its form. Each such repair writes a `record.workspace_repaired` audit event.

**Error responses:**
- `409 {conflict: {conflict_id, record_id, base_revision, server_revision, server_answers}}`: the base revision is stale and the content differs. The conflict is recorded; the server never overwrites.
- `422`: invalid record, unknown `workflow_id` or `workflow_version`, or an invalid attachment declaration.
- `404`: the record id belongs to another user.

**Related routes:**
- `PUT attachments/{id}`: the raw body, with `Content-Type` set to an allowed type (`image/jpeg`, `image/png`, `image/webp`, `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg`, `audio/wav`, `audio/x-wav`). Other types return `415`. Max 15 MB (`413`). The SHA-256 must equal the declared value (`422` otherwise). Repeating the same upload returns `duplicate: true`. Response: the same fields as the sync response, plus `attachment_id` and `status: "stored"`.
- `GET attachments/{id}`: the file, with `X-FieldKit-SHA256`. Only for stored files of the caller.
- `GET sync/status`: `{records_by_sync_status, attachments_outstanding, open_conflicts, last_received_at, devices}`.
- `GET sync/conflicts`: `{conflicts: [...]}`.
- `POST sync/conflicts/{id}/resolve`: body `{resolution: keep_server | use_client | merge, merged_answers?}`. Returns `{conflict_id, resolution, record_id, revision}`.

## Devices
| Method | Path | Body | Result |
|---|---|---|---|
| GET | `devices` | | `{devices: [{id, label, first_seen, last_seen}]}`: the caller's devices only |
| POST | `devices` | `{device_id, label}` | Registers or renames one of the caller's devices. `device_id` must match `dev_<4-40 letters or digits>` (`422` otherwise). Control characters are removed from `label`; max 80 characters. |

## Records
| Method | Path | Query / result |
|---|---|---|
| GET | `records` | `workflow_id`, `limit` (default 50, max 500). Summaries include `workflow_title` and `subject`. |
| GET | `records/{id}` | The full entry: answers, `revision`, sync fields, and attachments. Each attachment has `kind` (`photo`, `audio` for a voice note, or `signature`), `field_label`, `captured_at`, `signed_at` (signatures), `phone_transcript` and `phone_ocr_text` (text the phone read, if any). Also `attachment_counts` (`{photo, audio, signature}`) and `attachment_summary` (for example "1 photo · 1 voice note"). |
| GET | `records/{id}/questions` | Read-only. Questions asked about this entry in FieldKit before 0.3, with their status and answers. |
| GET | `records/{id}/report` | Read-only. The latest report made before 0.3. `404` when there is none. |

## Reports (read-only, before 0.3)
| Method | Path | Query / result |
|---|---|---|
| GET | `reports` | `record_id`, `limit` (default 50, max 200). Reports made before 0.3. |
| GET | `reports/{id}` | One report made before 0.3. |

## PWA
The app is served publicly at `/dashboard-plugins/fieldkit/app_dist/index.html`, outside Hermes' `/api` login gate. The page holds no data; every data call above still requires sign-in.

`GET /api/plugins/fieldkit/app/{path}` is the older authenticated address, and `GET app` redirects to `app/`. It serves `dashboard/app_dist`:
- `index.html`, `sw.js` and the manifest are sent with `no-cache`. Hashed assets are immutable.
- Unknown paths without a file extension return `index.html` (client-side routes).
- Path traversal returns `404`.

## Hermes tools
Hermes registers 12 tools. They act as the Hermes instance owner. Every tool returns a JSON string: `{"ok": true, ...}` or `{"ok": false, "error": "..."}`.

### Entries
| Tool | Arguments | Result |
|---|---|---|
| `fieldkit_list_records` | `workspace_id`, `workflow_id`, `subject` (partial match), `since`, `until` (completion date on the phone), `limit` (default 50, max 500), `include_answers`, `language` | Entries, newest first, with `subject`, `attachments` counts and sync state. With `include_answers`, each entry's answers with their questions. Entries of a form shared by several workspaces and synced without their workspace are counted in `unassigned_records` and not listed. |
| `fieldkit_get_record` | `record_id`, `language`, `history_limit` (default 5) | The entry with its answers and questions, attachments (kind, field, integrity check), revisions, the subject and its earlier entries, and `from_earlier_fieldkit_versions` (reports, questions and answers, and on-phone findings from before 0.3, read-only). |
| `fieldkit_get_attachment` | `attachment_id` | A local copy of a photo, voice note or signature, with the right file extension, for Hermes' own vision and speech-to-text tools. Returns `path`, `kind`, `field_label`, `integrity`, and any text the phone read. A file still uploading returns an error saying so. |

### Sync
| Tool | Arguments | Result |
|---|---|---|
| `fieldkit_get_sync_status` | | Entries received, files still uploading, devices, and each open conflict (up to 20) with its workspace, form, subject, date and the answers that differ (`conflicts_total` gives the full count) |
| `fieldkit_resolve_conflict` | `conflict_id`, `record_id` (must be the conflict's record), `resolution` (`keep_server`, `use_client`, `merge`), `merged_answers`, `user_confirmed` | Without `user_confirmed: true`: a preview of the conflict and what would happen, nothing changes. With it: the resolved conflict. A `record_id` that does not match the conflict is refused. |

### Phone link
| Tool | Arguments | Result |
|---|---|---|
| `fieldkit_get_app_link` | `workspace_id` or `workflow_id` (both optional) | The phone app link: with `workspace_id` it opens that workspace (the usual case), with `workflow_id` one form, with neither the app. Unknown ids are refused (a workspace id passed as `workflow_id` gets a hint). `absolute` is true when a full address is known; otherwise it returns a path and a note. |

### Workspaces
| Tool | Arguments | Result |
|---|---|---|
| `fieldkit_workspace_format` | | The form format: field types, rules, an example form and the JSON Schema. Read it before writing forms. |
| `fieldkit_draft_workspace` | `workspace_id` (required), and for a new workspace `title`, `purpose`, `languages`, `forms`; for an edit only what changes: `forms` (each changed form in full; same id replaces it), `remove_forms`, `title`, `purpose`, `profile`, `languages`, `workflow_refs`, `changelog` | A new draft version, never published. Returns `valid`, `errors`, `warnings`, `summary`, `forms`, `fixed_automatically` (shape repairs FieldKit made), and for an edit `changes_since_published`. |
| `fieldkit_publish_workspace` | `workspace_id`, `version` (optional), `user_approved` (must be true) | Publishes a valid draft, returns its changes and the app link. Refused without `user_approved`. |
| `fieldkit_undo_workspace_update` | `workspace_id`, `to_version` (optional), `user_confirmed` | Without `user_confirmed`, lists what would change back. With it, republishes the earlier version as a new version, so phones see an update. Entries keep their form version. |
| `fieldkit_get_workspace` | `workspace_id`, `version` (optional), `include_forms` (default true) | Purpose, languages, forms, version history with changelogs, validation, and `legacy_parts_not_used` for parts from earlier versions. |
| `fieldkit_list_workspaces` | `include_drafts` (optional) | Published workspaces; with `include_drafts`, drafts too |

### Forms and checks
A form is a JSON object with `id`, `title`, `languages`, `metadata.subject_field` (optional), and `fields`. Field types: `text`, `multiline`, `number`, `date`, `time`, `checkbox`, `single_choice`, `multi_choice`, `photo`, `audio` (voice note), `gps`, `signature`, `instruction`. Fields can have `required`, `required_if`, `visible_if`, `unit`, `validation` (for example `min`, `max`, `min_length`, `max_length`, rules) and `options` (`[{value, label}]`).

Conditions use `{op, field, value}`, with `and`, `or` and `not`. Errors point to the path and say why, for example that a number field needs a number, or that a value is not an option of a choice field.

## Plugin settings
| Setting | Environment variable | Effect |
|---|---|---|
| `public_url` | `FIELDKIT_PUBLIC_URL` | The address used for phone links. Set it when FieldKit cannot detect the address (see [INSTALL.md](INSTALL.md)). An explicit setting always wins. |

FieldKit has no other settings.
