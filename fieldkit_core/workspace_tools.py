"""Hermes tools for building FieldKit workspaces (plan section 4-5). Used by the fieldkit-workspace-builder skill.

Flow: interview → fieldkit_save_workspace_brief (user confirms the summary) → research with Hermes' own web_search /
web_extract (quote exact source text) → fieldkit_build_workspace (validated, evidence computed, excerpts checked) →
show the research report → fieldkit_publish_workspace only with the user's approval.
"""
from __future__ import annotations

import json
from typing import Any

from . import workspace as ws
from .db import ALL, Invalid, get_store

FORMAT = {
    "overview": "A workspace bundle is JSON. FieldKit validates it and COMPUTES each evidence status from your sources; "
                "labels you assign are ignored. Unverified model knowledge cannot become an instruction.",
    "top_level": {
        "id": "lowercase slug, e.g. dairy-collection-mh",
        "title": {"en": "...", "hi": "..."},
        "profile": "the confirmed brief: role, industry, country, region, responsibilities[{id, description, frequency, decisions[]}], "
                   "tools_and_instruments[{name, model?, units[]}], procedures_in_use[{title, source}], escalation[]",
        "languages": {"content": ["en", "hi"], "speech": ["en", "hi"], "ocr": ["en", "hi"]},
        "workflows": "FieldKit workflow definitions (same schema as fieldkit_create_workflow). As many as the responsibilities "
                     "need; each classification rule may cite evidence_ids.",
        "workflow_refs": "ids of existing workflows to include (optional)",
        "sources": "[{id, url, title, publisher, type, published_at?, retrieved_at}]; type is one of " + ", ".join(ws.SOURCE_TYPES),
        "evidence": "[{id, claim, excerpts[{source_id, quote (verbatim, ≥20 chars), locator (page/section/table)}], "
                    "applicability{jurisdiction, industry, subject, matches_profile: bool, notes}, conflicts[{source_id, claim}]?, "
                    "user_procedure?: bool}]",
        "knowledge": "{entries[{id, type: explanation|procedure|faq|troubleshooting|term|reference, title{lang}, text{lang}, "
                     "evidence_ids[]}]} — procedure/troubleshooting entries need evidence that is at least 'supported'",
        "vocabulary": "{entries[{term, lang, definition, translations{lang: term}, synonyms[]}]}",
        "report_policy": "{decision_scale[{id, label{lang}, severity}], review_triggers[], escalation_rules[]}",
        "guides": "[{id, title{lang}, workflow_id?, start, nodes{node_id: question node {slot, field? (read from the record) "
                  "or question{lang}, input: yes_no|choice|number|text, options?, next[{when: condition AST, to}], default?} "
                  "or outcome node {outcome{decision (from decision_scale), title{lang}, actions[{text{lang}, evidence_ids[], "
                  "kind?: 'escalate'}], escalate_to?}}}}]",
        "intents": "optional [{id, examples{lang: [questions users would ask]}}] for the phone's offline assistant",
        "gaps": "[{topic, searched[], note}] — everything you could not find authoritative evidence for",
        "traceability": "[{responsibility_id, workflow_ids[], guide_ids[], entry_ids[]}] — every responsibility must be served",
    },
    "evidence_rules": {
        "verified": "a tier-1 source (regulator/government on an official domain, standards body, manufacturer, the user's "
                    "own document) quoted and applicable to the profile, or two independent tier-2 publishers",
        "supported": "one tier-2/3 source, or a tier-1 source that does not fully apply",
        "conflicting": "applicable sources disagree (record both); actions must name escalate_to",
        "user_procedure": "from the user's documents (source type user_document); authoritative for their own process",
        "unverified": "no qualifying quoted source. May only be labelled background; never an instruction or threshold",
        "excluded_sources": "forums, Q&A, social media, unattributed blogs: they support nothing",
        "quotes": "copy the exact sentence(s) from the page or document you opened with web_extract; FieldKit fetches web "
                  "pages and drops quotes it cannot find (PDFs are not checked automatically: quote carefully)",
    },
}


def _ok(**d: Any) -> str:
    return json.dumps({"ok": True, **d}, ensure_ascii=False, default=str)


def _fail(msg: str, **d: Any) -> str:
    return json.dumps({"ok": False, "error": msg, **d}, ensure_ascii=False, default=str)


def workspace_format(a: dict) -> str:
    return _ok(format=FORMAT)


def save_brief(a: dict) -> str:
    brief = a.get("brief")
    v = ws.validate_brief(brief)
    if a.get("confirmed") and not v["ok"]:
        return _fail("the brief is incomplete, so it cannot be confirmed", missing=v["missing"], summary=v["summary"])
    saved = get_store().save_workspace_brief(ALL, brief if isinstance(brief, dict) else {}, a.get("brief_id"),
                                             confirmed=bool(a.get("confirmed")) and v["ok"])
    nxt = ("Research next: follow the skill's research plan." if saved["confirmed"] else
           "Show this summary to the user in their language and ask them to confirm or correct it; then call again with "
           "confirmed=true." if v["ok"] else "Ask the user about the missing items, then save again.")
    return _ok(brief_id=saved["brief_id"], confirmed=saved["confirmed"], missing=v["missing"], summary=v["summary"], next=nxt)


