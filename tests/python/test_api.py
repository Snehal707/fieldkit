"""Plugin API tests through FastAPI's TestClient against the real router (dashboard/plugin_api.py).

A middleware stands in for Hermes' auth gate: it attaches ``request.state.session`` for the
``X-Test-User`` header and returns 401 without it (``auth_required`` mode), mirroring Hermes.
"""
import hashlib
import importlib.util
import json
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from hermes_stub import GOOD_REPORT, Recorder, make_llm  # noqa: E402

from fieldkit_core import analysis, db, runtime  # noqa: E402

PREFIX = "/api/plugins/fieldkit"


def _load_router():
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_fieldkit_test", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FIELDKIT_AUTO_ANALYZE", "true")
    store = db.Store(path=str(tmp_path / "test.db"))
    db.set_store(store)
    runtime.llm = None
    mod = _load_router()
    app = FastAPI()
    app.state.auth_required = True

    @app.middleware("http")
    async def fake_gate(request: Request, call_next):
        user = request.headers.get("x-test-user")
        if not user:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        request.state.session = SimpleNamespace(user_id=user, display_name=user.title(), provider="test")
        return await call_next(request)

    app.include_router(mod.router, prefix=PREFIX)
    client = TestClient(app)
    yield SimpleNamespace(client=client, store=store, mod=mod, tmp=tmp_path)
    db.set_store(None)
    runtime.llm = None


def H(user="alice"):
    return {"X-Test-User": user}


def _install(env, user="alice"):
    r = env.client.post(f"{PREFIX}/examples/install", headers=H(user))
    assert r.status_code == 200, r.text
    return r.json()


def _record(answers=None, rid=None, base=0, attachments=None, wf="equipment-inspection", ver=1):
    return {"id": rid or f"rec_{uuid.uuid4().hex[:16]}", "workflow_id": wf, "workflow_version": ver, "base_revision": base,
            "answers": answers or {"asset_id": "PMP-0042", "inspection_date": "2026-11-08", "condition": "poor",
                                   "symptoms": ["vibration"], "vibration_level": 9, "guard_ok": False},
            "local_results": {"findings": [{"id": "guard_missing", "severity": "critical", "source": "local"}]},
            "created_local_at": "2026-11-08T10:00:00Z", "completed_at": "2026-11-08T10:05:00Z",
            "attachments": attachments or []}


def _sync(env, rec, key=None, user="alice"):
    return env.client.post(f"{PREFIX}/sync/records", headers=H(user),
                           json={"idempotency_key": key or uuid.uuid4().hex, "device_id": "dev-1", "record": rec})


# ----------------------------------------------------------------------------- auth & meta
def test_unauthenticated_is_401(env):
    assert env.client.get(f"{PREFIX}/records").status_code == 401
    assert env.client.post(f"{PREFIX}/sync/records", json={}).status_code == 401


def test_me_and_status(env):
    assert env.client.get(f"{PREFIX}/me", headers=H()).json()["user_id"] == "alice"
    st = env.client.get(f"{PREFIX}/status", headers=H()).json()
    assert st["analysis_mode"] == "deferred" and st["llm_available"] is False


# ----------------------------------------------------------------------------- workflows & packs
def test_examples_install_idempotent_and_shared(env):
    first = _install(env)
    assert sorted(first["workflows"]) == ["classroom-observation", "crop-health-survey", "equipment-inspection"]
    assert len(first["packs"]) == 6
    assert _install(env)["workflows"] == []
    wfs = env.client.get(f"{PREFIX}/workflows", headers=H("bob")).json()["workflows"]
    assert len(wfs) == 3  # published workflows are instance-wide


def test_pack_integrity_header(env):
    _install(env)
    r = env.client.get(f"{PREFIX}/packs/maintenance-basics", headers=H())
    assert r.status_code == 200
    assert hashlib.sha256(r.content).hexdigest() == r.headers["x-fieldkit-sha256"]


def test_invalid_workflow_rejected(env):
    r = env.client.post(f"{PREFIX}/workflows", headers=H(), json={"definition": {"id": "x", "title": "X", "fields": []}})
    assert r.status_code == 422 and r.json()["problems"]


