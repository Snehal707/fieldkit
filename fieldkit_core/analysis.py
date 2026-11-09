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

from . import engine, media, packs as packs_mod
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
    "missing_information. Cite reference passages by title in references. Keep the summary under 120 words. "
    "Set requires_review true ONLY when (a) a high or critical issue needs a qualified person's decision before work "
    "continues, (b) evidence conflicts or a decisive measurement is missing so no safe conclusion is possible, or "
    "(c) the decision legally or medically requires sign-off. A finding with clear evidence and a clear next action "
    "(for example a leak to repair within a week) is NOT a review case: set requires_review false. When true, "
    "review_reason must say which of (a), (b) or (c) applies and why."
)


def _answers_for_prompt(wf: dict, answers: dict, lang: str, files: Optional[dict] = None) -> list[dict]:
    """Answers as the model sees them. Media answers are described by kind: a photo with any text read from it,
    a voice note with its transcript (from the phone or from Hermes speech-to-text), a signature with its time."""
    files = files or {}
    rows = []
    for f in wf["fields"]:
        if f["type"] == "instruction" or f["id"] not in answers:
            continue
        v = answers[f["id"]]
        if f["type"] in ("photo", "audio", "signature"):
            items = [x for x in (v if isinstance(v, list) else [v]) if isinstance(x, dict)]
            desc = []
            for x in items:
                info = files.get(x.get("attachment_id"), {})
                if f["type"] == "photo":
                    d = {"photo": x.get("attachment_id")}
                    if x.get("ocr_text"):
                        d["text_read_from_photo"] = x["ocr_text"]
                    if x.get("caption"):
                        d["caption"] = x["caption"]
                elif f["type"] == "audio":
                    t = info.get("transcript") or (x.get("transcript") or "").strip()
                    d = {"voice_note": x.get("attachment_id"),
                         "transcript": t or None,
                         "transcript_source": info.get("transcript_source") or ("device" if t else None)}
                    if not t:
                        d["not_transcribed_because"] = info.get("transcript_error") or "no transcript available"
                else:
                    d = {"signed": True, "signed_at": x.get("signed_at"), "signature_file": x.get("attachment_id"),
                         "file_stored": info.get("status") == "stored"}
                desc.append(d)
            v = desc
        elif f["type"] in ("single_choice", "multi_choice"):
            labels = {o["value"]: engine.text(o["label"], lang) for o in f.get("options", [])}
            v = [labels.get(x, x) for x in v] if isinstance(v, list) else labels.get(v, v)
        rows.append({"field_id": f["id"], "question": engine.text(f["label"], lang), "answer": v, "unit": f.get("unit")})
    return rows


def build_context(store: Store, record: dict, wf: dict, lang: str = "en", files: Optional[list[dict]] = None) -> dict:
    answers = record["answers"]
    local = record.get("local_results") or {}
    findings = local.get("findings") or engine.classify(wf, answers, lang)
    pack_docs = [p for p in (store.get_pack_content(pid) for pid in wf.get("knowledge_packs", [])) if p]
    by_id = {x["id"]: x for x in (files or [])}
    rows = _answers_for_prompt(wf, answers, lang, by_id)
    transcripts = [x["transcript"] for x in (files or []) if x["kind"] == "audio" and x.get("transcript")]
    query = " ".join([engine.text(wf.get("title"), lang)] + [f.get("label", "") for f in findings] +
                     [str(a.get("answer")) for a in rows if isinstance(a.get("answer"), str)] + transcripts)
    refs = packs_mod.search_knowledge(pack_docs, query, k=5, lang=lang) if pack_docs else []
    return {
        "workflow": {"id": wf["id"], "version": wf.get("version"), "title": engine.text(wf.get("title"), lang),
                     "domain": wf.get("domain", ""), "analysis_instructions": wf.get("analysis_instructions", ""),
                     "review_required": bool(wf.get("review_required"))},
        "record": {"id": record["id"], "revision": record["revision"], "completed_at": record.get("completed_at"),
                   "device_id": record.get("device_id"), "answers": rows,
                   "attachments": media.describe_counts(media.counts(files or []))},
        "local_findings": findings,
        "reference_passages": [{"title": r["title"], "source": r["source"], "entry_id": r["entry_id"], "text": r["text"][:1500]}
                               for r in refs],
    }


def _image_inputs(files: list[dict], limit: int = 2, max_bytes: int = 4_000_000) -> list[dict]:
    """Photos only: a signature is an image file too, but it is evidence of sign-off, not something to analyse."""
    out = []
    for a in files:
        if len(out) >= limit:
            break
        if a["kind"] == "photo" and a.get("status") == "stored" and str(a.get("mime", "")).startswith("image/"):
            path = a.get("path")
            if path and Path(path).exists() and Path(path).stat().st_size <= max_bytes:
                out.append({"type": "image", "data": Path(path).read_bytes(), "mime_type": a["mime"]})
    return out


