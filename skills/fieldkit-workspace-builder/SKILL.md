---
name: fieldkit-workspace-builder
description: Set up, edit or undo changes to a FieldKit workspace for any kind of work (inspections, research and data collection, business or client visits, field surveys, personal or study logs) so the phone can record entries offline and Hermes can answer questions about them. Use when the user wants FieldKit set up for their work, wants to change their workspace (add, remove or change questions, rules, guides or the description), or says "undo my last workspace update".
---

# FieldKit workspace builder

A workspace is the user's work turned into an offline kit: forms to record entries, and, only if their work has them,
their own rules, decision guides and procedures. Saving or syncing never triggers AI work; Hermes answers when the user
asks. **Never present model knowledge as verified guidance, and never invent a part the user's work does not have.**
Web research is never needed to build a workspace; the user's own description, rules and documents are the source.

## 1. Interview: purpose first, then only what fits (in the user's language)

Start with one question: **what is this workspace for?** (e.g. "storing my research interviews", "checking milk at the
collection centre", "logging client site visits", "tracking my hives"). Then choose the follow-ups that fit that
purpose, a few at a time, **5-8 questions at most**, and infer the rest. Examples (not a fixed script):
- **Research / data collection / surveys:** what each entry records (fields, photos, audio, location), what identifies
  an entry (participant, household, sample id), categories or tags, consent or privacy needs, how they will analyse later.
- **Inspections / quality checks:** what is checked and measured (units, instruments), the rules and limits they use,
  the decisions they make (accept/reject, act now/watch), who they escalate to.
- **Business / client visits:** what is recorded per visit, clients and sites, what follow-up they track.
- **Personal or study logs:** what to capture and how they want to find it later.
- Anything else: ask what a typical entry looks like and what they would want to know from their entries later.

Always learn: the purpose, **what is recorded each time**, **what identifies an entry** (the subject), and languages
(the phone app supports **English and Hindi** only; do not offer other languages). Ask before drafting; do not guess
a form before the user has told you what they record.
Only ask about decisions, rules, escalation, location or instruments if the purpose involves them. If there are no
decisions, there are none: do not create a decision scale, guides or "flag" decisions to fill a template.

Call `fieldkit_save_workspace_brief` with `purpose`, `records` (what is captured), `subject`, `responsibilities`
(the uses of the workspace, each with an `id` and `description`; `decisions` only if real), `languages`, and any of
`rules`, `escalation`, `country`, `region`, `tools_and_instruments`, `procedures_in_use` that apply. Show the returned
summary **and the questions the form will have**, ask the user to confirm or correct, and call again with
`confirmed: true` only after they confirm.

## 2. Build straight away (about a minute)

1. `fieldkit_start_workspace_build` (brief id, lowercase workspace id, title, languages).
2. `fieldkit_workspace_format(part)` for the parts you write (copy the shape).
3. Add everything in **one or two calls**: `fieldkit_add_workspace_parts(workspace_id, parts={...})`:
   - `workflows`: the form(s) with the user's fields, units and terms (choice options as `{value, label}`); set
     `metadata.subject_field` to the field that identifies an entry (e.g. `participant_id`, `asset_id`).
   - Only if they stated real rules (limits, thresholds, steps; not a description of the form): one `sources` item `{"id": "s_user", "type": "user_statement", "title": "Stated by the
     user in the setup interview"}`, `evidence` quoting **their words**, classification rules citing it ("Your
     procedure" on the phone).
   - Only if they make decisions: `report_policy.decision_scale` and `guides` (actions cite their rules, or are
     `{"kind": "escalate"}`).
   - `vocabulary` and `gaps` if useful; `traceability` mapping each use (responsibility id) to its form or guide.
4. `fieldkit_build_workspace(workspace_id)`. Fix any rejected item from its path, error and hint, and build again.

## 3. Review and publish

Tell the user in a few lines what the phone will record and do. Publish with `fieldkit_publish_workspace` and
`user_approved: true` only after they approve. Give the app link: on the phone, "Download everything for offline".

## 4. Editing a workspace (no new interview)

For "add a question about X", "remove the GPS field", "make temperature required", "change the description",
"add our new rule", "change the guide":
1. `fieldkit_start_workspace_build(workspace_id)` (no brief needed; it starts from the published version). For the
   description or purpose, pass `profile_changes` (e.g. `{"purpose": "..."}`) and a new `title` if asked.
2. `fieldkit_get_workspace(workspace_id, include_bundle=true)` if you need the current form, then
   `fieldkit_add_workspace_parts`: send the **whole changed item** (e.g. the full form with the field added or removed);
   `remove` deletes items. Do only what was asked; do not redesign the rest.
3. `fieldkit_build_workspace(workspace_id)` returns `changes_since_published`: show it as a short list and ask
   "Publish these changes?". Publish only after they say yes.
4. Old records keep their original form version and answers, including answers to removed questions.

**Undo:** an explicit "undo my last workspace update" is the approval: call
`fieldkit_undo_workspace_update(workspace_id, user_confirmed=true)` and tell the user exactly what changed back (the
returned `changes`). If it is unclear which change they mean, preview first (without `user_confirmed`) and ask. It
publishes the previous version as a new version, so phones get it as an update.

## 5. Optional: check a rule against official sources

Only if the user asks, or a legal limit decides the outcome: at most two `web_search` calls on official domains, open
the one matching page with `web_extract`, copy the exact sentence, add it as a source + evidence (FieldKit checks the
quote). If nothing qualifies quickly, add a `gaps` item. Never spend long browsing.

**Which stage does a standard govern?** Record it in `applicability.governs` and `applicability.binding_for_this_work`.
A legal standard for another stage or party is a reference for this work, not its rule. Example: FSSAI fat/SNF
minimums govern milk **sold to consumers**; a village collection centre buying from farmers decides acceptance by its
union's or buyer's **procurement standard** (ask the user for it), and may show the FSSAI value for information only.
So: `binding_for_this_work: false` (status "Reference only"), never a rejection threshold. Reject/high-severity rules
and the most severe guide decisions must cite the user's procedure or a standard that binds this work; FieldKit
refuses them otherwise. If the user has no procurement standard, ask; do not substitute the legal one.

**Correcting such a workspace** (e.g. "the FSSAI limits are not our collection rule"): edit it as in section 4. Keep
the legal evidence but set its applicability (governs, binding_for_this_work=false); point the reject rule and guide
at the user's procurement rule (add it as their statement); relabel rules ("below our procurement standard", not
"below the legal minimum"). Show `changes_since_published` and publish only after the user approves. Old entries keep
their original form version.

## 6. Questions about entries

Users ask about an entry on the phone ("Ask Hermes about this visit"); FieldKit answers those after sync, and you can
see them with `fieldkit_list_questions`. In chat, a question about one entry goes to `fieldkit_ask_about_record` (it uses
the photos, voice notes, procedures and earlier entries of the same subject itself); summaries or comparisons across
entries use `fieldkit_list_records` with `include_answers` (and `workspace_id`). Answers about one case stay with it.

A build is saved as you go: if a chat ends, a new chat continues with `fieldkit_workspace_build_status`.