def test_workflow_versioning(env):
    wf = json.loads((ROOT / "examples/education/workflow.json").read_text(encoding="utf-8"))
    wf["id"] = "obs-copy"
    r1 = env.client.post(f"{PREFIX}/workflows", headers=H(), json={"definition": wf, "publish": False}).json()
    assert r1["workflow"]["version"] == 1 and r1["workflow"]["status"] == "draft"
    assert env.client.get(f"{PREFIX}/workflows/obs-copy", headers=H()).status_code == 404  # not published yet
    env.client.post(f"{PREFIX}/workflows/obs-copy/publish", headers=H(), json={})
    assert env.client.get(f"{PREFIX}/workflows/obs-copy", headers=H()).json()["version"] == 1
    r2 = env.client.post(f"{PREFIX}/workflows", headers=H(), json={"definition": wf, "publish": True}).json()
    assert r2["workflow"]["version"] == 2
    # bob may not publish alice's workflow
    assert env.client.post(f"{PREFIX}/workflows/obs-copy/publish", headers=H("bob"), json={}).status_code == 404


def test_document_import(env):
    doc = "# Proof of delivery\nA signed record that goods arrived.\n\n# Exceptions:\nDamaged goods must be photographed."
    r = env.client.post(f"{PREFIX}/packs/from-document", headers=H(),
                        json={"pack_id": "logistics-pod", "title": "POD guide", "document": doc, "domain": "logistics"})
    assert r.status_code == 200 and r.json()["entries"] == 2


# ----------------------------------------------------------------------------- sync
def test_sync_idempotent(env):
    _install(env)
    rec = _record()
    r1 = _sync(env, rec, key="k1")
    assert r1.status_code == 200, r1.text
    body = r1.json()
    assert body["revision"] == 1 and body["sync_status"] == "complete" and body["analysis_status"] == "pending"
    r2 = _sync(env, rec, key="k1")
    assert r2.json()["duplicate"] is True and r2.json()["revision"] == 1
    # same content resent under a new key after a lost ack → acknowledged, not duplicated
    r3 = _sync(env, rec, key="k2")
    assert r3.status_code == 200 and r3.json()["revision"] == 1
    assert len(env.client.get(f"{PREFIX}/records", headers=H()).json()["records"]) == 1


def test_sync_conflict_never_overwrites(env):
    _install(env)
    rec = _record()
    _sync(env, rec)
    edit = dict(rec, base_revision=1, answers=dict(rec["answers"], condition="fair"))
    assert _sync(env, edit).json()["revision"] == 2
    stale = dict(rec, base_revision=1, answers=dict(rec["answers"], condition="good"))
    r = _sync(env, stale)
    assert r.status_code == 409
    conflict = r.json()["conflict"]
    assert conflict["server_revision"] == 2 and conflict["server_answers"]["condition"] == "fair"
    assert env.client.get(f"{PREFIX}/records/{rec['id']}", headers=H()).json()["answers"]["condition"] == "fair"
    conflicts = env.client.get(f"{PREFIX}/sync/conflicts", headers=H()).json()["conflicts"]
    assert len(conflicts) == 1
    res = env.client.post(f"{PREFIX}/sync/conflicts/{conflicts[0]['id']}/resolve", headers=H(), json={"resolution": "use_client"})
    assert res.json()["revision"] == 3
    assert env.client.get(f"{PREFIX}/records/{rec['id']}", headers=H()).json()["answers"]["condition"] == "good"


def test_cross_user_isolation(env):
    _install(env)
    rec = _record()
    _sync(env, rec)
    assert env.client.get(f"{PREFIX}/records/{rec['id']}", headers=H("bob")).status_code == 404
    assert env.client.get(f"{PREFIX}/records", headers=H("bob")).json()["records"] == []
    # bob cannot overwrite alice's record id
    assert _sync(env, dict(rec, base_revision=1), user="bob").status_code == 404
    assert env.client.post(f"{PREFIX}/records/{rec['id']}/analyze", headers=H("bob")).status_code == 404


