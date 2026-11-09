"""FieldKit dashboard backend, mounted by Hermes at ``/api/plugins/fieldkit/``.

Every route sits behind the Hermes dashboard auth gate (Hermes returns 401 before this code runs
for unauthenticated requests). The verified identity comes from ``request.state.session``
(OAuth / basic provider) or is ``local`` on a loopback dashboard. Records, reports, follow-ups and
conflicts are scoped to that user; published workflows and packs are instance-wide resources.

Handlers that touch SQLite are plain ``def`` (FastAPI runs them in a worker thread) or offload with
``asyncio.to_thread`` so the gateway event loop is never blocked.
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fieldkit_core import __version__, engine, packs as packs_mod, runtime  # noqa: E402
from fieldkit_core.db import ALL, Conflict, Invalid, NotFound, data_dir, get_store  # noqa: E402

router = APIRouter()
APP_DIR = Path(__file__).resolve().parent / "app_dist"
MODELS_FILE = _ROOT / "fieldkit_core" / "models.json"
MAX_ATTACHMENT = 15 * 1024 * 1024
ATTACHMENT_MIME = {"image/jpeg", "image/png", "image/webp", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
                   "audio/wav", "audio/x-wav"}


# ----------------------------------------------------------------------------- identity
def _observe_origin(request: Request) -> None:
    """Remember the public URL users reach Hermes at (behind proxies too) so Hermes can hand out tappable app
    links without configuration. Only called for authenticated requests."""
    try:
        h = request.headers
        proto = (h.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
        host = (h.get("x-forwarded-host") or h.get("host") or request.url.netloc).split(",")[0].strip()
        path = request.url.path
        prefix = path.split("/api/plugins/fieldkit", 1)[0] if "/api/plugins/fieldkit" in path else ""
        runtime.record_observed_url(f"{proto}://{host}{prefix}")
    except Exception:
        pass


def current_user(request: Request) -> dict:
    user = _current_user(request)
    _observe_origin(request)
    return user


def _current_user(request: Request) -> dict:
    sess = getattr(request.state, "session", None)
    if sess is not None:
        uid = getattr(sess, "user_id", None) or (sess.get("user_id") if isinstance(sess, dict) else None)
        if uid:
            name = getattr(sess, "display_name", "") if not isinstance(sess, dict) else sess.get("display_name", "")
            return {"user_id": str(uid), "display_name": name or "", "provider": getattr(sess, "provider", "")}
    if getattr(request.app.state, "auth_required", False):
        raise HTTPException(401, "Unauthorized")
    # Loopback dashboards have no OAuth session; Hermes' session-token middleware already gated /api/.
    return {"user_id": "local", "display_name": "Local", "provider": "loopback"}


def _uid(request: Request) -> str:
    return current_user(request)["user_id"]


def _err(exc: Exception):
    if isinstance(exc, NotFound):
        raise HTTPException(404, "Not found")
    if isinstance(exc, Invalid):
        raise HTTPException(422, str(exc))
    raise exc


def _ensure_worker() -> None:
    try:
        runtime.start_worker()
    except Exception:  # pragma: no cover - never break a request over the worker
        pass


# ----------------------------------------------------------------------------- meta
@router.get("/me")
def me(request: Request):
    u = current_user(request)
    get_store().touch_user(u["user_id"], u["display_name"])
    return u


@router.get("/status")
def status(request: Request):
    _uid(request)
    _ensure_worker()
    store = get_store()
    return {
        "plugin": "fieldkit", "version": __version__,
        "analysis_mode": runtime.mode(), "llm_available": runtime.llm is not None,
        "auto_analyze": runtime.auto_analyze(), "worker": runtime.worker_state,
        "jobs": store.job_counts(), "app_built": (APP_DIR / "index.html").exists(),
        "public_url": runtime.public_url(),
    }


# ----------------------------------------------------------------------------- workflows
@router.get("/workflows")
def list_workflows(request: Request, include_drafts: bool = False):
    uid = _uid(request)
    store = get_store()
    rows = store.list_workflows(ALL, published_only=not include_drafts)
    if include_drafts:  # drafts only visible to their owner
        rows = [r for r in rows if r["published_version"] is not None or r["owner_user_id"] in (uid, "owner", "local")]
    return {"workflows": rows}


@router.get("/workflows/{wid}")
def get_workflow(wid: str, request: Request, version: Optional[int] = None, draft: bool = False):
    _uid(request)
    try:
        return get_store().get_workflow(ALL, wid, version=version, published=not draft and version is None)
    except Exception as exc:
        _err(exc)


@router.post("/workflows/validate")
def validate_workflow(request: Request, definition: dict = Body(..., embed=True)):
    _uid(request)
    return {"problems": engine.validate_definition(definition)}


@router.post("/workflows")
def save_workflow(request: Request, definition: dict = Body(...), publish: bool = Body(False)):
    uid = _uid(request)
    problems = engine.validate_definition(definition)
    if problems:
        return JSONResponse({"problems": problems}, status_code=422)
    try:
        saved = get_store().save_workflow(uid, definition, publish=publish)
    except Exception as exc:
        _err(exc)
    return {"workflow": saved}


@router.post("/workflows/{wid}/publish")
def publish_workflow(wid: str, request: Request, version: Optional[int] = Body(None, embed=True)):
    uid = _uid(request)
    store = get_store()
    try:
        owner_row = next((w for w in store.list_workflows(ALL) if w["id"] == wid), None)
        if not owner_row or owner_row["owner_user_id"] not in (uid, "owner", "local"):
            raise NotFound(wid)
        return {"workflow": store.publish_workflow(ALL, wid, version)}
    except Exception as exc:
        _err(exc)


# ----------------------------------------------------------------------------- packs
@router.get("/packs")
def list_packs(request: Request, kind: Optional[str] = None):
    _uid(request)
    return {"packs": get_store().list_packs(ALL, kind)}


@router.get("/packs/{pid}")
def get_pack(pid: str, request: Request):
    _uid(request)
    try:
        p = get_store().get_pack(ALL, pid)
    except Exception as exc:
        _err(exc)
    return Response(p["content"], media_type="application/json", headers={"X-FieldKit-SHA256": p["sha256"]})


@router.post("/packs")
def save_pack(request: Request, pack: dict = Body(..., embed=True)):
    uid = _uid(request)
    problems = packs_mod.validate_pack(pack)
    if problems:
        return JSONResponse({"problems": problems}, status_code=422)
    try:
        return {"pack": get_store().save_pack(uid, pack)}
    except Exception as exc:
        _err(exc)


@router.post("/packs/from-document")
def pack_from_document(request: Request, pack_id: str = Body(...), title: str = Body(...), document: str = Body(...),
                       domain: str = Body(""), language: str = Body("en")):
    """Deterministic import (no LLM): split a text/markdown document into a knowledge pack."""
    uid = _uid(request)
    sections = packs_mod.chunk_document(document)
    pack = packs_mod.knowledge_pack_from_sections(pack_id, title, sections, domain=domain, language=language,
                                                  source={"title": title, "kind": "document-import"})
    problems = packs_mod.validate_pack(pack)
    if problems:
        return JSONResponse({"problems": problems}, status_code=422)
    return {"pack": get_store().save_pack(uid, pack), "entries": len(pack["entries"])}


@router.delete("/packs/{pid}")
def delete_pack(pid: str, request: Request):
    uid = _uid(request)
    try:
        store = get_store()
        row = next((p for p in store._q("SELECT owner_user_id FROM packs WHERE id=?", (pid,))), None)
        if not row or row["owner_user_id"] not in (uid, "owner", "local"):
            raise NotFound(pid)
        store.delete_pack(ALL, pid)
    except Exception as exc:
        _err(exc)
    return {"deleted": pid}


@router.get("/models")
def model_catalog(request: Request):
    """Pinned upstream on-device model manifests (metadata only; the browser downloads from upstream)."""
    _uid(request)
    return json.loads(MODELS_FILE.read_text(encoding="utf-8"))


# ----------------------------------------------------------------------------- sync
@router.post("/sync/records")
def sync_record(request: Request, payload: dict = Body(...)):
    uid = _uid(request)
    store = get_store()
    get_store().touch_user(uid)
    try:
        resp = store.sync_record(uid, str(payload.get("idempotency_key", "")), str(payload.get("device_id") or "unknown")[:64],
                                 payload.get("record") or {}, auto_analyze=runtime.auto_analyze())
    except Conflict as c:
        return JSONResponse({"conflict": c.payload}, status_code=409)
    except Exception as exc:
        _err(exc)
    _ensure_worker()
    return resp


@router.put("/attachments/{aid}")
async def put_attachment(aid: str, request: Request):
    uid = _uid(request)
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if mime not in ATTACHMENT_MIME:
        raise HTTPException(415, f"unsupported media type {mime!r}")
    length = int(request.headers.get("content-length") or 0)
    if length > MAX_ATTACHMENT:
        raise HTTPException(413, "attachment too large")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_ATTACHMENT:
            raise HTTPException(413, "attachment too large")
    try:
        res = await asyncio.to_thread(get_store().store_attachment, uid, aid, bytes(body), mime,
                                      data_dir() / "attachments", runtime.auto_analyze())
    except Exception as exc:
        _err(exc)
    _ensure_worker()
    return res


@router.get("/attachments/{aid}")
def get_attachment(aid: str, request: Request):
    uid = _uid(request)
    try:
        a = get_store().get_attachment(uid, aid)
    except Exception as exc:
        _err(exc)
    return FileResponse(a["path"], media_type=a["mime"] or "application/octet-stream",
                        headers={"X-FieldKit-SHA256": a["sha256"], "Cache-Control": "private, max-age=3600"})


@router.get("/sync/status")
def sync_status(request: Request):
    return get_store().sync_status(_uid(request))


@router.get("/sync/conflicts")
def list_conflicts(request: Request):
    return {"conflicts": get_store().list_conflicts(_uid(request))}


@router.post("/sync/conflicts/{cid}/resolve")
def resolve_conflict(cid: str, request: Request, resolution: str = Body(...), merged_answers: Optional[dict] = Body(None)):
    try:
        return get_store().resolve_conflict(_uid(request), cid, resolution, runtime.auto_analyze(), merged_answers)
    except Exception as exc:
        _err(exc)


# ----------------------------------------------------------------------------- records & reports
@router.get("/records")
def list_records(request: Request, workflow_id: Optional[str] = None, limit: int = Query(50, le=500),
                 analysis_status: Optional[str] = None):
    store = get_store()
    rows = store.list_records(_uid(request), workflow_id, limit, analysis_status)
    titles = {w["id"]: w["title"] for w in store.list_workflows(ALL)}
    for r in rows:  # lets other devices show a readable name without downloading the record
        r["workflow_title"] = titles.get(r["workflow_id"], r["workflow_id"])
    return {"records": rows}


@router.get("/devices")
def list_devices(request: Request):
    """The signed-in user's devices (each browser / Home Screen app has its own on-device storage and id)."""
    return {"devices": get_store().list_devices(_uid(request))}


