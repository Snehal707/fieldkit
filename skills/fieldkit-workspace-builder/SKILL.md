---
name: fieldkit-workspace-builder
description: Set up or update a FieldKit workspace for the user's actual field job (their responsibilities, decisions, tools, own rules, documents and languages) so the phone can record work and give a quick opinion offline. Fast by default (built from the interview, no up-front web research). Use when the user wants FieldKit set up for their work, when FieldKit has no workspace yet, or when a workspace needs changes, gaps filled or improvements reviewed.
---

# FieldKit workspace builder

A workspace is the user's job turned into an offline kit: a form to record their work, the decisions they make, decision
guides that walk to a decision, and the rules they already use. The phone records offline and gives a quick opinion from
the workspace; after sync, Hermes gives the full opinion on each record. FieldKit validates everything you build and
computes where each rule comes from. **Never present model knowledge as verified guidance.**

**Be fast.** Setup should take the user a few minutes of answers and about a minute of building. Do **not** research
the web before building. The user's own rules and documents are the source for their process.

## 1. Interview (in the user's language, a few questions at a time)

- What they do, how often, and **the decisions each task needs** (accept/reject, act now/watch, refer/treat…).
- What they record or measure, with which instruments and units.
- **The rules they already use**, in their words: limits, thresholds, steps ("we reject below 8.3 SNF", "spray only
  after the KVK says so"). Ask for any SOP, checklist, form or photo of their paper form: build from it.
- Country/region, languages (reading, speaking, text in photos), who they escalate to (roles), how long offline.

Call `fieldkit_save_workspace_brief`; show the returned `summary`; call again with `confirmed: true` only after the user
confirms. Keep each responsibility's `id` short (e.g. `r_accept`).

## 2. Build straight away (about a minute)

1. `fieldkit_start_workspace_build` (brief id, lowercase workspace id, title and languages).
2. `fieldkit_workspace_format` once, then `fieldkit_workspace_format(part)` for the parts you write (copy the shape).
3. Add everything in **one or two calls** with `fieldkit_add_workspace_parts(workspace_id, parts={...})`:
   - `sources`: one `{"type": "user_statement", "title": "Stated by the user in the setup interview"}` for the rules
     they told you, plus `user_document` sources for documents they shared.
   - `evidence`: one item per rule they stated, quoting **their words** (`source_id` = the user_statement source).
     These are labelled "Your procedure" on the phone, never "verified".
   - `report_policy` (their decisions), `workflows` (their fields, units, terms; choice options as `{value, label}`),
     `guides` (their steps to a decision; actions cite their rules, or are `{"kind": "escalate"}`), `vocabulary`,
     `gaps` (what they did not know, e.g. "no SNF limit given: ask the union"), `traceability` (every responsibility).
4. You may suggest extra checks from your own knowledge, but say they are suggestions and ask the user. Only what the
   user accepts becomes a rule (record it as a user_statement: "Suggested by Hermes, accepted by the user"). Anything
   not accepted stays out, or is an explanation entry (shown as unverified background).
5. `fieldkit_build_workspace(workspace_id)`. Fix any rejected item from its path, error and hint, and build again.

## 3. Review and publish

Tell the user in a few lines what the phone will do, which rules are theirs, and the gaps (with who to ask). Publish with
`fieldkit_publish_workspace` and `user_approved: true` only after they approve. Give them the app link and tell them to
tap "Download everything for offline".

## 4. Optional: check rules against official sources (only if the user asks, or a legal limit decides the outcome)

Keep it short and targeted, one question at a time: at most two `web_search` calls on official domains for the country
(regulator, standards body, manufacturer), open the one matching page with `web_extract`, copy the exact sentence, add it
as a source + evidence. FieldKit checks the quote. If nothing qualifies quickly, add a `gaps` item and move on. Tell the
user whether their rule matches ("matches FSSAI") or differs. Never spend long browsing.

## 5. After sync: answer what the user asks

Syncing alone triggers no AI work. Users ask about a visit on the phone ("Ask Hermes about this visit"); FieldKit
answers those from that record automatically, and you can see them with `fieldkit_list_questions`. In chat, a question
about one visit goes to `fieldkit_ask_about_record` (it gathers the photos, voice notes, procedures and history itself);
summaries or comparisons across visits use `fieldkit_list_records` with `include_answers` (and `workspace_id`). Answers about one case stay with that case; never turn them into workspace rules.

### Solution first

When the user asks about a synced record or a report, answer with the solution and next steps from the record, the report
and the workspace. Research only the one open question that blocks the answer, as in section 4. If it cannot be found
quickly, say who to ask (their escalation role, KVK, supervisor) and record a gap. Questions the phone could not answer
offline arrive as learning candidates (`fieldkit_propose_workspace_changes`): answer them the same way, and add accepted
answers to the workspace (start a build with the same id, add the parts, build, publish) so the phone answers them
offline next time.

A build is saved as you go: if a chat ends, a new chat continues with `fieldkit_workspace_build_status`.