def test_attachment_flow_and_integrity(env):
    _install(env)
    body = b"\xff\xd8\xff\xe0fake-jpeg-bytes"
    sha = hashlib.sha256(body).hexdigest()
    rec = _record(attachments=[{"id": "att_0001_photo", "field_id": "photos", "mime": "image/jpeg", "size": len(body), "sha256": sha}])
    r = _sync(env, rec).json()
    assert r["sync_status"] == "received" and r["attachments_needed"] == ["att_0001_photo"]
    assert r["analysis_status"] == "not_requested"  # analysis waits for complete upload
    bad = env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H(), "Content-Type": "image/jpeg"}, content=body[:-2])
    assert bad.status_code == 422  # truncated upload detected
    assert env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H("bob"), "Content-Type": "image/jpeg"},
                          content=body).status_code == 404
    assert env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H(), "Content-Type": "text/html"},
                          content=body).status_code == 415
    ok = env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H(), "Content-Type": "image/jpeg"}, content=body)
    assert ok.status_code == 200 and ok.json()["sync_status"] == "complete" and ok.json()["analysis_status"] == "pending"
    again = env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H(), "Content-Type": "image/jpeg"}, content=body)
    assert again.json()["duplicate"] is True
    got = env.client.get(f"{PREFIX}/attachments/att_0001_photo", headers=H())
    assert got.content == body
    assert env.client.get(f"{PREFIX}/attachments/att_0001_photo", headers=H("bob")).status_code == 404


def test_unknown_workflow_rejected(env):
    _install(env)
    assert _sync(env, _record(wf="nope")).status_code == 422


# ----------------------------------------------------------------------------- analysis
def _llm(recorder):
    llm = make_llm(recorder)
    if llm is None:
        pytest.skip("Hermes source not available for PluginLlm")
    return llm


def test_job_processing_creates_report(env):
    _install(env)
    rec = _record()
    _sync(env, rec)
    rec_obj = Recorder({"default": GOOD_REPORT})
    done = analysis.process_pending(env.store, _llm(rec_obj))
    assert done[0]["status"] == "requires_review"
    call = rec_obj.calls[0]
    assert call["response_format"] if "response_format" in call else True
    user_text = json.dumps(call["messages"], ensure_ascii=False)
    assert "Common reasons for equipment vibration" in user_text  # knowledge grounding passed to the model
    r = env.client.get(f"{PREFIX}/records/{rec['id']}", headers=H()).json()
    assert r["analysis_status"] == "requires_review" and r["report_version"] == 1
    rep = env.client.get(f"{PREFIX}/records/{rec['id']}/report", headers=H()).json()
    assert rep["source"] == "hermes" and rep["summary"].startswith("Guard missing")
    assert rep["local_findings"][0]["source"] == "local"  # local findings preserved separately
    fus = env.client.get(f"{PREFIX}/followups", headers=H()).json()["followups"]
    assert fus[0]["title"] == "Re-inspect after alignment" and fus[0]["due_date"]
    assert env.client.get(f"{PREFIX}/records/{rec['id']}/report", headers=H("bob")).status_code == 404


def test_job_retry_then_fail_permanently(env):
    _install(env)
    rec = _record()
    _sync(env, rec)
    llm = _llm(Recorder({"default": GOOD_REPORT}, fail_times=10))
    out = analysis.process_pending(env.store, llm)
    assert out[0]["status"] == "pending"
    assert env.client.get(f"{PREFIX}/records/{rec['id']}", headers=H()).json()["analysis_status"] == "pending"
    for _ in range(2):
        env.store.conn.execute("UPDATE jobs SET next_run_at=0")
        out = analysis.process_pending(env.store, llm)
    assert out[0]["status"] == "failed"
    assert env.client.get(f"{PREFIX}/records/{rec['id']}", headers=H()).json()["analysis_status"] == "failed"
    # explicit re-request resets the same durable job
    r = env.client.post(f"{PREFIX}/records/{rec['id']}/analyze", headers=H()).json()
    assert r["analysis_status"] == "pending"
    assert env.store.job_counts() == {"pending": 1}


def test_schema_violating_output_fails_job(env):
    _install(env)
    _sync(env, _record())
    out = analysis.process_pending(env.store, _llm(Recorder({"default": {"summary": 3}})))
    assert out[0]["status"] == "pending" and "schema" in out[0]["error"]


def test_no_double_processing(env):
    _install(env)
    _sync(env, _record())
    assert len(env.store.claim_jobs(5)) == 1
    assert env.store.claim_jobs(5) == []


