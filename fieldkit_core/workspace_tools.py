"""Hermes tools for building FieldKit workspaces. Used by the fieldkit-workspace-builder skill.

Flow (0.2.6): interview → fieldkit_save_workspace_brief (user confirms) → fieldkit_start_workspace_build →
research with Hermes' own web_search / web_extract, adding each part as soon as it is ready with
fieldkit_add_workspace_parts (schema-checked, cross-referenced, saved server-side, so a long build survives the end of
a chat and no single call carries the whole workspace) → fieldkit_build_workspace (assemble, validate, check quotes
with a bounded wait; slow pages keep loading in the background) → show the research report →
fieldkit_publish_workspace only with the user's approval.
"""
from __future__ import annotations

import json
from typing import Any

from . import workspace as ws
from . import workspace_schema as wsc
from .db import ALL, Invalid, NotFound, get_store

BUILD_WAIT_S = 20        # longest a build call waits for source pages (Hermes tool calls must stay short)
EVIDENCE_WAIT_S = 8      # adding evidence: quick look; the rest continues in the background
LIST_PARTS = tuple(p for p in wsc.PARTS if p != "report_policy")


def _ok(**d: Any) -> str:
    return json.dumps({"ok": True, **d}, ensure_ascii=False, default=str)


def _fail(msg: str, **d: Any) -> str:
    return json.dumps({"ok": False, "error": msg, **d}, ensure_ascii=False, default=str)


def workspace_format(a: dict) -> str:
    return _ok(format=wsc.format_doc(a.get("part") or None))


def save_brief(a: dict) -> str:
    brief = a.get("brief")
    v = ws.validate_brief(brief)
    if a.get("confirmed") and not v["ok"]:
        return _fail("the brief is incomplete, so it cannot be confirmed", missing=v["missing"], summary=v["summary"])
    saved = get_store().save_workspace_brief(ALL, brief if isinstance(brief, dict) else {}, a.get("brief_id"),
                                             confirmed=bool(a.get("confirmed")) and v["ok"])
    nxt = ("Next: fieldkit_start_workspace_build, then research and add parts (skill section 2-3)." if saved["confirmed"] else
           "Show this summary to the user in their language and ask them to confirm or correct it; then call again with "
           "confirmed=true." if v["ok"] else "Ask the user about the missing items, then save again.")
    return _ok(brief_id=saved["brief_id"], confirmed=saved["confirmed"], missing=v["missing"], summary=v["summary"], next=nxt)


# ----------------------------------------------------------------------------- build state
def _empty_parts() -> dict:
    return {p: {} for p in wsc.PARTS}


def _parts_from_bundle(b: dict) -> dict:
    parts = _empty_parts()
    for p in LIST_PARTS:
        items = b.get(p)
        if p in ("knowledge", "vocabulary"):
            items = (items or {}).get("entries") if isinstance(items, dict) else items
        for it in items or []:
            parts[p][wsc.item_key(p, it)] = it
    if isinstance(b.get("report_policy"), dict):
        parts["report_policy"]["report_policy"] = b["report_policy"]
    return parts


def _assemble(build: dict, brief: dict) -> dict:
    h, parts = build["header"], build["parts"]
    b = {"id": build["workspace_id"], "title": h.get("title"), "profile": brief,
         "languages": h.get("languages") or {"content": ["en"]}}
    if h.get("workflow_refs"):
        b["workflow_refs"] = h["workflow_refs"]
    for p in LIST_PARTS:
        items = list((parts.get(p) or {}).values())
        if p in ("knowledge", "vocabulary"):
            b[p] = {"entries": items}
        else:
            b[p] = items
    if parts.get("report_policy"):
        b["report_policy"] = next(iter(parts["report_policy"].values()))
    return b


def _existing_workflows(store: Any) -> dict:
    out = {}
    for w in store.list_workflows(ALL):
        d = store.get_workflow_any_owner(w["id"], w.get("published_version") or w["latest_version"])
        if d:
            out[w["id"]] = d
    return out


def _statuses(parts: dict) -> dict:
    sources = dict(parts.get("sources") or {})
    return {k: ws.evidence_status(ev, sources)[0] for k, ev in (parts.get("evidence") or {}).items()}


