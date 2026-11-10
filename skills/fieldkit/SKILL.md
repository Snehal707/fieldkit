---
name: fieldkit
description: Create offline mobile field workflows and knowledge packs with FieldKit, then retrieve, analyse, compare and report on records synchronised from phones. Use when the user mentions FieldKit, field inspections, surveys, checklists, offline forms, or asks about their latest submitted records or reports.
---

# FieldKit

FieldKit lets people collect structured information on a phone **with no internet**. The
phone app (an installable PWA) runs downloaded workflows, shows locally generated findings,
answers questions from downloaded knowledge packs, and synchronises records to this Hermes
instance when connectivity returns. You are the connected intelligence layer.

Results live in three places. Never blur them:
- **Local findings** are computed on the phone by the workflow's own rules (`source: "local"`). They are not your analysis.
- **Synchronised** means the record was durably received. It does **not** mean it has been analysed.
- **Hermes reports** are what you (or the background worker) generated with `source: "hermes"`.

## Creating a workflow (for example, "create an equipment inspection workflow with photographs")

1. Call `fieldkit_create_workflow` with `request` (the user's words plus any detail you know), `languages` (default `["en"]`; add `"hi"` etc. when asked), and `domain`. It returns a validated **draft**.
   - If generation fails validation, fix the returned `definition` yourself and call again with `definition`.
2. Summarise the draft for the user: number of questions, branching questions, photo/GPS/audio fields, and local classification rules.
3. When the user agrees (or explicitly asked for it to be ready), call `fieldkit_publish_workflow`.
4. Give the user the `app_link` and say: "Open this on your phone, sign in once, tap **Download for offline**, then add FieldKit to your home screen."
   - If the link is not absolute, tell them to open their Hermes dashboard URL followed by that path.
5. If reference material is needed (troubleshooting, explanations), offer `fieldkit_create_knowledge_pack`.

Workflow rules you must follow when writing a `definition` yourself:
- Field `type` is one of: text, multiline, number, date, time, checkbox, single_choice, multi_choice, photo, gps, audio, signature, instruction.
- Branching uses a JSON condition AST, never code: `{"op":"eq|neq|gt|gte|lt|lte|in|contains|exists|empty","field":"id","value":…}`, combined with `{"op":"and","all":[…]}`, `{"op":"or","any":[…]}` and `{"op":"not","cond":…}`.
- Use `visible_if` to show follow-up questions and `required_if` to make them mandatory.
- Use `classification` (`rules`, `keywords`, `scores`, `decision_trees`) to give the field user immediate local findings.
- Set `review_required: true` for safety, health, legal or financial workflows.

## Knowledge and dictionaries

- `fieldkit_create_knowledge_pack` takes `document` text (from a file the user shared, or content you have) and turns it into explanations, procedures, FAQs and troubleshooting entries. Only include facts that are present in the source.
- `fieldkit_create_dictionary_pack` builds multilingual term lists (`term`, `lang`, `definition`, `translations`).
- Reference the pack ids in the workflow's `knowledge_packs` / `dictionary_packs` so phones download them together.

## Answering questions about observations ("what do you think about observation 024?", "what do the photos show?", "compare my last five", "summarise this workspace")

Syncing never triggers AI work: you act only on what the user asks. Interpret the request yourself; the user should not
have to ask for photo analysis, transcription or history.
1. Find the record(s): `fieldkit_list_records` (newest first; filter by `workflow_id` or a whole `workspace_id`; the
   rows carry a `subject` such as an asset id or farmer code, so match the user's words to it).
2. One observation, any question (including broad ones like "what do you think?"): `fieldkit_ask_about_record` with the
   user's question. It retrieves the evidence itself (answers, photos, voice-note transcripts, on-phone findings, the
   workspace's procedures and earlier visits of the same subject) and returns an answer with confidence, uncertainty
   and next steps; it is also saved on that visit for the phone. Relay it conversationally.
   - Only if the user explicitly wants a full structured report: `fieldkit_get_report`, or `fieldkit_analyze_record`.
3. Several observations or a whole workspace (summaries, counts, trends, comparisons):
   `fieldkit_list_records` with `include_answers: true` (and `workspace_id`), then reason over the answers; use
   `fieldkit_ask_about_record` for individual visits whose photos or voice notes matter.
4. Questions users asked on the phone about a visit are answered automatically after sync; see them with
   `fieldkit_list_questions`. Answers about one case stay with that case: never turn them into workspace rules.
5. To compare records:
   - Fetch each with `fieldkit_get_record` and/or `fieldkit_get_report`, then compare the answers and findings yourself.
   - If the user wants the comparison kept, store it against the most recent record with `fieldkit_save_report`.
6. `fieldkit_create_followup` for any agreed next action; `fieldkit_list_followups` for open tasks.
7. Always say which statements come from local findings, which from a stored Hermes report, and which are your new reasoning.
8. Flag `requires_review` items as needing a qualified person.
9. Attachments: `fieldkit_get_record` gives each file's `kind` (photo, voice note or signature) and `attachment_summary`
   (for example "2 photos · 1 voice note · 1 signature"). Use those counts; a signature is not a photo.
   - Voice notes appear in `answers_readable` with their transcript (made on the phone or by Hermes speech-to-text),
     or with `not_transcribed_because`. Treat a transcript as the inspector's own words; never guess an
     untranscribed note's content.
   - A report's `attachments.evidence` lists every file with its SHA-256 and an `integrity` check
     (`intact`, `mismatch`, `missing`). Signatures carry `signed_at`. Mention any file that is not `intact`.

## Sync and processing

- `fieldkit_get_sync_status` shows records received, attachments still uploading, open conflicts and analysis jobs.
- Syncing creates no analysis. Questions users queued about a visit are answered by FieldKit's worker; if the analysis
  mode is `deferred` (no worker), call `fieldkit_process_pending_jobs`, which also answers queued questions.
- Conflicts mean a phone edited an old revision. Show both versions, then call `fieldkit_resolve_conflict` with the user's choice. Never pick a resolution silently.

## Demo content

`fieldkit_install_examples` installs synthetic example workflows for education (classroom observation), equipment maintenance (equipment inspection) and agriculture (crop health), each with knowledge and dictionary packs.
