"""Hermes tool schemas and handlers for FieldKit.

FieldKit's tools create and edit workspaces and give Hermes reliable access to what phones synchronised: entries,
their answers, attachment files, history and sync state. They never call a model: the user's Hermes agent analyses,
compares or reports on the data with its own tools when the user asks.

Registered by ``register(ctx)`` via ``ctx.register_tool``. Handlers follow the Hermes convention
``handler(args: dict, **kwargs) -> str`` (JSON string). Tools act as the Hermes instance owner (scope ``ALL``): Hermes
is single-tenant and its operator owns every record synchronised to this instance.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Optional

from . import engine, media, runtime
from .db import ALL, Conflict, Invalid, NotFound, data_dir, get_store

TOOLSET = "fieldkit"


def _ok(**data: Any) -> str:
    return json.dumps({"ok": True, **data}, ensure_ascii=False, default=str)


def _fail(msg: str, **data: Any) -> str:
    return json.dumps({"ok": False, "error": msg, **data}, ensure_ascii=False, default=str)


def _guard(fn: Callable[[dict], str]) -> Callable[..., str]:
    def handler(args: dict | None = None, **_kw: Any) -> str:
        try:
            return fn(args or {})
        except NotFound as exc:
            return _fail(f"not found: {exc}")
        except Invalid as exc:
            return _fail(str(exc))
        except Conflict as exc:
            return _fail("revision conflict", conflict=exc.payload)
        except Exception as exc:  # tool errors go back to the model, never crash the turn
            return _fail(f"{type(exc).__name__}: {exc}")
    handler.__name__ = fn.__name__
    return handler


def app_link(workflow_id: str | None = None) -> dict:
    # Public plugin-asset address: outside Hermes' /api auth gate, so an expired session opens the app
    # (which offers sign-in) instead of a raw 401 JSON page.
    path = "/dashboard-plugins/fieldkit/app_dist/index.html" + (f"#/workflow/{workflow_id}" if workflow_id else "")
    base = runtime.public_url()
    explicit = bool(str(runtime.setting("public_url", "") or "").strip())
    return {"url": f"{base}{path}" if base else path, "path": path, "absolute": bool(base),
            "source": "public_url setting" if explicit else ("detected from dashboard/app traffic" if base else "none"),
            "note": "" if base else "Open the FieldKit dashboard tab once over https (or set plugins.entries.fieldkit."
                                   "settings.public_url) so Hermes can return a full link."}


# ----------------------------------------------------------------------------- record helpers
SUBJECT_HINT = re.compile(r"(^|_)(id|code|no|number|tag|name|asset|site|person|participant|household|plot|unit)(_|$)")


def subject_field(wf: dict) -> Optional[str]:
    """The field that names what an entry is about (a site, person, asset...): the form's metadata.subject_field,
    else the first text field whose id looks like an identifier, else the first text field."""
    explicit = (wf.get("metadata") or {}).get("subject_field")
    if explicit and any(f.get("id") == explicit for f in wf.get("fields") or []):
        return explicit
    texts = [f for f in wf.get("fields") or [] if f.get("type") == "text"]
    for f in texts:
        if SUBJECT_HINT.search(str(f.get("id", ""))):
            return f["id"]
    return texts[0]["id"] if texts else None


def readable_answers(wf: dict, answers: dict, lang: str = "en") -> list[dict]:
    """Answers with their question text; choice values as labels; media answers by attachment id."""
    rows = []
    for f in wf.get("fields") or []:
        if f.get("type") == "instruction" or f.get("id") not in answers:
            continue
        v = answers[f["id"]]
        if f["type"] in ("photo", "audio", "signature"):
            items = [x for x in (v if isinstance(v, list) else [v]) if isinstance(x, dict)]
            v = [{k: x[k] for k in ("attachment_id", "caption", "transcript", "ocr_text", "signed_at") if x.get(k)} for x in items]
        elif f["type"] in ("single_choice", "multi_choice"):
            labels = {o.get("value"): engine.text(o.get("label"), lang) for o in f.get("options") or [] if isinstance(o, dict)}
            v = [labels.get(x, x) for x in v] if isinstance(v, list) else labels.get(v, v)
        rows.append({"field_id": f["id"], "question": engine.text(f.get("label"), lang), "type": f["type"], "answer": v,
                     "unit": f.get("unit")})
    return rows


def _subject_value(store: Any, rec: dict, cache: dict) -> tuple[Optional[str], str]:
    key = (rec["workflow_id"], rec.get("workflow_version"))
    if key not in cache:
        cache[key] = store.get_workflow_any_owner(*key) if key[1] else None
    wf = cache[key] or {}
    fid = subject_field(wf) if wf else None
    return fid, str((rec.get("answers") or {}).get(fid, "")).strip() if fid else ""


# ----------------------------------------------------------------------------- data tools
def list_records(a: dict) -> str:
    """Entries newest first, optionally of one workspace / form / subject / period; answers on request."""
    store = get_store()
    limit = max(1, min(int(a.get("limit") or 50), 500))
    wfs: list = [a["workflow_id"]] if a.get("workflow_id") else [None]
    wid = a.get("workspace_id")
    if wid:
        try:
            b = store.get_workspace_version(wid)["bundle"]
        except NotFound:
            return _fail(f"unknown workspace {wid!r}")
        wfs = [w.get("id") for w in b.get("workflows") or []] + list(b.get("workflow_refs") or [])
    rows = []
    for w in wfs:
        rows += store.list_records(ALL, w, 500, full=True, since=a.get("since"), until=a.get("until"))
    rows.sort(key=lambda r: r.get("received_at") or 0, reverse=True)
    cache: dict = {}
    subject = str(a.get("subject") or "").strip().lower()
    out, unassigned = [], 0
    for r in rows:
        if wid and r.get("workspace_id") != wid:
            if r.get("workspace_id"):
                continue                                    # filed under another workspace
            if store.workspaces_with_workflow(r.get("workflow_id")) != [wid]:
                unassigned += 1                             # shared form, synced without its workspace: never guessed
                continue
        fid, subj = _subject_value(store, r, cache)
        if subject and subject not in subj.lower():
            continue
        item = {k: r.get(k) for k in ("id", "workflow_id", "workflow_version", "workspace_id", "completed_at", "received_at",
                                       "sync_status", "revision")}
        item["subject"] = subj or None
        item["attachments"] = media.describe_counts(media.counts(media.classify(r, cache.get((r["workflow_id"], r.get("workflow_version"))) or {})))
        if a.get("include_answers"):
            wf = cache.get((r["workflow_id"], r.get("workflow_version"))) or {}
            item["answers"] = readable_answers(wf, r.get("answers") or {}, a.get("language", "en")) if wf else r.get("answers")
        out.append(item)
        if len(out) >= limit:
            break
    res: dict = {"records": out, "count": len(out)}
    if unassigned:
        res["unassigned_records"] = unassigned
        res["note"] = (f"{unassigned} entry/entries use a form shared by several workspaces and were synced without saying "
                       "which; they are not included. Ask the user if they belong here.")
    return _ok(**res)


def get_record(a: dict) -> str:
    """One entry with everything synced about it: answers with questions, attachments (kind, integrity), revisions,
    earlier entries of the same subject, and anything from earlier FieldKit versions (old reports, old answers)."""
    store = get_store()
    rec = store.get_record(ALL, a["record_id"])
    lang = a.get("language", "en")
    wf = store.get_workflow_any_owner(rec["workflow_id"], rec["workflow_version"]) or {}
    media.annotate(rec, wf or None, lang)
    for att in rec.get("attachments") or []:
        att["integrity"] = media.verify_file(store.get_attachment(ALL, att["id"]).get("path"), att.get("sha256")) \
            if att.get("status") == "stored" else "not_uploaded"
        for k in ("transcript_source", "transcript_error"):
            att.pop(k, None)
    out: dict = {"record": {k: v for k, v in rec.items() if k not in ("analysis_job_id", "analysis_status", "report_id",
                                                                      "report_version", "content_hash")}}
    out["form"] = {"id": wf.get("id"), "version": wf.get("version"), "title": wf.get("title")} if wf else None
    out["answers"] = readable_answers(wf, rec.get("answers") or {}, lang) if wf else None
    out["revisions"] = [dict(r) for r in store._q("SELECT revision, device_id, created_at FROM record_revisions WHERE "
                                                  "record_id=? ORDER BY revision", (rec["id"],))]
    fid, subj = _subject_value(store, rec, {})
    if subj:
        earlier = []
        for r in store.list_records(ALL, rec["workflow_id"], 300, full=True):
            if r["id"] == rec["id"] or str((r.get("answers") or {}).get(fid, "")).strip().lower() != subj.lower():
                continue
            if str(r.get("completed_at") or "") > str(rec.get("completed_at") or "9999"):
                continue
            earlier.append({"record_id": r["id"], "completed_at": r.get("completed_at")})
            if len(earlier) >= int(a.get("history_limit") or 5):
                break
        out["subject"] = {"field_id": fid, "value": subj, "earlier_entries": earlier}
    legacy: dict = {}
    findings = (rec.get("local_results") or {}).get("findings")
    if findings:
        legacy["on_phone_findings"] = findings
    qs = store.list_questions(ALL, rec["id"], None, 20)
    if qs:
        legacy["questions"] = [{"question": q["question"], "status": q["status"],
                                "answer": (q.get("answer") or {}).get("answer")} for q in qs]
    try:
        rep = store.get_report(ALL, record_id=rec["id"])
        legacy["report"] = {"report_id": rep.get("report_id"), "version": rep.get("version"), "summary": rep.get("summary"),
                            "note": "Made by FieldKit before 0.3 (kept for reference)."}
    except NotFound:
        pass
    if legacy:
        out["from_earlier_fieldkit_versions"] = legacy
    out["next"] = ("Use fieldkit_get_attachment for any photo, voice note or signature you need to look at or transcribe "
                   "with your own tools.")
    return _ok(**out)


def get_attachment(a: dict) -> str:
    """A synced photo, voice note or signature as a local file Hermes' own tools can open (vision, speech-to-text)."""
    store = get_store()
    try:
        att = store.get_attachment(ALL, a["attachment_id"])
    except NotFound:
        declared = store._q("SELECT status FROM attachments WHERE id=?", (a["attachment_id"],))
        if declared:
            return _fail("this file has not finished uploading from the phone yet", status=declared[0]["status"])
        raise
    integrity = media.verify_file(att["path"], att.get("sha256"))
    path = media.readable_copy(att["path"], att["id"], att.get("mime") or "", data_dir() / "exports")
    rec = store.get_record(ALL, att["record_id"])
    wf = store.get_workflow_any_owner(rec["workflow_id"], rec["workflow_version"]) or {}
    info = next((x for x in media.classify(rec, wf) if x["id"] == att["id"]), {})
    return _ok(attachment_id=att["id"], record_id=att["record_id"], kind=info.get("kind"), field_label=info.get("field_label"),
               mime=att.get("mime"), size=att.get("size"), sha256=att.get("sha256"), integrity=integrity, path=path,
               captured_at=info.get("captured_at"), phone_transcript=info.get("phone_transcript"),
               phone_ocr_text=info.get("phone_ocr_text"),
               next="Open the file at 'path' with your own tools if the user's request needs it (e.g. vision for a "
                    "photo, speech-to-text for a voice note).")