def _ctx(store: Any, build: dict, brief: dict, existing: dict | None = None) -> dict:
    parts = build["parts"]
    pol = next(iter((parts.get("report_policy") or {}).values()), None)
    return {"sources": parts.get("sources") or {}, "evidence": parts.get("evidence") or {},
            "workflows": parts.get("workflows") or {},
            "existing_workflows": existing if existing is not None else _existing_workflows(store),
            "decisions": {d.get("id") for d in (pol or {}).get("decision_scale") or [] if isinstance(d, dict)},
            "statuses": _statuses(parts), "guides": parts.get("guides") or {}, "entries": parts.get("knowledge") or {},
            "responsibilities": {r.get("id") for r in brief.get("responsibilities") or [] if isinstance(r, dict) and r.get("id")},
            "languages": ((build["header"].get("languages") or {}).get("content") or [])}


def _counts(parts: dict) -> dict:
    return {p: len(parts.get(p) or {}) for p in wsc.PARTS}


def _missing(parts: dict, brief: dict) -> list[str]:
    out = []
    for p, why in (("sources", "researched sources"), ("evidence", "quoted evidence"), ("report_policy", "a decision scale"),
                   ("workflows", "at least one workflow"), ("traceability", "traceability for each responsibility")):
        if not parts.get(p):
            out.append(f"{p}: {why}")
    traced = set((parts.get("traceability") or {}).keys())
    resp = [r.get("id") for r in brief.get("responsibilities") or [] if isinstance(r, dict) and r.get("id")]
    untraced = [r for r in resp if r not in traced]
    if parts.get("traceability") and untraced:
        out.append(f"traceability: responsibilities not yet served {untraced}")
    return out


def _brief_for(store: Any, bid: str) -> dict:
    brief = store.get_workspace_brief(ALL, bid)
    if not brief["confirmed"]:
        raise Invalid("the brief is not confirmed by the user yet; research and building start after confirmation")
    return brief


def _status_dict(store: Any, build: dict) -> dict:
    brief = store.get_workspace_brief(ALL, build["brief_id"])["brief"]
    parts = build["parts"]
    st = _statuses(parts)
    return {"workspace_id": build["workspace_id"], "title": build["header"].get("title"), "brief_id": build["brief_id"],
            "parts": _counts(parts), "missing": _missing(parts, brief),
            "evidence_status": {s: sum(1 for v in st.values() if v == s) for s in ws.STATUSES if any(v == s for v in st.values())},
            "responsibilities": [{"id": r.get("id"), "description": r.get("description")} for r in brief.get("responsibilities") or []
                                 if isinstance(r, dict)],
            "ids": {p: list((parts.get(p) or {}).keys())[:60] for p in ("sources", "evidence", "workflows", "guides", "knowledge")}}


def start_build(a: dict) -> str:
    store = get_store()
    bid = a.get("brief_id")
    if not bid:
        return _fail("brief_id required: interview the user and confirm the brief first (fieldkit_save_workspace_brief)")
    brief = _brief_for(store, bid)["brief"]
    wid = str(a.get("workspace_id") or "").strip()
    if not ws.SLUG.match(wid):
        return _fail("workspace_id must be a lowercase slug of 2-48 characters, e.g. dairy-collection-pune")
    cur = store.get_workspace_build(wid)
    if cur and not a.get("restart"):
        return _ok(resumed=True, **_status_dict(store, cur),
                   next="A build for this workspace is already in progress: continue adding the missing parts "
                        "(restart=true discards it).")
    langs = a.get("languages") or brief.get("languages") or {"content": ["en"]}
    if isinstance(langs, list):
        langs = {"content": langs}
    header = {"title": a.get("title") or {"en": brief.get("role") or wid}, "languages": langs,
              "workflow_refs": a.get("workflow_refs") or []}
    parts = _empty_parts()
    from_existing = None
    if a.get("from_existing", True):         # updating a workspace: start from its latest version
        try:
            rec = store.get_workspace_version(wid, store.get_workspace_version(wid)["latest_version"])
            b = rec["bundle"]
            parts = _parts_from_bundle(b)
            header = {"title": a.get("title") or b.get("title") or header["title"],
                      "languages": header["languages"] if a.get("languages") else (b.get("languages") or header["languages"]),
                      "workflow_refs": a.get("workflow_refs") or b.get("workflow_refs") or []}
            from_existing = rec["version"]
        except NotFound:
            pass
    store.save_workspace_build(ALL, wid, bid, header, parts)
    build = store.get_workspace_build(wid)
    return _ok(started=True, from_version=from_existing, **_status_dict(store, build),
               next="For each part in order (sources, evidence, report_policy, workflows, guides, knowledge, vocabulary, "
                    "intents, gaps, traceability): call fieldkit_workspace_format(part) once for its schema and example, "
                    "then fieldkit_add_workspace_parts. Add parts as soon as they are researched.")


