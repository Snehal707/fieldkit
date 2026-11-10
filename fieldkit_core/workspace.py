"""Workspaces: a user's job turned into an offline kit (plan: docs/plans/workspace-builder.md, sections 3 and 5).

A workspace bundle is built by Hermes (interview → research → structured output) and submitted through a tool.
FieldKit never trusts the labels in it: this module validates the bundle and *computes* every evidence status
from the recorded sources, excerpts and applicability. Unsupported model knowledge can never drive a decision guide,
a rule threshold or a next action.

Publishing turns a valid bundle into things FieldKit already knows how to sync and run offline:
  - each workflow → a normal published workflow (so records, analysis and the phone work unchanged);
  - knowledge entries → a knowledge pack ``ws-<id>-knowledge`` (entries carry their evidence status);
  - vocabulary → a dictionary pack ``ws-<id>-dictionary``;
  - everything else (profile, decision guides, report policy, sources, evidence, gaps, traceability) → a
    ``workspace`` pack ``ws-<id>``, which the phone downloads with the same SHA-256 check as every pack.
"""
from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import urlparse

from . import engine

SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{1,47}$")
STATUSES = ("verified", "user_procedure", "supported", "local_practice", "conflicting", "unverified")
STATUS_RANK = {"verified": 4, "user_procedure": 4, "supported": 3, "local_practice": 3, "conflicting": 2, "unverified": 1}
MIN_PRACTICE_OUTCOMES = 3   # a "local practice" needs this many verified follow-up outcomes, ≥80% successful
SOURCE_TYPES = {
    "regulator": 1, "government": 1, "standards_body": 1, "manufacturer": 1, "user_document": 1, "user_statement": 1,
    "academic": 2, "extension_or_ngo": 2, "international_body": 2,
    "industry_body": 3, "trade_media": 3, "reference_work": 3,
    "forum": 0, "blog": 0, "social": 0, "other": 0,
}
# Pages that may never support guidance (user-generated or unattributed). Domain suffix match.
EXCLUDED_DOMAINS = ("reddit.com", "quora.com", "medium.com", "facebook.com", "youtube.com", "x.com", "twitter.com",
                    "pinterest.com", "stackexchange.com", "stackoverflow.com", "tiktok.com", "instagram.com",
                    "answers.com", "brainly.in", "scribd.com", "slideshare.net")
# Government / intergovernmental domains (a "government"/"regulator" claim on another domain is downgraded).
OFFICIAL_SUFFIXES = (".gov", ".gov.in", ".nic.in", ".gov.uk", ".gc.ca", ".gov.au", ".govt.nz", ".go.ke", ".gov.za",
                     ".gov.ng", ".go.jp", ".gouv.fr", ".europa.eu", ".gob.mx", ".gov.br", ".gov.bd", ".gov.pk",
                     ".gov.ph", ".go.id", ".gov.sg", ".who.int", ".fao.org", ".ilo.org", ".un.org", ".int")
GUIDANCE_ENTRY_TYPES = ("procedure", "troubleshooting")   # instructions: need evidence ≥ supported
MIN_EXCERPT = 20
MIN_USER_EXCERPT = 3       # the user's own words ("reject below 8.3 SNF") are short and are not checked against a page
# The user's own process: their documents, or rules they stated (or approved) in the conversation. Authoritative for
# their own procedure only; never presented as an external standard.
USER_SOURCE_TYPES = ("user_document", "user_statement")


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def _suffix_match(host: str, suffixes: tuple) -> bool:
    return any(host == s.lstrip(".") or host.endswith(s if s.startswith(".") else "." + s) for s in suffixes)


def source_tier(src: dict) -> tuple[int, list[str]]:
    """Tier 1-3 (0 = excluded) from the declared type, checked against the domain. Returns (tier, notes)."""
    notes: list[str] = []
    stype = src.get("type", "other")
    tier = SOURCE_TYPES.get(stype, 0)
    host = _host(src.get("url", ""))
    if stype in USER_SOURCE_TYPES:
        return 1, notes
    if not host:
        return 0, ["no usable URL"]
    if _suffix_match(host, EXCLUDED_DOMAINS):
        return 0, [f"{host} is user-generated or unattributed content"]
    if stype in ("regulator", "government") and not _suffix_match(host, OFFICIAL_SUFFIXES):
        notes.append(f"declared {stype} but {host} is not an official government domain: treated as tier 2")
        tier = 2
    if stype == "international_body" and _suffix_match(host, OFFICIAL_SUFFIXES):
        tier = 1
    return tier, notes


def text_langs(v: Any) -> set[str]:
    return {k for k, x in v.items() if isinstance(x, str) and x.strip()} if isinstance(v, dict) else ({"*"} if isinstance(v, str) and v.strip() else set())


def evidence_status(ev: dict, sources: dict[str, dict]) -> tuple[str, list[str]]:
    """Compute verified / user_procedure / supported / conflicting / unverified from the recorded evidence."""
    notes: list[str] = []
    def _min(x: dict) -> int:
        return MIN_USER_EXCERPT if (sources.get(x.get("source_id")) or {}).get("type") in USER_SOURCE_TYPES else MIN_EXCERPT
    excerpts = [x for x in ev.get("excerpts", []) if isinstance(x, dict) and len(str(x.get("quote", "")).strip()) >= _min(x)
                and x.get("source_id") in sources and x.get("check") != "not_found"]
    dropped = len(ev.get("excerpts", [])) - len(excerpts)
    if dropped:
        notes.append(f"{dropped} excerpt(s) ignored: empty, too short, citing an unrecorded source, or not found on the page")
    tiers = {}
    for x in excerpts:
        t, _ = source_tier(sources[x["source_id"]])
        if t:
            tiers[x["source_id"]] = t
    user_cited = any(sources[x["source_id"]].get("type") in USER_SOURCE_TYPES for x in excerpts)
    if ev.get("local_practice"):
        o = ev.get("outcomes") or {}
        n, done = int(o.get("n") or 0), int(o.get("done") or 0)
        if n >= MIN_PRACTICE_OUTCOMES and done / max(1, n) >= 0.8 and len(o.get("records") or []) >= n:
            return "local_practice", notes + [f"learned from {done} of {n} verified follow-up outcomes (not a standard)"]
        notes.append("local practice without enough verified outcomes")
        return "unverified", notes
    external = {s: t for s, t in tiers.items() if sources[s].get("type") not in USER_SOURCE_TYPES}
    if user_cited and not external:
        return "user_procedure", notes          # the user's own rule (document or stated/approved in the interview)
    if ev.get("user_procedure") and not user_cited:
        notes.append("marked as the user's procedure but cites no user document or statement")
    if ev.get("conflicts"):
        if any(isinstance(c, dict) and c.get("source_id") in sources for c in ev["conflicts"]):
            return "conflicting", notes
        notes.append("conflicts listed without a recorded source were ignored")
    applicable = bool((ev.get("applicability") or {}).get("matches_profile"))
    t1 = [s for s, t in tiers.items() if t == 1]
    t2_publishers = {(sources[s].get("publisher") or _host(sources[s].get("url", ""))).lower() for s, t in tiers.items() if t == 2}
    if applicable and (t1 or len(t2_publishers) >= 2):
        return "verified", notes
    if tiers:
        if not applicable:
            notes.append("source does not (fully) apply to this profile")
        return "supported", notes
    return "unverified", notes + ["no qualifying source"]