def build(a: dict) -> str:
    store = get_store()
    bid = a.get("brief_id")
    if not bid:
        return _fail("brief_id required: interview the user and confirm the brief first (fieldkit_save_workspace_brief)")
    brief = store.get_workspace_brief(ALL, bid)
    if not brief["confirmed"]:
        return _fail("the brief is not confirmed by the user yet; research and building start after confirmation")
    bundle = a.get("bundle")
    if not isinstance(bundle, dict):
        return _fail("bundle must be an object; call fieldkit_workspace_format for the structure")
    bundle.setdefault("profile", brief["brief"])
    checks = ws.check_excerpts(bundle) if a.get("check_excerpts", True) else {"skipped": True}
    d = ws.build_draft(store, ALL, bundle, brief_id=bid, changelog=a.get("changelog"))
    rr = d["research_report"]
    compact = {
        "summary": rr["summary"], "excerpt_check": checks,
        "conflicting": rr["evidence"]["conflicting"], "unverified": [e["claim"] for e in rr["evidence"]["unverified"]][:20],
        "excluded_sources": [s for s in rr["sources"] if s["tier"] == 0],
        "downgraded_sources": [s for s in rr["sources"] if s["notes"]], "gaps": rr["gaps"],
    }
    return _ok(workspace_id=d["workspace_id"], version=d["version"], valid=d["ok"], errors=d["validation"]["errors"][:30],
               warnings=d["validation"]["warnings"][:30], research_report=compact,
               next=("Show the research report to the user (verified / supported / conflicting / gaps, and which sources were "
                     "excluded). Publish only after they approve." if d["ok"] else
                     "Fix the errors (usually: find and quote a qualifying source, or remove the unsupported instruction) and build again."))


def publish(a: dict) -> str:
    if not a.get("user_approved"):
        return _fail("publish only after the user has seen the research report and approved it (user_approved=true)")
    from .tools import app_link
    out = ws.publish(get_store(), a["workspace_id"], a.get("version"), actor=ALL)
    link = app_link()
    link["url"] = link["url"] + f"#/workspace/{a['workspace_id']}"
    return _ok(**out, app_link=link, next="Give the user the app link; on the phone, open it and tap 'Download everything for offline'.")


def get(a: dict) -> str:
    rec = get_store().get_workspace_version(a["workspace_id"], a.get("version"))
    out = {k: rec[k] for k in ("workspace_id", "version", "status", "published_version", "latest_version", "starter", "changelog")}
    out["summary"] = rec["validation"].get("summary")
    out["errors"] = rec["validation"].get("errors", [])[:20]
    out["research_report"] = ws.research_report(rec["bundle"], ws.validate_bundle(rec["bundle"]))
    if a.get("include_bundle"):
        out["bundle"] = rec["bundle"]
    return _ok(**out)


def list_all(a: dict) -> str:
    return _ok(workspaces=get_store().list_workspaces(published_only=not a.get("include_drafts")))


def _s(name: str, description: str, props: dict, required: list | None = None) -> dict:
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": props, "required": required or []}}


OBJ, STR, INT, BOOL = {"type": "object"}, {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
TOOLS = [
    (_s("fieldkit_workspace_format", "The structure of a FieldKit workspace bundle and the evidence rules FieldKit enforces. "
        "Read before building a workspace.", {}), workspace_format),
    (_s("fieldkit_save_workspace_brief", "Save the interview result describing the user's actual job (role, industry, country, "
        "region, responsibilities with the decisions each needs, tools and instruments, procedures already used, languages, "
        "escalation roles). Returns what is missing and a summary to confirm with the user. Set confirmed=true only after the "
        "user confirmed the summary.", {"brief": OBJ, "brief_id": STR, "confirmed": BOOL}, ["brief"]), save_brief),
    (_s("fieldkit_build_workspace", "Validate and store a draft workspace built from your research for a confirmed brief. "
        "FieldKit checks quotes against the source pages, computes evidence status, and returns a research report and any "
        "errors to fix.", {"brief_id": STR, "bundle": OBJ, "check_excerpts": BOOL, "changelog": {"type": "array", "items": STR}},
        ["brief_id", "bundle"]), build),
    (_s("fieldkit_publish_workspace", "Publish a valid workspace draft so the user's phone can download it for offline use. "
        "Requires user_approved=true after the user reviewed the research report.",
        {"workspace_id": STR, "version": INT, "user_approved": BOOL}, ["workspace_id", "user_approved"]), publish),
    (_s("fieldkit_get_workspace", "Get a FieldKit workspace version with its research report (sources, evidence status, "
        "conflicts, gaps).", {"workspace_id": STR, "version": INT, "include_bundle": BOOL}, ["workspace_id"]), get),
    (_s("fieldkit_list_workspaces", "List FieldKit workspaces (published; include_drafts for drafts too).",
        {"include_drafts": BOOL}), list_all),
]