#: Plugin-owned Hermes auxiliary task for photo analysis (registered in register(ctx) via
#: ctx.register_auxiliary_task, inheriting Hermes' built-in "vision" settings). The operator points it at a
#: vision-capable model under ``auxiliary.fieldkit_vision`` in config.yaml — the gateway's default model is
#: unchanged — and opts in with plugin setting ``vision_task: true``.
VISION_TASK = "fieldkit_vision"

TEXT_ONLY_NOTE = (
    "Photos were attached to this record but are NOT available to you in this request. Do not describe, infer or "
    "speculate about image contents. Base the report only on the structured answers, notes, OCR text, transcripts, "
    "local findings and reference passages provided."
)

VOICE_NOTE = (
    "Voice notes appear in the answers with their transcripts. Treat a transcript as the inspector's own spoken "
    "observation and use it as evidence. A voice note marked not_transcribed_because has unknown content: list it "
    "under missing_information instead of guessing."
)

_IMAGE_ERROR_HINTS = ("image", "vision", "multimodal", "multi-modal", "modality", "modalities", "image_url",
                      "content type", "content part", "unsupported content", "non-text")


def is_image_rejection(exc: BaseException) -> bool:
    """True when a provider error means "this model/endpoint does not accept image input".

    Providers phrase this differently (400 "image input is not supported", "image_url is only supported by
    certain models", "this model does not support multimodal input", ...). A 400/415/422 on a request that
    carried images is treated the same way: the retry is text-only and costs one extra call at most.
    Transient failures (timeouts, 429, 5xx) are NOT image rejections and go to the normal job retry.
    """
    msg = f"{type(exc).__name__} {exc}".lower()
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None) or getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int) and (status == 429 or status >= 500):
        return False
    if any(t in msg for t in ("timeout", "timed out", "rate limit", "429", "503", "502", "overloaded", "unavailable")):
        return False
    if any(h in msg for h in _IMAGE_ERROR_HINTS):
        return True
    return isinstance(status, int) and status in (400, 415, 422)


def _is_task_unavailable(exc: BaseException) -> bool:
    """The opt-in vision task could not be used (trust gate / not registered / not configured)."""
    name = type(exc).__name__
    msg = str(exc).lower()
    return name == "PluginLlmTrustError" or "auxiliary task" in msg or "fieldkit_vision" in msg or "no llm provider configured" in msg


def _structured_call(llm: Any, context: dict, images: list[dict], task: Optional[str]) -> Any:
    text = json.dumps(context, ensure_ascii=False, indent=1)
    inputs: list[dict] = [{"type": "text", "text": text}] + images
    system = SYSTEM if images or not context.get("record", {}).get("attachments_present") else f"{SYSTEM} {TEXT_ONLY_NOTE}"
    if context.get("record", {}).get("voice_notes_present"):
        system = f"{system} {VOICE_NOTE}"
    kwargs = dict(instructions="Produce the FieldKit report for this record as JSON matching the schema.",
                  input=inputs, json_schema=REPORT_SCHEMA, schema_name="fieldkit.report", system_prompt=system,
                  temperature=0.2, max_tokens=1800, purpose="fieldkit.analyze_record", timeout=120)
    if task:
        kwargs["task"] = task
    return llm.complete_structured(**kwargs)


_DEFAULT = object()


