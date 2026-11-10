"""Hermes tool schemas and handlers for FieldKit.

Registered by ``register(ctx)`` via ``ctx.register_tool(name, toolset, schema, handler)``.
Handlers follow the Hermes convention ``handler(args: dict, **kwargs) -> str`` (JSON string).
Tools act as the Hermes instance owner (scope ``ALL``): Hermes is single-tenant and the agent's
operator owns every record synchronised to this instance.
"""
from __future__ import annotations

import json
from typing import Any, Callable

from . import analysis, engine, media, packs as packs_mod, runtime
from .db import ALL, Conflict, Invalid, NotFound, get_store

TOOLSET = "fieldkit"


def _ok(**data: Any) -> str:
    return json.dumps({"ok": True, **data}, ensure_ascii=False, default=str)


def _fail(msg: str, **data: Any) -> str:
    return json.dumps({"ok": False, "error": msg, **data}, ensure_ascii=False, default=str)


def _guard(fn: Callable[[dict], str]) -> Callable[..., str]:
    def handler(args: dict | None = None, **_kw: Any) -> str:
        try:
            runtime.start_worker()  # idempotent; no-op without ctx.llm or with auto_analyze off
        except Exception:
            pass
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


def _brief(wf: dict) -> dict:
    return {"id": wf["id"], "version": wf.get("version"), "status": wf.get("status"), "title": engine.text(wf.get("title")),
            "domain": wf.get("domain", ""), "fields": len(wf.get("fields", [])),
            "branching_fields": sum(1 for f in wf.get("fields", []) if f.get("visible_if") or f.get("required_if")),
            "knowledge_packs": wf.get("knowledge_packs", [])}


# ----------------------------------------------------------------------------- workflows
def create_workflow(a: dict) -> str:
    definition = a.get("definition")
    source = "provided"
    if definition is None:
        if not a.get("request"):
            return _fail("give either 'request' (natural language) or 'definition' (workflow JSON)")
        definition = analysis.generate_workflow(runtime.llm, a["request"], a.get("languages") or ["en"],
                                                a.get("domain", ""), a.get("workflow_id"))
        source = "generated"
    elif a.get("workflow_id"):
        definition = dict(definition, id=a["workflow_id"])
    problems = engine.validate_definition(definition)
    if problems:
        return _fail("workflow failed validation", problems=problems[:30], definition=definition)
    saved = get_store().save_workflow(ALL, definition, publish=bool(a.get("publish")), actor="hermes")
    return _ok(workflow=_brief(saved), source=source, published=saved["status"] == "published",
               app_link=app_link(saved["id"]) if saved["status"] == "published" else None,
               next_step=None if saved["status"] == "published" else "Review, then call fieldkit_publish_workflow.")


def validate_workflow(a: dict) -> str:
    definition = a.get("definition")
    if definition is None and a.get("workflow_id"):
        definition = get_store().get_workflow(ALL, a["workflow_id"])
    problems = engine.validate_definition(definition)
    return _ok(valid=not problems, problems=problems[:50])


def publish_workflow(a: dict) -> str:
    wf = get_store().publish_workflow(ALL, a["workflow_id"], a.get("version"))
    return _ok(workflow=_brief(wf), app_link=app_link(wf["id"]))


def list_workflows(a: dict) -> str:
    rows = get_store().list_workflows(ALL, published_only=not a.get("include_drafts", True))
    return _ok(workflows=[{k: r[k] for k in ("id", "title", "domain", "status", "latest_version", "published_version")} for r in rows])


def get_workflow(a: dict) -> str:
    return _ok(workflow=get_store().get_workflow(ALL, a["workflow_id"], version=a.get("version")))


def get_app_link(a: dict) -> str:
    return _ok(**app_link(a.get("workflow_id")))


