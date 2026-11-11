"""Security regressions (0.3.1) through the real plugin router and store.

- Attachment ids are file names: a malicious id must never write or read outside the attachments folder, while
  legitimate attachments (and every id FieldKit has ever generated) keep working.
- Restoring a workflow version can only put back a lost version; it can never publish.
- Only the browser's Host header (validated) is remembered as the public address, never X-Forwarded-Host.
- Stored files are served with headers that stop a browser from sniffing or running them.
- A synced record has bounded size.
"""
import hashlib
import json
import uuid

import pytest

from fieldkit_core import db, media, runtime, tools
from test_api import PREFIX, H, _install, _record, _sync, env  # noqa: F401  (fixture)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _att(aid, body=PNG, mime="image/png", field="photos"):
    return {"id": aid, "field_id": field, "mime": mime, "size": len(body), "sha256": hashlib.sha256(body).hexdigest()}


def _files_outside(root, base):
    base = base.resolve()
    return [p for p in root.rglob("*") if p.is_file() and base not in p.resolve().parents
            and p.suffix not in (".db", ".db-wal", ".db-shm", ".json", ".tmp")]


MALICIOUS = ["../../escaped-1.txt", "..\\..\\escaped-2.txt", "/tmp/escaped-3.txt", "C:/escaped-4.txt",
             "att_ok/../../../escaped-5", "att\x00nullbyte", "att with spaces", "att_" + "a" * 61, "short"]


# ----------------------------------------------------------------------------- attachment ids
@pytest.mark.parametrize("aid", MALICIOUS)
def test_malicious_attachment_ids_are_refused_at_sync(env, aid):
    _install(env)
    r = _sync(env, _record(attachments=[_att(aid)]))
    assert r.status_code == 422, r.text
    assert env.store.conn.execute("SELECT COUNT(*) FROM attachments").fetchone()[0] == 0
    if aid.isprintable():                       # (the HTTP client cannot put a NUL byte in a URL at all)
        put = env.client.put(f"{PREFIX}/attachments/{aid.replace('/', '%2F')}", headers={**H(), "Content-Type": "image/png"}, content=PNG)
        assert put.status_code in (404, 405, 422)
    assert _files_outside(env.tmp, env.tmp / "attachments") == []


def test_a_row_declared_before_the_fix_cannot_write_outside(env):
    """An unsafe id already in the database (declared by an older version) is never used as a file name."""
    _install(env)
    rec = _record(attachments=[_att("att_legit_0001")])
    assert _sync(env, rec).status_code == 200
    bad = "../../escaped-old.txt"
    env.store.conn.execute("INSERT INTO attachments(id, record_id, owner_user_id, field_id, mime, size, sha256, status, created_at) "
                           "VALUES (?,?,?,?,?,?,?,?,?)", (bad, rec["id"], "alice", "photos", "image/png", len(PNG),
                                                          hashlib.sha256(PNG).hexdigest(), "declared", 0))
    env.store.conn.commit()
    with pytest.raises(db.NotFound):
        env.store.store_attachment("alice", bad, PNG, "image/png", env.tmp / "attachments")
    assert _files_outside(env.tmp, env.tmp / "attachments") == []


def test_a_stored_path_outside_the_folder_is_never_served(env):
    _install(env)
    rec = _record(attachments=[_att("att_legit_0002")])
    assert _sync(env, rec).status_code == 200
    put = env.client.put(f"{PREFIX}/attachments/att_legit_0002", headers={**H(), "Content-Type": "image/png"}, content=PNG)
    assert put.status_code == 200, put.text
    secret = env.tmp / "secret.txt"
    secret.write_text("not an attachment")
    env.store.conn.execute("UPDATE attachments SET path=? WHERE id='att_legit_0002'", (str(secret),))
    env.store.conn.commit()
    assert env.client.get(f"{PREFIX}/attachments/att_legit_0002", headers=H()).status_code == 404
    out = json.loads(tools.handler_for("fieldkit_get_attachment")({"attachment_id": "att_legit_0002"}))
    assert out.get("ok") is False and "path" not in out