# ----------------------------------------------------------------------------- decision guides
def _ast_fields(cond: Any) -> set[str]:
    if not isinstance(cond, dict):
        return set()
    out = {cond["field"]} if isinstance(cond.get("field"), str) else set()
    for k in ("all", "any"):
        for c in cond.get(k, []) or []:
            out |= _ast_fields(c)
    if "cond" in cond:
        out |= _ast_fields(cond["cond"])
    return out


def validate_guide(g: dict, workflows: dict[str, dict], decisions: set[str], statuses: dict[str, str],
                   languages: list[str]) -> tuple[list[str], list[str]]:
    """A guide is an executable graph: question nodes (a slot filled from a record field or asked directly) with
    conditional edges, and outcome leaves. Checks: start exists, every node reachable, no cycles, every leaf has an
    outcome, conditions only use known slots/fields, outcome decisions exist in the report policy, and every outcome
    action is backed by evidence that is at least 'supported' (or is an escalation)."""
    errs, warns = [], []
    gid = g.get("id", "?")
    nodes = g.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        return [f"guide {gid}: needs nodes"], warns
    start = g.get("start")
    if start not in nodes:
        errs.append(f"guide {gid}: start node '{start}' does not exist")
        return errs, warns
    wf = workflows.get(g.get("workflow_id") or "")
    wf_fields = {f["id"] for f in (wf or {}).get("fields", [])}
    slots = {n.get("slot") for n in nodes.values() if isinstance(n, dict) and n.get("slot")}
    known = slots | wf_fields
    for nid, n in nodes.items():
        if not isinstance(n, dict):
            errs.append(f"guide {gid}: node {nid} must be an object")
            continue
        has_out = isinstance(n.get("outcome"), dict)
        edges = n.get("next") or []
        if has_out and (edges or n.get("default")):
            errs.append(f"guide {gid}: node {nid} has an outcome and further steps")
        if not has_out:
            if not n.get("slot"):
                errs.append(f"guide {gid}: question node {nid} needs a slot")
            if n.get("field") and n["field"] not in wf_fields:
                errs.append(f"guide {gid}: node {nid} reads unknown workflow field '{n['field']}'")
            if not n.get("field") and not text_langs(n.get("question")):
                errs.append(f"guide {gid}: node {nid} needs a question or a workflow field")
            if not edges and not n.get("default"):
                errs.append(f"guide {gid}: node {nid} is a dead end (no outcome and no next step)")
            for e in edges:
                if not isinstance(e, dict) or e.get("to") not in nodes:
                    errs.append(f"guide {gid}: node {nid} has an edge to an unknown node")
                    continue
                unknown = _ast_fields(e.get("when")) - known
                if unknown:
                    errs.append(f"guide {gid}: node {nid} condition uses unknown slot/field {sorted(unknown)}")
            if n.get("default") and n["default"] not in nodes:
                errs.append(f"guide {gid}: node {nid} default goes to unknown node")
            if n.get("question") and languages:
                missing = [lg for lg in languages if lg not in text_langs(n["question"]) and "*" not in text_langs(n["question"])]
                if missing:
                    warns.append(f"guide {gid}: node {nid} question missing languages {missing}")
        else:
            o = n["outcome"]
            if decisions and o.get("decision") not in decisions:
                errs.append(f"guide {gid}: node {nid} outcome decision '{o.get('decision')}' is not in the report policy's decision scale")
            for i, a in enumerate(o.get("actions") or []):
                ids = a.get("evidence_ids") or o.get("evidence_ids") or g.get("evidence_ids") or []
                best = max((STATUS_RANK.get(statuses.get(x, "unverified"), 1) for x in ids), default=0)
                if a.get("kind") == "escalate":
                    continue                     # "ask your supervisor" needs no external evidence
                conflicting = any(statuses.get(x) == "conflicting" for x in ids)
                if conflicting and not o.get("escalate_to"):
                    errs.append(f"guide {gid}: node {nid} action {i + 1} rests on conflicting evidence and must name an escalation")
                elif not conflicting and best < STATUS_RANK["supported"]:
                    errs.append(f"guide {gid}: node {nid} action {i + 1} has no supporting evidence (only unverified or none); "
                                f"unverified model knowledge cannot be an instruction")
    # Reachability and cycles.
    seen, stack, order = set(), [start], []
    while stack:
        cur = stack.pop()
        if cur in seen or cur not in nodes:
            continue
        seen.add(cur)
        order.append(cur)
        n = nodes[cur] if isinstance(nodes[cur], dict) else {}
        stack += [e.get("to") for e in (n.get("next") or []) if isinstance(e, dict)] + ([n["default"]] if n.get("default") else [])
    for nid in nodes:
        if nid not in seen:
            errs.append(f"guide {gid}: node {nid} is unreachable")
    state: dict[str, int] = {}

    def dfs(u: str) -> bool:
        state[u] = 1
        n = nodes.get(u) if isinstance(nodes.get(u), dict) else {}
        for v in [e.get("to") for e in (n.get("next") or []) if isinstance(e, dict)] + ([n["default"]] if n.get("default") else []):
            if v not in nodes:
                continue
            if state.get(v) == 1 or (state.get(v) is None and dfs(v)):
                return True
        state[u] = 2
        return False
    if dfs(start):
        errs.append(f"guide {gid}: contains a cycle")
    return errs, warns