def test_worker_thread_processes_automatically(env):
    import time
    _install(env)
    rec = _record()
    _sync(env, rec)
    runtime.llm = _llm(Recorder({"default": GOOD_REPORT}))
    try:
        assert runtime.start_worker(interval_s=0.2)
        for _ in range(50):
            if env.store.get_record(db.ALL, rec["id"])["analysis_status"] == "requires_review":
                break
            time.sleep(0.1)
        assert env.store.get_record(db.ALL, rec["id"])["analysis_status"] == "requires_review"
        assert runtime.mode() == "automatic"
    finally:
        runtime.stop_worker()


# ----------------------------------------------------------------------------- PWA serving
def test_app_serving_and_traversal(env, tmp_path, monkeypatch):
    app_dir = tmp_path / "app_dist"
    app_dir.mkdir()
    (app_dir / "index.html").write_text("<html>fk</html>")
    (app_dir / "sw.js").write_text("self.x=1")
    monkeypatch.setattr(env.mod, "APP_DIR", app_dir)
    r = env.client.get(f"{PREFIX}/app/", headers=H())
    assert r.status_code == 200 and "fk" in r.text and r.headers["cache-control"] == "no-cache"
    assert env.client.get(f"{PREFIX}/app/sw.js", headers=H()).headers["content-type"].startswith(("application/javascript", "text/javascript"))
    assert env.client.get(f"{PREFIX}/app/records/123", headers=H()).text == "<html>fk</html>"  # SPA fallback
    assert env.client.get(f"{PREFIX}/app/..%2F..%2Fplugin_api.py", headers=H()).status_code == 404
    assert env.client.get(f"{PREFIX}/app/missing.js", headers=H()).status_code == 404


# ----------------------------------------------------------------------------- app links (Hermes Mobile)
def test_app_link_detected_from_authenticated_traffic(env, monkeypatch):
    from fieldkit_core import runtime as rt, tools
    monkeypatch.delenv("FIELDKIT_PUBLIC_URL", raising=False)
    assert tools.app_link("equipment-inspection")["absolute"] is False          # nothing seen yet
    # unauthenticated requests never record anything
    env.client.get(f"{PREFIX}/status", headers={"Host": "evil.example", "X-Forwarded-Proto": "https"})
    assert rt.observed_url() == ""
    # behind a reverse proxy, under a path prefix
    env.client.get(f"/hermes{PREFIX}/status".replace("/hermes", ""), headers={**H(), "X-Forwarded-Proto": "https",
                   "X-Forwarded-Host": "hermes.example.org"})
    link = tools.app_link("equipment-inspection")
    assert link["url"] == "https://hermes.example.org/dashboard-plugins/fieldkit/app_dist/index.html#/workflow/equipment-inspection"
    assert link["source"] == "detected from dashboard/app traffic"
    # a later plain-http request never downgrades a recorded https origin; loopback is ignored
    env.client.get(f"{PREFIX}/status", headers={**H(), "Host": "10.0.0.5:9119"})
    env.client.get(f"{PREFIX}/status", headers={**H(), "Host": "127.0.0.1:9119", "X-Forwarded-Proto": "https"})
    assert rt.observed_url() == "https://hermes.example.org"
    # explicit setting wins
    monkeypatch.setenv("FIELDKIT_PUBLIC_URL", "https://fk.example.com/")
    assert tools.app_link()["url"] == "https://fk.example.com/dashboard-plugins/fieldkit/app_dist/index.html"
    assert tools.app_link()["source"] == "public_url setting"


def test_observed_url_keeps_dashboard_prefix(env):
    from fieldkit_core import runtime as rt
    rt.record_observed_url("https://example.org/hermes")
    assert rt.observed_url() == "https://example.org/hermes"


def test_jobs_are_scoped_to_their_owner(env):
    _install(env)
    _sync(env, _record(rid="rec_alice_job_01"), user="alice")
    _sync(env, _record(rid="rec_bob_job_0001"), user="bob")
    a = env.client.get(f"{PREFIX}/jobs", headers=H("alice")).json()
    b = env.client.get(f"{PREFIX}/jobs", headers=H("bob")).json()
    assert [j["record_id"] for j in a["jobs"]] == ["rec_alice_job_01"] and a["counts"] == {"pending": 1}
    assert [j["record_id"] for j in b["jobs"]] == ["rec_bob_job_0001"]
