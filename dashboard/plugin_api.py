"""FieldKit dashboard backend, mounted by Hermes at ``/api/plugins/fieldkit/``.

Every route sits behind the Hermes dashboard auth gate (Hermes returns 401 before this code runs
for unauthenticated requests). The verified identity comes from ``request.state.session``
(OAuth / basic provider) or is ``local`` on a loopback dashboard. Records, attachments and conflicts
are scoped to that user; published forms and workspaces are instance-wide. Reports and questions from
FieldKit versions before 0.3 stay readable (read-only routes).

Handlers that touch SQLite are plain ``def`` (FastAPI runs them in a worker thread) or offload with
``asyncio.to_thread`` so the gateway event loop is never blocked.
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import socket
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fieldkit_core import __version__, engine, media, runtime  # noqa: E402
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


# ----------------------------------------------------------------------------- meta
@router.get("/me")
def me(request: Request):
    u = current_user(request)
    get_store().touch_user(u["user_id"], u["display_name"])
    return u


@router.get("/status")
def status(request: Request):
    uid = _uid(request)
    store = get_store()
    return {
        "plugin": "fieldkit", "version": __version__,
        # Which machine and which database answered: lets two installs of the same account tell whether they
        # reach the same FieldKit data (hosts with several machines/volumes, or a reset volume, do not).
        "instance": {"machine": os.environ.get("FLY_MACHINE_ID") or socket.gethostname(),
                     "region": os.environ.get("FLY_REGION", ""), "pid": os.getpid()},
        "store": store.store_info(uid), "app_built": (APP_DIR / "index.html").exists(),
        "public_url": runtime.public_url(),
    }


# ----------------------------------------------------------------------------- workflows
@router.get("/workflows/{wid}")
def get_workflow(wid: str, request: Request, version: Optional[int] = None, draft: bool = False):
    _uid(request)
    try:
        return get_store().get_workflow(ALL, wid, version=version, published=not draft and version is None)
    except Exception as exc:
        _err(exc)


@router.post("/workflows/restore")
def restore_workflow(request: Request, definition: dict = Body(..., embed=True)):
    """Restore one exact workflow version this Hermes lacks (its FieldKit data was reset or moved), from the copy a
    device downloaded. Validated like any workflow; never overwrites a version or another user's workflow."""
    uid = _uid(request)
    problems = engine.validate_definition(definition)
    if problems:
        return JSONResponse({"problems": problems}, status_code=422)
    try:
        return get_store().restore_workflow_version(uid, definition)
    except Exception as exc:
        _err(exc)


# ----------------------------------------------------------------------------- packs
@router.get("/packs/{pid}")
def get_pack(pid: str, request: Request):
    _uid(request)
    try:
        p = get_store().get_pack(ALL, pid)
    except Exception as exc:
        _err(exc)
    return Response(p["content"], media_type="application/json", headers={"X-FieldKit-SHA256": p["sha256"]})


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
                                 payload.get("record") or {})
    except Conflict as c:
        return JSONResponse({"conflict": c.payload}, status_code=409)
    except Exception as exc:
        _err(exc)
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
        res = await asyncio.to_thread(get_store().store_attachment, uid, aid, bytes(body), mime, data_dir() / "attachments")
    except Exception as exc:
        _err(exc)
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
        return get_store().resolve_conflict(_uid(request), cid, resolution, merged_answers)
    except Exception as exc:
        _err(exc)


# ----------------------------------------------------------------------------- records & reports
@router.get("/records")
def list_records(request: Request, workflow_id: Optional[str] = None, limit: int = Query(50, le=500)):
    store = get_store()
    uid = _uid(request)
    rows = store.list_records(uid, workflow_id, limit)
    _label(store, uid, rows, "id")   # lets other devices and the dashboard show readable names
    return {"records": rows}


def _subject(wf: Optional[dict], answers: dict) -> str:
    """A short human label for a record: the first short text answer (an asset id, farm or class name)."""
    for f in (wf or {}).get("fields", []):
        v = answers.get(f.get("id"))
        if f.get("type") == "text" and isinstance(v, str) and 0 < len(v.strip()) <= 40:
            return v.strip()
    return ""


def _label(store: Any, uid: str, rows: list[dict], key: str) -> None:
    titles = {w["id"]: w["title"] for w in store.list_workflows(ALL)}
    info = store.record_answers(uid, [r[key] for r in rows])
    defs: dict = {}
    for r in rows:
        r["workflow_title"] = titles.get(r["workflow_id"], r["workflow_id"])
        wid, ver, answers = info.get(r[key], (r["workflow_id"], None, {}))
        if (wid, ver) not in defs:
            defs[(wid, ver)] = store.get_workflow_any_owner(wid, ver) if ver else None
        r["subject"] = _subject(defs[(wid, ver)], answers or {})


@router.get("/workspaces")
def list_workspaces(request: Request):
    """Published workspaces (instance-wide, like published workflows). Starter workspaces are labelled."""
    _uid(request)
    return {"workspaces": get_store().list_workspaces(published_only=True)}


@router.get("/workspaces/{wid}")
def get_workspace(wid: str, request: Request, version: Optional[int] = None):
    _uid(request)
    try:
        rec = get_store().get_workspace_version(wid, version)
    except Exception as exc:
        _err(exc)
    from fieldkit_core import workspace as ws_mod
    return {"workspace_id": wid, "version": rec["version"], "status": rec["status"], "published_version": rec["published_version"],
            "starter": rec["starter"], "manifest_pack": ws_mod.pack_ids(wid)["workspace"], "changelog": rec["changelog"],
            "summary": rec["validation"].get("summary", {}), "title": rec["bundle"].get("title"),
            "profile": rec["bundle"].get("profile", {})}


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
        store = get_store()
        rec = store.get_record(_uid(request), rid)
        # Each attachment's kind (photo / voice note / signature) and correct per-kind counts.
        return media.annotate(rec, store.get_workflow_any_owner(rec["workflow_id"], rec["workflow_version"]))
    except Exception as exc:
        _err(exc)


@router.get("/records/{rid}/questions")
def record_questions(rid: str, request: Request):
    """Questions asked about this entry with FieldKit before 0.3, and their answers (read-only)."""
    try:
        get_store().get_record(_uid(request), rid)          # owner check
        return {"questions": get_store().list_questions(_uid(request), rid)}
    except Exception as exc:
        _err(exc)


@router.get("/records/{rid}/report")
def record_report(rid: str, request: Request):
    try:
        return get_store().get_report(_uid(request), record_id=rid)
    except Exception as exc:
        _err(exc)


@router.get("/reports")
def list_reports(request: Request, record_id: Optional[str] = None, limit: int = Query(50, le=200)):
    store, uid = get_store(), _uid(request)
    rows = store.list_reports(uid, record_id, limit)
    _label(store, uid, rows, "record_id")
    return {"reports": rows}


@router.get("/reports/{rep_id}")
def get_report(rep_id: str, request: Request):
    try:
        return get_store().get_report(_uid(request), report_id=rep_id)
    except Exception as exc:
        _err(exc)


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