# ----------------------------------------------------------------------------- packs
def create_knowledge_pack(a: dict) -> str:
    pid, title = a["pack_id"], a["title"]
    language, domain = a.get("language", "en"), a.get("domain", "")
    source = {"title": a.get("source_title") or title, "kind": "hermes"}
    if a.get("entries"):
        pack = {"kind": "knowledge", "id": pid, "title": title, "domain": domain, "languages": [language],
                "source": source, "entries": a["entries"]}
        method = "provided"
    elif a.get("document"):
        method = "llm"
        try:
            if runtime.llm is None or a.get("use_llm") is False:
                raise RuntimeError("deterministic")
            entries = analysis.generate_knowledge_entries(runtime.llm, title, a["document"])
            pack = {"kind": "knowledge", "id": pid, "title": title, "domain": domain, "languages": [language],
                    "source": source, "entries": entries}
        except Exception:
            method = "chunked"
            pack = packs_mod.knowledge_pack_from_sections(pid, title, packs_mod.chunk_document(a["document"]),
                                                          domain=domain, language=language, source=source)
    else:
        return _fail("give 'document' (text to convert) or 'entries'")
    problems = packs_mod.validate_pack(pack)
    if problems:
        return _fail("knowledge pack failed validation", problems=problems[:30])
    saved = get_store().save_pack(ALL, pack, actor="hermes")
    return _ok(pack=saved, entries=len(pack["entries"]), method=method)


def create_dictionary_pack(a: dict) -> str:
    pack = {"kind": "dictionary", "id": a["pack_id"], "title": a["title"], "domain": a.get("domain", ""),
            "languages": a.get("languages") or ["en"], "source": {"title": a.get("source_title") or a["title"], "kind": "hermes"},
            "entries": a.get("entries") or []}
    problems = packs_mod.validate_pack(pack)
    if problems:
        return _fail("dictionary pack failed validation", problems=problems[:30])
    return _ok(pack=get_store().save_pack(ALL, pack, actor="hermes"), entries=len(pack["entries"]))


def list_knowledge_packs(a: dict) -> str:
    return _ok(packs=get_store().list_packs(ALL, a.get("kind")))


def search_knowledge(a: dict) -> str:
    store = get_store()
    ids = a.get("pack_ids") or [p["id"] for p in store.list_packs(ALL, "knowledge")]
    docs = [p for p in (store.get_pack_content(i) for i in ids) if p]
    return _ok(results=packs_mod.search_knowledge(docs, a["query"], k=int(a.get("limit", 5)), lang=a.get("language", "en")))


# ----------------------------------------------------------------------------- records & reports
def list_records(a: dict) -> str:
    full = bool(a.get("include_answers"))
    store = get_store()
    wfs = [a["workflow_id"]] if a.get("workflow_id") else [None]
    if a.get("workspace_id"):                  # every workflow of that workspace
        try:
            b = store.get_workspace_version(a["workspace_id"])["bundle"]
        except NotFound:
            return _fail(f"unknown workspace {a['workspace_id']!r}")
        wfs = [w.get("id") for w in b.get("workflows") or []] + list(b.get("workflow_refs") or [])
    rows = []
    for w in wfs:
        rows += store.list_records(ALL, w, int(a.get("limit", 20)), a.get("analysis_status"), full=full)
    rows.sort(key=lambda r: r.get("received_at") or 0, reverse=True)
    return _ok(records=rows[: int(a.get("limit", 20)) if not a.get("workspace_id") else max(1, int(a.get("limit", 100)))])


def get_record(a: dict) -> str:
    rec = get_store().get_record(ALL, a["record_id"])
    wf = get_store().get_workflow_any_owner(rec["workflow_id"], rec["workflow_version"]) or {}
    lang = a.get("language", "en")
    if wf:
        files = {x["id"]: x for x in media.classify(rec, wf, lang)}
        rec["answers_readable"] = analysis._answers_for_prompt(wf, rec["answers"], lang, files)
    else:
        rec["answers_readable"] = None
    media.annotate(rec, wf or None, lang)
    return _ok(record=rec)


def analyze_record(a: dict) -> str:
    store = get_store()
    rid = a["record_id"]
    report, review, provider, model = analysis.analyze_record(store, runtime.llm, rid, lang=a.get("language", "en"))
    rec = store.get_record(ALL, rid)
    job = {"id": rec.get("analysis_job_id"), "record_id": rid, "revision": rec["revision"]}
    if job["id"]:
        saved = store.complete_job(job, report, review, provider, model, generated_by="fieldkit_analyze_record")
    else:
        saved = store.save_report_direct(rid, report, review, generated_by="fieldkit_analyze_record")
    return _ok(report=saved)