def _learned_items(store: Any, wid: str) -> dict:
    """Evidence created by the learning loop from verified outcomes, as stored by FieldKit (never from Hermes)."""
    try:
        b = store.get_workspace_version(wid, store.get_workspace_version(wid)["latest_version"])["bundle"]
    except NotFound:
        return {}
    return {e["id"]: e for e in b.get("evidence") or [] if isinstance(e, dict) and e.get("local_practice")}


def _forged_practice(store: Any, wid: str, item: Any) -> bool:
    """A 'local practice' must come from FieldKit's learning loop; Hermes may keep one unchanged, never write one."""
    if not isinstance(item, dict) or not (item.get("local_practice") or item.get("outcomes")):
        return False
    known = _learned_items(store, wid).get(item.get("id"))
    return not known or known.get("outcomes") != item.get("outcomes")


def add_parts(a: dict) -> str:
    if isinstance(a.get("parts"), dict) and a["parts"]:
        # Several parts in one call (fewer model round-trips): applied in the standard order.
        results, ok = {}, True
        for p in [x for x in wsc.PARTS if x in a["parts"]]:
            r = json.loads(add_parts({"workspace_id": a.get("workspace_id"), "part": p, "items": a["parts"][p],
                                      "dry_run": a.get("dry_run")}))
            if not r.get("ok"):
                return _fail(r.get("error", "failed"), part=p, done=results)
            results[p] = {k: r[k] for k in ("accepted", "rejected", "fixed_automatically", "quote_check", "quotes_not_found",
                                            "evidence_status") if r.get(k)}
            ok = ok and not r["rejected"]
        unknown = [p for p in a["parts"] if p not in wsc.PARTS]
        return _ok(results=results, unknown_parts=unknown, dry_run=bool(a.get("dry_run")),
                   next=("Fix each rejected item using its errors and hints, then add it again." if not ok else
                         "Saved. When all parts are in, call fieldkit_build_workspace(workspace_id)."))
    store = get_store()
    wid, part = a.get("workspace_id"), a.get("part")
    build = store.get_workspace_build(wid or "")
    if not build:
        return _fail(f"no build in progress for {wid!r}; call fieldkit_start_workspace_build first")
    if part not in wsc.PARTS:
        return _fail(f"part must be one of {list(wsc.PARTS)}")
    brief = store.get_workspace_brief(ALL, build["brief_id"])["brief"]
    items = a.get("items")
    if isinstance(items, dict):
        items = [items]
    if items is None:
        items = []
    if not isinstance(items, list):
        return _fail("items must be a list of objects (see fieldkit_workspace_format(part))")
    parts = build["parts"]
    removed = []
    for key in a.get("remove") or []:
        if key in (parts.get(part) or {}):
            parts[part].pop(key)
            removed.append(key)
    existing = _existing_workflows(store) if part in ("guides", "traceability") else {}
    accepted, rejected, fixes_out = [], [], {}
    old_policy = dict(parts.get("report_policy") or {})
    for i, raw in enumerate(items):
        item, fixes = wsc.normalize(part, raw)
        key = wsc.item_key(part, item)
        if part == "report_policy":
            parts["report_policy"] = {}     # one policy: a new one replaces the old (restored below if rejected)
        errs = wsc.check_item(part, item, _ctx(store, build, brief, existing))
        if part == "evidence" and _forged_practice(store, wid, item):
            errs = [{"path": "local_practice", "error": "local-practice evidence is created only by FieldKit from verified "
                     "follow-up outcomes (fieldkit_propose_workspace_changes); it cannot be written", "hint": ""}] + errs
        if fixes:
            fixes_out[key] = fixes[:20]
        if errs:
            rejected.append({"index": i, "key": key, "errors": errs[:12]})
            if part == "report_policy":
                parts["report_policy"] = old_policy
            continue
        parts.setdefault(part, {})[key] = item
        accepted.append(key)
    check = None
    if part == "evidence" and accepted:
        mini = {"sources": list((parts.get("sources") or {}).values()),
                "evidence": [parts["evidence"][k] for k in accepted]}
        check = ws.check_excerpts(mini, store=store, wait_s=EVIDENCE_WAIT_S)
    if part == "sources" and accepted:
        urls = [parts["sources"][k].get("url") for k in accepted if parts["sources"][k].get("url")]
        ws.fetch_pages(urls, store=store, wait_s=0)            # start downloading now; evidence checks reuse them
    out: dict = {"part": part, "accepted": accepted, "rejected": rejected, "removed": removed, "dry_run": bool(a.get("dry_run"))}
    if fixes_out:
        out["fixed_automatically"] = fixes_out
    if check:
        out["quote_check"] = check
        st = _statuses(parts)
        out["evidence_status"] = {k: st.get(k) for k in accepted}
        nf = [{"evidence_id": k, "source_id": x.get("source_id"), "note": x.get("check_note")} for k in accepted
              for x in parts["evidence"][k].get("excerpts") or [] if x.get("check") == "not_found"]
        if nf:
            out["quotes_not_found"] = nf[:20]
    if not a.get("dry_run"):
        store.save_workspace_build(ALL, wid, build["brief_id"], build["header"], parts)
    out["counts"] = _counts(parts)
    out["next"] = ("Fix each rejected item using its errors and hints, then add it again." if rejected else
                   ("Dry run only: nothing was saved. Call again without dry_run to save." if a.get("dry_run") else
                    "Saved. Continue with the next part; when all parts are in, call fieldkit_build_workspace(workspace_id)."))
    if check and out.get("quotes_not_found"):
        out["next"] += (" Some quotes were not found on their pages: re-open the page with web_extract and copy the exact "
                        "text, or the claim stays unsupported.")
    return _ok(**out)