# ----------------------------------------------------------------------------- bundle validation
def validate_bundle(b: Any, existing_workflow_ids: Optional[Any] = None) -> dict:
    """Validate a workspace bundle and compute evidence statuses. Returns
    {ok, errors[], warnings[], statuses{evidence_id: status}, evidence_notes{}, tiers{source_id: tier}, summary{}}."""
    errs: list[str] = []
    warns: list[str] = []
    if not isinstance(b, dict):
        return {"ok": False, "errors": ["bundle must be an object"], "warnings": [], "statuses": {}, "summary": {}}
    wid = b.get("id")
    if not isinstance(wid, str) or not SLUG.match(wid):
        errs.append("id must be a lowercase slug (2-48 chars)")
    if not text_langs(b.get("title")):
        errs.append("title required")
    profile = b.get("profile") or {}
    resp = profile.get("responsibilities") or []
    if not resp or not all(isinstance(r, dict) and r.get("id") and r.get("description") for r in resp):
        errs.append("profile.responsibilities: at least one use of the workspace, each with id and description")
    uses_decisions = any((r.get("decisions") or []) for r in resp if isinstance(r, dict)) or bool(b.get("guides"))
    langs = (b.get("languages") or {}).get("content") or []
    if not langs or not all(isinstance(x, str) and re.match(r"^[a-z]{2,3}$", x) for x in langs):
        errs.append("languages.content: list of language codes required")
    elif any(x not in ("en", "hi") for x in langs):
        warns.append(f"languages {[x for x in langs if x not in ('en', 'hi')]}: the phone app supports English and Hindi only")

    # Sources and evidence.
    sources = {s["id"]: s for s in b.get("sources") or [] if isinstance(s, dict) and s.get("id")}
    tiers, tier_notes = {}, {}
    for sid, s in sources.items():
        tiers[sid], n = source_tier(s)
        if n:
            tier_notes[sid] = n
        if not s.get("retrieved_at"):
            warns.append(f"source {sid}: retrieved_at missing")
    statuses, ev_notes = {}, {}
    for ev in b.get("evidence") or []:
        if not isinstance(ev, dict) or not ev.get("id") or not ev.get("claim"):
            errs.append("evidence items need id and claim")
            continue
        statuses[ev["id"]], ev_notes[ev["id"]] = evidence_status(ev, sources)

    # Workflows.
    workflows: dict[str, dict] = {}
    for i, w in enumerate(b.get("workflows") or []):
        problems = engine.validate_definition(w) if isinstance(w, dict) else [{"path": "", "message": "must be an object"}]
        if problems:
            errs += [f"workflows[{i}] ({w.get('id', '?') if isinstance(w, dict) else '?'}): {p['path']} {p['message']}" for p in problems[:10]]
        else:
            workflows[w["id"]] = w
            for r in w.get("classification", {}).get("rules", []):
                ids = r.get("evidence_ids") or []
                if ids and max(STATUS_RANK.get(statuses.get(x, "unverified"), 1) for x in ids) < STATUS_RANK["supported"]:
                    errs.append(f"workflow {w['id']}: rule {r.get('id')} threshold rests only on unverified evidence")
                if not ids and r.get("severity") in ("high", "critical"):
                    warns.append(f"workflow {w['id']}: high/critical rule {r.get('id')} cites no evidence")
    for ref in b.get("workflow_refs") or []:
        if existing_workflow_ids is not None and ref not in existing_workflow_ids:
            errs.append(f"workflow_refs: unknown workflow {ref}")
    if not workflows and not b.get("workflow_refs"):
        errs.append("a workspace needs at least one workflow")

    # Knowledge entries: instructions must be supported; background may be unverified but is flagged.
    for i, e in enumerate((b.get("knowledge") or {}).get("entries") or []):
        if not isinstance(e, dict) or not e.get("id") or not text_langs(e.get("title")) or not text_langs(e.get("text")):
            errs.append(f"knowledge.entries[{i}] needs id, title, text")
            continue
        ids = e.get("evidence_ids") or []
        best = max((STATUS_RANK.get(statuses.get(x, "unverified"), 1) for x in ids), default=1)
        if e.get("type") in GUIDANCE_ENTRY_TYPES and best < STATUS_RANK["supported"]:
            errs.append(f"knowledge {e['id']}: a {e.get('type')} entry needs evidence that is at least 'supported'")
        elif best < STATUS_RANK["supported"]:
            warns.append(f"knowledge {e['id']}: unverified background; it will be labelled as such")
        missing = [lg for lg in langs if lg not in text_langs(e.get("text")) and "*" not in text_langs(e.get("text"))]
        if missing:
            warns.append(f"knowledge {e['id']}: missing languages {missing}")

    # Guides.
    policy = b.get("report_policy") or {}
    decisions = {d.get("id") for d in policy.get("decision_scale") or [] if isinstance(d, dict)}
    if not uses_decisions and decisions:
        errs.append("no task in this workspace involves a decision, so it must not have a decision scale: remove "
                    "report_policy.decision_scale (never invent decisions such as 'needs review' or 'flag')")
    if uses_decisions and not decisions:
        errs.append("report_policy.decision_scale required when the work involves decisions or guides "
                    "(e.g. stop / repair_soon / monitor)")
    for g in b.get("guides") or []:
        e2, w2 = validate_guide(g if isinstance(g, dict) else {}, workflows, decisions, statuses, langs)
        errs += e2
        warns += w2

    # Every stated responsibility must be served by something.
    trace = {t.get("responsibility_id"): t for t in b.get("traceability") or [] if isinstance(t, dict)}
    for r in resp:
        if isinstance(r, dict) and r.get("id"):
            t = trace.get(r["id"])
            if not t or not (t.get("workflow_ids") or t.get("guide_ids") or t.get("entry_ids")):
                errs.append(f"responsibility {r['id']} is not served by any workflow, guide or knowledge entry")

    # The same schema, cross-reference and type checks Hermes gets when adding parts one by one.
    from . import workspace_schema
    defs = existing_workflow_ids if isinstance(existing_workflow_ids, dict) else {}
    seen = set(errs)
    for e in workspace_schema.bundle_errors(b, statuses, defs):
        if e not in seen:
            errs.append(e)
            seen.add(e)

    counts = {s: sum(1 for v in statuses.values() if v == s) for s in STATUSES}
    summary = {**counts, "sources": len(sources), "sources_excluded": sum(1 for t in tiers.values() if t == 0),
               "gaps": len(b.get("gaps") or []), "workflows": len(workflows) + len(b.get("workflow_refs") or []),
               "guides": len(b.get("guides") or []), "entries": len((b.get("knowledge") or {}).get("entries") or [])}
    return {"ok": not errs, "errors": errs, "warnings": warns, "statuses": statuses, "evidence_notes": ev_notes,
            "tiers": tiers, "tier_notes": tier_notes, "summary": summary}