def generate_report(a: dict) -> str:
    store = get_store()
    if not a.get("regenerate"):
        try:
            return _ok(report=store.get_report(ALL, record_id=a["record_id"]), cached=True)
        except NotFound:
            pass
    return analyze_record(a)


def save_report(a: dict) -> str:
    import jsonschema
    report = a["report"]
    jsonschema.validate(report, analysis.REPORT_SCHEMA)
    store = get_store()
    rec = store.get_record(ALL, a["record_id"])
    wf = store.get_workflow_any_owner(rec["workflow_id"], rec["workflow_version"]) or {"id": rec["workflow_id"], "fields": []}
    ctx = analysis.build_context(store, rec, wf)
    normalized = analysis._normalize_report(report, ctx)
    return _ok(report=store.save_report_direct(a["record_id"], normalized, bool(report.get("requires_review")),
                                               generated_by="hermes-agent"))


def get_report(a: dict) -> str:
    return _ok(report=get_store().get_report(ALL, report_id=a.get("report_id"), record_id=a.get("record_id")))


def list_reports(a: dict) -> str:
    return _ok(reports=get_store().list_reports(ALL, a.get("record_id"), int(a.get("limit", 20))))


def create_followup(a: dict) -> str:
    return _ok(followup=get_store().create_followup(ALL, a["title"], a.get("detail", ""), a.get("record_id"),
                                                     a.get("due_date"), source="hermes"))


def list_followups(a: dict) -> str:
    return _ok(followups=get_store().list_followups(ALL, a.get("record_id"), a.get("status")))


def get_sync_status(a: dict) -> str:
    store = get_store()
    return _ok(status=store.sync_status(ALL), analysis_mode=runtime.mode(), conflicts=store.list_conflicts(ALL)[:20])


def resolve_conflict(a: dict) -> str:
    return _ok(result=get_store().resolve_conflict(ALL, a["conflict_id"], a["resolution"], runtime.auto_analyze(),
                                                   a.get("merged_answers")))


def process_pending_jobs(a: dict) -> str:
    store = get_store()
    store.recover_stale_jobs()
    requeued = store.requeue_failed_jobs() if a.get("retry_failed") else 0
    from . import questions
    return _ok(requeued_failed=requeued, processed=analysis.process_pending(store, runtime.llm, limit=int(a.get("limit", 3))),
               answered_questions=questions.process_questions(store, runtime.llm, limit=int(a.get("limit", 3))),
               jobs=store.job_counts())


def ask_about_record(a: dict) -> str:
    from . import questions
    out = questions.ask_now(get_store(), runtime.llm, a["record_id"], a["question"], a.get("language", "en"))
    return _ok(**out, next="Tell the user the answer with its uncertainty and next steps. It is also saved on that visit "
                           "in FieldKit (the phone shows it after sync). It is about this case only: never a workspace rule.")


def list_questions(a: dict) -> str:
    """Questions users asked about specific visits, with Hermes' answers (case-specific; never workspace rules)."""
    rows = get_store().list_questions(ALL, a.get("record_id"), a.get("status"), int(a.get("limit", 50)))
    return _ok(questions=rows, next=("Queued questions are answered automatically when FieldKit's worker runs; otherwise "
                                     "call fieldkit_process_pending_jobs. To discuss one, fetch the record with fieldkit_get_record."))


def install_examples(a: dict) -> str:
    from . import examples
    return _ok(installed=examples.install(get_store(), ALL))


# ----------------------------------------------------------------------------- schemas
def _s(name: str, description: str, props: dict, required: list[str] | None = None) -> dict:
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": props, "required": required or []}}


STR = {"type": "string"}
INT = {"type": "integer"}
BOOL = {"type": "boolean"}
OBJ = {"type": "object"}
LANGS = {"type": "array", "items": STR, "description": "Language codes, e.g. [\"en\", \"hi\"]"}

