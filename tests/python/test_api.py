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
from fieldkit_core import db  # noqa: E402
from seed import example_forms, seed  # noqa: E402

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
    store = db.Store(path=str(tmp_path / "test.db"))
    db.set_store(store)
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


def H(user="alice"):
    return {"X-Test-User": user}


def _install(env, user="alice"):
    return seed(env.store)


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
    assert st["plugin"] == "fieldkit" and st["version"] == "0.3.0"
    assert not {"analysis_mode", "llm_available", "worker", "jobs", "auto_analyze"} & set(st)


# ----------------------------------------------------------------------------- workflows & packs
# ----------------------------------------------------------------------------- sync
def test_sync_idempotent(env):
    _install(env)
    rec = _record()
    r1 = _sync(env, rec, key="k1")
    assert r1.status_code == 200, r1.text
    body = r1.json()
    assert body["revision"] == 1 and body["sync_status"] == "complete" and body["workspace_id"] == "starter-equipment-inspection"
    assert "analysis_status" not in body and env.store.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
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
    assert env.client.get(f"{PREFIX}/records/{rec['id']}/questions", headers=H("bob")).status_code == 404


def test_attachment_flow_and_integrity(env):
    _install(env)
    body = b"\xff\xd8\xff\xe0fake-jpeg-bytes"
    sha = hashlib.sha256(body).hexdigest()
    rec = _record(attachments=[{"id": "att_0001_photo", "field_id": "photos", "mime": "image/jpeg", "size": len(body), "sha256": sha}])
    r = _sync(env, rec).json()
    assert r["sync_status"] == "received" and r["attachments_needed"] == ["att_0001_photo"]
    bad = env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H(), "Content-Type": "image/jpeg"}, content=body[:-2])
    assert bad.status_code == 422  # truncated upload detected
    assert env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H("bob"), "Content-Type": "image/jpeg"},
                          content=body).status_code == 404
    assert env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H(), "Content-Type": "text/html"},
                          content=body).status_code == 415
    ok = env.client.put(f"{PREFIX}/attachments/att_0001_photo", headers={**H(), "Content-Type": "image/jpeg"}, content=body)
    assert ok.status_code == 200 and ok.json()["sync_status"] == "complete"
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


# ----------------------------------------------------------------------------- devices & cross-device records
def test_devices_are_named_and_scoped_per_user(env):
    _install(env)
    r = env.client.post(f"{PREFIX}/devices", headers=H(), json={"device_id": "dev_123456", "label": "iPhone · Home Screen app"})
    assert r.status_code == 200 and r.json()["label"] == "iPhone · Home Screen app"
    env.client.post(f"{PREFIX}/devices", headers=H(), json={"device_id": "dev_123456", "label": "iPhone · Safari\x00\x07"})
    devs = env.client.get(f"{PREFIX}/devices", headers=H()).json()["devices"]
    assert [d["label"] for d in devs] == ["iPhone · Safari"]                    # renamed, control chars stripped
    assert env.client.get(f"{PREFIX}/devices", headers=H("bob")).json()["devices"] == []   # isolation
    # bob using the same device id string never touches alice's row
    env.client.post(f"{PREFIX}/devices", headers=H("bob"), json={"device_id": "dev_123456", "label": "Bob's laptop"})
    assert env.client.get(f"{PREFIX}/devices", headers=H()).json()["devices"][0]["label"] == "iPhone · Safari"
    assert env.client.post(f"{PREFIX}/devices", headers=H(), json={"device_id": "../etc", "label": "x"}).status_code == 422
    long = env.client.post(f"{PREFIX}/devices", headers=H(), json={"device_id": "dev_999999", "label": "x" * 500}).json()
    assert len(long["label"]) == 80
    assert env.client.post(f"{PREFIX}/devices", json={"device_id": "dev_123456", "label": "x"}).status_code == 401


def test_record_summaries_carry_device_and_title_and_stay_per_user(env):
    _install(env)
    _sync(env, _record(rid="rec_from_phone_01"), user="alice")
    rec = env.client.get(f"{PREFIX}/records", headers=H()).json()["records"][0]
    assert rec["workflow_title"] == "Equipment inspection" and rec["device_id"] == "dev-1"
    assert "answers" not in rec                                                 # summaries only
    assert env.client.get(f"{PREFIX}/records", headers=H("bob")).json()["records"] == []


def test_status_identifies_the_data_store_and_counts_only_your_records(env):
    _install(env)
    assert _sync(env, _record()).status_code == 200
    assert _sync(env, _record()).status_code == 200
    assert _sync(env, _record(), user="bob").status_code == 200
    a = env.client.get(f"{PREFIX}/status", headers=H("alice")).json()
    b = env.client.get(f"{PREFIX}/status", headers=H("bob")).json()
    assert a["store"]["store_id"].startswith("fks_") and len(a["store"]["store_id"]) == 20
    assert a["store"]["store_id"] == b["store"]["store_id"]          # same database → same id, every time
    assert a["store"]["records_for_you"] == 2 and b["store"]["records_for_you"] == 1   # never another user's count
    assert a["store"]["path"].endswith(".db")
    assert a["instance"]["machine"]
    assert env.client.get(f"{PREFIX}/status").status_code == 401


