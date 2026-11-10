---
name: fieldkit
description: Answer questions about entries (observations, visits, inspections, survey records) collected offline with the FieldKit phone app and synchronised to Hermes: one entry, several, or a whole workspace. Use when the user mentions FieldKit, their visits, inspections, surveys, records or field data. To set up or change a workspace, use the fieldkit-workspace-builder skill.
---

# FieldKit

FieldKit lets people record entries on a phone **with no internet** (forms, photos, voice notes, GPS), apply their own
rules on the phone, and sync when connected. **Saving or syncing never triggers AI work.** You help only when asked:
questions about an entry queued on the phone, or the user's requests here in chat.

Keep sources apart:
- **On-phone results** come from the workspace's own rules (`source: "local"`). They are not your analysis.
- **Synchronised** means received, not analysed.
- **Your answers** are your reasoning over the entry's evidence; say what you could not tell.

## Questions about entries

Interpret the request yourself; the user should not have to ask for photo analysis, transcription or history.
1. Find the entry or entries: `fieldkit_list_records` (newest first; filter by `workspace_id` or `workflow_id`). Rows
   carry a `subject` (asset id, participant, farmer code...) and a title: match the user's words to them. If several
   match, ask which one.
2. **One entry, any question** ("what do you think about observation 024?", "what do the photos show?", "is it worse
   than last time?", "write a short report on this visit"): `fieldkit_ask_about_record` with the user's question. It
   uses the entry's answers, photos, voice-note transcripts, on-phone results, the workspace's procedures and earlier
   entries of the same subject, and returns an answer with confidence, uncertainty and next steps (also saved on that
   entry for the phone). Relay it conversationally; keep the uncertainty.
3. **Several entries or a whole workspace** (summaries, counts, trends, comparisons, "most common problems"):
   `fieldkit_list_records` with `include_answers: true` (and `workspace_id`), then reason over the answers. Use
   `fieldkit_ask_about_record` for individual entries whose photos or voice notes matter.
4. Questions asked on the phone are answered automatically after sync; see them with `fieldkit_list_questions`.
5. An answer about one case stays with that case: never turn it into a workspace rule. If the user wants a rule
   changed, use the fieldkit-workspace-builder skill (it shows the change and asks before publishing).
6. Attachments: `fieldkit_get_record` gives each file's `kind` (photo, voice note, signature) and a summary such as
   "2 photos · 1 voice note". A signature is not a photo. Never guess an untranscribed voice note's content.
7. Older entries may have a stored structured report from before 0.2.6: `fieldkit_get_report` reads it.

## Sync and processing

- `fieldkit_get_sync_status` shows records received, attachments still uploading and open conflicts.
- Questions queued on the phone are answered by FieldKit's worker; if the analysis mode is `deferred` (no worker),
  call `fieldkit_process_pending_jobs`, which answers queued questions.
- Conflicts mean a phone edited an old revision. Show both versions, then call `fieldkit_resolve_conflict` with the
  user's choice. Never pick a resolution silently.

## Links and demo content

- `fieldkit_get_app_link` gives the phone link (open it, sign in once, tap "Download everything for offline").
- `fieldkit_install_examples` installs synthetic example workspaces (education, equipment maintenance, agriculture).
