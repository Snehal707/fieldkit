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
    "regulator": 1, "government": 1, "standards_body": 1, "manufacturer": 1, "user_document": 1,
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
    if stype == "user_document":
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
    excerpts = [x for x in ev.get("excerpts", []) if isinstance(x, dict) and len(str(x.get("quote", "")).strip()) >= MIN_EXCERPT
                and x.get("source_id") in sources and x.get("check") != "not_found"]
    dropped = len(ev.get("excerpts", [])) - len(excerpts)
    if dropped:
        notes.append(f"{dropped} excerpt(s) ignored: empty, too short, citing an unrecorded source, or not found on the page")
    tiers = {}
    for x in excerpts:
        t, _ = source_tier(sources[x["source_id"]])
        if t:
            tiers[x["source_id"]] = t
    if not tiers and any(sources[x["source_id"]].get("type") == "user_document" for x in excerpts):
        tiers = {x["source_id"]: 1 for x in excerpts}
    if ev.get("local_practice"):
        o = ev.get("outcomes") or {}
        n, done = int(o.get("n") or 0), int(o.get("done") or 0)
        if n >= MIN_PRACTICE_OUTCOMES and done / max(1, n) >= 0.8 and len(o.get("records") or []) >= n:
            return "local_practice", notes + [f"learned from {done} of {n} verified follow-up outcomes (not a standard)"]
        notes.append("local practice without enough verified outcomes")
        return "unverified", notes
    if ev.get("user_procedure"):
        if any(sources[s].get("type") == "user_document" for s in tiers):
            return "user_procedure", notes
        notes.append("marked as the user's procedure but cites no user document")
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
def validate_bundle(b: Any, existing_workflow_ids: Optional[set] = None) -> dict:
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
        errs.append("profile.responsibilities: at least one, each with id and description")
    if not any((r.get("decisions") or []) for r in resp if isinstance(r, dict)):
        errs.append("profile.responsibilities: at least one responsibility must list the decisions it requires")
    if not profile.get("country"):
        errs.append("profile.country required")
    langs = (b.get("languages") or {}).get("content") or []
    if not langs or not all(isinstance(x, str) and re.match(r"^[a-z]{2,3}$", x) for x in langs):
        errs.append("languages.content: list of language codes required")

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
    if not decisions:
        errs.append("report_policy.decision_scale required (e.g. stop / repair_soon / monitor)")
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


def manifest(bundle: dict, v: dict, workflow_versions: dict[str, int], packs: dict) -> dict:
    """The ``workspace`` pack the phone downloads (profile, guides, policy, provenance; no server paths)."""
    statuses = v["statuses"]
    return {
        "kind": "workspace", "id": packs["workspace"], "workspace_id": bundle["id"], "title": bundle["title"],
        "languages": (bundle.get("languages") or {}).get("content", []), "domain": (bundle.get("profile") or {}).get("industry", ""),
        "profile": bundle.get("profile") or {}, "language_features": bundle.get("languages") or {},
        "workflows": [{"id": k, "version": ver} for k, ver in workflow_versions.items()],
        "packs": [p for p in (packs.get("knowledge_saved"), packs.get("dictionary_saved")) if p],
        "guides": bundle.get("guides") or [], "report_policy": bundle.get("report_policy") or {},
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
            "entries": out, "source": {"title": "Researched by Hermes for this workspace"}}


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


