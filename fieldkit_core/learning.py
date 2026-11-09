"""Learning loop (0.2.5; plan section 8). Keeps four kinds of input apart and never lets weak ones change guidance:

- ``ai_suggestion``     report actions and research proposals: never evidence on their own;
- ``user_feedback``     helpful / not helpful on answers and reports: can flag content for review, never certify it;
- ``verified_outcome``  follow-up checks answered on a later inspection (the record is the evidence): enough consistent
                        ones can propose a "local practice" entry, labelled with n;
- ``knowledge_gap``     questions the phone could not answer: proposed for research.

Every change is a *candidate* that a person approves; approval creates a new workspace version with a changelog.
Rejected candidates keep their fingerprint and are never proposed again.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any, Optional

from . import decision, workspace as ws
from .db import ALL, Invalid, NotFound, _id, _j, _uj

APP_KINDS = ("knowledge_gap", "user_feedback")          # what a phone may send; outcomes are derived from records
MIN_OUTCOMES = 3                                        # verified outcomes needed before a local practice is proposed
MIN_SUCCESS = 0.8
MIN_GAP_ASKS = 1


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", str(t or "").lower(), flags=re.U)).strip()


def _fp(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


def _tokens(t: str) -> set:
    return {w for w in _norm(t).split() if len(w) > 2}


# ----------------------------------------------------------------------------- ingest
def save_events(store: Any, owner: str, device_id: str, events: list) -> dict:
    """Store events from a phone (idempotent per idempotency_key). Only gaps and feedback are accepted from clients."""
    if not isinstance(events, list) or len(events) > 200:
        raise Invalid("events must be a list of at most 200 items")
    saved, dup, rejected = 0, 0, []
    now = time.time()
    with store.tx() as c:
        for e in events:
            if not isinstance(e, dict) or e.get("kind") not in APP_KINDS or not e.get("idempotency_key"):
                rejected.append(str((e or {}).get("id") if isinstance(e, dict) else "?"))
                continue
            payload = e.get("payload") if isinstance(e.get("payload"), dict) else {}
            if len(_j(payload)) > 8000:
                rejected.append(str(e.get("id")))
                continue
            try:
                c.execute("INSERT INTO learning_events(id, owner_user_id, workspace_id, kind, ref_type, ref_id, payload, device_id, "
                          "idempotency_key, created_at, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (_id("lev"), owner, e.get("workspace_id"), e["kind"], e.get("ref_type"), e.get("ref_id"), _j(payload),
                           device_id[:64], str(e["idempotency_key"])[:128], _ts(e.get("created_at"), now), now))
                saved += 1
            except Exception:
                dup += 1                                     # UNIQUE(owner, idempotency_key): already stored
    return {"saved": saved, "duplicates": dup, "rejected": rejected}


def _ts(v: Any, default: float) -> float:
    try:
        return time.mktime(time.strptime(str(v)[:19], "%Y-%m-%dT%H:%M:%S")) if v else default
    except Exception:
        return default


def record_outcomes(store: Any, owner: str, record_id: str) -> int:
    """Turn the follow-up checks answered in a synced record into verified-outcome events (idempotent)."""
    rec = store.get_record(owner, record_id)
    checks = (rec.get("local_results") or {}).get("followup_checks") or []
    if not checks:
        return 0
    wsm = decision.workspace_for_workflow(store, rec["workflow_id"])
    n = 0
    now = time.time()
    with store.tx() as c:
        for chk in checks:
            if not isinstance(chk, dict) or chk.get("result") not in ("done", "not_done", "cannot_check"):
                continue
            key = f"vo:{record_id}:{chk.get('id')}"
            payload = {"what": str(chk.get("what", ""))[:300], "how": str(chk.get("how", ""))[:300], "result": chk["result"],
                       "value": str(chk.get("value", ""))[:200], "report_id": chk.get("report_id"),
                       "earlier_record_id": chk.get("record_id"), "verified_in_record": record_id}
            try:
                c.execute("INSERT INTO learning_events(id, owner_user_id, workspace_id, kind, ref_type, ref_id, payload, device_id, "
                          "idempotency_key, created_at, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (_id("lev"), owner, (wsm or {}).get("workspace_id"), "verified_outcome", "report", chk.get("report_id"),
                           _j(payload), "", key, now, now))
                n += 1
            except Exception:
                pass
    return n


def events(store: Any, workspace_id: Optional[str] = None, kind: Optional[str] = None) -> list[dict]:
    sql, args = "SELECT * FROM learning_events WHERE 1=1", []
    if workspace_id:
        # Only this workspace's events: an unattributed question must not become another workspace's candidate.
        sql += " AND workspace_id=?"
        args.append(workspace_id)
    if kind:
        sql += " AND kind=?"
        args.append(kind)
    return [{**dict(r), "payload": _uj(r["payload"])} for r in store._q(sql + " ORDER BY received_at", tuple(args))]


def summary(store: Any, workspace_id: Optional[str] = None) -> dict:
    ev = events(store, workspace_id)
    out = {k: sum(1 for e in ev if e["kind"] == k) for k in ("knowledge_gap", "user_feedback", "verified_outcome")}
    out["open_candidates"] = len(list_candidates(store, workspace_id, status="open"))
    return out


# ----------------------------------------------------------------------------- candidates
def _existing(store: Any, workspace_id: str) -> dict:
    return {r["fingerprint"]: r["status"] for r in store._q("SELECT fingerprint, status FROM candidates WHERE workspace_id=?", (workspace_id,))}


def _add(store: Any, workspace_id: str, kind: str, target: str, payload: dict, basis: dict, fp: str) -> dict:
    cid = _id("cand")
    with store.tx() as c:
        c.execute("INSERT INTO candidates(id, workspace_id, kind, target, payload, basis, status, fingerprint, created_at) "
                  "VALUES (?,?,?,?,?,?,?,?,?)", (cid, workspace_id, kind, target, _j(payload), _j(basis), "open", fp, time.time()))
    return {"id": cid, "kind": kind, "target": target, "payload": payload, "basis": basis, "status": "open"}


def propose(store: Any, workspace_id: str, min_outcomes: int = MIN_OUTCOMES) -> list[dict]:
    """Create candidates from the learning events of one workspace. Returns the new ones."""
    store.get_workspace_version(workspace_id)            # NotFound for an unknown workspace
    seen = _existing(store, workspace_id)
    new: list[dict] = []

    # 1. Knowledge gaps → research candidates (clustered by shared words).
    clusters: list[dict] = []
    for e in events(store, workspace_id, "knowledge_gap"):
        q = str(e["payload"].get("question", ""))
        toks = _tokens(q)
        for cl in clusters:
            if toks and len(toks & cl["tokens"]) / max(1, len(toks | cl["tokens"])) >= 0.5:
                cl["questions"].append(q); cl["events"].append(e["id"]); cl["tokens"] |= toks
                break
        else:
            clusters.append({"tokens": set(toks), "questions": [q], "events": [e["id"]], "lang": e["payload"].get("lang")})
    for cl in clusters:
        if len(cl["questions"]) < MIN_GAP_ASKS:
            continue
        fp = _fp("gap", " ".join(sorted(cl["tokens"])))
        if fp in seen:
            continue
        new.append(_add(store, workspace_id, "research_gap", cl["questions"][0],
                        {"questions": cl["questions"][:10], "asked": len(cl["questions"]), "lang": cl["lang"],
                         "instruction": "Research with reliable sources (fieldkit-workspace-builder skill), add the answer to the "
                                        "workspace with evidence, rebuild and publish; or reject if out of scope."},
                        {"type": "knowledge_gap", "events": cl["events"], "count": len(cl["events"])}, fp))

    # 2. Verified outcomes → local-practice candidates (only with enough consistent, verified results).
    groups: dict[str, dict] = {}
    for e in events(store, workspace_id, "verified_outcome"):
        p = e["payload"]
        if p.get("result") not in ("done", "not_done"):
            continue                                       # "can't check" is not an outcome
        k = _norm(p.get("what", ""))
        g = groups.setdefault(k, {"what": p.get("what"), "how": p.get("how"), "done": 0, "n": 0, "records": set(), "events": []})
        if p.get("verified_in_record") in g["records"]:
            continue
        g["records"].add(p.get("verified_in_record"))
        g["n"] += 1
        g["done"] += p["result"] == "done"
        g["events"].append(e["id"])
    for k, g in groups.items():
        if g["n"] < min_outcomes or g["done"] / g["n"] < MIN_SUCCESS:
            continue
        fp = _fp("practice", k)
        if fp in seen:
            continue
        new.append(_add(store, workspace_id, "local_practice", g["what"],
                        {"action": g["what"], "verify_by": g["how"], "label": f"Learned from your team's verified outcomes "
                         f"(worked in {g['done']} of {g['n']} follow-up checks)"},
                        {"type": "verified_outcomes", "n": g["n"], "done": g["done"], "records": sorted(g["records"]),
                         "events": g["events"]}, fp))

    # 3. Negative feedback → review flags (feedback can flag, never certify).
    neg: dict[str, list] = {}
    for e in events(store, workspace_id, "user_feedback"):
        if e["payload"].get("helpful") is False:
            neg.setdefault(_norm(e["payload"].get("question", ""))[:120], []).append(e)
    for k, evs in neg.items():
        fp = _fp("review", k)
        if not k or fp in seen:
            continue
        new.append(_add(store, workspace_id, "review_content", evs[0]["payload"].get("question", ""),
                        {"question": evs[0]["payload"].get("question"), "answer": evs[0]["payload"].get("answer"),
                         "instruction": "Check this answer's content and sources; correct the workspace if it is wrong."},
                        {"type": "user_feedback", "not_helpful": len(evs), "events": [e["id"] for e in evs]}, fp))
    return new


def list_candidates(store: Any, workspace_id: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
    sql, args = "SELECT * FROM candidates WHERE 1=1", []
    if workspace_id:
        sql += " AND workspace_id=?"
        args.append(workspace_id)
    if status:
        sql += " AND status=?"
        args.append(status)
    return [{**dict(r), "payload": _uj(r["payload"]), "basis": _uj(r["basis"])} for r in store._q(sql + " ORDER BY created_at", tuple(args))]


def decide(store: Any, candidate_id: str, accept: bool, note: str = "", actor: Any = ALL) -> dict:
    """Reject (remembered, never re-proposed) or accept. Accepting a local practice adds it to a new draft version of
    the workspace as a labelled entry backed by the outcome evidence; research and review candidates are accepted after
    Hermes has updated the workspace (note which version answered it)."""
    rows = store._q("SELECT * FROM candidates WHERE id=?", (candidate_id,))
    if not rows:
        raise NotFound(candidate_id)
    cand = {**dict(rows[0]), "payload": _uj(rows[0]["payload"]), "basis": _uj(rows[0]["basis"])}
    if cand["status"] != "open":
        raise Invalid(f"candidate is already {cand['status']}")
    draft = None
    if accept and cand["kind"] == "local_practice":
        rec = store.get_workspace_version(cand["workspace_id"])
        b = json.loads(json.dumps(rec["bundle"]))
        eid = f"ev_outcomes_{candidate_id[-8:]}"
        b.setdefault("evidence", []).append({"id": eid, "claim": cand["payload"]["action"], "local_practice": True,
                                             "outcomes": {"n": cand["basis"]["n"], "done": cand["basis"]["done"],
                                                          "records": cand["basis"]["records"]},
                                             "applicability": {"matches_profile": True, "notes": "this team's own verified outcomes"}})
        b.setdefault("knowledge", {}).setdefault("entries", []).append({
            "id": f"k_practice_{candidate_id[-8:]}", "type": "procedure",
            "title": {lg: cand["payload"]["action"] for lg in (b.get("languages") or {}).get("content", ["en"])},
            "text": {lg: f"{cand['payload']['action']}. {cand['payload']['label']}. Check: {cand['payload'].get('verify_by') or ''}"
                     for lg in (b.get("languages") or {}).get("content", ["en"])},
            "evidence_ids": [eid], "learned": True})
        b.pop("version", None)
        draft = ws.build_draft(store, actor, b, changelog=[f"Added local practice from verified outcomes: {cand['payload']['action']} "
                                                           f"({cand['basis']['done']}/{cand['basis']['n']})"])
        if not draft["ok"]:
            raise Invalid("the workspace with this practice did not validate: " + "; ".join(draft["validation"]["errors"][:5]))
    with store.tx() as c:
        c.execute("UPDATE candidates SET status=?, decided_at=?, decided_by=?, decision_note=? WHERE id=?",
                  ("accepted" if accept else "rejected", time.time(), "owner" if actor is ALL else str(actor), note[:500], candidate_id))
    out = {"candidate_id": candidate_id, "status": "accepted" if accept else "rejected"}
    if draft:
        out["draft"] = {"workspace_id": draft["workspace_id"], "version": draft["version"], "valid": draft["ok"],
                        "next": "Show the change to the user and publish with fieldkit_publish_workspace (user_approved)."}
    return out