def test_readable_copy_refuses_unsafe_ids(tmp_path):
    src = tmp_path / "attachments" / "x" / "att_legit_0003"
    src.parent.mkdir(parents=True)
    src.write_bytes(PNG)
    with pytest.raises(db.Invalid):
        media.readable_copy(str(src), "../../escaped-copy", "image/png", tmp_path / "exports")
    assert media.readable_copy(str(src), "att_legit_0003", "image/png", tmp_path / "exports").endswith("att_legit_0003.png")
    assert not (tmp_path.parent / "escaped-copy.png").exists()


def test_legitimate_attachments_sync_serve_and_stay_private(env):
    """Real ids (as the phone makes them) still upload, download intact with safe headers, and stay per-account."""
    _install(env)
    aid = f"att_{uuid.uuid4().hex[:24]}"
    rec = _record(attachments=[_att(aid)], answers={"asset_id": "PMP-0042", "inspection_date": "2026-11-08", "condition": "good",
                                                     "guard_ok": True, "photos": [{"attachment_id": aid}]})
    assert _sync(env, rec).status_code == 200
    put = env.client.put(f"{PREFIX}/attachments/{aid}", headers={**H(), "Content-Type": "image/png"}, content=PNG)
    assert put.status_code == 200 and put.json()["status"] == "stored"
    got = env.client.get(f"{PREFIX}/attachments/{aid}", headers=H())
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in got.headers["content-security-policy"] and got.headers["cross-origin-resource-policy"] == "same-origin"
    assert got.headers["content-type"].startswith("image/png")
    stored = env.store.get_attachment("alice", aid)["path"]
    assert (env.tmp / "attachments").resolve() in db.Path(stored).resolve().parents
    # account isolation: bob can neither read nor overwrite alice's file
    assert env.client.get(f"{PREFIX}/attachments/{aid}", headers=H("bob")).status_code == 404
    assert env.client.put(f"{PREFIX}/attachments/{aid}", headers={**H("bob"), "Content-Type": "image/png"}, content=PNG).status_code == 404
    # Hermes' tool still hands over a readable copy
    out = json.loads(tools.handler_for("fieldkit_get_attachment")({"attachment_id": aid}))
    assert out["integrity"] == "intact" and out["path"].endswith(".png")


def test_every_historical_id_shape_is_still_accepted():
    for aid in ["att_0123456789abcdef01234567", "att_sig_00001", "att_pending_01", "0123456789abcdef0123456789abcdef", "att-legacy-1"]:
        assert db.is_safe_id(aid), aid


# ----------------------------------------------------------------------------- workflow restore
def _wf(version, title="Maintenance"):
    from seed import example_forms
    return dict(example_forms()["maintenance"], version=version, title={"en": title})


def test_restore_puts_back_a_lost_version_without_publishing(env):
    wf = _wf(3)
    r = env.client.post(f"{PREFIX}/workflows/restore", headers=H(), json={"definition": wf})
    assert r.status_code == 200 and r.json() == {"restored": True, "version": 3}
    row = env.store.conn.execute("SELECT published_version, latest_version FROM workflows WHERE id=?", (wf["id"],)).fetchone()
    assert row["published_version"] is None and row["latest_version"] == 3       # restored, not published
    assert env.client.get(f"{PREFIX}/workflows/{wf['id']}", headers=H()).status_code == 404
    assert env.client.get(f"{PREFIX}/workflows/{wf['id']}?version=3", headers=H()).json()["version"] == 3
    assert _sync(env, _record(wf=wf["id"], ver=3)).status_code == 200            # its records upload again


