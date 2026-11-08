"""Hermes-powered analysis: records → structured reports, natural language → workflows/packs.

All model calls go through the host-owned ``ctx.llm`` (``PluginLlm.complete_structured``) so the
plugin never handles provider credentials. Outputs are JSON-schema constrained and then checked
by deterministic validators before anything is stored.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Optional

from . import engine, packs as packs_mod
from .db import ALL, Store

REPORT_SCHEMA: dict = {
    "type": "object",
    "required": ["summary", "issues", "missing_information", "suggested_actions", "followups", "requires_review"],
    "additionalProperties": False,
    "properties": {
        "summary": {"type": "string"},
        "issues": {"type": "array", "items": {
            "type": "object", "required": ["title", "severity", "evidence"], "additionalProperties": False,
            "properties": {"title": {"type": "string"}, "severity": {"enum": ["info", "low", "medium", "high", "critical"]},
                           "evidence": {"type": "string"}, "field_ids": {"type": "array", "items": {"type": "string"}}}}},
        "missing_information": {"type": "array", "items": {"type": "string"}},
        "references": {"type": "array", "items": {
            "type": "object", "required": ["title"], "additionalProperties": False,
            "properties": {"title": {"type": "string"}, "source": {"type": "string"}, "entry_id": {"type": "string"}}}},
        "suggested_actions": {"type": "array", "items": {
            "type": "object", "required": ["action", "priority"], "additionalProperties": False,
            "properties": {"action": {"type": "string"}, "priority": {"enum": ["low", "medium", "high", "urgent"]}}}},
        "followups": {"type": "array", "items": {
            "type": "object", "required": ["title"], "additionalProperties": False,
            "properties": {"title": {"type": "string"}, "detail": {"type": "string"}, "due_in_days": {"type": "integer"}}}},
        "requires_review": {"type": "boolean"},
        "review_reason": {"type": "string"},
    },
}

SYSTEM = (
    "You are FieldKit's analysis component inside Hermes Agent. You analyse one structured field record. "
    "Use ONLY the record, the workflow definition, the locally generated findings and the reference passages provided. "
    "Never invent measurements or facts. If information needed for a conclusion is absent, list it under "
    "missing_information. Cite reference passages by title in references. Mark requires_review true for anything "
    "safety-related, medical, legal, or uncertain. Keep the summary under 120 words."
)


def _answers_for_prompt(wf: dict, answers: dict, lang: str) -> list[dict]:
    rows = []
    for f in wf["fields"]:
        if f["type"] == "instruction" or f["id"] not in answers:
            continue
        v = answers[f["id"]]
        if f["type"] in ("photo", "audio", "signature"):
            items = v if isinstance(v, list) else [v]
            v = [{k: x.get(k) for k in ("attachment_id", "transcript", "ocr_text", "caption") if isinstance(x, dict) and x.get(k)}
                 for x in items]
        elif f["type"] in ("single_choice", "multi_choice"):
            labels = {o["value"]: engine.text(o["label"], lang) for o in f.get("options", [])}
            v = [labels.get(x, x) for x in v] if isinstance(v, list) else labels.get(v, v)
        rows.append({"field_id": f["id"], "question": engine.text(f["label"], lang), "answer": v, "unit": f.get("unit")})
    return rows


def build_context(store: Store, record: dict, wf: dict, lang: str = "en") -> dict:
    answers = record["answers"]
    local = record.get("local_results") or {}
    findings = local.get("findings") or engine.classify(wf, answers, lang)
    pack_docs = [p for p in (store.get_pack_content(pid) for pid in wf.get("knowledge_packs", [])) if p]
    query = " ".join([engine.text(wf.get("title"), lang)] + [f.get("label", "") for f in findings] +
                     [str(a.get("answer")) for a in _answers_for_prompt(wf, answers, lang) if isinstance(a.get("answer"), str)])
    refs = packs_mod.search_knowledge(pack_docs, query, k=5, lang=lang) if pack_docs else []
    return {
        "workflow": {"id": wf["id"], "version": wf.get("version"), "title": engine.text(wf.get("title"), lang),
                     "domain": wf.get("domain", ""), "analysis_instructions": wf.get("analysis_instructions", ""),
                     "review_required": bool(wf.get("review_required"))},
        "record": {"id": record["id"], "revision": record["revision"], "completed_at": record.get("completed_at"),
                   "device_id": record.get("device_id"), "answers": _answers_for_prompt(wf, answers, lang)},
        "local_findings": findings,
        "reference_passages": [{"title": r["title"], "source": r["source"], "entry_id": r["entry_id"], "text": r["text"][:1500]}
                               for r in refs],
    }


def _image_inputs(record: dict, limit: int = 2, max_bytes: int = 4_000_000) -> list[dict]:
    out = []
    for a in record.get("attachments", []):
        if len(out) >= limit:
            break
        if a.get("status") == "stored" and str(a.get("mime", "")).startswith("image/"):
            path = a.get("path")
            if path and Path(path).exists() and Path(path).stat().st_size <= max_bytes:
                out.append({"type": "image", "data": Path(path).read_bytes(), "mime_type": a["mime"]})
    return out


def analyze_record(store: Store, llm: Any, record_id: str, *, owner: Any = ALL, lang: str = "en",
                   with_images: bool = True) -> tuple[dict, bool, str, str]:
    """Run one structured analysis. Returns (report, requires_review, provider, model). Raises on failure."""
    if llm is None:
        raise RuntimeError("Hermes LLM access (ctx.llm) is not available in this process")
    record = store.get_record(owner, record_id)
    if with_images:
        for a in record["attachments"]:
            try:
                a["path"] = store.get_attachment(owner, a["id"]).get("path")
            except Exception:
                a["path"] = None
    wf = store.get_workflow_any_owner(record["workflow_id"], record["workflow_version"])
    if not wf:
        raise RuntimeError(f"workflow {record['workflow_id']}@{record['workflow_version']} missing")
    context = build_context(store, record, wf, lang)
    inputs: list[dict] = [{"type": "text", "text": json.dumps(context, ensure_ascii=False, indent=1)}]
    if with_images:
        inputs += _image_inputs(record)
    result = llm.complete_structured(
        instructions="Produce the FieldKit report for this record as JSON matching the schema.",
        input=inputs, json_schema=REPORT_SCHEMA, schema_name="fieldkit.report", system_prompt=SYSTEM,
        temperature=0.2, max_tokens=1800, purpose="fieldkit.analyze_record", timeout=120,
    )
    report = result.parsed
    if not isinstance(report, dict):
        raise RuntimeError("model did not return a parseable report")
    report = _normalize_report(report, context)
    critical = any(i.get("severity") in ("high", "critical") for i in report["issues"]) or any(
        f.get("severity") in ("high", "critical") for f in context["local_findings"])
    requires_review = bool(report.get("requires_review")) or (context["workflow"]["review_required"] and critical)
    report["requires_review"] = requires_review
    return report, requires_review, getattr(result, "provider", "") or "", getattr(result, "model", "") or ""


def _normalize_report(report: dict, context: dict) -> dict:
    now = time.time()
    fus = []
    for f in report.get("followups", []) or []:
        days = f.get("due_in_days")
        due = time.strftime("%Y-%m-%d", time.gmtime(now + 86400 * int(days))) if isinstance(days, int) and 0 <= days < 3650 else None
        fus.append({"title": f.get("title", "")[:300], "detail": f.get("detail", "")[:2000], "due_date": due})
    return {
        "summary": str(report.get("summary", ""))[:4000],
        "issues": report.get("issues", [])[:50],
        "missing_information": [str(x) for x in report.get("missing_information", [])][:50],
        "references": report.get("references", [])[:20],
        "suggested_actions": report.get("suggested_actions", [])[:30],
        "followups": fus[:20],
        "requires_review": bool(report.get("requires_review")),
        "review_reason": str(report.get("review_reason", ""))[:1000],
        "workflow": context["workflow"],
        "observations": context["record"]["answers"],
        "local_findings": context["local_findings"],
        "available_references": [{"title": r["title"], "source": r["source"], "entry_id": r["entry_id"]}
                                 for r in context["reference_passages"]],
        "source": "hermes",
    }


def process_pending(store: Store, llm: Any, limit: int = 2) -> list[dict]:
    """Claim and run ready jobs. Each job is retried with backoff and fails permanently after max_attempts."""
    done = []
    for job in store.claim_jobs(limit):
        try:
            report, review, provider, model = analyze_record(store, llm, job["record_id"])
            saved = store.complete_job(job, report, review, provider, model, generated_by="fieldkit.worker")
            done.append({"job_id": job["id"], "record_id": job["record_id"], "report_id": saved["report_id"],
                         "status": "requires_review" if review else "completed"})
        except Exception as exc:  # job-level isolation
            status = store.fail_job(job, f"{type(exc).__name__}: {exc}")
            done.append({"job_id": job["id"], "record_id": job["record_id"], "status": status, "error": str(exc)[:300]})
    return done


# ----------------------------------------------------------------------------- generation
WORKFLOW_GEN_INSTRUCTIONS = (
    "Design a FieldKit workflow (a mobile data-collection form) from the user's request. Output JSON that matches "
    "the provided JSON schema exactly. Rules: field ids are snake_case; use visible_if/required_if conditions "
    "(JSON AST with op/field/value) for branching; use instruction fields for guidance text; add a classification "
    "block (rules/keywords/scores/decision_trees) that produces useful LOCAL findings without any code; provide labels "
    "in every requested language as {lang: text}; never include scripts, URLs to execute, or code."
)


def generate_workflow(llm: Any, request: str, languages: list[str], domain: str = "", wid: Optional[str] = None) -> dict:
    if llm is None:
        raise RuntimeError("Hermes LLM access (ctx.llm) is not available")
    schema = json.loads(engine.SCHEMA_PATH.read_text(encoding="utf-8"))
    schema.pop("$id", None)
    schema.pop("$schema", None)
    hint = {"request": request, "languages": languages or ["en"], "domain": domain, "id": wid or ""}
    result = llm.complete_structured(
        instructions=WORKFLOW_GEN_INSTRUCTIONS, input=[{"type": "text", "text": json.dumps(hint, ensure_ascii=False)}],
        json_schema=schema, schema_name="fieldkit.workflow", temperature=0.3, max_tokens=6000,
        purpose="fieldkit.create_workflow", timeout=180,
    )
    wf = result.parsed
    if not isinstance(wf, dict):
        raise RuntimeError("model did not return a workflow object")
    if wid:
        wf["id"] = wid
    wf.setdefault("languages", languages or ["en"])
    wf.setdefault("default_language", (languages or ["en"])[0])
    if domain:
        wf.setdefault("domain", domain)
    return wf


KNOWLEDGE_GEN_INSTRUCTIONS = (
    "Turn the supplied reference material into FieldKit knowledge entries. Use ONLY the supplied material. "
    "Each entry: id (slug), type (explanation|procedure|faq|troubleshooting|term|reference), title, text (self-contained, "
    "<= 1200 chars), tags, source (the document title/section). Include FAQ entries for likely questions and "
    "troubleshooting entries where the material supports them. Do not add facts that are not in the material."
)
KNOWLEDGE_ENTRY_SCHEMA = {
    "type": "object", "required": ["entries"], "additionalProperties": False,
    "properties": {"entries": {"type": "array", "items": {
        "type": "object", "required": ["id", "type", "title", "text"], "additionalProperties": False,
        "properties": {"id": {"type": "string"}, "type": {"enum": list(packs_mod.ENTRY_TYPES)}, "title": {"type": "string"},
                       "text": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}},
                       "source": {"type": "string"}, "related": {"type": "array", "items": {"type": "string"}},
                       "followups": {"type": "array", "items": {"type": "string"}}}}}},
}


def generate_knowledge_entries(llm: Any, title: str, document: str) -> list[dict]:
    if llm is None:
        raise RuntimeError("Hermes LLM access (ctx.llm) is not available")
    result = llm.complete_structured(
        instructions=KNOWLEDGE_GEN_INSTRUCTIONS,
        input=[{"type": "text", "text": f"Document title: {title}\n\n{document[:60000]}"}],
        json_schema=KNOWLEDGE_ENTRY_SCHEMA, schema_name="fieldkit.knowledge", temperature=0.2, max_tokens=6000,
        purpose="fieldkit.create_knowledge_pack", timeout=180,
    )
    parsed = result.parsed
    if not isinstance(parsed, dict) or not isinstance(parsed.get("entries"), list):
        raise RuntimeError("model did not return knowledge entries")
    return parsed["entries"]
