# FieldKit Workspaces: architecture and implementation plan (draft for approval)

Status: **proposal, not implemented.** Written 2026-11-10 against FieldKit 0.2.4 (commit 98804e9) and Hermes v0.23.0.

## 0. Goal

A user installs FieldKit and Hermes builds them a **workspace**: their workflows, procedures, decision guides, knowledge,
vocabulary and report policy, researched from reliable sources for *their* job, region, country, industry, tools and
languages. The phone uses that workspace to help them **make decisions with no internet**. After sync, Hermes analyses
their records, produces decision-focused reports, and the workspace **improves from verified outcomes**, never from
unchecked AI output.

Hermes stays the core: it interviews, researches, builds, analyses and improves. FieldKit stores, validates, runs offline
and keeps provenance.

Non-goals: replacing a qualified professional; image understanding on the phone (photos are read via OCR offline and
analysed by Hermes' vision model after sync); a free-form chatbot that answers questions outside the workspace.

## 1. What exists today (inspected)

| Area | Current state | Reused as |
|---|---|---|
| Workflows | JSON schema with fields, branching (JSON condition AST), validation, `classification` (rules, keywords, scores, `decision_trees`), multilingual labels; Python + TS engines share test vectors | Workspace workflows, unchanged format |
| Knowledge packs | Entries `explanation/procedure/faq/troubleshooting/term/reference`, versioned, SHA-256, update detection on the phone | Workspace knowledge, extended with provenance |
| Dictionary packs | en↔hi terms with synonyms; now also drive translation terminology | Workspace vocabulary |
| Offline assistant | MiniSearch BM25 over packs; one-shot answer or "not covered"; no conversation, no record context | Replaced by the grounded assistant (section 6); BM25 kept as fallback |
| Generation | `ctx.llm.complete_structured` → workflows and knowledge entries, then deterministic validation | Same pattern for workspace bundles |
| Analysis | Structured report (summary, issues, missing info, actions, follow-ups, review flag), photos via `fieldkit_vision`, voice transcripts, Evidence block | Extended to decision-focused report v2 (section 7) |
| Hermes facilities (v0.23.0 source) | `web_search` / `web_extract` (configurable backends with keyless rescue), browser tools, `delegate` sub-agents, `cronjob`, memory, skills, `ctx.register_system_prompt_section` (dynamic, per new session), hooks (`on_session_start`, `post_tool_call`…) | Research, onboarding prompt, scheduled improvement |

## 2. Architecture overview

```
              ┌──────────────────────────── Hermes (online) ─────────────────────────────┐
 user ⇄ chat  │ onboarding prompt section ─► interview (skill) ─► brief (tool, user confirms) │
              │ research: web_search/web_extract/browser/delegate ─► evidence records        │
              │ build: ctx.llm structured ─► workspace bundle ─► FieldKit validators ─► draft │
              │ user reviews research report + gaps ─► publish version N                      │
              │ analysis: record + workspace + evidence ─► decision report v2                 │
              │ improvement: learning events ─► candidates ─► approval ─► version N+1         │
              └───────────────▲─────────────────────────────────────────────┬───────────────┘
                     sync (records, files, feedback, gaps, outcomes)         │ download workspace vN
              ┌───────────────┴──────────────── Phone (offline) ────────────▼───────────────┐
              │ workflows + decision guides (deterministic engine)                            │
              │ grounded assistant: understanding → dialogue state → reasoning → cited answer │
              │ OCR / speech / translation feed the same pipeline; reports read offline       │
              │ feedback, outcomes, unanswered questions queued like records                  │
              └───────────────────────────────────────────────────────────────────────────────┘
```

## 3. Workspace model

A workspace is a versioned bundle (server tables `workspaces`, `workspace_versions`; served to the phone as one manifest
plus the packs it references, so existing pack download, SHA-256 and update detection are reused).

```
workspace {
  id, version, status: draft|published, owner, created_by: "hermes", changelog[]
  profile {
    role, responsibilities[] {id, description, frequency, decisions[]},
    industry, sector, organisation_type,
    country, region, locality?, climate_or_context?,
    tools_and_instruments[] {name, model?, units}, assets_or_subjects[] (e.g. pump models, crop varieties, grade levels),
    procedures_in_use[] {title, source: user_document|described|none},
    regulations_and_standards[] (named by the user or found in research),
    languages {interface, content[], speech[], ocr[]}, connectivity, escalation_contacts[] (roles, not personal data)
  }
  workflows[]            -- no fixed number: one per responsibility/decision that needs structured capture
  decision_guides[]      -- executable: condition AST over answers + questions to ask + outcomes (section 6.4)
  knowledge              -- pack(s) of entries, each with provenance
  vocabulary             -- dictionary pack(s), every content language
  report_policy {decision_scale[], review_triggers[], deadlines_by_severity, escalation_rules}
  sources[]              -- every source cited anywhere in the bundle
  gaps[]                 -- questions research could not answer authoritatively
  traceability           -- responsibility → workflows/fields/guides/knowledge that serve it
}
```

**Provenance on every guidance item** (knowledge entry, guide step, rule threshold, report-policy rule):

```
evidence { status: verified|supported|conflicting|user_procedure|unverified,
           sources[] {source_id, excerpt (verbatim, ≤500 chars), locator (page/section), retrieved_at},
           applicability {jurisdiction, industry, equipment_or_subject, matches_profile: bool, notes},
           conflicts[] {source_id, claim}, reviewed_by_user: bool }
source { id, url, title, publisher, type: regulator|standards_body|government|manufacturer|academic|extension_or_ngo|
         industry_body|trade_media|user_document, tier: 1|2|3, published_at?, retrieved_at, country/region scope }
```

Existing example workflows/packs become **starter workspaces** by wrapping them in a workspace manifest (additive; their
ids, versions and records are unchanged). Records keep `workflow_id/workflow_version` and gain an optional `workspace_id`.

## 4. Onboarding and requirement capture (Hermes)

1. `ctx.register_system_prompt_section("fieldkit.workspace", callable)`: per new session, if the user has no workspace
   it tells Hermes FieldKit is installed and to offer to build one; otherwise it summarises active workspaces and open
   gaps/candidates (bounded, ≤1.5k chars).
2. Skill `fieldkit-workspace-builder` drives the interview. It must establish, in the user's language:
   responsibilities and the decisions each requires; what they inspect/measure/observe; tools and instruments (with units);
   procedures they already follow (invite uploads: SOPs, checklists, manuals → `user_procedure` evidence, highest
   authority for *their* process); regulations/standards they know of; country/region/site context; languages for
   reading, speaking, OCR; escalation roles; connectivity pattern. Hermes asks follow-ups until each item is filled or
   explicitly "unknown".
3. Tool `fieldkit_save_workspace_brief` validates completeness (required: ≥1 responsibility with ≥1 decision, country,
   languages) and returns a **brief summary the user must confirm** before research starts. The brief is stored and
   versioned; later edits trigger a rebuild plan.

## 5. Research, validation and evidence

**Who does what:** Hermes researches (its own `web_search`, `web_extract`, browser, `delegate` for parallel topics).
FieldKit never trusts a claim's label: it **validates** the bundle deterministically.

Research plan (in the skill, per responsibility and decision): regulations/standards for the jurisdiction → official
procedures (government, regulator, standards body, manufacturer manuals for the user's actual instruments/assets) →
technical guidance (academic, extension services, NGOs) → local terminology in each content language.

**Source policy** (tiers, recorded per source):
- Tier 1: regulators, government agencies, standards bodies, manufacturers' manuals, user's own documents (for their procedures).
- Tier 2: peer-reviewed/academic, university extension, recognised NGOs and international bodies (WHO, FAO, ILO…).
- Tier 3: reputable industry bodies and trade publications.
- Excluded: forums, Q&A sites, unattributed blogs, SEO/AI-generated pages, paywalled abstracts without the claim.

**Evidence status rules** (computed by FieldKit from the recorded sources, not taken from the model):
- `verified`: ≥1 tier-1 source whose excerpt states the claim and whose scope matches the profile, or ≥2 independent tier-2 sources agreeing, with applicability true.
- `supported`: one tier-2/3 source, or tier-1 with partial applicability (e.g. national rule, regional site).
- `conflicting`: applicable sources disagree. Both claims are stored; guidance says sources differ, names them, and routes to the user's escalation role or the stricter rule for safety.
- `user_procedure`: from the user's documents; authoritative for their process, shown as "your procedure".
- `unverified`: model knowledge without a qualifying source. **Never used in decision guides, rule thresholds or
  next-action instructions.** May appear only as clearly labelled background ("not verified; check locally"), or not at all.

**Validators (FieldKit, server):** every guide step, threshold and knowledge entry has evidence; excerpts are non-empty and
come from a recorded source; source tier matches its type/domain heuristics (gov/edu/known bodies; mismatch → downgrade);
dates recorded; applicability filled; units consistent with the profile's instruments; decision guides are acyclic,
reachable, and every leaf has an outcome; all content present in every content language (or the item is flagged).
Optional (if the dashboard process can fetch): re-fetch a sample of URLs and confirm the excerpt appears (`excerpt_check`).

**Missing evidence:** recorded in `gaps[]` with what was searched; surfaced to the user in the research report
("No authoritative source found for X in Maharashtra; upload your SOP or ask your supervisor"); the related guide asks the
user/escalation instead of answering. **Research report** (shown before publishing): sources by tier, what is verified /
supported / conflicting / missing, applicability notes. The user publishes or asks for changes.

## 6. Offline assistant: genuine understanding without Hermes

Requirement: understand questions, follow-ups, photo text, voice, records and reports on the phone, without Hermes and
without keyword matching. Options evaluated (HF API, 2026-11-10, Transformers.js ONNX):

| Option | Size | Verdict |
|---|---|---|
| Multilingual sentence embeddings `Xenova/multilingual-e5-small` (q8) or `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (q8) | ~118 MB | **Use.** Meaning-level matching across English and Hindi (and paraphrases), fast on WASM, same runtime as today |
| Small generative LLM: `onnx-community/gemma-3-270m-it` q4 / `HuggingFaceTB/SmolLM2-360M-Instruct` q8 / `onnx-community/Qwen2.5-0.5B-Instruct` q4f16 | 323 / 365 / 483 MB | **Not the reasoning core.** Slow single-threaded on iPhone, weak Hindi (SmolLM English-only), Gemma licence terms, and free generation can invent safety steps. Optional later, only as a phraser of already-grounded answers, behind an evaluation gate |
| Multilingual NLI `Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7` (q8) | ~317 MB | Optional verifier (does an answer follow from its source?). Too heavy for the default install |

**Design: a grounded reasoning assistant.** Understanding comes from embeddings + dialogue state + structured reasoning
over the workspace; answers are composed only from workspace content, records and reports, always cited.

6.1 **Inputs.** Typed text; voice → on-device Whisper (en tiny / hi small) → text; photo → OCR → text (and entity linking:
a nameplate model number links to the asset in the profile); a record, report or issue opened in context ("Ask about
this"). Script detection picks the language; Hindi is understood directly by the multilingual model, not via translation.

6.2 **Understanding.**
- *Intent* by nearest-prototype classification over embeddings. Intents: explain_issue, what_next, why, is_it_safe,
  how_to (procedure), troubleshoot, define_term, compare_to_previous, check_requirement (standard/threshold),
  explain_report, translate, read_aloud, record_lookup, out_of_scope. Each intent has multilingual exemplars generated by
  Hermes at build time for *this* workspace (so "milk SNF low" and "दूध में SNF कम है" map the same). Below a confidence
  margin the assistant asks a clarifying question instead of guessing.
- *Entity linking* against the workspace vocabulary: fields, option labels, assets, instruments, terms, synonyms, issue
  titles, record subjects, in every content language (embedding + exact/fuzzy on normalised forms).
- *Dialogue state*: active record/report/issue, active topic entity, open guide and its filled slots, last answer.
  Follow-ups and references ("what about the seal?", "issue 2", "that one", "और इसके बाद?") resolve against this state.

6.3 **Retrieval.** Hybrid: embedding similarity + BM25, filtered by applicability (workspace, asset, jurisdiction) and
re-ranked by entity overlap and evidence status (verified > user_procedure > supported > conflicting; unverified excluded
from instructions). Embeddings for workspace content are computed on the phone at install time and cached; the query
embedding is computed per question.

6.4 **Reasoning: executable decision guides.** A guide is a graph: nodes ask a question (bound to a record field or a
direct question), conditions use FieldKit's existing condition AST, leaves give an outcome (decision on the workspace
scale, actions, escalation) with evidence. The assistant runs the guide: slots are filled from the open record's answers,
OCR text and transcripts, then from the user's replies. It never skips a node by guessing. This is deterministic,
auditable and works fully offline.

6.5 **Records and reports.** "Explain issue 2" joins report issue → cited record evidence (answers, photo OCR text,
voice transcript quotes) → linked guide/knowledge with sources. "What should I do first?" reads the report's ordered next
actions and their offline procedures. "Compare with last time" uses Saved Records for the same subject.

6.6 **Answer composition.** Typed templates per intent; content comes only from workspace items, records and reports,
pre-authored by Hermes in each content language (on-device machine translation is a fallback for user text only). Every
answer shows: the source and evidence status, uncertainty ("sources differ", "not verified locally", "depends on X — tell
me X"), and the escalation route for safety-critical outcomes. Read aloud and translate are one tap.

6.7 **Out of scope.** If nothing passes the support threshold, the assistant says so, offers the nearest guides, and logs a
**knowledge gap** (question, language, context, timestamp) to sync later. No invented answers.

6.8 **Fallback.** Without the embedding pack, the current BM25 assistant plus dictionary synonym expansion runs, labelled
"basic search"; guides still work (they are deterministic).

## 7. Decision-focused reports (report v2)

Schema additions (validated server-side; v1 reports keep rendering):

```
decision { outcome: one of report_policy.decision_scale (e.g. stop_and_tag_out | repair_within_days | continue_and_monitor),
           rationale, confidence: high|medium|low, deadline?, escalate_to? }
issues[] { title, severity, evidence[] {kind: answer|photo|photo_text|voice_quote|measurement|local_finding|previous_record,
           ref, quote}, interpretation, guidance_refs[] {item_id, evidence_status} }
next_actions[] { order, action, who (role), by_when, offline_guide_id?, verify_by (observable check), origin: guide|ai_suggestion }
uncertainty[] { unknown, impact, how_to_resolve }
differences_from_local_findings[] { local, hermes, why }
follow_up_verification { checks[] {what, how, due}, next_inspection_prefill }
```

Validator rules: each issue cites ≥1 record evidence item (no restating without evidence: an issue that only repeats an
answer must add interpretation or it is rejected); each action is `guide` (linked, evidence ≥ supported) or explicitly
`ai_suggestion`; confidence must be ≤ medium when evidence is conflicting or a decisive field is missing; safety outcomes
include escalation.

**Review calibration** (also the immediate fix you asked for): `requires_review` is true only if a review trigger in the
report policy fires: severity high/critical, confidence low, conflicting evidence, or a policy rule (e.g. medical, legal).
Not "anything safety-related". Measured target on the regression set: well-evidenced routine inspections are not flagged.

**On the phone:** decision first, then actions with "how to do this offline" (opens the guide), then evidence, uncertainty,
follow-up checks. Generated in every content language by Hermes (no reliance on the weak on-device MT); "Ask about this
report" opens the assistant with the report in context.

**Follow-up verification:** follow-ups carry `verify_by`. The next inspection of the same subject pre-asks those checks;
the answers become **verified outcomes** (section 8).

## 8. Learning system: suggestions vs feedback vs verified outcomes

Every input is an event with provenance (`learning_events`, synced like records):

| Kind | Source | Can it change guidance? |
|---|---|---|
| `ai_suggestion` | report actions, research proposals | Never on its own |
| `user_feedback` | "Did this help? yes/no", corrections, free text on an answer/report/guide | Can flag or reorder; cannot certify |
| `verified_outcome` | follow-up check answered with evidence (measurement, photo, signature) on a later inspection | Yes, after thresholds |
| `knowledge_gap` | unanswered offline question | Triggers research |
| `user_procedure` | uploaded/declared SOP change | Yes, as "your procedure", with user confirmation |

**Improvement cycle** (Hermes, on request or via a scheduled cron job): gather events per workspace → cluster gaps and
issues → research gaps (section 5 rules) → propose **candidates** (add/modify/retire an item) each with its evidence:
research sources, and/or outcome statistics ("action A resolved leak type L in 7 of 8 verified follow-ups, n=8"). Promotion
rules: research-backed candidates need evidence ≥ supported; outcome-backed "local practice" needs ≥ a configured count of
consistent verified outcomes and is labelled as learned from the team's outcomes, not as a standard; feedback alone
never promotes. A human (the user or their admin) approves → new workspace version with changelog → phones see an
update. Rejected candidates are kept so they are not re-proposed.

## 9. Preservation, migration and compatibility

- DB migration v4, additive only: `workspaces`, `workspace_versions`, `sources`, `evidence`, `learning_events`,
  `knowledge_gaps`, `candidates`; `records.workspace_id` nullable. No existing row is modified or deleted.
- Existing workflows, packs, records, reports, attachments and APIs keep working; 0.2.4 phones keep syncing.
- Report v1 still renders; v2 is additive. Existing tools keep their names and behaviour; new tools are added.
- Offline assistant falls back to today's behaviour without the new pack.

**Languages (decision needed):** a workspace can ask for any content language. Hermes can write content in it, but the
phone's speech, OCR and offline translation exist only for English and Hindi today, and adding languages needs your
approval (standing rule). Proposal: content languages are unrestricted; device features beyond en/hi stay off until you
approve each language, and the workspace says which features are available.

## 10. New and changed interfaces

Hermes tools (new): `fieldkit_save_workspace_brief`, `fieldkit_record_sources` (sources + excerpts),
`fieldkit_build_workspace` (bundle → validation report → draft), `fieldkit_get_workspace`, `fieldkit_list_workspaces`,
`fieldkit_publish_workspace`, `fieldkit_list_learning_events`, `fieldkit_propose_workspace_changes`,
`fieldkit_review_candidates`. Changed: `fieldkit_analyze_record` / worker (report v2 + workspace context),
`fieldkit_create_followup` (`verify_by`).
Skill: `fieldkit-workspace-builder` (interview, research plan, source policy, build, review, publish, improve).
API: `GET /workspaces`, `GET /workspaces/{id}/versions/{v}` (manifest), `POST /learning/events` (batch, idempotent),
`GET /workspaces/{id}/gaps`. PWA: workspace home, guide runner, assistant chat (state, intents, guides, citations),
report v2 view, feedback and follow-up verification capture, embedding model pack.

## 11. Implementation phases

| Phase | Content | Estimate |
|---|---|---|
| A | Immediate fixes: example rules (rust, leak, corrosion raise risk); review calibration with report-policy triggers | 0.5 day |
| B | Workspace model, migration v4, validators, evidence computation, starter-workspace wrapping, API | 1 day |
| C | Hermes side: onboarding prompt section, skill, brief/sources/build/publish tools, research report | 1 day |
| D | Report v2 schema, validator, analysis prompt, phone + dashboard views, follow-up `verify_by` | 1 day |
| E | Offline assistant: embedding pack, intents, entity linking, dialogue state, guide runner, record/report reasoning, citations, gap logging | 2 days |
| F | Learning: events sync, outcomes from follow-ups, candidates, promotion rules, approval, versioned updates | 1 day |
| G | Evaluation sets, E2E, docs, real-device check by owner | 0.5–1 day |

Total ≈ 7–8 focused days. **This does not fit before the reported deadline (2026-11-11, 5 PM ET).** Sequencing options
for you to choose (no capability is removed, only ordered): (1) build in order A→B→C→D→E→F and submit what is complete,
labelled honestly; or (2) confirm the official deadline/extension and build the full plan.

## 12. Acceptance tests

Workspace generation (pytest with stub LLM + recorded research fixtures; E2E with the owner on hosted Hermes):
1. A new user with no workspace: the first Hermes session's system prompt contains the FieldKit onboarding section; with a
   workspace it contains the summary instead.
2. Brief validation rejects missing responsibilities/decisions/country/languages; research cannot start before the user confirms.
3. Three dissimilar profiles (dairy collection QA in Maharashtra, India; school classroom observation in Nairobi, Kenya;
   pump maintenance in Texas, USA) produce workspaces whose workflows trace to every stated responsibility, use the stated
   instruments' units, and have no fixed workflow count.
4. A guide step or threshold with only model knowledge is rejected or labelled `unverified` and excluded from guides/actions.
5. Tier computation: a forum source is excluded; a .gov regulator is tier 1; mismatched jurisdiction downgrades to `supported`.
6. Conflicting sources produce `conflicting` status, both claims stored, guidance routes to escalation/stricter rule.
7. Missing evidence appears in `gaps[]` and the research report; publishing still works with gaps shown.
8. Every content item exists in every content language or is flagged.
9. Existing examples load as starter workspaces; existing records, reports and phones are unaffected (all current tests pass).

Offline assistant (vitest + Playwright offline, airplane mode; regression set authored per starter workspace, en + hi):
10. Paraphrase understanding: ≥90% top-1 intent and ≥85% correct entry on a held-out paraphrase set (no shared keywords
    with the entry) in English and Hindi; keyword baseline reported alongside.
11. Follow-ups: ≥90% of two- and three-turn dialogues resolve references ("what about the seal", "issue 2", Hindi equivalents).
12. Guide execution: for every guide, every path reachable; slots filled from the open record; asks only for missing facts;
    outcome matches the guide's expected leaf on 100% of scripted paths.
13. Photo text and voice: an OCR'd nameplate and a transcribed voice question reach the same answer as the typed question.
14. Record/report reasoning: "explain issue N" cites the record evidence and the guide source; "what first" returns the report's first action and its offline guide.
15. Out-of-scope: unrelated questions return "not covered" with ≥95% precision and log a gap; zero invented steps
    (every sentence in an instruction answer is traceable to a workspace item).
16. Works with the network blocked (no request leaves the device) and after a cold restart; falls back to basic search without the embedding pack.

Reports (pytest with stub LLM + golden records):
17. v2 validator rejects issues without record evidence, actions without guide link or `ai_suggestion` label, high confidence with conflicting evidence.
18. Review calibration: on the golden set, routine well-evidenced records are not flagged; high/critical or low-confidence ones are.
19. Every next action has `verify_by`; the next inspection of the same subject pre-asks those checks.
20. The phone shows decision → actions → evidence → uncertainty → follow-up, in both content languages, offline.

Learning (pytest):
21. An `ai_suggestion` alone never creates a candidate that can be published; feedback alone never certifies.
22. N consistent verified outcomes create a "local practice" candidate labelled with n; below N they do not.
23. Gaps synced from the phone lead to research candidates with sources; approval publishes version N+1 with a changelog; the phone shows "Update available"; rejected candidates are not re-proposed.

Non-regression: all existing pytest, vitest and Playwright suites (Chromium + WebKit) pass; `hermes plugins validate`
and `doctor --ci` pass; owner re-checks on iPhone + Hermes mobile app.

## 13. Risks and open decisions

- **Deadline** (section 11): choose the sequencing.
- **Web search on the hosted Hermes** must work (`web_search`); otherwise research is limited to user documents and is labelled.
- **Content languages beyond en/hi** need your approval for device features (section 9).
- **Licences:** confirm the embedding model licence (multilingual-e5-small upstream is MIT; paraphrase-multilingual-MiniLM is Apache-2.0) before pinning.
- **iPhone memory:** embedding model (118 MB) + Whisper small (249 MB) + OCR at once; models are loaded on demand and released; to be measured on device.
- **Safety:** decision outcomes are decision support, never a substitute for the user's escalation; review triggers stay conservative for medical/legal policies.