def test_restore_cannot_add_or_publish_newer_versions(env):
    _install(env)
    wid = "equipment-inspection"
    before = env.store.conn.execute("SELECT published_version, latest_version FROM workflows WHERE id=?", (wid,)).fetchone()
    current = env.client.get(f"{PREFIX}/workflows/{wid}", headers=H()).json()
    tampered = dict(current, version=before["latest_version"] + 1, title={"en": "Tampered"})
    r = env.client.post(f"{PREFIX}/workflows/restore", headers=H(), json={"definition": tampered})
    assert r.status_code == 422, r.text
    for v in (99999, before["latest_version"] + 5):
        assert env.client.post(f"{PREFIX}/workflows/restore", headers=H(), json={"definition": dict(current, version=v)}).status_code == 422
    after = env.store.conn.execute("SELECT published_version, latest_version FROM workflows WHERE id=?", (wid,)).fetchone()
    assert tuple(after) == tuple(before)
    assert env.client.get(f"{PREFIX}/workflows/{wid}", headers=H()).json()["title"] == current["title"]
    # an existing version is never overwritten
    again = env.client.post(f"{PREFIX}/workflows/restore", headers=H(), json={"definition": dict(current, title={"en": "Tampered"})})
    assert again.json()["restored"] is False


# ----------------------------------------------------------------------------- public address
def test_forwarded_host_is_not_trusted(env, monkeypatch):
    seen = []
    monkeypatch.setattr(runtime, "record_observed_url", lambda url: seen.append(url))
    env.client.get(f"{PREFIX}/me", headers={**H(), "Host": "fieldkit.example.org", "X-Forwarded-Host": "evil.example.com",
                                             "X-Forwarded-Proto": "https"})
    assert seen == ["https://fieldkit.example.org"]
    seen.clear()
    # behind a proxy that rewrote Host to an internal address, the forwarded host is used (validated)
    env.client.get(f"{PREFIX}/me", headers={**H(), "Host": "10.0.0.7:9119", "X-Forwarded-Host": "fieldkit.example.org",
                                             "X-Forwarded-Proto": "https"})
    env.client.get(f"{PREFIX}/me", headers={**H(), "Host": "127.0.0.1:9119", "X-Forwarded-Host": "evil.example/<script>"})
    assert seen == ["https://fieldkit.example.org"]
    seen.clear()
    env.client.get(f"{PREFIX}/me", headers={**H(), "Host": "bad host/<x>"})
    env.client.get(f"{PREFIX}/me", headers={**H(), "Host": "ok.example.org", "X-Forwarded-Proto": "javascript"})
    assert seen == []


# ----------------------------------------------------------------------------- payload limits
def test_oversized_records_are_refused_and_normal_ones_accepted(env):
    _install(env)
    big = _record(answers={"asset_id": "PMP-0042", "notes": "x" * (db.MAX_ANSWERS_BYTES + 10)})
    assert _sync(env, big).status_code in (413, 422)
    huge = env.client.post(f"{PREFIX}/sync/records", headers={**H(), "Content-Type": "application/json"},
                           content=b'{"pad":"' + b"y" * (env.mod.MAX_SYNC_BODY + 1) + b'"}')
    assert huge.status_code == 413
    many = _record(attachments=[_att(f"att_many_{i:04d}") for i in range(db.MAX_ATTACHMENTS_PER_RECORD + 1)])
    assert _sync(env, many).status_code == 422
    assert env.client.post(f"{PREFIX}/sync/records", headers={**H(), "Content-Type": "application/json"}, content=b"not json").status_code == 422
    assert env.client.post(f"{PREFIX}/sync/records", headers={**H(), "Content-Type": "application/json"}, content=b"[1,2]").status_code == 422
    assert env.store.conn.execute("SELECT COUNT(*) FROM records").fetchone()[0] == 0
    # a normal record with a long note and several files is fine
    ok = _record(answers={"asset_id": "PMP-0042", "inspection_date": "2026-11-08", "condition": "good", "guard_ok": True,
                          "notes": "n" * 20000}, attachments=[_att(f"att_okay_{i:04d}") for i in range(10)])
    assert _sync(env, ok).status_code == 200
