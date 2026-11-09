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

## 2. Research (Hermes' own tools)

Call `fieldkit_workspace_format` once to see the bundle structure and evidence rules.
For each responsibility and each decision:
1. `web_search` for the governing regulation/standard **for this country and region**, the official procedure, and
   manufacturer manuals for the user's actual instruments. Prefer, in order: regulators and government on official
   domains, standards bodies, manufacturers, the user's documents (tier 1); academic, university extension, recognised
   NGOs and international bodies (tier 2); industry bodies and trade publications (tier 3). Never use forums, Q&A sites,
   social media or unattributed blogs as support. Use `delegate` for parallel topics if the job is broad.
2. **Open the actual page or document with `web_extract`** (not just search snippets) and copy the exact sentence(s)
   that state each rule or threshold, with a locator (page, section, table, clause). FieldKit re-fetches web pages and
   drops quotes it cannot find; PDFs are not re-checked, so quote PDFs carefully and give the page number.
3. Check **applicability**: does the rule cover this product/subject (e.g. raw cow milk, not cream), this jurisdiction
   (state, not just country), this equipment? Record it in `applicability.matches_profile` with notes.
4. If sources disagree, record both in `conflicts` and make the guide route to the user's escalation role or the
   stricter rule. If you cannot find an authoritative source, add a `gaps` entry (what you searched) instead of filling
   it from memory. Background explanations from your own knowledge may be included but stay labelled "unverified".
5. Write all user-facing text in **every content language** the user needs (do it yourself; the phone's offline
   translation is only a fallback).

## 3. Build

Create:
- **Workflows**: one for each responsibility or decision that needs structured capture, with the user's units and
  terms. Cite `evidence_ids` on classification rules with thresholds.
- **Decision guides**: executable steps that read record fields or ask questions and end in an outcome on the
  report policy's decision scale, with actions backed by evidence (or `kind: "escalate"`).
- **Knowledge** (procedures and troubleshooting need evidence ≥ supported), **vocabulary**, **report policy** (decision
  scale, review triggers, escalation), **intents** (example questions users would ask, in each language), **gaps**,
  and **traceability** (every responsibility served).

Call `fieldkit_build_workspace`. Fix every error (usually: find and quote a qualifying source, or drop the unsupported
instruction) and build again.

## 4. Review and publish

Show the user the research report in plain language: what is verified, supported, conflicting, unverified background,
which sources were excluded or downgraded, and the gaps (with what they can do: share an SOP, ask their supervisor).
Publish with `fieldkit_publish_workspace` and `user_approved: true` only after they approve. Give them the returned app
link and tell them to tap "Download everything for offline" on the phone.

## 5. Updating

When the user's job changes, a gap can now be filled, or learning candidates are waiting, update the bundle (get it with
`fieldkit_get_workspace` and `include_bundle: true`), rebuild with a `changelog`, review, and publish a new version.