def analyze_record(store: Store, llm: Any, record_id: str, *, owner: Any = ALL, lang: str = "en",
                   with_images: bool = True, use_vision_task: Optional[bool] = None,
                   transcriber: Any = _DEFAULT) -> tuple[dict, bool, str, str]:
    """Run one structured analysis. Returns (report, requires_review, provider, model). Raises on failure.

    Attempt chain inside ONE job attempt (so a non-multimodal model never burns the job's retries):
      1. opt-in plugin vision task ``fieldkit_vision`` with photos (only if ``vision_task`` is enabled);
      2. Hermes' default model with photos;
      3. default model text-only — answers, notes, OCR/transcripts, local findings, knowledge references —
         when the model rejects image input. The report then says the photos were not analysed.
    Attachments are never modified or removed by analysis.
    """
    if llm is None:
        raise RuntimeError("Hermes LLM access (ctx.llm) is not available in this process")
    record = store.get_record(owner, record_id)
    for a in record["attachments"]:
        try:
            a["path"] = store.get_attachment(owner, a["id"]).get("path")
        except Exception:
            a["path"] = None
    wf = store.get_workflow_any_owner(record["workflow_id"], record["workflow_version"])
    if not wf:
        raise RuntimeError(f"workflow {record['workflow_id']}@{record['workflow_version']} missing")
    files = media.classify(record, wf, lang)
    # Voice notes: the phone's transcript, else Hermes speech-to-text (cached). Opt out with voice_transcription: false.
    if any(f["kind"] == "audio" for f in files):
        from . import runtime
        if transcriber is _DEFAULT:
            if runtime.setting("voice_transcription", True):
                transcriber, why = media.hermes_transcriber()
            else:
                transcriber, why = None, "voice-note transcription is turned off in FieldKit settings (voice_transcription: false)"
        else:
            why = "" if transcriber else "no speech-to-text available"
        media.ensure_transcripts(store, files, transcriber, why)
    c = media.counts(files)
    context = build_context(store, record, wf, lang, files)
    images = _image_inputs(files) if with_images else []
    photo_count = c["photo"]
    context["record"]["attachments_present"] = photo_count
    context["record"]["voice_notes_present"] = c["audio"]

    if use_vision_task is None:
        from . import runtime
        use_vision_task = bool(runtime.setting("vision_task", False))
    attempts: list[tuple[list[dict], Optional[str], str]] = []
    if images and use_vision_task:
        attempts.append((images, VISION_TASK, "vision_task"))
    if images:
        attempts.append((images, None, "default_model_with_images"))
    attempts.append(([], None, "text_only"))

    result, mode, notes = None, "", []
    for i, (imgs, task, label) in enumerate(attempts):
        last = i == len(attempts) - 1
        try:
            result = _structured_call(llm, context, imgs, task)
            mode = label
            break
        except Exception as exc:
            if last:
                raise
            if label == "vision_task" and (_is_task_unavailable(exc) or is_image_rejection(exc)):
                notes.append(f"vision task unavailable: {type(exc).__name__}: {str(exc)[:160]}")
                continue
            if label == "default_model_with_images" and is_image_rejection(exc):
                notes.append(f"model rejected image input: {type(exc).__name__}: {str(exc)[:160]}")
                continue
            raise  # transient/other errors → normal job retry (no silent downgrade)

    report = result.parsed
    if not isinstance(report, dict):
        raise RuntimeError("model did not return a parseable report")
    report = _normalize_report(report, context)
    analysed = mode in ("vision_task", "default_model_with_images")
    report["images"] = {
        "attached": photo_count,
        "sent_to_model": len(images) if analysed else 0,
        "analyzed": analysed if photo_count else None,
        "mode": mode,
        "note": ("" if not photo_count else
                 f"{photo_count} photo(s) analysed by the model." if analysed else
                 f"{photo_count} photo(s) attached but NOT analysed: the configured model does not accept image input"
                 f"{'' if with_images else ' (image analysis disabled for this run)'}. Findings are based on answers, notes, "
                 "OCR text, local findings and knowledge references. Photos remain stored with the record."),
        "fallback_reasons": notes,
    }
    if photo_count and not analysed:
        msg = "Photos were not analysed by Hermes (text-only analysis); review them manually if visual evidence matters."
        if msg not in report["missing_information"]:
            report["missing_information"].append(msg)
    voice = [f for f in files if f["kind"] == "audio"]
    heard = [f for f in voice if f.get("transcript")]
    unheard = [f for f in voice if not f.get("transcript")]
    if unheard:
        reasons = sorted({f.get("transcript_error") or "no transcript" for f in unheard})
        msg = f"{len(unheard)} voice note(s) could not be transcribed, so their content was not considered: {'; '.join(reasons)[:300]}."
        if msg not in report["missing_information"]:
            report["missing_information"].append(msg)
    report["attachments"] = {
        "counts": c, "summary": media.describe_counts(c),
        "voice_notes": {"attached": len(voice), "transcribed": len(heard),
                        "from_device": sum(1 for f in heard if f.get("transcript_source") == "device"),
                        "from_hermes": sum(1 for f in heard if f.get("transcript_source") == "hermes")},
        "signatures": [{"attachment_id": f["id"], "field_label": f.get("field_label"), "signed_at": f.get("signed_at"),
                        "stored": f.get("status") == "stored"} for f in files if f["kind"] == "signature"],
        "evidence": media.evidence(files),
    }
    report["review_triggers"] = review_triggers(report, context)
    requires_review = bool(report["review_triggers"])
    report["requires_review"] = requires_review
    if not requires_review:
        report["review_reason"] = ""
    return report, requires_review, getattr(result, "provider", "") or "", getattr(result, "model", "") or ""


def review_triggers(report: dict, context: dict) -> list[str]:
    """Why a report needs human review; empty means it doesn't. Calibrated (0.2.5): before, the model flagged every
    safety-related record, so 7 of 7 real inspections said "requires review" and the flag meant nothing.
    Triggers: a high/critical issue (from Hermes or the phone's local rules), or the model's own flag *with* a stated
    reason (conflicting evidence, a decisive gap, or a required sign-off)."""
    out = []
    sev = [i.get("severity") for i in report.get("issues", [])] + [f.get("severity") for f in context.get("local_findings", [])]
    worst = "critical" if "critical" in sev else "high" if "high" in sev else ""
    if worst:
        out.append(f"{worst} severity finding")
    reason = str(report.get("review_reason") or "").strip()
    if report.get("requires_review") and reason:
        out.append(f"Hermes: {reason[:300]}")
    return out


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
        existing = store.report_for_revision(job["record_id"], job["revision"])
        if existing:  # a report for this exact revision already exists (e.g. saved by Hermes) → never duplicate
            store.finish_job_without_report(job)
            done.append({"job_id": job["id"], "record_id": job["record_id"], "report_id": existing, "status": "already_reported"})
            continue
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
