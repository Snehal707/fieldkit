"""Regression for the real-iPhone findings (0.2.4): attachments are evidence.

- A signature (PNG) was counted and sent to the vision model as a photo: "2 photo(s) attached but NOT analysed".
- Voice notes were ignored by the analysis unless the phone had transcribed them.
- Signatures must stay linked to the right inspection, intact, and visible in the report for validation.
"""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from hermes_stub import GOOD_REPORT, Recorder, make_llm  # noqa: E402

from fieldkit_core import analysis, db, examples, media  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"fake-photo-bytes" * 20
PNG = b"\x89PNG\r\n\x1a\n" + b"fake-signature-strokes" * 10
M4A = b"\x00\x00\x00\x18ftypM4A " + b"fake-aac-voice" * 30


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    examples.install(s, db.ALL)
    yield s
    db.set_store(None)


def _inspection(store, tmp_path, rid="rec_media_000001", owner="alice", device_transcript=None, upload=True):
    """An equipment inspection with one photo, one voice note and the inspector's signature (synthetic)."""
    voice = {"attachment_id": f"att_voice_{rid[-6:]}", "recorded_at": "2026-11-09T10:01:00Z"}
    if device_transcript:
        voice["transcript"] = device_transcript
    rec = {"id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0,
           "answers": {"asset_id": "PMP-0042", "inspection_date": "2026-11-09", "condition": "fair", "guard_ok": True,
                       "photos": [{"attachment_id": f"att_photo_{rid[-6:]}", "taken_at": "2026-11-09T10:00:00Z"}],
                       "voice_note": [voice],
                       "inspector_sign": {"attachment_id": f"att_sign_{rid[-6:]}", "signed_at": "2026-11-09T10:05:00Z"}},
           "attachments": [
               {"id": f"att_photo_{rid[-6:]}", "field_id": "photos", "mime": "image/jpeg", "size": len(JPEG), "sha256": sha(JPEG)},
               {"id": f"att_voice_{rid[-6:]}", "field_id": "voice_note", "mime": "audio/mp4", "size": len(M4A), "sha256": sha(M4A)},
               {"id": f"att_sign_{rid[-6:]}", "field_id": "inspector_sign", "mime": "image/png", "size": len(PNG), "sha256": sha(PNG)}]}
    store.sync_record(owner, f"k-{rid}", "dev", rec, auto_analyze=True)
    if upload:
        for aid, body, mime in ((f"att_photo_{rid[-6:]}", JPEG, "image/jpeg"), (f"att_voice_{rid[-6:]}", M4A, "audio/mp4"),
                                (f"att_sign_{rid[-6:]}", PNG, "image/png")):
            store.store_attachment(owner, aid, body, mime, tmp_path / "att", auto_analyze=True)
    return rid


def _llm(rec):
    llm = make_llm(rec)
    if llm is None:
        pytest.skip("Hermes source not available for PluginLlm")
    return llm


class FakeSTT:
    def __init__(self, text="Bearing is noisy near the coupling, grease it this week.", ok=True):
        self.text, self.ok, self.paths = text, ok, []

    def __call__(self, path):
        self.paths.append(path)
        assert Path(path).read_bytes() == M4A               # the stored voice note, unchanged
        return {"success": True, "transcript": self.text, "provider": "fake"} if self.ok else \
            {"success": False, "transcript": "", "error": "No STT provider available."}


def test_signature_is_not_a_photo_and_is_never_sent_to_the_vision_model(store, tmp_path):
    rid = _inspection(store, tmp_path)
    rec = Recorder({"default": GOOD_REPORT})
    report, *_ = analysis.analyze_record(store, _llm(rec), rid, transcriber=FakeSTT())
    assert report["images"]["attached"] == 1                     # was 2: the signature PNG counted as a photo
    assert report["images"]["sent_to_model"] == 1
    sent = json.dumps(rec.calls[0]["messages"], default=str)
    assert sent.count("image") >= 1
    # Exactly one image part, and it is the photo (the signature's bytes never reach the model).
    images = [p for m in rec.calls[0]["messages"] for p in (m.get("content") if isinstance(m.get("content"), list) else [])
              if isinstance(p, dict) and p.get("type") in ("image", "image_url", "input_image")]
    assert len(images) == 1
    assert report["attachments"]["counts"] == {"photo": 1, "audio": 1, "signature": 1}
    assert report["attachments"]["summary"] == "1 photo · 1 voice note · 1 signature"