def research_report(bundle: dict, v: dict) -> dict:
    """What the user reviews before publishing: sources by tier, evidence by status, conflicts, gaps."""
    srcs = {s["id"]: s for s in bundle.get("sources") or [] if isinstance(s, dict) and s.get("id")}
    by_status: dict[str, list] = {s: [] for s in STATUSES}
    for ev in bundle.get("evidence") or []:
        if isinstance(ev, dict) and ev.get("id") in v["statuses"]:
            by_status[v["statuses"][ev["id"]]].append({"id": ev["id"], "claim": ev.get("claim"),
                                                      "sources": [x.get("source_id") for x in ev.get("excerpts") or []],
                                                      "notes": v["evidence_notes"].get(ev["id"], [])})
    return {"summary": v["summary"],
            "sources": [{"id": sid, "title": s.get("title"), "publisher": s.get("publisher"), "url": s.get("url"),
                         "tier": v["tiers"].get(sid), "notes": v["tier_notes"].get(sid, [])} for sid, s in srcs.items()],
            "evidence": by_status, "gaps": bundle.get("gaps") or [], "errors": v["errors"], "warnings": v["warnings"]}


# ----------------------------------------------------------------------------- publishing
def pack_ids(wid: str) -> dict:
    return {"workspace": f"ws-{wid}", "knowledge": f"ws-{wid}-knowledge", "dictionary": f"ws-{wid}-dictionary"}


def phone_guides(guides: list, workflows: dict) -> list:
    """Guides as the phone runs them. A question that reads a workflow field is asked when the record doesn't have the
    value yet, so it carries that field's label, its full option list and the matching input (found in a real
    Hermes-built guide: without this the phone showed the raw field id and only the options its conditions mention)."""
    import copy as _copy
    out = []
    for g in guides:
        if not isinstance(g, dict):
            continue
        g = _copy.deepcopy(g)
        wf = workflows.get(g.get("workflow_id") or "") or {}
        fields = {f.get("id"): f for f in wf.get("fields") or [] if isinstance(f, dict)}
        for n in (g.get("nodes") or {}).values():
            f = fields.get(n.get("field")) if isinstance(n, dict) and not n.get("outcome") else None
            if not f:
                continue
            if not text_langs(n.get("question")):
                n["question"] = f.get("label")
            ftype = f.get("type")
            if ftype in ("single_choice", "multi_choice") and f.get("options") and not n.get("options"):
                n["options"] = f["options"]
                n["input"] = "choice"
            elif ftype == "checkbox":
                n["input"] = "yes_no"
            elif ftype == "number":
                n["input"] = "number"
            elif not n.get("input"):
                n["input"] = "text"
            if f.get("unit") and not n.get("unit"):
                n["unit"] = f["unit"]
        out.append(g)
    return out


def manifest(bundle: dict, v: dict, workflow_versions: dict[str, int], packs: dict) -> dict:
    """The ``workspace`` pack the phone downloads (profile, guides, policy, provenance; no server paths)."""
    statuses = v["statuses"]
    return {
        "kind": "workspace", "id": packs["workspace"], "workspace_id": bundle["id"], "title": bundle["title"],
        "languages": (bundle.get("languages") or {}).get("content", []), "domain": (bundle.get("profile") or {}).get("industry", ""),
        "profile": bundle.get("profile") or {}, "language_features": bundle.get("languages") or {},
        "workflows": [{"id": k, "version": ver} for k, ver in workflow_versions.items()],
        "packs": [p for p in (packs.get("knowledge_saved"), packs.get("dictionary_saved")) if p],
        "guides": phone_guides(bundle.get("guides") or [], {w["id"]: w for w in bundle.get("workflows") or [] if isinstance(w, dict)}),
        "report_policy": bundle.get("report_policy") or {},
        "intents": bundle.get("intents") or [],
        "sources": [{**s, "tier": v["tiers"].get(s["id"])} for s in bundle.get("sources") or [] if isinstance(s, dict)],
        "evidence": [{**e, "status": statuses.get(e.get("id"), "unverified")} for e in bundle.get("evidence") or [] if isinstance(e, dict)],
        "gaps": bundle.get("gaps") or [], "traceability": bundle.get("traceability") or [],
        "summary": v["summary"], "starter": bool(bundle.get("starter")),
    }


def knowledge_pack(bundle: dict, statuses: dict, pid: str) -> Optional[dict]:
    entries = (bundle.get("knowledge") or {}).get("entries") or []
    if not entries:
        return None
    out = []
    for e in entries:
        ids = e.get("evidence_ids") or []
        best = max(ids, key=lambda x: STATUS_RANK.get(statuses.get(x, "unverified"), 1), default=None)
        out.append({**e, "evidence_status": statuses.get(best, "unverified") if best else "unverified"})
    return {"kind": "knowledge", "id": pid, "title": f"{engine.text(bundle['title'])} — knowledge",
            "languages": (bundle.get("languages") or {}).get("content", []), "domain": (bundle.get("profile") or {}).get("industry", ""),
            "entries": out, "source": {"title": "Your workspace (built with Hermes)"}}


def dictionary_pack(bundle: dict, pid: str) -> Optional[dict]:
    entries = (bundle.get("vocabulary") or {}).get("entries") or []
    if not entries:
        return None
    return {"kind": "dictionary", "id": pid, "title": f"{engine.text(bundle['title'])} — vocabulary",
            "languages": (bundle.get("languages") or {}).get("content", []), "entries": entries}


def starter_bundle(wf: dict, packs: list[str]) -> dict:
    """Wrap a bundled example workflow as a starter workspace (synthetic demo content, labelled as such)."""
    title = wf.get("title") or {"en": wf["id"]}
    return {"id": f"starter-{wf['id']}"[:48], "title": title, "starter": True,
            "profile": {"role": engine.text(title), "industry": wf.get("domain", ""), "country": "any",
                        "responsibilities": [{"id": "main", "description": engine.text(wf.get("description") or title),
                                              "decisions": ["What to do after this inspection"]}]},
            "languages": {"content": wf.get("languages") or ["en"]},
            "workflow_refs": [wf["id"]], "pack_refs": packs,
            "report_policy": {"decision_scale": [
                {"id": "stop", "label": {"en": "Stop and escalate", "hi": "रोकें और सूचित करें"}, "severity": "critical"},
                {"id": "act_soon", "label": {"en": "Act within days", "hi": "कुछ दिनों में कार्रवाई करें"}, "severity": "medium"},
                {"id": "monitor", "label": {"en": "Continue and monitor", "hi": "जारी रखें और निगरानी करें"}, "severity": "low"}]},
            "traceability": [{"responsibility_id": "main", "workflow_ids": [wf["id"]]}],
            "gaps": [{"topic": "Example content", "note": "Synthetic demo workspace: not researched for a real site."}]}


def existing_workflow_defs(store: Any) -> dict:
    out = {}
    for w in store.list_workflows(ALL_OWNERS()):
        out[w["id"]] = store.get_workflow_any_owner(w["id"], w.get("published_version") or w["latest_version"]) or {}
    return out


