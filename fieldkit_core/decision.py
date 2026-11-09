"""Decision-focused reports (report v2; plan section 7).

A report must help the user decide: a decision on a defined scale with its confidence and deadline, issues that
interpret cited evidence (not restate answers), ordered next actions that say who, by when, how to do it offline and
how to verify it worked, what is uncertain and how to resolve it, and follow-up checks that the next inspection asks.
`check_report` enforces this deterministically after the model answers; the analysis asks the model to repair once.
"""
from __future__ import annotations

import json
from typing import Any, Optional

DEFAULT_SCALE = [
    {"id": "stop", "label": {"en": "Stop and escalate now", "hi": "अभी रोकें और सूचित करें"}, "severity": "critical"},
    {"id": "act_soon", "label": {"en": "Act within days", "hi": "कुछ दिनों में कार्रवाई करें"}, "severity": "medium"},
    {"id": "monitor", "label": {"en": "Continue and monitor", "hi": "जारी रखें और निगरानी करें"}, "severity": "low"},
    {"id": "no_action", "label": {"en": "No action needed", "hi": "कोई कार्रवाई आवश्यक नहीं"}, "severity": "info"},
]

EVIDENCE_KINDS = ["answer", "photo", "photo_text", "voice_quote", "measurement", "local_finding", "previous_record",
                  "followup_check", "reference"]

# JSON-schema additions merged into analysis.REPORT_SCHEMA (structured output).
V2_PROPERTIES = {
    "decision": {"type": "object", "required": ["outcome", "rationale", "confidence"], "additionalProperties": False,
                 "properties": {"outcome": {"type": "string"}, "rationale": {"type": "string"},
                                "confidence": {"enum": ["high", "medium", "low"]},
                                "deadline_days": {"type": "integer"}, "escalate_to": {"type": "string"}}},
    "next_actions": {"type": "array", "items": {
        "type": "object", "required": ["action", "verify_by", "origin"], "additionalProperties": False,
        "properties": {"order": {"type": "integer"}, "action": {"type": "string"}, "who": {"type": "string"},
                       "by_when_days": {"type": "integer"}, "guide_id": {"type": "string"}, "entry_id": {"type": "string"},
                       "verify_by": {"type": "string"}, "origin": {"enum": ["guide", "knowledge", "ai_suggestion"]}}}},
    "uncertainty": {"type": "array", "items": {
        "type": "object", "required": ["unknown", "how_to_resolve"], "additionalProperties": False,
        "properties": {"unknown": {"type": "string"}, "impact": {"type": "string"}, "how_to_resolve": {"type": "string"}}}},
    "differences_from_local_findings": {"type": "array", "items": {
        "type": "object", "required": ["local", "hermes", "why"], "additionalProperties": False,
        "properties": {"local": {"type": "string"}, "hermes": {"type": "string"}, "why": {"type": "string"}}}},
    "follow_up_verification": {"type": "array", "items": {
        "type": "object", "required": ["what", "how"], "additionalProperties": False,
        "properties": {"what": {"type": "string"}, "how": {"type": "string"}, "due_in_days": {"type": "integer"}}}},
    "translations": {"type": "object", "additionalProperties": {
        "type": "object", "additionalProperties": False,
        "properties": {"summary": {"type": "string"}, "rationale": {"type": "string"},
                       "next_actions": {"type": "array", "items": {"type": "string"}},
                       "issues": {"type": "array", "items": {"type": "string"}}}}},
}
ISSUE_V2 = {"interpretation": {"type": "string"}, "evidence_refs": {"type": "array", "items": {
    "type": "object", "required": ["kind", "ref"], "additionalProperties": False,
    "properties": {"kind": {"enum": EVIDENCE_KINDS}, "ref": {"type": "string"}, "quote": {"type": "string"}}}},
    "guidance_refs": {"type": "array", "items": {"type": "string"}}}

INSTRUCTIONS = (
    "Help the user DECIDE. decision.outcome must be one of the ids in decision_scale; give a rationale, an honest "
    "confidence (high only when the decisive facts were measured and nothing conflicts), deadline_days, and escalate_to "
    "for critical outcomes. Each issue must cite evidence_refs from the record (kind + ref: a field id, attachment id, "
    "local finding id, previous record id or follow-up check) and add an interpretation: what it means and why it "
    "matters, not a restatement. next_actions are ordered, say who and by_when_days, and each has verify_by: the "
    "observation that proves it worked. Use origin 'guide' with a guide_id or 'knowledge' with an entry_id only for "
    "items listed in workspace_guides / workspace_knowledge; otherwise origin 'ai_suggestion'. List what is uncertain "
    "and how to resolve it. Explain any difference from the phone's local findings. follow_up_verification lists checks "
    "for the next inspection. If report_languages has more than one language, add translations for the others."
)


def scale_for(workspace: Optional[dict]) -> list[dict]:
    s = (workspace or {}).get("report_policy", {}).get("decision_scale") or []
    return s if s else DEFAULT_SCALE