def get_sync_status(a: dict) -> str:
    store = get_store()
    return _ok(status=store.sync_status(ALL), conflicts=store.list_conflicts(ALL)[:20])


def resolve_conflict(a: dict) -> str:
    return _ok(result=get_store().resolve_conflict(ALL, a["conflict_id"], a["resolution"], a.get("merged_answers")))


def get_app_link(a: dict) -> str:
    return _ok(**app_link(a.get("workflow_id")))


# ----------------------------------------------------------------------------- schemas
def _s(name: str, description: str, props: dict, required: list[str] | None = None) -> dict:
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": props, "required": required or []}}


STR = {"type": "string"}
INT = {"type": "integer"}
BOOL = {"type": "boolean"}
OBJ = {"type": "object"}

TOOLS: list[tuple[dict, Callable[[dict], str]]] = [
    (_s("fieldkit_list_records", "List synced FieldKit entries (observations, visits, surveys), newest first. Filter by "
        "workspace_id, workflow_id (form), subject (the site/person/item an entry is about; partial match), since/until "
        "(ISO date of completion on the phone). include_answers=true adds each entry's answers with their questions, for "
        "summaries, counts, trends and comparisons.",
        {"workspace_id": STR, "workflow_id": STR, "subject": STR, "since": STR, "until": STR, "limit": INT,
         "include_answers": BOOL, "language": STR}), list_records),
    (_s("fieldkit_get_record", "One synced FieldKit entry: answers with their questions, attachments (photo, voice note, "
        "signature; integrity check), revisions, earlier entries of the same subject, and data kept from earlier "
        "FieldKit versions (old reports, old questions and answers).",
        {"record_id": STR, "language": STR, "history_limit": INT}, ["record_id"]), get_record),
    (_s("fieldkit_get_attachment", "A synced photo, voice note or signature as a local file path that your own tools can "
        "open (vision, speech-to-text, OCR), with its kind, field, integrity and any text the phone already read from it.",
        {"attachment_id": STR}, ["attachment_id"]), get_attachment),
    (_s("fieldkit_get_sync_status", "Synchronisation overview: entries received, files still uploading, open conflicts, devices.",
        {}), get_sync_status),
    (_s("fieldkit_resolve_conflict", "Resolve a synchronisation conflict with the user's choice: keep_server, use_client, "
        "or merge (with merged_answers).",
        {"conflict_id": STR, "resolution": {"type": "string", "enum": ["keep_server", "use_client", "merge"]}, "merged_answers": OBJ},
        ["conflict_id", "resolution"]), resolve_conflict),
    (_s("fieldkit_get_app_link", "The link that opens the FieldKit phone app (optionally at one form).",
        {"workflow_id": STR}), get_app_link),
]

from . import workspace_tools as _wst  # noqa: E402

TOOLS += _wst.TOOLS
TOOL_NAMES = [schema["name"] for schema, _ in TOOLS]


def handler_for(name: str) -> Callable[..., str]:
    for schema, fn in TOOLS:
        if schema["name"] == name:
            return _guard(fn)
    raise KeyError(name)


def register_all(ctx: Any) -> list[str]:
    names = []
    for schema, fn in TOOLS:
        ctx.register_tool(name=schema["name"], toolset=TOOLSET, schema=schema, handler=_guard(fn),
                          description=schema["description"])
        names.append(schema["name"])
    return names