def build_draft(store: Any, owner: Any, bundle: dict, brief_id: Optional[str] = None, changelog: Optional[list] = None) -> dict:
    """Validate and store a new draft version. Invalid bundles are stored too (so Hermes can fix them), but cannot
    be published. Returns the draft id/version, the validation and the research report."""
    existing = {w["id"] for w in store.list_workflows(ALL_OWNERS())}
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
    v = validate_bundle(bundle, set(existing))
    if not v["ok"]:
        raise Invalid("workspace is not valid: " + "; ".join(v["errors"][:8]))
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
    """The interview must establish the user's actual job before any research. Returns missing items and a summary
    the user confirms in their own words."""
    if not isinstance(brief, dict):
        return {"ok": False, "missing": ["brief must be an object"], "summary": ""}
    missing = []
    if not str(brief.get("role") or "").strip():
        missing.append("role (what the user does)")
    resp = brief.get("responsibilities") or []
    if not resp or not all(isinstance(r, dict) and r.get("description") for r in resp):
        missing.append("responsibilities (each with a description)")
    elif not all(r.get("decisions") for r in resp):
        missing.append("the decisions each responsibility requires")
    if not brief.get("country"):
        missing.append("country (and region if rules differ by region)")
    langs = brief.get("languages") or {}
    if not (langs.get("content") if isinstance(langs, dict) else langs):
        missing.append("languages (reading; speaking and photo text if different)")
    for k, label in (("tools_and_instruments", "tools and instruments used (or an empty list)"),
                     ("procedures_in_use", "procedures/SOPs already followed (or an empty list)"),
                     ("escalation", "who to escalate to (roles)")):
        if k not in brief:
            missing.append(label)
    lines = [f"Role: {brief.get('role', '?')}" + (f" ({brief.get('industry')})" if brief.get("industry") else ""),
             "Where: " + ", ".join(str(x) for x in (brief.get("region"), brief.get("country")) if x)]
    for r in resp if isinstance(resp, list) else []:
        if isinstance(r, dict):
            dec = r.get("decisions") or []
            lines.append(f"- {r.get('description')}" + (f" (decides: {', '.join(map(str, dec))})" if dec else ""))
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
def prompt_section(store: Any) -> str:
    """Bounded text added to each new Hermes session (ctx.register_system_prompt_section)."""
    try:
        built = [w for w in store.list_workspaces(published_only=True) if not w["starter"]]
    except Exception:
        return ""
    if not built:
        return ("FieldKit (offline field-work plugin) is installed, but no workspace has been built for this user yet. "
                "When the user talks about their field work, inspections, surveys or FieldKit, offer once to build a "
                "FieldKit workspace for their actual job, following the fieldkit-workspace-builder skill: interview, "
                "confirm the brief (fieldkit_save_workspace_brief), research with web_search and web_extract quoting the "
                "exact source text, fieldkit_build_workspace, show the research report, and publish only after the user approves.")
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
    return ("FieldKit workspaces built for this user: " + "; ".join(parts) + ". Use the fieldkit-workspace-builder skill "
            "to update them (new responsibilities, gaps, conflicting evidence, learning candidates).")[:1500]


# ----------------------------------------------------------------------------- excerpt check
import ipaddress  # noqa: E402
import socket  # noqa: E402
import unicodedata  # noqa: E402

MAX_FETCH = 2_000_000


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


def default_fetch(url: str) -> tuple:
    """(content_type, text). Only public http(s) hosts; size and time limited."""
    import urllib.request
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or not _public_host(u.hostname):
        raise ValueError("not a public http(s) URL")
    req = urllib.request.Request(url, headers={"User-Agent": "FieldKit-excerpt-check/0.2.5"})
    with urllib.request.urlopen(req, timeout=8) as r:  # noqa: S310 (scheme and host checked above)
        ctype = r.headers.get("content-type", "")
        body = r.read(MAX_FETCH)
    return ctype, body.decode("utf-8", errors="replace")


def check_excerpts(bundle: dict, fetch: Any = None, limit: int = 40) -> dict:
    """Confirm each quoted excerpt appears on its source page. Marks excerpts in place with check = found /
    not_found / not_checked (+ check_note). PDFs and user documents are not checked automatically. A not_found
    excerpt no longer counts as evidence."""
    fetch = fetch or default_fetch
    sources = {x.get("id"): x for x in bundle.get("sources") or [] if isinstance(x, dict)}
    pages: dict = {}
    counts = {"found": 0, "not_found": 0, "not_checked": 0}
    for ev in bundle.get("evidence") or []:
        if not isinstance(ev, dict):
            continue
        for x in ev.get("excerpts") or []:
            if not isinstance(x, dict):
                continue
            src = sources.get(x.get("source_id"))
            url = (src or {}).get("url", "")
            why = ""
            if not src or src.get("type") == "user_document" or not url:
                why = "user document or no URL"
            elif url.lower().split("?")[0].endswith(".pdf"):
                why = "PDF: not checked automatically"
            elif url not in pages and len(pages) >= limit:
                why = "check limit reached"
            if why:
                x["check"], x["check_note"] = "not_checked", why
                counts["not_checked"] += 1
                continue
            if url not in pages:
                try:
                    ctype, body = fetch(url)
                    pages[url] = None if "pdf" in str(ctype).lower() else _norm(body)
                except Exception as exc:
                    pages[url] = "!" + type(exc).__name__
            page = pages[url]
            if page is None or page.startswith("!"):
                x["check"], x["check_note"] = "not_checked", ("PDF" if page is None else "could not fetch (" + page[1:] + ")")
                counts["not_checked"] += 1
                continue
            q = _norm(str(x.get("quote", "")))[:160]
            if q and q in page:
                x["check"] = "found"
                counts["found"] += 1
            else:
                x["check"], x["check_note"] = "not_found", "quote not found on the page"
                counts["not_found"] += 1
    return counts