def workspace_for_workflow(store: Any, workflow_id: str) -> Optional[dict]:
    """The published workspace manifest that contains this workflow (a built workspace beats a starter)."""
    from .db import ALL
    best = None
    try:
        for p in store.list_packs(ALL, "workspace"):
            m = json.loads(store.get_pack(ALL, p["id"])["content"])
            if any(w.get("id") == workflow_id for w in m.get("workflows", [])):
                if not m.get("starter"):
                    return m
                best = best or m
    except Exception:
        return None
    return best


def workspace_context(ws: Optional[dict]) -> dict:
    """What the model may cite: guides and evidenced knowledge (by id), escalation roles, languages."""
    if not ws:
        return {"workspace": None, "workspace_guides": [], "workspace_knowledge": []}
    status = {e.get("id"): e.get("status") for e in ws.get("evidence", [])}
    guides = []
    for g in ws.get("guides", []):
        outs = [n["outcome"].get("decision") for n in (g.get("nodes") or {}).values() if isinstance(n, dict) and n.get("outcome")]
        guides.append({"id": g.get("id"), "title": g.get("title"), "outcomes": outs})
    return {"workspace": {"id": ws.get("workspace_id"), "title": ws.get("title"), "role": (ws.get("profile") or {}).get("role"),
                          "escalation": (ws.get("profile") or {}).get("escalation", []), "starter": bool(ws.get("starter"))},
            "workspace_guides": guides, "_evidence_status": status}


def allowed_refs(record: dict, local_findings: list, files: list) -> set:
    refs = set((record.get("answers") or {}).keys())
    refs |= {f.get("id") for f in local_findings if isinstance(f, dict) and f.get("id")}
    refs |= {f.get("id") for f in files if isinstance(f, dict)}
    for c in (record.get("local_results") or {}).get("followup_checks") or []:
        if isinstance(c, dict) and c.get("id"):
            refs.add(c["id"])
    return {r for r in refs if r}


def check_report(report: dict, scale: list, refs: set, guide_ids: set, entry_ids: set) -> list[str]:
    """Deterministic quality rules. Returns problems (empty = acceptable)."""
    p: list[str] = []
    ids = {s["id"]: s for s in scale}
    d = report.get("decision") or {}
    if d.get("outcome") not in ids:
        p.append(f"decision.outcome '{d.get('outcome')}' is not one of {sorted(ids)}")
    elif ids[d["outcome"]].get("severity") in ("critical", "high") and not d.get("escalate_to"):
        p.append("a critical/high decision must name escalate_to (a role)")
    if not str(d.get("rationale") or "").strip():
        p.append("decision.rationale is empty")
    for i, it in enumerate(report.get("issues") or []):
        er = [e for e in it.get("evidence_refs") or [] if isinstance(e, dict)]
        cited = [e for e in er if e.get("ref") in refs or e.get("kind") == "reference"]
        if not cited:
            p.append(f"issue {i + 1} '{it.get('title')}' cites no evidence from this record (evidence_refs)")
        interp = str(it.get("interpretation") or "").strip()
        if len(interp) < 15 or interp.lower() == str(it.get("evidence") or "").strip().lower():
            p.append(f"issue {i + 1} '{it.get('title')}' restates the answer; add what it means and why it matters (interpretation)")
    for i, a in enumerate(report.get("next_actions") or []):
        if not str(a.get("verify_by") or "").strip():
            p.append(f"action {i + 1} has no verify_by")
        if a.get("origin") == "guide" and a.get("guide_id") not in guide_ids:
            p.append(f"action {i + 1} cites guide '{a.get('guide_id')}' that is not in workspace_guides; use origin ai_suggestion")
        if a.get("origin") == "knowledge" and a.get("entry_id") not in entry_ids:
            p.append(f"action {i + 1} cites knowledge '{a.get('entry_id')}' that is not in workspace_knowledge; use origin ai_suggestion")
    if not report.get("next_actions") and d.get("outcome") not in ("no_action",) and ids.get(d.get("outcome"), {}).get("severity") != "info":
        p.append("next_actions is empty for a decision that requires action")
    if d.get("confidence") == "high" and (report.get("uncertainty") or []) and any(
            "decisive" in str(u.get("impact", "")).lower() for u in report["uncertainty"]):
        p.append("confidence is high but a decisive fact is uncertain; lower the confidence")
    return p


def followups_from(report: dict) -> list[dict]:
    """Next actions and follow-up checks become follow-up tasks that carry their verification."""
    out = []
    for a in report.get("next_actions") or []:
        days = a.get("by_when_days")
        out.append({"title": str(a.get("action", ""))[:300],
                    "detail": f"Verify: {a.get('verify_by', '')}" + (f" · Who: {a['who']}" if a.get("who") else ""),
                    "due_in_days": days if isinstance(days, int) else None, "verify_by": a.get("verify_by", "")})
    for c in report.get("follow_up_verification") or []:
        out.append({"title": f"Check: {c.get('what', '')}"[:300], "detail": f"How: {c.get('how', '')}",
                    "due_in_days": c.get("due_in_days") if isinstance(c.get("due_in_days"), int) else None,
                    "verify_by": c.get("how", "")})
    return out
