"""Regression: analysis with non-multimodal models (image rejection → text-only fallback in ONE job attempt),
no duplicate reports, no endless retries, attachments preserved, opt-in plugin vision task."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from hermes_stub import GOOD_REPORT, Recorder, make_llm  # noqa: E402

from fieldkit_core import analysis, db, examples  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"fake-photo-bytes" * 20


class ProviderError(Exception):
    def __init__(self, msg, status_code):
        super().__init__(msg)
        self.status_code = status_code


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    examples.install(s, db.ALL)
    yield s
    db.set_store(None)


def _record_with_photo(store, tmp_path, rid="rec_photo_000001"):
    sha = hashlib.sha256(JPEG).hexdigest()
    rec = {"id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0,
           "answers": {"asset_id": "PMP-0042", "inspection_date": "2026-11-08", "condition": "poor", "guard_ok": False,
                       "notes": "grinding noise at the coupling", "photos": [{"attachment_id": "att_photo_00001"}]},
           "local_results": {"findings": [{"id": "guard_missing", "label": "Safety guard problem", "severity": "critical", "source": "local"}]},
           "attachments": [{"id": "att_photo_00001", "field_id": "photos", "mime": "image/jpeg", "size": len(JPEG), "sha256": sha}]}
    store.sync_record("alice", f"k-{rid}", "dev", rec, auto_analyze=True)
    store.store_attachment("alice", "att_photo_00001", JPEG, "image/jpeg", tmp_path / "att", auto_analyze=True)
    return rid


def _llm(rec):
    llm = make_llm(rec)
    if llm is None:
        pytest.skip("Hermes source not available for PluginLlm")
    return llm


IMAGE_ERRORS = [
    ProviderError("Error code: 400 - this model does not support image input", 400),
    ProviderError("Invalid content type. image_url is only supported by certain models.", 400),
    RuntimeError("Model z-ai/glm-5.3 does not support multimodal content"),
    ProviderError("Bad request", 400),  # generic 4xx on a request that carried images
]


@pytest.mark.parametrize("err", IMAGE_ERRORS, ids=lambda e: str(e)[:40])
def test_image_rejection_falls_back_to_text_in_one_attempt(store, tmp_path, err):
    rid = _record_with_photo(store, tmp_path)
    rec = Recorder({"default": GOOD_REPORT}, reject_images=err)
    out = analysis.process_pending(store, _llm(rec))
    assert out[0]["status"] in ("completed", "requires_review"), out
    assert len(rec.calls) == 2
    assert Recorder.has_image(rec.calls[0]) and not Recorder.has_image(rec.calls[1])
    text_prompt = json.dumps(rec.calls[1]["messages"], ensure_ascii=False)
    assert "NOT available to you" in text_prompt              # model told not to invent image contents
    assert "grinding noise at the coupling" in text_prompt    # notes still analysed
    assert "Safety guard problem" in text_prompt              # local findings still analysed
    assert "Common reasons for equipment vibration" in text_prompt or "Lockout" in text_prompt or "reference_passages" in text_prompt
    report = store.get_report(db.ALL, record_id=rid)
    assert report["images"]["analyzed"] is False and report["images"]["attached"] == 1
    assert "NOT analysed" in report["images"]["note"]
    assert any("Photos were not analysed" in m for m in report["missing_information"])
    jobs = store.list_jobs()
    assert jobs[0]["status"] == "completed" and jobs[0]["attempts"] == 1
    assert len(store.list_reports(db.ALL, rid)) == 1
    att = store.get_attachment("alice", "att_photo_00001")  # attachment preserved
    assert Path(att["path"]).read_bytes() == JPEG


def test_multimodal_model_analyses_photos(store, tmp_path):
    rid = _record_with_photo(store, tmp_path)
    rec = Recorder({"default": GOOD_REPORT})
    analysis.process_pending(store, _llm(rec))
    assert len(rec.calls) == 1 and Recorder.has_image(rec.calls[0])
    rep = store.get_report(db.ALL, record_id=rid)
    assert rep["images"]["analyzed"] is True and rep["images"]["sent_to_model"] == 1


def test_transient_error_is_not_downgraded_to_text(store, tmp_path):
    _record_with_photo(store, tmp_path)
    rec = Recorder({"default": GOOD_REPORT}, always_fail=ProviderError("Service unavailable", 503))
    out = analysis.process_pending(store, _llm(rec))
    assert out[0]["status"] == "pending"           # normal backoff retry
    assert len(rec.calls) == 1                      # no text-only call on a 503


def test_no_endless_retries_when_text_also_fails(store, tmp_path):
    _record_with_photo(store, tmp_path)
    rec = Recorder({"default": GOOD_REPORT}, always_fail=ProviderError("this model does not support image input", 400))
    llm = _llm(rec)
    statuses = []
    for _ in range(5):
        store.conn.execute("UPDATE jobs SET next_run_at=0")
        statuses += [d["status"] for d in analysis.process_pending(store, llm)]
    assert statuses == ["pending", "pending", "failed"]   # max_attempts=3, then stops
    assert len(rec.calls) == 6                            # 2 calls per attempt (image → text), 3 attempts
    assert store.list_reports(db.ALL) == []


def test_record_without_photos_makes_one_text_call(store):
    store.sync_record("alice", "k2", "dev", {"id": "rec_nophoto_0001", "workflow_id": "equipment-inspection",
                                              "workflow_version": 1, "base_revision": 0, "answers": {"condition": "good"}},
                      auto_analyze=True)
    rec = Recorder({"default": GOOD_REPORT})
    analysis.process_pending(store, _llm(rec))
    assert len(rec.calls) == 1 and not Recorder.has_image(rec.calls[0])
    rep = store.get_report(db.ALL, record_id="rec_nophoto_0001")
    assert rep["images"]["analyzed"] is None and rep["images"]["note"] == ""


def test_vision_task_opt_in_then_fallback(store, tmp_path):
    """With vision_task on, FieldKit asks for its own aux task first. Unregistered/unconfigured in this test
    (Hermes' trust gate raises), so it falls back to the default model — with photos."""
    rid = _record_with_photo(store, tmp_path)
    rec = Recorder({"default": GOOD_REPORT})
    report, *_ = analysis.analyze_record(store, _llm(rec), rid, use_vision_task=True)
    assert report["images"]["mode"] == "default_model_with_images"
    assert any("vision task unavailable" in r for r in report["images"]["fallback_reasons"])


def test_no_duplicate_report_for_same_revision(store, tmp_path):
    rid = _record_with_photo(store, tmp_path)
    store.save_report_direct(rid, dict(GOOD_REPORT), True, generated_by="hermes-agent")  # Hermes already reported
    store.conn.execute("UPDATE jobs SET status='pending', next_run_at=0")
    rec = Recorder({"default": GOOD_REPORT})
    out = analysis.process_pending(store, _llm(rec))
    assert out[0]["status"] == "already_reported" and rec.calls == []
    assert len(store.list_reports(db.ALL, rid)) == 1
    assert store.list_jobs()[0]["status"] == "completed"


def test_requeue_failed_jobs_once_then_complete(store, tmp_path):
    rid = _record_with_photo(store, tmp_path)
    store.conn.execute("UPDATE jobs SET status='failed', attempts=3, last_error='old image error'")
    assert store.requeue_failed_jobs() == 1
    rec = Recorder({"default": GOOD_REPORT}, reject_images=ProviderError("does not support image input", 400))
    out = analysis.process_pending(store, _llm(rec))
    assert out[0]["status"] in ("completed", "requires_review")
    assert store.requeue_failed_jobs() == 0                # nothing left to requeue
    assert len(store.list_reports(db.ALL, rid)) == 1


@pytest.mark.parametrize("msg,status,expected", [
    ("image input not supported", 400, True), ("Request timed out", None, False), ("rate limit exceeded", 429, False),
    ("internal error", 500, False), ("schema mismatch", 422, True), ("connection reset", None, False)])
def test_is_image_rejection(msg, status, expected):
    assert analysis.is_image_rejection(ProviderError(msg, status)) is expected