def build_draft(store: Any, owner: Any, bundle: dict, brief_id: Optional[str] = None, changelog: Optional[list] = None) -> dict:
    """Validate and store a new draft version. Invalid bundles are stored too (so Hermes can fix them), but cannot
    be published. Returns the draft id/version, the validation and the research report."""
    existing = existing_workflow_defs(store)
    v = validate_bundle(bundle, existing)
    d = store.save_workspace_draft(owner, bundle, v, brief_id=brief_id, changelog=changelog, starter=bool(bundle.get("starter")))
    return {**d, "ok": v["ok"], "validation": {k: v[k] for k in ("errors", "warnings", "summary")},
            "research_report": research_report(bundle, v)}


def publish(store: Any, wid: str, version: Optional[int] = None, actor: Any = None) -> dict:
    """Publish a validated draft: workflows, knowledge and vocabulary packs, and the workspace manifest pack."""
    from .db import Invalid
    rec = store.get_workspace_version(wid, version or store.get_workspace_version(wid)["latest_version"])
    bundle = rec["bundle"]
    existing = {w["id"]: w for w in store.list_workflows(ALL_OWNERS())}
    v = validate_bundle(bundle, existing_workflow_defs(store))
    if not v["ok"]:
        raise Invalid("workspace is not valid: " + "; ".join(v["errors"][:8]))
    if pending_checks(bundle):
        raise Invalid("source quotes are still being checked; build again (fieldkit_build_workspace) and publish after the checks finish")
    ids = pack_ids(wid)
    versions: dict[str, int] = {}
    for w in bundle.get("workflows") or []:
        saved = store.save_workflow(ALL_OWNERS(), w, publish=True, actor=actor)
        versions[w["id"]] = saved["version"]
    for ref in bundle.get("workflow_refs") or []:
        versions[ref] = existing[ref].get("published_version") or existing[ref]["latest_version"]
    packs = {**ids, "knowledge_saved": None, "dictionary_saved": None}
    kp = knowledge_pack(bundle, v["statuses"], ids["knowledge"])
    if kp:
        packs["knowledge_saved"] = store.save_pack(ALL_OWNERS(), kp, actor=actor)["id"]
    dp = dictionary_pack(bundle, ids["dictionary"])
    if dp:
        packs["dictionary_saved"] = store.save_pack(ALL_OWNERS(), dp, actor=actor)["id"]
    m = manifest(bundle, v, versions, packs)
    m["packs"] = [p for p in m["packs"] if p] + list(bundle.get("pack_refs") or [])
    m["version_of_workspace"] = rec["version"]
    saved = store.save_pack(ALL_OWNERS(), m, actor=actor)
    store.mark_workspace_published(wid, rec["version"], saved["id"])
    return {"workspace_id": wid, "version": rec["version"], "manifest_pack": saved["id"], "workflows": versions,
            "packs": m["packs"], "summary": v["summary"]}


def ALL_OWNERS():  # late import keeps this module importable without a store
    from .db import ALL
    return ALL


def ensure_starters(store: Any) -> list[str]:
    """Each bundled example workflow is also offered as a starter workspace (idempotent, labelled synthetic)."""
    made = []
    have = {w["id"] for w in store.list_workspaces(published_only=False)}
    for w in store.list_workflows(ALL_OWNERS()):
        if w["id"] not in ("equipment-inspection", "classroom-observation", "crop-health-survey"):
            continue
        sid = f"starter-{w['id']}"[:48]
        if sid in have:
            continue
        wf = store.get_workflow_any_owner(w["id"], w.get("published_version") or w["latest_version"]) or {}
        packs = [p for p in (wf.get("knowledge_packs") or []) + (wf.get("dictionary_packs") or []) if store.get_pack_content(p)]
        b = starter_bundle(wf, packs)
        d = build_draft(store, ALL_OWNERS(), b, changelog=["Starter workspace from the bundled example."])
        if d["ok"]:
            publish(store, sid, d["version"])
            made.append(sid)
    return made


# ----------------------------------------------------------------------------- brief (interview result)
def validate_brief(brief: Any) -> dict:
    """Purpose first (0.2.6): any kind of work (inspection, research, business visits, personal logs). Required: what
    the workspace is for, what is recorded, and languages. Decisions, rules, location, escalation, instruments and
    documents are used only if the person has them; nothing is invented to fill a template."""
    if not isinstance(brief, dict):
        return {"ok": False, "missing": ["brief must be an object"], "summary": ""}
    missing = []
    purpose = str(brief.get("purpose") or brief.get("role") or "").strip()
    if not purpose:
        missing.append("purpose (what this workspace is for, in the user's words)")
    resp = brief.get("responsibilities") or []
    records = brief.get("records") or []
    if not (records or (resp and all(isinstance(r, dict) and r.get("description") for r in resp))):
        missing.append("what is recorded each time (the things to capture)")
    langs = brief.get("languages") or {}
    if not (langs.get("content") if isinstance(langs, dict) else langs):
        missing.append("languages")
    lines = [f"Purpose: {purpose or '?'}" + (f" ({brief.get('role')})" if brief.get("purpose") and brief.get("role") else "")]
    where = ", ".join(str(x) for x in (brief.get("region"), brief.get("country")) if x)
    if where:
        lines.append(f"Where: {where}")
    if records:
        lines.append("Each entry records: " + ", ".join(str(r.get("label") if isinstance(r, dict) else r) for r in records))
    for r in resp if isinstance(resp, list) else []:
        if isinstance(r, dict):
            dec = r.get("decisions") or []
            lines.append(f"- {r.get('description')}" + (f" (decides: {', '.join(map(str, dec))})" if dec else ""))
    if brief.get("subject"):
        lines.append(f"Each entry is about: {brief['subject']}")
    if brief.get("rules"):
        lines.append("Your rules: " + "; ".join(map(str, brief["rules"] if isinstance(brief["rules"], list) else [brief["rules"]])))
    if brief.get("tools_and_instruments"):
        lines.append("Tools: " + ", ".join(str(t.get("name") if isinstance(t, dict) else t) for t in brief["tools_and_instruments"]))
    if brief.get("procedures_in_use"):
        lines.append("Procedures: " + ", ".join(str(x.get("title") if isinstance(x, dict) else x) for x in brief["procedures_in_use"]))
    lg = langs if isinstance(langs, dict) else {"content": langs}
    lines.append("Languages: " + ", ".join(lg.get("content") or []))
    esc = brief.get("escalation")
    if esc:
        lines.append("Escalate to: " + ", ".join(map(str, esc if isinstance(esc, list) else [esc])))
    return {"ok": not missing, "missing": missing, "summary": "\n".join(lines)}


