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

## Answering questions about results ("analyse my latest inspection", "what should I do next?", "compare my last five")

1. `fieldkit_list_records` (filter by `workflow_id`; newest first) to find the records.
2. For one record:
   - `fieldkit_get_report` with `record_id`.
   - If there is none, `fieldkit_analyze_record` (stores a structured report the phone can download).
   - Explain the summary, issues, missing information and suggested actions conversationally.
3. To compare records:
   - Fetch each with `fieldkit_get_record` and/or `fieldkit_get_report`, then compare the answers and findings yourself.
   - If the user wants the comparison kept, store it against the most recent record with `fieldkit_save_report`.
4. `fieldkit_create_followup` for any agreed next action; `fieldkit_list_followups` for open tasks.
5. Always say which statements come from local findings, which from a stored Hermes report, and which are your new reasoning.
6. Flag `requires_review` items as needing a qualified person.

## Sync and processing

- `fieldkit_get_sync_status` shows records received, attachments still uploading, open conflicts and analysis jobs.
- If jobs are `pending` and the analysis mode is `deferred`, call `fieldkit_process_pending_jobs`. A Hermes cron job can also call it periodically.
- Conflicts mean a phone edited an old revision. Show both versions, then call `fieldkit_resolve_conflict` with the user's choice. Never pick a resolution silently.

## Demo content

`fieldkit_install_examples` installs synthetic example workflows for education (classroom observation), equipment maintenance (equipment inspection) and agriculture (crop health), each with knowledge and dictionary packs.