@router.post("/devices")
def register_device(request: Request, device_id: str = Body(...), label: str = Body("")):
    try:
        return get_store().register_device(_uid(request), device_id, label)
    except Exception as exc:
        _err(exc)


@router.get("/records/{rid}")
def get_record(rid: str, request: Request):
    try:
        return get_store().get_record(_uid(request), rid)
    except Exception as exc:
        _err(exc)


@router.post("/records/{rid}/analyze")
def analyze(rid: str, request: Request):
    try:
        res = get_store().request_analysis(_uid(request), rid)
    except Exception as exc:
        _err(exc)
    _ensure_worker()
    return dict(res, analysis_mode=runtime.mode())


@router.get("/records/{rid}/report")
def record_report(rid: str, request: Request):
    try:
        return get_store().get_report(_uid(request), record_id=rid)
    except Exception as exc:
        _err(exc)


@router.get("/reports")
def list_reports(request: Request, record_id: Optional[str] = None, limit: int = Query(50, le=200)):
    return {"reports": get_store().list_reports(_uid(request), record_id, limit)}


@router.get("/reports/{rep_id}")
def get_report(rep_id: str, request: Request):
    try:
        return get_store().get_report(_uid(request), report_id=rep_id)
    except Exception as exc:
        _err(exc)


@router.get("/followups")
def list_followups(request: Request, record_id: Optional[str] = None, status: Optional[str] = None):
    return {"followups": get_store().list_followups(_uid(request), record_id, status)}