def build_status(a: dict) -> str:
    store = get_store()
    if a.get("workspace_id"):
        b = store.get_workspace_build(a["workspace_id"])
        if not b:
            return _fail(f"no build in progress for {a['workspace_id']!r}")
        return _ok(**_status_dict(store, b))
    return _ok(builds=[{"workspace_id": b["workspace_id"], "title": b["header"].get("title"), "parts": _counts(b["parts"])}
                       for b in store.list_workspace_builds()])


def _check_whole_bundle(bundle: dict, store: Any, brief: dict) -> tuple[dict, list, dict]:
    """A complete bundle sent in one call: run the same per-part normalisation and checks, part by part."""
    build = {"workspace_id": bundle.get("id"), "brief_id": "", "header": {"languages": bundle.get("languages") or {}},
             "parts": _empty_parts()}
    existing = _existing_workflows(store)
    rejected, fixes_out = [], {}
    src = _parts_from_bundle(bundle)
    for p in wsc.PARTS:
        for key, raw in (src.get(p) or {}).items():
            item, fixes = wsc.normalize(p, raw)
            errs = wsc.check_item(p, item, _ctx(store, build, brief, existing))
            if fixes:
                fixes_out[f"{p}/{key}"] = fixes[:10]
            if errs:
                rejected.append({"part": p, "key": key, "errors": errs[:8]})
            build["parts"][p][wsc.item_key(p, item)] = item
    out = _assemble({**build, "header": {"title": bundle.get("title"), "languages": bundle.get("languages"),
                                         "workflow_refs": bundle.get("workflow_refs") or []}}, brief)
    for k in ("starter", "pack_refs"):
        if k in bundle:
            out[k] = bundle[k]
    return out, rejected, fixes_out