TOOLS: list[tuple[dict, Callable[[dict], str]]] = [
    (_s("fieldkit_create_workflow",
        "Create a FieldKit offline mobile workflow (data-collection form with branching, validation and local "
        "classification). Pass a natural-language 'request' to generate it, or a full 'definition'. Saved as a draft "
        "unless publish=true. Returns a link to open it in the FieldKit mobile app once published.",
        {"request": STR, "definition": OBJ, "languages": LANGS, "domain": STR, "workflow_id": STR, "publish": BOOL}),
     create_workflow),
    (_s("fieldkit_validate_workflow", "Validate a FieldKit workflow definition (or a stored workflow by id).",
        {"definition": OBJ, "workflow_id": STR}), validate_workflow),
    (_s("fieldkit_publish_workflow", "Publish a FieldKit workflow version so phones can download it.",
        {"workflow_id": STR, "version": INT}, ["workflow_id"]), publish_workflow),
    (_s("fieldkit_list_workflows", "List FieldKit workflows.", {"include_drafts": BOOL}), list_workflows),
    (_s("fieldkit_get_workflow", "Get a FieldKit workflow definition.", {"workflow_id": STR, "version": INT}, ["workflow_id"]),
     get_workflow),
    (_s("fieldkit_get_app_link", "Get the link that opens the FieldKit mobile app (optionally at one workflow).",
        {"workflow_id": STR}), get_app_link),
    (_s("fieldkit_create_knowledge_pack",
        "Turn reference material into a downloadable offline knowledge pack (explanations, procedures, FAQs, "
        "troubleshooting). Give 'document' text to convert, or ready 'entries' [{id,type,title,text,tags,source}].",
        {"pack_id": STR, "title": STR, "document": STR, "entries": {"type": "array", "items": OBJ}, "domain": STR,
         "language": STR, "source_title": STR, "use_llm": BOOL}, ["pack_id", "title"]), create_knowledge_pack),
    (_s("fieldkit_create_dictionary_pack",
        "Create a downloadable offline multilingual dictionary. entries: [{term, lang, definition, translations:{lang:term}, "
        "examples:[], synonyms:[], related:[], source}].",
        {"pack_id": STR, "title": STR, "languages": LANGS, "domain": STR, "entries": {"type": "array", "items": OBJ},
         "source_title": STR}, ["pack_id", "title", "entries"]), create_dictionary_pack),
    (_s("fieldkit_list_knowledge_packs", "List FieldKit packs (knowledge, dictionary, classification).",
        {"kind": {"type": "string", "enum": ["knowledge", "dictionary", "classification", "model"]}}), list_knowledge_packs),
    (_s("fieldkit_search_knowledge", "Search FieldKit knowledge packs for grounded reference passages.",
        {"query": STR, "pack_ids": {"type": "array", "items": STR}, "limit": INT, "language": STR}, ["query"]), search_knowledge),
    (_s("fieldkit_list_records", "List synchronised FieldKit records (newest first) with sync and analysis status. To "
        "answer a question about ONE of them (assessment, photos, voice notes, trend), follow up with "
        "fieldkit_ask_about_record, which examines its evidence. "
        "include_answers=true returns each record's answers, for summaries, counts, trends and comparisons across records "
        "(e.g. 'summarize my 50 survey visits').",
        {"workflow_id": STR, "workspace_id": STR, "limit": INT, "include_answers": {"type": "boolean"},
         "analysis_status": {"type": "string", "enum": ["not_requested", "pending", "processing", "completed", "failed", "requires_review"]}}),
     list_records),
    (_s("fieldkit_get_record", "Get one synchronised FieldKit record with answers, local findings and attachments.",
        {"record_id": STR, "language": STR}, ["record_id"]), get_record),
    (_s("fieldkit_analyze_record", "Run Hermes analysis on a record now and store the structured report.",
        {"record_id": STR, "language": STR}, ["record_id"]), analyze_record),
    (_s("fieldkit_generate_report", "Return the stored report for a record, generating it if missing (regenerate=true forces a new version).",
        {"record_id": STR, "regenerate": BOOL}, ["record_id"]), generate_report),
    (_s("fieldkit_save_report",
        "Store a report you wrote yourself for a record (use when you analysed or compared records conversationally). "
        "report: {summary, issues[{title,severity,evidence}], missing_information[], references[], "
        "suggested_actions[{action,priority}], followups[{title,detail,due_in_days}], requires_review, review_reason}.",
        {"record_id": STR, "report": OBJ}, ["record_id", "report"]), save_report),
    (_s("fieldkit_get_report", "Get a stored FieldKit report by report_id or by record_id (latest version).",
        {"report_id": STR, "record_id": STR}), get_report),
    (_s("fieldkit_list_reports", "List stored FieldKit reports.", {"record_id": STR, "limit": INT}), list_reports),
    (_s("fieldkit_create_followup", "Create a follow-up task, optionally linked to a record.",
        {"title": STR, "detail": STR, "record_id": STR, "due_date": {"type": "string", "description": "YYYY-MM-DD"}}, ["title"]),
     create_followup),
    (_s("fieldkit_list_followups", "List follow-up tasks.", {"record_id": STR, "status": {"type": "string", "enum": ["open", "done"]}}),
     list_followups),
    (_s("fieldkit_get_sync_status", "Synchronisation overview: records received, attachments outstanding, open conflicts, analysis jobs.",
        {}), get_sync_status),
    (_s("fieldkit_resolve_conflict", "Resolve a synchronisation conflict: keep_server, use_client, or merge (with merged_answers).",
        {"conflict_id": STR, "resolution": {"type": "string", "enum": ["keep_server", "use_client", "merge"]}, "merged_answers": OBJ},
        ["conflict_id", "resolution"]), resolve_conflict),
    (_s("fieldkit_ask_about_record", "Answer any question about ONE FieldKit observation (record), e.g. 'what do you think "
        "about this visit?', 'what do the photos show?', 'is it getting worse?'. Retrieves and uses the evidence itself: "
        "answers, photos, voice-note transcripts, on-phone findings, the workspace's procedures and earlier visits of the "
        "same subject. Returns an answer with confidence, uncertainty and next steps; the answer is also saved on that "
        "visit for the phone. Case-specific: never a workspace rule.",
        {"record_id": STR, "question": STR, "language": STR}, ["record_id", "question"]), ask_about_record),
    (_s("fieldkit_list_questions", "Questions users asked about a specific visit (record) from the phone, with status "
        "(queued / answering / answered / failed) and Hermes' answers. Answers are about that case only.",
        {"record_id": STR, "status": {"type": "string", "enum": ["queued", "answering", "answered", "failed"]}, "limit": INT}),
     list_questions),
    (_s("fieldkit_process_pending_jobs",
        "Run queued automatic analysis jobs for newly synchronised records. retry_failed=true gives jobs that "
        "previously failed permanently one fresh set of attempts (records that already have a report are skipped).",
        {"limit": INT, "retry_failed": BOOL}),
     process_pending_jobs),
    (_s("fieldkit_install_examples", "Install FieldKit's synthetic example workflows and packs (education, maintenance, agriculture).",
        {}), install_examples),
]