def test_voice_note_is_transcribed_by_hermes_and_used_in_the_analysis(store, tmp_path):
    rid = _inspection(store, tmp_path)
    stt = FakeSTT()
    rec = Recorder({"default": GOOD_REPORT})
    report, *_ = analysis.analyze_record(store, _llm(rec), rid, transcriber=stt)
    assert len(stt.paths) == 1 and stt.paths[0].endswith(".m4a")   # right extension for Hermes' decoder
    prompt = json.dumps(rec.calls[0]["messages"], ensure_ascii=False, default=str)
    assert "Bearing is noisy near the coupling" in prompt            # considered by the model
    assert "Voice notes appear in the answers" in prompt
    vn = report["attachments"]["voice_notes"]
    assert vn == {"attached": 1, "transcribed": 1, "from_device": 0, "from_hermes": 1}
    ev = [e for e in report["attachments"]["evidence"] if e["kind"] == "audio"][0]
    assert ev["transcript"].startswith("Bearing is noisy") and ev["transcript_source"] == "hermes"
    assert not any("could not be transcribed" in m for m in report["missing_information"])
    # Cached on the attachment: a re-analysis does not transcribe again.
    analysis.analyze_record(store, _llm(Recorder({"default": GOOD_REPORT})), rid, transcriber=stt)
    assert len(stt.paths) == 1
    a = [x for x in store.get_record(db.ALL, rid)["attachments"] if x["field_id"] == "voice_note"][0]
    assert a["transcript"].startswith("Bearing is noisy") and a["transcript_source"] == "hermes"


def test_phone_transcript_takes_precedence(store, tmp_path):
    rid = _inspection(store, tmp_path, device_transcript="Oil level low, top up before the next shift.")
    stt = FakeSTT()
    rec = Recorder({"default": GOOD_REPORT})
    report, *_ = analysis.analyze_record(store, _llm(rec), rid, transcriber=stt)
    assert stt.paths == []
    assert "Oil level low" in json.dumps(rec.calls[0]["messages"], ensure_ascii=False, default=str)
    assert report["attachments"]["voice_notes"]["from_device"] == 1


def test_untranscribed_voice_note_is_reported_not_ignored(store, tmp_path):
    rid = _inspection(store, tmp_path)
    rec = Recorder({"default": GOOD_REPORT})
    report, *_ = analysis.analyze_record(store, _llm(rec), rid, transcriber=FakeSTT(ok=False))
    assert report["attachments"]["voice_notes"]["transcribed"] == 0
    assert any("1 voice note(s) could not be transcribed" in m and "No STT provider" in m for m in report["missing_information"])
    assert "not_transcribed_because" in json.dumps(rec.calls[0]["messages"], default=str)


def test_transcription_can_be_turned_off(store, tmp_path, monkeypatch):
    rid = _inspection(store, tmp_path)
    monkeypatch.setenv("FIELDKIT_VOICE_TRANSCRIPTION", "false")
    called = []
    monkeypatch.setattr(media, "hermes_transcriber", lambda: (called.append(1), (None, "x"))[1])
    report, *_ = analysis.analyze_record(store, _llm(Recorder({"default": GOOD_REPORT})), rid)
    assert called == []
    assert any("turned off" in m for m in report["missing_information"])


def test_signature_evidence_is_linked_intact_and_in_the_report(store, tmp_path):
    rid = _inspection(store, tmp_path)
    other = _inspection(store, tmp_path, rid="rec_media_000002")
    report, *_ = analysis.analyze_record(store, _llm(Recorder({"default": GOOD_REPORT})), rid, transcriber=FakeSTT())
    sig = report["attachments"]["signatures"]
    assert sig == [{"attachment_id": "att_sign_000001", "field_label": "Inspector signature", "signed_at": "2026-11-09T10:05:00Z", "stored": True}]
    ev = [e for e in report["attachments"]["evidence"] if e["kind"] == "signature"][0]
    assert ev["integrity"] == "intact" and ev["sha256"] == sha(PNG) and ev["url"] == "attachments/att_sign_000001"
    assert "path" not in json.dumps(report)                        # no server file paths in reports
    # Linked to this inspection only.
    rec2 = store.get_record(db.ALL, other)
    assert [a["id"] for a in rec2["attachments"] if a["field_id"] == "inspector_sign"] == ["att_sign_000002"]
    # Preserved byte for byte.
    assert Path(store.get_attachment("alice", "att_sign_000001")["path"]).read_bytes() == PNG


def test_tampered_or_missing_evidence_is_flagged(store, tmp_path):
    rid = _inspection(store, tmp_path)
    Path(store.get_attachment("alice", "att_sign_000001")["path"]).write_bytes(PNG + b"x")
    report, *_ = analysis.analyze_record(store, _llm(Recorder({"default": GOOD_REPORT})), rid, transcriber=FakeSTT())
    ev = {e["kind"]: e for e in report["attachments"]["evidence"]}
    assert ev["signature"]["integrity"] == "mismatch" and ev["photo"]["integrity"] == "intact"