def build(a: dict) -> str:
    store = get_store()
    wid, bundle = a.get("workspace_id"), a.get("bundle")
    part_errors, fixes = [], {}
    if bundle is not None:                       # whole bundle in one call (small workspaces, scripted updates)
        bid = a.get("brief_id")
        if not bid:
            return _fail("brief_id required: interview the user and confirm the brief first (fieldkit_save_workspace_brief)")
        brief = _brief_for(store, bid)["brief"]
        if not isinstance(bundle, dict):
            return _fail("bundle must be an object; prefer fieldkit_start_workspace_build + fieldkit_add_workspace_parts")
        forged = [e.get("id") for e in bundle.get("evidence") or [] if _forged_practice(store, str(bundle.get("id")), e)]
        if forged:
            return _fail(f"evidence {forged} claims local practice from outcomes; only FieldKit's learning loop creates that")
        bundle, part_errors, fixes = _check_whole_bundle(dict(bundle, profile=bundle.get("profile") or brief), store, brief)
        bundle["profile"] = a["bundle"].get("profile") or brief
    else:
        b = store.get_workspace_build(wid or "")
        if not b:
            return _fail(f"no build in progress for {wid!r}: call fieldkit_start_workspace_build and add parts first "
                         "(or pass brief_id and a complete bundle)")
        bid = b["brief_id"]
        brief = _brief_for(store, bid)["brief"]
        bundle = _assemble(b, brief)
    checks = ws.check_excerpts(bundle, store=store, wait_s=BUILD_WAIT_S) if a.get("check_excerpts", True) else {"skipped": True}
    d = ws.build_draft(store, ALL, bundle, brief_id=bid, changelog=a.get("changelog"))
    rr = d["research_report"]
    pending = ws.pending_checks(bundle)
    compact = {
        "summary": rr["summary"], "quote_check": checks,
        "conflicting": rr["evidence"]["conflicting"], "unverified": [e["claim"] for e in rr["evidence"]["unverified"]][:20],
        "quotes_not_found": [{"evidence_id": e.get("id"), "source_id": x.get("source_id")} for e in bundle.get("evidence") or []
                             for x in e.get("excerpts") or [] if x.get("check") == "not_found"][:20],
        "quotes_approximate": [{"evidence_id": e.get("id"), "source_id": x.get("source_id"), "note": x.get("check_note")}
                               for e in bundle.get("evidence") or [] for x in e.get("excerpts") or []
                               if x.get("check") == "approximate"][:20],
        "quotes_not_checked": [{"evidence_id": e.get("id"), "source_id": x.get("source_id"), "note": x.get("check_note")}
                               for e in bundle.get("evidence") or [] for x in e.get("excerpts") or []
                               if x.get("check") == "not_checked"
                               and not str(x.get("check_note", "")).startswith("the user's own")][:20],
        "excluded_sources": [s for s in rr["sources"] if s["tier"] == 0],
        "downgraded_sources": [s for s in rr["sources"] if s["notes"]], "gaps": rr["gaps"],
    }
    errors = [{"part": e["part"], "key": e["key"], "errors": e["errors"]} for e in part_errors][:20] + d["validation"]["errors"][:30]
    valid = d["ok"] and not part_errors
    if valid and pending:
        nxt = (f"{pending} source quote(s) are still being checked in the background (slow pages). Wait a minute, then "
               "call fieldkit_build_workspace again; publishing is blocked until the checks finish.")
    elif valid:
        nxt = ("Show the research report to the user in plain language (verified / supported / conflicting / unverified "
               "background / gaps, and which sources were excluded or downgraded). Publish only after they approve.")
    else:
        nxt = ("Fix the errors: with a build in progress use fieldkit_add_workspace_parts to replace or remove the items "
               "named, then build again. Unsupported instructions need a quoted qualifying source or must be removed.")
    out = dict(workspace_id=d["workspace_id"], version=d["version"], valid=valid, checks_pending=pending, errors=errors,
               warnings=d["validation"]["warnings"][:20], research_report=compact, next=nxt)
    if fixes:
        out["fixed_automatically"] = dict(list(fixes.items())[:20])
    return _ok(**out)