TOOL_NAMES = [schema["name"] for schema, _ in TOOLS]


from . import workspace_tools as _wst  # noqa: E402

TOOLS += _wst.TOOLS
TOOL_NAMES = [schema["name"] for schema, _ in TOOLS]


# Retired from Hermes in 0.2.6 (the product is: workspaces built by interview, visits recorded offline, questions
# answered on request). The code stays for existing data and is reachable through handler_for() in tests.
RETIRED = {
    "fieldkit_create_workflow", "fieldkit_validate_workflow", "fieldkit_publish_workflow", "fieldkit_list_workflows",
    "fieldkit_get_workflow", "fieldkit_create_knowledge_pack", "fieldkit_create_dictionary_pack",
    "fieldkit_list_knowledge_packs", "fieldkit_search_knowledge", "fieldkit_analyze_record", "fieldkit_generate_report",
    "fieldkit_save_report", "fieldkit_list_reports", "fieldkit_create_followup", "fieldkit_list_followups",
    "fieldkit_propose_workspace_changes", "fieldkit_list_learning", "fieldkit_decide_candidate",
}
TOOL_NAMES = [schema["name"] for schema, _ in TOOLS if schema["name"] not in RETIRED]


def handler_for(name: str) -> Callable[..., str]:
    """Any FieldKit tool handler, including retired ones (tests and internal use)."""
    for schema, fn in TOOLS:
        if schema["name"] == name:
            return _guard(fn)
    raise KeyError(name)


def register_all(ctx: Any) -> list[str]:
    names = []
    for schema, fn in TOOLS:
        if schema["name"] in RETIRED:
            continue
        ctx.register_tool(name=schema["name"], toolset=TOOLSET, schema=schema, handler=_guard(fn),
                          description=schema["description"])
        names.append(schema["name"])
    return names
