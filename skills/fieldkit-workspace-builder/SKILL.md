---
name: fieldkit-workspace-builder
description: Build or update a FieldKit workspace for the user's actual field job (their responsibilities, region, country, industry, tools, procedures and languages), researched from reliable sources so the phone can support decisions offline. Use when the user wants FieldKit set up for their work, when FieldKit has no workspace yet, or when a workspace needs new knowledge, gaps filled or improvements reviewed.
---

# FieldKit workspace builder

A workspace is the user's job turned into an offline kit: workflows to record their work, decision guides that walk
them to a decision, knowledge, vocabulary and a report policy. FieldKit validates everything you build and computes
how well each piece is evidenced. **Never present model knowledge as verified guidance.**

## 1. Interview (in the user's language)

Ask until each item is known or explicitly "unknown". Keep it conversational; a few questions at a time.
- Role, organisation type, industry or sector.
- Responsibilities: what they do, how often, and **the decisions each one requires** (accept/reject, stop/continue,
  refer/treat, repair now/later…).
- What they inspect, measure or observe, and the **tools and instruments** they use (model and units if known).
- **Procedures they already follow** (SOPs, checklists, manuals, forms). Invite them to share documents: their own
  procedures are the highest authority for their own process.
- Rules or standards they know apply. Country and region/state/site (rules often differ by region).
- Languages: for reading, for speaking (voice notes), for text in photos. Literacy or simplicity needs.
- Who they escalate to (roles, not names). Connectivity pattern (how long offline).

Call `fieldkit_save_workspace_brief` with what you learned. Show the returned `summary` to the user, ask them to
confirm or correct it, and call again with `confirmed: true` only after they confirm. Do not research before that.

## 2. Start the build

Call `fieldkit_start_workspace_build` with the brief id, a lowercase workspace id (e.g. `dairy-collection-pune`), the
title in every content language and the languages. The build is saved by FieldKit as you go: **if this chat ends or
gets long, a new chat continues with `fieldkit_workspace_build_status`** — never start over.

Call `fieldkit_workspace_format` (no part) once for the steps and evidence rules. Before writing items for a part,
call `fieldkit_workspace_format(part)` for its exact JSON Schema and a valid example, and copy that shape exactly.

## 3. Research and add parts as you go (Hermes' own tools)

Work one responsibility at a time. For each one and each decision it needs:
1. `web_search` for the governing regulation/standard **for this country and region**, the official procedure, and
   manufacturer manuals for the user's actual instruments. Prefer, in order: regulators and government on official
   domains, standards bodies, manufacturers, the user's documents (tier 1); academic, university extension, recognised
   NGOs and international bodies (tier 2); industry bodies and trade publications (tier 3). Never use forums, Q&A sites,
   social media or unattributed blogs as support.
2. **Open the actual page or document with `web_extract`** (not just search snippets) and copy the exact sentence(s)
   that state each rule or threshold, with a locator (page, section, table, clause).
3. **Add them right away** with `fieldkit_add_workspace_parts`: first the `sources` you opened, then the `evidence`
   (claim, verbatim excerpts, applicability: does it cover this product, this state, this equipment?). FieldKit checks
   each quote against its page and tells you the computed status; if a quote is "not found", re-open the page and copy
   the exact text, or drop the claim. Don't keep long page text in the conversation once its evidence is added.
4. If sources disagree, record both (`conflicts`) and make the guide route to the user's escalation role. If you cannot
   find an authoritative source, add a `gaps` item (what you searched) instead of filling it from memory.

Broad jobs: use `delegate` for a responsibility's research, asking the subagent to return ONLY compact JSON (sources and
evidence items in FieldKit's shape, verbatim quotes, no page dumps); then add those items yourself.

## 4. Build the rest, part by part

In this order, each with `fieldkit_add_workspace_parts` (use `dry_run: true` first for large items):
- `report_policy`: the decision scale (2+ decisions, most severe first) and escalation rules.
- `workflows`: one per responsibility or decision that needs structured capture, with the user's units and terms.
  Field types, options as `{value, label}` and conditions as FieldKit's AST exactly as in the schema. Cite
  `evidence_ids` on classification rules with thresholds.
- `guides`: executable decision steps that read record fields or ask questions and end in an outcome from the decision
  scale; every action cites supported evidence or is `{"kind": "escalate"}`.
- `knowledge` (procedures/troubleshooting need evidence ≥ supported), `vocabulary`, `intents` (extra example questions
  for the phone, ids from the schema), `gaps`, and `traceability` (every responsibility served).

Write all user-facing text in **every content language** (the phone's offline translation is only a fallback).
Every rejected item comes back with a path, the error and a hint: fix exactly that and add it again. Items with the
same id replace earlier ones; `remove` deletes. FieldKit reports shape mistakes it repaired in `fixed_automatically`.

Then call `fieldkit_build_workspace(workspace_id)`. If it reports `checks_pending`, some source pages are slow: wait a
minute and build again (publishing is blocked until every quote has been checked). Fix any errors with
`fieldkit_add_workspace_parts` and build again.

## 5. Review and publish

Show the user the research report in plain language: what is verified, supported, conflicting, unverified background,
which sources were excluded or downgraded, quotes that could not be confirmed, and the gaps (with what they can do:
share an SOP, ask their supervisor). Publish with `fieldkit_publish_workspace` and `user_approved: true` only after they
approve. Give them the returned app link and tell them to tap "Download everything for offline" on the phone.

## 6. Updating

When the user's job changes, a gap can now be filled, or learning candidates are waiting: call
`fieldkit_start_workspace_build` with the same workspace id (it starts from the latest version), add or replace only the
parts that change, build with a `changelog`, review, and publish a new version.