def publish(a: dict) -> str:
    if not a.get("user_approved"):
        return _fail("publish only after the user has seen the research report and approved it (user_approved=true)")
    from .tools import app_link
    store = get_store()
    out = ws.publish(store, a["workspace_id"], a.get("version"), actor=ALL)
    store.delete_workspace_build(a["workspace_id"])          # the build is finished; updates start a new one
    link = app_link()
    link["url"] = link["url"] + f"#/workspace/{a['workspace_id']}"
    return _ok(**out, app_link=link, next="Give the user the app link; on the phone, open it and tap 'Download everything for offline'.")


def get(a: dict) -> str:
    rec = get_store().get_workspace_version(a["workspace_id"], a.get("version"))
    out = {k: rec[k] for k in ("workspace_id", "version", "status", "published_version", "latest_version", "starter", "changelog")}
    out["summary"] = rec["validation"].get("summary")
    out["errors"] = rec["validation"].get("errors", [])[:20]
    rr = ws.research_report(rec["bundle"], ws.validate_bundle(rec["bundle"], ws.existing_workflow_defs(get_store())))
    if a.get("include_bundle"):
        out["research_report"] = rr
        out["bundle"] = rec["bundle"]
    else:   # compact: what to tell the user; the full bundle only on request
        out["research_report"] = {"summary": rr["summary"], "errors": rr["errors"][:20],
                                  "evidence": {s: [{"id": e["id"], "claim": e["claim"], "notes": e["notes"][:3]} for e in v]
                                               for s, v in rr["evidence"].items() if v},
                                  "sources": [{k: s.get(k) for k in ("id", "title", "publisher", "tier", "notes")} for s in rr["sources"]],
                                  "gaps": [{"topic": g.get("topic"), "note": g.get("note")} for g in rr["gaps"] if isinstance(g, dict)]}
        quotes = [{"evidence_id": e.get("id"), "source_id": x.get("source_id"), "check": x.get("check"), "note": x.get("check_note")}
                  for e in rec["bundle"].get("evidence") or [] for x in e.get("excerpts") or []
                  if isinstance(x, dict) and x.get("check") not in (None, "found")]
        out["quotes_needing_attention"] = quotes[:30]
    return _ok(**out)


def list_all(a: dict) -> str:
    return _ok(workspaces=get_store().list_workspaces(published_only=not a.get("include_drafts")))


def propose_changes(a: dict) -> str:
    from . import learning
    new = learning.propose(get_store(), a["workspace_id"], int(a.get("min_outcomes") or learning.MIN_OUTCOMES))
    return _ok(new=new, open=learning.list_candidates(get_store(), a["workspace_id"], "open"),
               summary=learning.summary(get_store(), a["workspace_id"]),
               next="For research_gap: research it (skill), update and rebuild the workspace, then accept the candidate with a note. "
                    "For local_practice: show the outcome evidence; accept to create a draft version. For review_content: check "
                    "the content. Ask the user before accepting or rejecting.")


def list_learning(a: dict) -> str:
    from . import learning
    wid = a.get("workspace_id")
    ev = learning.events(get_store(), wid, a.get("kind"))[-50:]
    return _ok(summary=learning.summary(get_store(), wid), events=ev, candidates=learning.list_candidates(get_store(), wid, a.get("status")))


def decide_candidate(a: dict) -> str:
    from . import learning
    if a.get("decision") not in ("accept", "reject"):
        return _fail("decision must be accept or reject")
    if not a.get("user_confirmed"):
        return _fail("ask the user first; then call again with user_confirmed=true")
    return _ok(**learning.decide(get_store(), a["candidate_id"], a["decision"] == "accept", a.get("note", ""), ALL))


def _s(name: str, description: str, props: dict, required: list | None = None) -> dict:
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": props, "required": required or []}}