def test_counts_while_files_are_still_uploading(store, tmp_path):
    rid = _inspection(store, tmp_path, upload=False)
    files = media.classify(store.get_record(db.ALL, rid), store.get_workflow_any_owner("equipment-inspection", 1))
    assert media.counts(files) == {"photo": 1, "audio": 1, "signature": 1}
    assert {f["status"] for f in files} == {"pending"}
    assert [e["integrity"] for e in media.evidence(files)] == ["not_uploaded"] * 3


def test_api_record_has_attachment_kinds_and_isolation(store, tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    sys.path.insert(0, str(Path(__file__).parents[2] / "dashboard"))
    import plugin_api  # noqa: E402
    rid = _inspection(store, tmp_path)
    app = FastAPI()

    @app.middleware("http")
    async def fake_session(request, call_next):
        user = request.headers.get("x-test-user")
        if user:
            request.state.session = type("S", (), {"user_id": user})()
        return await call_next(request)

    app.include_router(plugin_api.router, prefix="/api/plugins/fieldkit")
    c = TestClient(app)
    r = c.get(f"/api/plugins/fieldkit/records/{rid}", headers={"x-test-user": "alice"}).json()
    kinds = {a["field_id"]: a["kind"] for a in r["attachments"]}
    assert kinds == {"photos": "photo", "voice_note": "audio", "inspector_sign": "signature"}
    assert r["attachment_summary"] == "1 photo · 1 voice note · 1 signature"
    assert [a.get("signed_at") for a in r["attachments"] if a["kind"] == "signature"] == ["2026-11-09T10:05:00Z"]
    got = c.get("/api/plugins/fieldkit/attachments/att_sign_000001", headers={"x-test-user": "alice"})
    assert got.status_code == 200 and got.content == PNG and got.headers["x-fieldkit-sha256"] == sha(PNG)
    # Another account can neither read the record nor its signature.
    assert c.get(f"/api/plugins/fieldkit/records/{rid}", headers={"x-test-user": "mallory"}).status_code == 404
    assert c.get("/api/plugins/fieldkit/attachments/att_sign_000001", headers={"x-test-user": "mallory"}).status_code == 404


def test_voice_note_is_transcribed_on_hermes_right_after_upload(store, tmp_path, monkeypatch):
    """The dashboard transcribes a voice note when it arrives, so the transcript exists before any analysis."""
    import importlib.util
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    spec = importlib.util.spec_from_file_location("fk_api_stt", Path(__file__).parents[2] / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    stt = FakeSTT("Coupling guard rattles at full speed.")
    monkeypatch.setattr(media, "hermes_transcriber", lambda: (stt, ""))
    app = FastAPI()

    @app.middleware("http")
    async def fake_session(request, call_next):
        request.state.session = type("S", (), {"user_id": "alice"})()
        return await call_next(request)

    app.include_router(api.router, prefix="/api/plugins/fieldkit")
    c = TestClient(app)
    rid = _inspection(store, tmp_path, rid="rec_media_000009", upload=False)
    for aid, body, mime in (("att_photo_000009", JPEG, "image/jpeg"), ("att_voice_000009", M4A, "audio/mp4")):
        assert c.put(f"/api/plugins/fieldkit/attachments/{aid}", content=body, headers={"content-type": mime}).status_code == 200
    api._STT_POOL.shutdown(wait=True)                     # let the background transcription finish
    api._STT_POOL = None
    a = [x for x in c.get(f"/api/plugins/fieldkit/records/{rid}").json()["attachments"] if x["field_id"] == "voice_note"][0]
    assert a["transcript"] == "Coupling guard rattles at full speed." and a["transcript_source"] == "hermes"
    assert len(stt.paths) == 1                            # only the audio upload triggered it

    # The phone already transcribed it: Hermes does not transcribe again.
    stt2 = FakeSTT()
    monkeypatch.setattr(media, "hermes_transcriber", lambda: (stt2, ""))
    rid2 = _inspection(store, tmp_path, rid="rec_media_000010", upload=False, device_transcript="Seal weeping slightly.")
    assert c.put("/api/plugins/fieldkit/attachments/att_voice_000010", content=M4A, headers={"content-type": "audio/mp4"}).status_code == 200
    api._STT_POOL.shutdown(wait=True)
    api._STT_POOL = None
    assert stt2.paths == []
