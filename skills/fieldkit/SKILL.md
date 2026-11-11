---
name: fieldkit
description: Read what the user collected offline with the FieldKit phone app and synchronised to Hermes (entries such as observations, visits, inspections, interviews, survey responses, with photos, voice notes, GPS and signatures), then do what the user asks with it. Use when the user mentions FieldKit, their entries, visits, observations, field data or synced photos and voice notes. To set up or change a workspace (its forms), use the fieldkit-workspace-builder skill.
---

# FieldKit

FieldKit collects entries on a phone **with no internet** and syncs them to Hermes. Its job ends at making that data
reliably available to you. **FieldKit does not analyse anything:** when the user asks a question about their entries
(what do you think, what do the photos show, summarise, compare, find trends, write a report), you do it yourself,
with your own reasoning and tools.

## Finding entries
- `fieldkit_list_records`: newest first. Filter by `workspace_id`, `workflow_id` (a form), `subject` (the site, person
  or item an entry is about; partial match) and `since`/`until` (date the entry was completed on the phone).
  `include_answers: true` adds each entry's answers with their questions, for counts, summaries and comparisons.
- `fieldkit_list_workspaces` / `fieldkit_get_workspace`: what each workspace is for and its forms.
- If several entries match the user's words, ask which one.

## Reading one entry
- `fieldkit_get_record`: answers with their questions, attachments (kind, field, integrity), revisions, and earlier
  entries of the same subject (for "is it worse than last time?").
- Photos, voice notes and signatures: `fieldkit_get_attachment` returns a local file `path`. Open it with your own
  tools when the request needs it: vision for a photo, speech-to-text for a voice note. A signature is not a photo.
  Never guess what an untranscribed voice note or an unopened photo contains.
- Text the phone already read (`phone_transcript`, `phone_ocr_text`) is the phone's own reading; say so if you use it.
- Data from FieldKit versions before 0.3 (old reports, questions answered then, on-phone findings) appears under
  `from_earlier_fieldkit_versions`. It is historical: mention it when useful, never as a new result.

## Sync
- `fieldkit_get_sync_status`: entries received, files still uploading, open conflicts, devices.
- Conflicts mean a phone edited an old revision. `fieldkit_get_sync_status` describes each one (workspace, form,
  subject, date, the answers that differ). Make sure you and the user mean the **same** conflict, show the differences,
  then call `fieldkit_resolve_conflict` with its `conflict_id`, its `record_id` and their choice: first without
  `user_confirmed` (a preview of what will happen), then with `user_confirmed: true` once they agree. Never choose silently.
- A file that is still uploading cannot be opened yet; tell the user it will be available after the phone syncs.

## Links
- `fieldkit_get_app_link` with `workspace_id` gives the phone link to a workspace (the usual case): open it, sign in
  once, tap "Download everything for offline", then add the app to the home screen. `workflow_id` opens one form;
  never pass a workspace id as `workflow_id`.