def test_v1_database_upgrades_keeps_records_and_gets_a_stable_store_id(tmp_path):
    import sqlite3
    from fieldkit_core import db as dbmod
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.executescript("BEGIN;" + dbmod.MIGRATIONS[0] + "PRAGMA user_version=1;COMMIT;")
    conn.execute("INSERT INTO records(id, owner_user_id, device_id, workflow_id, workflow_version, revision, answers, content_hash, "
                 "received_at, sync_status) VALUES ('rec_old_0001','alice','dev_1','w',1,1,'{}','h',1.0,'complete')")
    conn.commit(); conn.close()
    s1 = dbmod.Store(path=path)
    first = s1.store_info("alice")
    assert first["records_for_you"] == 1
    s1.conn.close()
    assert dbmod.Store(path=path).store_info("alice")["store_id"] == first["store_id"]   # survives reopening


def test_restore_workflow_version_puts_back_exact_version_and_enables_resync(env):
    wf = dict(example_forms()["maintenance"], version=3)
    rec = _record(wf=wf["id"], ver=3)
    assert _sync(env, rec).status_code == 422                          # fresh data store: workflow unknown
    r = env.client.post(f"{PREFIX}/workflows/restore", headers=H(), json={"definition": wf})
    assert r.status_code == 200 and r.json() == {"restored": True, "version": 3}
    again = env.client.post(f"{PREFIX}/workflows/restore", headers=H(), json={"definition": dict(wf, title={"en": "Tampered"})})
    assert again.json() == {"restored": False, "version": 3}          # never overwrites an existing version
    got = env.client.get(f"{PREFIX}/workflows/{wf['id']}", headers=H()).json()
    assert got["version"] == 3 and got["title"] == wf["title"]
    assert _sync(env, rec).status_code == 200                          # the record can now be uploaded again
    # Another user cannot add versions to alice's workflow, and invalid definitions are rejected.
    assert env.client.post(f"{PREFIX}/workflows/restore", headers=H("bob"), json={"definition": dict(wf, version=4)}).status_code == 404
    assert env.client.post(f"{PREFIX}/workflows/restore", headers=H(), json={"definition": {"id": "x", "version": 1}}).status_code == 422
    assert env.client.post(f"{PREFIX}/workflows/restore", json={"definition": wf}).status_code == 401


# ----------------------------------------------------------------------------- packs, retired routes, earlier data
def test_workspace_manifest_is_served_with_its_hash(env):
    _install(env)
    r = env.client.get(f"{PREFIX}/packs/ws-starter-equipment-inspection", headers=H())
    assert r.status_code == 200 and hashlib.sha256(r.content).hexdigest() == r.headers["x-fieldkit-sha256"]
    assert r.json()["workflows"] == [{"id": "equipment-inspection", "version": 1}]


def test_retired_routes_are_gone(env):
    _install(env)
    rec = _record()
    _sync(env, rec)
    for method, path in (("post", f"/records/{rec['id']}/analyze"), ("post", f"/records/{rec['id']}/questions"),
                         ("get", "/jobs"), ("get", "/followups"), ("post", "/learning/events"), ("post", "/examples/install"),
                         ("post", "/workflows"), ("post", "/packs"), ("post", "/packs/from-document"),
                         ("get", "/workflows"), ("get", "/packs")):
        kw = {"json": {}} if method == "post" else {}
        assert getattr(env.client, method)(f"{PREFIX}{path}", headers=H(), **kw).status_code in (404, 405), path


def test_reports_and_questions_from_earlier_versions_stay_readable_and_private(env):
    _install(env)
    rec = _record()
    _sync(env, rec)
    env.store.conn.execute("INSERT INTO reports(id, record_id, owner_user_id, version, record_revision, content, created_at) "
                           "VALUES ('rep_1', ?, 'alice', 1, 1, ?, 1.0)",
                           (rec["id"], json.dumps({"report_id": "rep_1", "version": 1, "summary": "Older report"})))
    env.store.conn.execute("INSERT INTO questions(id, owner_user_id, record_id, question, status, answer, attempts, created_at) "
                           "VALUES ('q_1', 'alice', ?, 'Why?', 'answered', ?, 1, 1.0)", (rec["id"], json.dumps({"answer": "Because."})))
    env.store.conn.commit()
    assert env.client.get(f"{PREFIX}/records/{rec['id']}/report", headers=H()).json()["summary"] == "Older report"
    assert env.client.get(f"{PREFIX}/reports", headers=H()).json()["reports"][0]["record_id"] == rec["id"]
    assert env.client.get(f"{PREFIX}/records/{rec['id']}/questions", headers=H()).json()["questions"][0]["answer"]["answer"] == "Because."
    assert env.client.get(f"{PREFIX}/records/{rec['id']}/report", headers=H("bob")).status_code == 404


def test_model_catalog_offers_only_ocr_and_translation(env):
    cat = env.client.get(f"{PREFIX}/models", headers=H()).json()
    assert sorted({p["capability"] for p in cat["packs"]}) == ["ocr", "translation"]