# ----------------------------------------------------------------------------- Hermes onboarding prompt
ASK_HINT = ("FieldKit: for any question about one observation/visit (\"what do you think about ...\", photos, is it worse), "
            "find it with fieldkit_list_records and call fieldkit_ask_about_record: it looks at the photos, voice notes, "
            "procedures and earlier visits itself. Syncing never triggers analysis; act only on what the user asks. ")


def prompt_section(store: Any) -> str:
    """Bounded text added to each new Hermes session (ctx.register_system_prompt_section)."""
    try:
        built = [w for w in store.list_workspaces(published_only=True) if not w["starter"]]
        open_builds = store.list_workspace_builds()
    except Exception:
        return ""
    resume = ""
    if open_builds:
        resume = ("A FieldKit workspace build is in progress (" + ", ".join(
            f"{b['workspace_id']}: {sum(len(v) for v in (b['parts'] or {}).values())} parts added" for b in open_builds[:3])
            + "). If the user wants to continue, call fieldkit_workspace_build_status and carry on from there; never "
              "start over. ")
    if not built:
        return (ASK_HINT + resume + "FieldKit (offline field-work plugin) is installed, but no workspace has been built for this user yet. "
                "When the user talks about their field work, inspections, surveys or FieldKit, offer once to build a "
                "FieldKit workspace for their actual job, following the fieldkit-workspace-builder skill: a short interview "
                "(including the rules they already use), confirm the brief, then build straight away from their answers and "
                "documents (no up-front web research), show what the phone will do, and publish only after the user "
                "approves.")[:1500]
    parts = []
    for w in built[:6]:
        try:
            rec = store.get_workspace_version(w["id"])
            sm = (rec.get("validation") or {}).get("summary", {})
            try:
                from . import learning
                ls = learning.summary(store, w["id"])
                extra = f", {ls['open_candidates']} improvement candidate(s), {ls['knowledge_gap']} unanswered offline question(s)"
            except Exception:
                extra = ""
            parts.append(f"{w['title']} (id {w['id']}, v{w['published_version']}; {sm.get('verified', 0)} verified, "
                         f"{sm.get('conflicting', 0)} conflicting, {sm.get('gaps', 0)} gaps{extra})")
        except Exception:
            parts.append(f"{w['title']} (id {w['id']})")
    return (ASK_HINT + resume + "FieldKit workspaces built for this user: " + "; ".join(parts) + ". Use the fieldkit-workspace-builder skill "
            "to update them (new responsibilities, gaps, conflicting evidence, learning candidates).")[:1500]


# ----------------------------------------------------------------------------- excerpt check
import ipaddress  # noqa: E402
import socket  # noqa: E402
import unicodedata  # noqa: E402

MAX_FETCH = 2_000_000
MAX_PDF_FETCH = 20_000_000


def pdf_text(data: bytes) -> Optional[str]:
    """Text of a PDF using Hermes' own document extractor (tools.read_extract, available inside the Hermes
    process), else pypdf if installed. None when no extractor is available: the quote is then not checked."""
    try:
        from tools.read_extract import extract_document_bytes  # type: ignore[import-not-found]
        return extract_document_bytes(data, "source.pdf")
    except ImportError:
        pass
    except Exception:  # noqa: BLE001 (extractor present but failed: try the fallback)
        pass
    try:
        import io

        from pypdf import PdfReader  # type: ignore[import-not-found]
        return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages)
    except Exception:  # noqa: BLE001
        return None


def _norm(t: str) -> str:
    t = unicodedata.normalize("NFKC", t or "").lower()
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"[^\w\s]", " ", t, flags=re.U)
    return re.sub(r"\s+", " ", t).strip()


def _public_host(host: str) -> bool:
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except Exception:
        return False


