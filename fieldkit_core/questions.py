"""Questions about one observation (0.2.6).

A user asks about a specific visit, online or offline ("What do the photos show?"). The phone queues the question with
its workspace, record and attachments; after sync it reaches Hermes, which answers from THAT record's evidence only
(answers, photos, voice-note transcripts, on-phone findings, the workspace's procedures) and returns the answer to the
same visit on the phone. An answer is case-specific: it is never turned into a workspace rule or a learning event.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, Optional

from . import analysis, media
from .db import ALL, Invalid, NotFound, Store

MAX_QUESTION = 1000
ANSWER_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["answer", "confidence", "uncertainty", "evidence_used", "next_steps"],
    "properties": {
        "answer": {"type": "string", "description": "Direct answer to the question, in the question's language, 1-6 sentences."},
        "confidence": {"enum": ["low", "medium", "high"]},
        "uncertainty": {"type": "string", "description": "What cannot be told from this record, and how to find out. Empty if nothing."},
        "evidence_used": {"type": "array", "items": {"type": "string"},
                          "description": "Which parts of THIS record the answer rests on, e.g. 'photo 1', 'SNF reading 8.2', 'voice note'."},
        "next_steps": {"type": "array", "items": {"type": "string"}, "description": "0-4 concrete steps, if the question asks what to do."},
    },
}
INSTRUCTIONS = (
    "Answer the user's QUESTION about this one field record. Use only this record's evidence: its answers, photos, "
    "voice-note transcripts, on-phone findings, the workspace's procedures and rules given, and the history of "
    "earlier records of the same subject. A broad question (\"what do you think?\") gets a short assessment of what "
    "matters, with uncertainties and next steps. Say plainly what the "
    "evidence cannot show and how to find out (uncertainty). Do not invent readings, sources or standards. Label "
    "anything that is your own suggestion as a suggestion. photo_descriptions, when present, are Hermes vision's descriptions of the record's photos: use them as what the photos show, and say so. Evidence with status 'reference' is a standard for another stage or party (e.g. a legal sale standard): mention it as information, never as the rule that decides this case. This answer is about this case only; do not state general "
    "rules for future records. Answer in the language of the question."
)


SUBJECT_HINT = re.compile(r"(^|_)(id|code|no|number|tag|asset|panel|farmer|household|plot|patient|woman|student|site|unit)(_|$)")


def subject_field(wf: dict) -> Optional[str]:
    """The field that names what a record is about (asset id, farmer code, household id...), for its history."""
    explicit = (wf.get("metadata") or {}).get("subject_field")
    if explicit and any(f.get("id") == explicit for f in wf.get("fields") or []):
        return explicit
    texts = [f for f in wf.get("fields") or [] if f.get("type") == "text"]
    for f in texts:
        if SUBJECT_HINT.search(str(f.get("id", ""))):
            return f["id"]
    return texts[0]["id"] if texts else None


def history(store: Store, record: dict, wf: dict, lang: str, limit: int = 3) -> list[dict]:
    """Earlier records of the same subject (same workflow and subject value), newest first, with what Hermes said."""
    fid = subject_field(wf)
    subj = str((record.get("answers") or {}).get(fid, "")).strip().lower() if fid else ""
    if not subj:
        return []
    out = []
    for r in store.list_records(record["owner_user_id"], record["workflow_id"], 200, full=True):
        if r["id"] == record["id"] or str((r.get("answers") or {}).get(fid, "")).strip().lower() != subj:
            continue
        if str(r.get("completed_at") or "") > str(record.get("completed_at") or "9999"):
            continue
        item = {"record_id": r["id"], "completed_at": r.get("completed_at"),
                "answers": analysis._answers_for_prompt(wf, r.get("answers") or {}, lang),
                "findings": [f.get("label") for f in (r.get("local_results") or {}).get("findings") or []][:8]}
        try:
            rep = store.get_report(ALL, record_id=r["id"])["report"]
            item["hermes_decision"] = (rep.get("decision") or {}).get("outcome")
        except Exception:
            pass
        answered = [{"question": q["question"], "answer": (q.get("answer") or {}).get("answer")}
                    for q in store.list_questions(ALL, r["id"], "answered", 5)]
        if answered:
            item["earlier_questions"] = answered
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _context(store: Store, q: dict) -> tuple[dict, list[dict]]:
    record = store.get_record(ALL, q["record_id"])
    for a in record["attachments"]:
        try:
            a["path"] = store.get_attachment(ALL, a["id"]).get("path")
        except Exception:
            a["path"] = None
    wf = store.get_workflow_any_owner(record["workflow_id"], record["workflow_version"])
    if not wf:
        raise RuntimeError(f"workflow {record['workflow_id']}@{record['workflow_version']} missing")
    lang = q.get("lang") or "en"
    files = media.classify(record, wf, lang)
    if any(f["kind"] == "audio" for f in files):
        from . import runtime
        transcriber, why = (media.hermes_transcriber() if runtime.setting("voice_transcription", True)
                            else (None, "voice-note transcription is turned off"))
        media.ensure_transcripts(store, files, transcriber, why)
    ctx = analysis.build_context(store, record, wf, lang, files)
    ctx["history_of_this_subject"] = history(store, record, wf, lang)
    focus = set(q.get("attachment_ids") or [])
    photos = [f for f in files if f["kind"] == "photo" and (not focus or f.get("id") in focus)]
    images = analysis._image_inputs(photos) if photos else []
    ctx["_photos"] = [p for p in photos if p.get("status") == "stored" and p.get("path")][:2]   # for Hermes vision
    ctx["question"] = q["question"]
    return ctx, images


def _ask(llm: Any, ctx: dict, images: list[dict], task: Optional[str] = None) -> Any:
    text = json.dumps({k: v for k, v in ctx.items() if not k.startswith("_")}, ensure_ascii=False, indent=1)
    kwargs = dict(instructions=INSTRUCTIONS, input=[{"type": "text", "text": text}] + images, json_schema=ANSWER_SCHEMA,
                  schema_name="fieldkit.answer", temperature=0.2, max_tokens=900, purpose="fieldkit.answer_question",
                  timeout=120)
    if task:
        kwargs["task"] = task
    try:
        return llm.complete_structured(**kwargs)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "match schema" in msg:          # one corrective retry, as for reports
            kwargs["instructions"] += f" Your previous answer was rejected: {msg[:300]}. Use ONLY the schema's keys."
            return llm.complete_structured(**kwargs)
        raise


class AnswerError(RuntimeError):
    """Every route failed; the message says what each route returned (shown on the phone and in Hermes)."""


def _err(exc: BaseException) -> str:
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    return f"{type(exc).__name__}{f' {status}' if isinstance(status, int) else ''}: {str(exc)[:110]}"


def use_vision_slot() -> bool:
    """FieldKit's own model slot ``fieldkit_vision`` is used for photos when the operator configured it (a model or
    provider under auxiliary.fieldkit_vision in config.yaml), or turned it on with plugin setting vision_task: true.
    Unconfigured, Hermes routes the slot to the main model, so trying it would only repeat the main-model call.
    vision_task: false never uses it."""
    from . import runtime
    v = runtime.setting("vision_task", None)
    if v is not None:
        return v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes")
    try:
        from agent.auxiliary_task_config import _get_auxiliary_task_config  # type: ignore[import-not-found]
        cfg = _get_auxiliary_task_config(analysis.VISION_TASK) or {}
    except Exception:
        return False
    return bool(cfg.get("model") or str(cfg.get("provider") or "auto").lower() not in ("", "auto", "main"))


def answer_question(store: Store, llm: Any, qid: str) -> dict:
    """Answer one queued question from its record's evidence. Returns the stored answer.

    Routes, in order, within one attempt: photos to the fieldkit_vision slot (when configured); photos to Hermes' main
    model; if that model takes no images, Hermes' vision tool describes the photos and the main model answers from
    the descriptions; last, the text evidence only (the answer then says the photos were not seen). A rate limit
    stops the chain so the question waits.
    """
    if llm is None:
        raise RuntimeError("Hermes LLM access (ctx.llm) is not available in this process")
    q = store.get_question(ALL, qid)
    ctx, images = _context(store, q)
    routes: list[tuple[list[dict], Optional[str], str]] = []
    if images and use_vision_slot():
        routes.append((images, analysis.VISION_TASK, "vision_slot"))
    if images:
        routes.append((images, None, "main_model_with_photos"))
        routes.append(([], None, "photo_descriptions"))
    routes.append(([], None, "text_only"))
    result, route, tried, described = None, "", [], 0
    for imgs, task, label in routes:
        if label == "photo_descriptions":
            describer, why = media.hermes_photo_describer()
            descs, problems = media.describe_photos(describer, ctx.get("_photos") or [], store)
            if not descs and why:
                problems = [why]
            if not descs:
                tried.append(f"photo_descriptions: {'; '.join(problems)[:300]}")
                continue
            ctx["photo_descriptions"] = descs
            described = len(descs)
            if problems:
                tried.append(f"photo_descriptions: {'; '.join(problems)[:300]}")
        if label == "text_only" and images:
            ctx.pop("photo_descriptions", None)
            ctx["photos_not_seen"] = "The model could not look at the photos; the answer uses the text evidence only."
        try:
            result = _ask(llm, ctx, imgs, task)
            route = label
            break
        except Exception as exc:  # noqa: BLE001
            if analysis.rate_limit_delay(exc) is not None:
                raise                                   # the provider is busy: wait as told, don't burn other routes
            tried.append(f"{label}: {_err(exc)}")
            if label == "vision_slot":
                continue                                # slot not configured / unavailable / failed → main model
            if label == "main_model_with_photos" and analysis.is_image_rejection(exc):
                continue                                # main model takes no images → photo descriptions
            raise AnswerError("; ".join(tried)) from exc
    ans = result.parsed if hasattr(result, "parsed") else result
    if not isinstance(ans, dict) or not str(ans.get("answer", "")).strip():
        raise AnswerError("; ".join(tried + [f"{route}: the model returned no answer"]))
    meta = {"provider": getattr(result, "provider", "") or "", "model": getattr(result, "model", "") or "",
            "photos_seen": described if route == "photo_descriptions" else (len(images) if route != "text_only" else 0),
            "route": route}
    if tried:
        meta["fallbacks"] = tried
    return store.answer_question(qid, {**ans, **meta})


def ask_now(store: Store, llm: Any, record_id: str, question: str, lang: str = "en") -> dict:
    """A question asked in the Hermes chat about one record: answered right away from the same evidence (photos, voice
    notes, procedures, history) and stored with the record, so the phone shows it too."""
    rec = store.get_record(ALL, record_id)
    q = store.save_question(ALL, record_id, validate_new({"id": "qc_" + uuid.uuid4().hex[:16], "question": question, "lang": lang}))
    store.conn.execute("UPDATE questions SET status='answering', attempts=1 WHERE id=?", (q["id"],))
    store.conn.commit()
    try:
        ans = answer_question(store, llm, q["id"])
    except Exception as exc:
        store.fail_question(dict(q, attempts=3), f"{type(exc).__name__}: {exc}")
        raise
    return {"question_id": q["id"], "record_id": rec["id"], **ans}


def process_questions(store: Store, llm: Any, limit: int = 2) -> list[dict]:
    """Answer ready questions; a rate limit waits as told, other errors retry with backoff."""
    out = []
    for q in store.claim_questions(limit):
        try:
            a = answer_question(store, llm, q["id"])
            out.append({"question_id": q["id"], "status": "answered", "answer": a["answer"][:200]})
        except Exception as exc:  # noqa: BLE001
            wait = analysis.rate_limit_delay(exc)
            if wait is not None:
                store.defer_question(q, f"Hermes' model is busy (rate limited); retrying in {int(wait // 60) or 1} min.", wait)
                out.append({"question_id": q["id"], "status": "queued", "retry_in_s": int(wait)})
            else:
                out.append({"question_id": q["id"], "status": store.fail_question(q, f"{type(exc).__name__}: {exc}")})
    return out


def validate_new(payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise Invalid("question must be an object")
    text = str(payload.get("question") or "").strip()
    if not text:
        raise Invalid("question text is required")
    if len(text) > MAX_QUESTION:
        raise Invalid(f"question is longer than {MAX_QUESTION} characters")
    qid = str(payload.get("id") or "")
    if not qid or len(qid) > 64:
        raise Invalid("question id required (the phone's id, used to avoid duplicates)")
    ids = payload.get("attachment_ids") or []
    if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
        raise Invalid("attachment_ids must be a list of ids")
    return {"id": qid, "question": text, "lang": str(payload.get("lang") or "en")[:8],
            "workspace_id": payload.get("workspace_id") or None, "attachment_ids": ids[:20], "retry": payload.get("retry") is True}


__all__ = ["answer_question", "process_questions", "validate_new", "ANSWER_SCHEMA", "NotFound", "Optional"]