OBJ, STR, INT, BOOL = {"type": "object"}, {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
TOOLS = [
    (_s("fieldkit_workspace_format", "How to build a FieldKit workspace. Without part: the steps, part order and evidence "
        "rules. With part: that part's exact JSON Schema, a valid example and its rules. Read a part's schema before writing "
        "items for it.", {"part": {"type": "string", "enum": list(wsc.PARTS)}}), workspace_format),
    (_s("fieldkit_save_workspace_brief", "Save the interview result describing the user's actual job (role, industry, country, "
        "region, responsibilities with the decisions each needs, tools and instruments, procedures already used, languages, "
        "escalation roles). Returns what is missing and a summary to confirm with the user. Set confirmed=true only after the "
        "user confirmed the summary.", {"brief": OBJ, "brief_id": STR, "confirmed": BOOL}, ["brief"]), save_brief),
    (_s("fieldkit_start_workspace_build", "Start (or resume) building a workspace for a confirmed brief. Parts are then added "
        "one at a time with fieldkit_add_workspace_parts and saved server-side, so a long build can continue in a later chat. "
        "If the workspace already exists, the build starts from its latest version (for updates).",
        {"brief_id": STR, "workspace_id": STR, "title": OBJ, "languages": OBJ, "workflow_refs": {"type": "array", "items": STR},
         "restart": BOOL, "from_existing": BOOL}, ["brief_id", "workspace_id"]), start_build),
    (_s("fieldkit_add_workspace_parts", "Add, replace (same id) or remove items of one workspace part: sources, evidence, "
        "report_policy, workflows, guides, knowledge, vocabulary, intents, gaps or traceability. Each item is checked against "
        "the part's schema, the rest of the build (evidence ids, fields, decisions) and value types; unambiguous shape "
        "mistakes are repaired and reported. Evidence quotes are checked against their pages. dry_run=true checks without "
        "saving. To add several parts in one call, pass parts={part: [items], ...} instead of part/items.",
        {"workspace_id": STR, "part": {"type": "string", "enum": list(wsc.PARTS)},
         "items": {"type": "array", "items": OBJ}, "parts": OBJ, "remove": {"type": "array", "items": STR}, "dry_run": BOOL},
        ["workspace_id"]), add_parts),
    (_s("fieldkit_workspace_build_status", "Workspace builds in progress: parts added so far, what is missing, evidence "
        "status counts and item ids. Use it to continue a build in a new chat.", {"workspace_id": STR}), build_status),
    (_s("fieldkit_build_workspace", "Assemble the parts of a build (workspace_id), validate everything, check source quotes "
        "(bounded wait; slow pages keep loading in the background) and store a draft version with a research report. "
        "Alternatively pass brief_id and a complete bundle. Returns errors to fix, or the report to show the user.",
        {"workspace_id": STR, "brief_id": STR, "bundle": OBJ, "check_excerpts": BOOL,
         "changelog": {"type": "array", "items": STR}}), build),
    (_s("fieldkit_publish_workspace", "Publish a valid workspace draft so the user's phone can download it for offline use. "
        "Requires user_approved=true after the user reviewed the research report.",
        {"workspace_id": STR, "version": INT, "user_approved": BOOL}, ["workspace_id", "user_approved"]), publish),
    (_s("fieldkit_get_workspace", "Get a FieldKit workspace version with its research report (sources, evidence status, "
        "conflicts, gaps).", {"workspace_id": STR, "version": INT, "include_bundle": BOOL}, ["workspace_id"]), get),
    (_s("fieldkit_list_workspaces", "List FieldKit workspaces (published; include_drafts for drafts too).",
        {"include_drafts": BOOL}), list_all),
    (_s("fieldkit_propose_workspace_changes", "Turn a workspace's learning events into improvement candidates: questions the "
        "phone could not answer (research_gap), actions that verified follow-up outcomes show working (local_practice, needs "
        "enough consistent outcomes), and answers users marked unhelpful (review_content). AI suggestions and feedback alone "
        "never become guidance.", {"workspace_id": STR, "min_outcomes": INT}, ["workspace_id"]), propose_changes),
    (_s("fieldkit_list_learning", "Learning events (knowledge gaps, feedback, verified outcomes) and improvement candidates "
        "for a workspace.", {"workspace_id": STR, "kind": STR, "status": STR}), list_learning),
    (_s("fieldkit_decide_candidate", "Accept or reject an improvement candidate after asking the user. Accepting a "
        "local_practice creates a new draft workspace version; publish it with fieldkit_publish_workspace. Rejected "
        "candidates are never proposed again.", {"candidate_id": STR, "decision": STR, "note": STR, "user_confirmed": BOOL},
        ["candidate_id", "decision", "user_confirmed"]), decide_candidate),
]