@router.post("/followups")
def create_followup(request: Request, title: str = Body(...), detail: str = Body(""), record_id: Optional[str] = Body(None),
                    due_date: Optional[str] = Body(None)):
    try:
        return get_store().create_followup(_uid(request), title, detail, record_id, due_date)
    except Exception as exc:
        _err(exc)


@router.post("/followups/{fid}")
def update_followup(fid: str, request: Request, status: str = Body(..., embed=True)):
    try:
        return get_store().update_followup(_uid(request), fid, status)
    except Exception as exc:
        _err(exc)


@router.get("/jobs")
def jobs(request: Request):
    uid = _uid(request)
    store = get_store()
    return {"jobs": store.list_jobs(owner=uid), "counts": store.job_counts_for(uid), "mode": runtime.mode()}


@router.post("/examples/install")
def install_examples(request: Request):
    """Load the bundled multi-domain example workflows and packs (synthetic demo data)."""
    from fieldkit_core import examples
    return examples.install(get_store(), _uid(request))


# ----------------------------------------------------------------------------- PWA
@router.get("/app")
def app_root():
    return RedirectResponse("app/", status_code=307)


@router.get("/app/{path:path}")
def app_files(path: str):
    target = (APP_DIR / (path or "index.html")).resolve()
    try:
        target.relative_to(APP_DIR.resolve())
    except ValueError:
        raise HTTPException(404, "Not found")
    if not target.is_file():
        if "." in Path(path).name:
            raise HTTPException(404, "Not found")
        target = APP_DIR / "index.html"  # client-side routes
        if not target.is_file():
            raise HTTPException(503, "FieldKit app is not built (run npm run build)")
    media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if target.suffix == ".webmanifest":
        media = "application/manifest+json"
    no_cache = target.name in ("index.html", "sw.js", "manifest.webmanifest", "version.json")
    headers = {"Cache-Control": "no-cache" if no_cache else "public, max-age=31536000, immutable",
               "X-Content-Type-Options": "nosniff"}
    if target.name == "index.html":
        headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; "
            "worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.hf.co https://cdn-lfs.hf.co "
            "https://cdn.jsdelivr.net https://tessdata.projectnaptha.com blob: data:; img-src 'self' blob: data:; "
            "media-src 'self' blob:; style-src 'self' 'unsafe-inline'")
    return FileResponse(target, media_type=media, headers=headers)