class _SafeRedirect(__import__("urllib.request").request.HTTPRedirectHandler):
    """Follow redirects only to public http(s) hosts (a public page must not bounce the check into the local network)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        u = urlparse(newurl)
        if u.scheme not in ("http", "https") or not u.hostname or not _public_host(u.hostname):
            raise ValueError("redirect to a non-public URL")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


FETCH_DEADLINE_S = 25      # per page, whole download (a slow-drip server cannot hold a worker longer)


def default_fetch(url: str) -> tuple:
    """(content_type, text). Only public http(s) hosts (redirects re-checked); size and time limited."""
    import time
    import urllib.request
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or not _public_host(u.hostname):
        raise ValueError("not a public http(s) URL")
    opener = urllib.request.build_opener(_SafeRedirect())
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; FieldKit-excerpt-check/0.2.6)",
                                               "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"})
    t0 = time.monotonic()
    with opener.open(req, timeout=10) as r:  # noqa: S310 (scheme and host checked above and on every redirect)
        ctype = r.headers.get("content-type", "")
        is_pdf = "pdf" in ctype.lower() or u.path.lower().endswith(".pdf")
        cap = MAX_PDF_FETCH if is_pdf else MAX_FETCH
        chunks, size = [], 0
        while size < cap:
            if time.monotonic() - t0 > FETCH_DEADLINE_S:
                raise TimeoutError("page download took too long")
            b = r.read(65536)
            if not b:
                break
            chunks.append(b)
            size += len(b)
        charset = r.headers.get_content_charset() or "utf-8"
    body = b"".join(chunks)[:cap]
    if is_pdf or body[:5] == b"%PDF-":
        text = pdf_text(body)
        if text is None:
            return "application/pdf", ""            # no extractor: reported as "PDF: not checked"
        return "text/plain; source=pdf", text
    return ctype, body.decode(charset, errors="replace")


# Pages are fetched in a small background pool and cached (memory + the store), so a build tool call waits a bounded
# time and later calls reuse the result. Injected fetchers (tests) bypass the caches.
_POOL = None
_INFLIGHT: dict = {}
_MEM: dict = {}
_POOL_LOCK = __import__("threading").RLock()
OK_TTL_S, ERROR_TTL_S = 3 * 86400, 600
MIN_PAGE_TEXT = 400        # fewer readable characters than this: probably a script-rendered page; don't judge quotes


def _pool():
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            from concurrent.futures import ThreadPoolExecutor
            _POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="fieldkit-source")
        return _POOL


def _load_page(url: str, fetch: Any) -> tuple:
    """(status, content): status ok / pdf / thin / error."""
    try:
        ctype, body = fetch(url)
        if str(ctype).lower().startswith("application/pdf"):
            return "pdf", None
        text = _norm(body)
        return ("ok" if len(text) >= MIN_PAGE_TEXT else "thin"), text
    except Exception as exc:  # noqa: BLE001 (any network/parse failure is "could not check")
        return "error", (type(exc).__name__ + (": " + str(exc))[:120] if str(exc) else type(exc).__name__)


def _fresh(status: str, at: float) -> bool:
    import time
    return (time.time() - (at or 0)) < (ERROR_TTL_S if status == "error" else OK_TTL_S)


def fetch_pages(urls: list, fetch: Any = None, store: Any = None, wait_s: Optional[float] = None) -> dict:
    """url → (status, content) with status ok / pdf / thin / error / pending (still downloading in the background)."""
    import time
    from concurrent.futures import wait as fwait
    out: dict = {}
    if fetch is not None:      # injected fetcher (tests): synchronous, uncached
        for u in urls:
            out[u] = _load_page(u, fetch)
        return out
    futs = {}
    for u in dict.fromkeys(urls):
        hit = _MEM.get(u)
        if hit and _fresh(hit[0], hit[2]):
            out[u] = hit[:2]
            continue
        if store is not None:
            try:
                row = store.get_source_page(u)
            except Exception:
                row = None
            if row and _fresh(row["status"], row["fetched_at"]):
                _MEM[u] = (row["status"], row["content"] if row["status"] != "error" else row["error"], row["fetched_at"])
                out[u] = _MEM[u][:2]
                continue
        with _POOL_LOCK:
            f = _INFLIGHT.get(u)
            if f is None:
                def job(url=u):
                    st, content = _load_page(url, default_fetch)
                    _MEM[url] = (st, content, time.time())
                    if store is not None:
                        try:
                            store.save_source_page(url, st, content if st != "error" else None, content if st == "error" else None)
                        except Exception:
                            pass
                    with _POOL_LOCK:
                        _INFLIGHT.pop(url, None)
                    return st, content
                f = _INFLIGHT[u] = _pool().submit(job)
        futs[u] = f
    if futs:
        fwait(list(futs.values()), timeout=wait_s)
    for u, f in futs.items():
        out[u] = f.result() if f.done() else ("pending", None)
    return out


def _quote_found(quote: str, page: str) -> bool:
    q = _norm(quote)
    if not q:
        return False
    if q[:160] in page:
        return True
    # Quotes copied from extracted markdown can cross a table cell or line break: accept when every 6-word window of
    # the quote appears on the page (still exact text, just not one contiguous run).
    words = q.split()
    if len(words) < 6:
        return False
    wins = [" ".join(words[i:i + 6]) for i in range(0, len(words) - 5, 3)]
    return all(w in page for w in wins)


APPROX_MIN = 0.85


def _approx_match(quote: str, page: str) -> float:
    """Best similarity of the quote to a same-length run of page words, for text extracted from scanned or garbled
    documents (OCR turns "milk is for" into "111 milk is or"). Every number in the quote must appear, in order and
    exactly, in that run: a misquoted threshold never matches approximately. Returns 0..1."""
    import difflib
    q = _norm(quote)
    qw, pw = q.split(), page.split()
    n = len(qw)
    if n < 6 or not pw:
        return 0.0
    nums = [w for w in qw if any(ch.isdigit() for ch in w)]
    qs = set(qw)
    hits = [1 if w in qs else 0 for w in pw]
    win = sum(hits[:n])
    cands = []
    for i in range(0, max(1, len(pw) - n + 1)):
        if i:
            win += (hits[i + n - 1] if i + n - 1 < len(hits) else 0) - hits[i - 1]
        if win >= 0.5 * n:
            cands.append((win, i))
    best = 0.0
    for _, i in sorted(cands, reverse=True)[:300]:
        seg = pw[max(0, i - 2): i + n + 2]
        it = iter(seg)
        if nums and not all(any(x == num for x in it) for num in nums):
            continue
        best = max(best, difflib.SequenceMatcher(None, q, " ".join(pw[i:i + n])).ratio())
    return best


def check_excerpts(bundle: dict, fetch: Any = None, limit: int = 80, wait_s: Optional[float] = None, store: Any = None) -> dict:
    """Confirm each quoted excerpt appears on its source page. Marks excerpts in place with check = found /
    not_found / not_checked / pending (+ check_note). PDFs are read with Hermes' document extractor; user documents are not checked; a page
    with almost no readable text (script-rendered) is not judged. A not_found excerpt no longer counts as evidence;
    a pending one blocks publishing until the check finishes."""
    sources = {x.get("id"): x for x in bundle.get("sources") or [] if isinstance(x, dict)}
    counts = {"found": 0, "approximate": 0, "not_found": 0, "not_checked": 0, "pending": 0}
    todo: list = []
    marks: list = []
    for ev in bundle.get("evidence") or []:
        if not isinstance(ev, dict):
            continue
        for x in ev.get("excerpts") or []:
            if not isinstance(x, dict):
                continue
            src = sources.get(x.get("source_id"))
            url = (src or {}).get("url", "")
            why = ""
            if src and src.get("type") in USER_SOURCE_TYPES:
                why = "the user's own words or document (their procedure; not a published source)"
            elif not src or not url:
                why = "no URL"
            elif url not in todo and len(todo) >= limit:
                why = "check limit reached"
            if why:
                x["check"], x["check_note"] = "not_checked", why
                counts["not_checked"] += 1
                continue
            if url not in todo:
                todo.append(url)
            marks.append((x, url))
    pages = fetch_pages(todo, fetch=fetch, store=store, wait_s=wait_s) if todo else {}
    for x, url in marks:
        st, content = pages.get(url, ("error", "not fetched"))
        x.pop("check_note", None)
        found = st in ("ok", "thin") and _quote_found(str(x.get("quote", "")), content or "")
        if st == "pending":
            x["check"], x["check_note"] = "pending", "the page is still being fetched"
        elif st == "pdf":
            x["check"], x["check_note"] = "not_checked", "PDF: no text extractor available, or a scanned PDF"
        elif st == "error":
            x["check"], x["check_note"] = "not_checked", f"could not fetch ({content})"
        elif found:
            x["check"] = "found"
        elif st == "ok" and _approx_match(str(x.get("quote", "")), content or "") >= APPROX_MIN:
            x["check"], x["check_note"] = "approximate", ("close match in text extracted from a scanned or garbled "
                                                          "document; numbers match exactly; check the wording by eye")
        elif st == "thin":
            x["check"], x["check_note"] = "not_checked", "the page has almost no readable text (it may need a browser); quote not verified"
        else:
            x["check"], x["check_note"] = "not_found", "quote not found on the page"
        counts[x["check"]] += 1
    return counts


def pending_checks(bundle: dict) -> int:
    return sum(1 for ev in bundle.get("evidence") or [] if isinstance(ev, dict)
               for x in ev.get("excerpts") or [] if isinstance(x, dict) and x.get("check") == "pending")



# ----------------------------------------------------------------------------- what changed between two versions
def _lbl(v: Any) -> str:
    return engine.text(v) if v else ""


def workspace_changes(old: Optional[dict], new: dict) -> list[str]:
    """A short, plain-language list of what changed (shown to the user before publishing an edit or an undo)."""
    if not old:
        return ["New workspace."]
    out: list[str] = []
    if _lbl(old.get("title")) != _lbl(new.get("title")):
        out.append(f"Title: \"{_lbl(old.get('title'))}\" → \"{_lbl(new.get('title'))}\"")
    op, np_ = old.get("profile") or {}, new.get("profile") or {}
    for k, name in (("purpose", "Purpose"), ("role", "Role"), ("region", "Region"), ("country", "Country")):
        if op.get(k) != np_.get(k) and (op.get(k) or np_.get(k)):
            out.append(f"{name}: \"{op.get(k) or '—'}\" → \"{np_.get(k) or '—'}\"")
    od = {r.get("id"): r for r in op.get("responsibilities") or [] if isinstance(r, dict)}
    nd = {r.get("id"): r for r in np_.get("responsibilities") or [] if isinstance(r, dict)}
    for k in nd.keys() - od.keys():
        out.append(f"Added task: {nd[k].get('description')}")
    for k in od.keys() - nd.keys():
        out.append(f"Removed task: {od[k].get('description')}")
    ow = {w.get("id"): w for w in old.get("workflows") or [] if isinstance(w, dict)}
    nw = {w.get("id"): w for w in new.get("workflows") or [] if isinstance(w, dict)}
    for k in nw.keys() - ow.keys():
        out.append(f"Added form: {_lbl(nw[k].get('title')) or k}")
    for k in ow.keys() - nw.keys():
        out.append(f"Removed form: {_lbl(ow[k].get('title')) or k} (existing records keep their answers)")
    for k in nw.keys() & ow.keys():
        form = _lbl(nw[k].get("title")) or k
        of = {f.get("id"): f for f in ow[k].get("fields") or []}
        nf = {f.get("id"): f for f in nw[k].get("fields") or []}
        for fid in [f.get("id") for f in nw[k].get("fields") or [] if f.get("id") not in of]:
            out.append(f"{form}: added question \"{_lbl(nf[fid].get('label')) or fid}\" ({nf[fid].get('type')})")
        for fid in [f.get("id") for f in ow[k].get("fields") or [] if f.get("id") not in nf]:
            out.append(f"{form}: removed question \"{_lbl(of[fid].get('label')) or fid}\" (old records keep this answer)")
        for fid in of.keys() & nf.keys():
            a, b = of[fid], nf[fid]
            bits = []
            if _lbl(a.get("label")) != _lbl(b.get("label")):
                bits.append(f"label \"{_lbl(a.get('label'))}\" → \"{_lbl(b.get('label'))}\"")
            if a.get("type") != b.get("type"):
                bits.append(f"type {a.get('type')} → {b.get('type')}")
            if [o.get("value") for o in a.get("options") or []] != [o.get("value") for o in b.get("options") or []]:
                bits.append("options changed")
            if bool(a.get("required")) != bool(b.get("required")):
                bits.append("now required" if b.get("required") else "now optional")
            if (a.get("validation") or {}) != (b.get("validation") or {}) or a.get("unit") != b.get("unit"):
                bits.append("limits/units changed")
            if bits:
                out.append(f"{form}: changed \"{_lbl(b.get('label')) or fid}\": " + ", ".join(bits))
        orr = {r.get("id"): r for r in (ow[k].get("classification") or {}).get("rules") or []}
        nrr = {r.get("id"): r for r in (nw[k].get("classification") or {}).get("rules") or []}
        for rid in nrr.keys() - orr.keys():
            out.append(f"{form}: added rule \"{_lbl(nrr[rid].get('label')) or rid}\"")
        for rid in orr.keys() - nrr.keys():
            out.append(f"{form}: removed rule \"{_lbl(orr[rid].get('label')) or rid}\"")
        for rid in orr.keys() & nrr.keys():
            if orr[rid] != nrr[rid]:
                out.append(f"{form}: changed rule \"{_lbl(nrr[rid].get('label')) or rid}\"")
        if (ow[k].get("metadata") or {}).get("subject_field") != (nw[k].get("metadata") or {}).get("subject_field"):
            out.append(f"{form}: each entry is now identified by \"{(nw[k].get('metadata') or {}).get('subject_field')}\"")
    for part, name, key in (("guides", "guide", "id"), ("evidence", "rule source", "id"), ("gaps", "gap", "topic")):
        oi = {x.get(key): x for x in old.get(part) or [] if isinstance(x, dict)}
        ni = {x.get(key): x for x in new.get(part) or [] if isinstance(x, dict)}
        for k in ni.keys() - oi.keys():
            out.append(f"Added {name}: {_lbl(ni[k].get('title')) or ni[k].get('claim') or k}")
        for k in oi.keys() - ni.keys():
            out.append(f"Removed {name}: {_lbl(oi[k].get('title')) or oi[k].get('claim') or k}")
        if part == "guides":
            for k in oi.keys() & ni.keys():
                if oi[k] != ni[k]:
                    out.append(f"Changed guide: {_lbl(ni[k].get('title')) or k}")
    ok = {e.get("id"): e for e in (old.get("knowledge") or {}).get("entries") or [] if isinstance(e, dict)}
    nk = {e.get("id"): e for e in (new.get("knowledge") or {}).get("entries") or [] if isinstance(e, dict)}
    for k in nk.keys() - ok.keys():
        out.append(f"Added procedure/knowledge: {_lbl(nk[k].get('title')) or k}")
    for k in ok.keys() - nk.keys():
        out.append(f"Removed procedure/knowledge: {_lbl(ok[k].get('title')) or k}")
    for k in ok.keys() & nk.keys():
        if ok[k] != nk[k]:
            out.append(f"Changed procedure/knowledge: {_lbl(nk[k].get('title')) or k}")
    odec = [d.get("id") for d in (old.get("report_policy") or {}).get("decision_scale") or []]
    ndec = [d.get("id") for d in (new.get("report_policy") or {}).get("decision_scale") or []]
    if odec != ndec:
        out.append(f"Decisions: {', '.join(odec) or '—'} → {', '.join(ndec) or '—'}")
    ov = len((old.get("vocabulary") or {}).get("entries") or [])
    nv = len((new.get("vocabulary") or {}).get("entries") or [])
    if ov != nv:
        out.append(f"Vocabulary: {ov} → {nv} terms")
    return out or ["No visible changes."]
