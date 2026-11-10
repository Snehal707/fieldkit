"""0.2.6: questions about one observation. Queued with their record (owner-checked, idempotent), answered by Hermes
from THAT record's evidence (photos included), returned with the record; never turned into workspace rules; sync alone
creates no AI work."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).parent))

from hermes_stub import Recorder, make_llm  # noqa: E402

from fieldkit_core import db, examples, questions  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"fake-photo-bytes" * 20
ANSWER = {"answer": "The photo shows the belt guard missing; the bearing reading is above the alarm level.",
          "confidence": "medium", "uncertainty": "The photo does not show the bearing itself.",
          "evidence_used": ["photo 1", "bearing_temp 92"], "next_steps": ["Stop and refit the guard before restart."]}


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    examples.install(s, db.ALL)
    yield s
    db.set_store(None)


def _visit(store, tmp_path, rid="rec_q_000001", owner="alice"):
    sha = hashlib.sha256(JPEG).hexdigest()
    store.sync_record(owner, "k-" + rid, "dev", {
        "id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0,
        "answers": {"asset_id": "PMP-0101", "condition": "poor", "guard_ok": False, "bearing_temp": 92,
                    "photos": [{"attachment_id": "att_q_photo_01", "sha256": sha}]},
        "attachments": [{"id": "att_q_photo_01", "field_id": "photos", "kind": "photo", "mime": "image/jpeg", "size": len(JPEG), "sha256": sha}]},
        auto_analyze=True)
    store.store_attachment(owner, "att_q_photo_01", JPEG, "image/jpeg", tmp_path / "att", auto_analyze=True)
    return rid


def test_sync_alone_creates_no_ai_work(store, tmp_path):
    rid = _visit(store, tmp_path)
    assert store.get_record("alice", rid)["analysis_status"] == "not_requested"
    assert store.job_counts().get("pending", 0) == 0 and store.list_questions(db.ALL) == []


def test_question_is_answered_from_that_record_with_its_photo(store, tmp_path):
    rid = _visit(store, tmp_path)
    q = store.save_question("alice", rid, questions.validate_new({"id": "q_1", "question": "What do the photos show?",
                                                                   "workspace_id": "ws-x", "attachment_ids": ["att_q_photo_01"]}))
    # The record's workspace wins over what the phone claims (here the only workspace containing the form).
    assert q["status"] == "queued" and q["workspace_id"] == "starter-equipment-inspection" and q["attachment_ids"] == ["att_q_photo_01"]
    # Same phone id again (a retried upload): no duplicate.
    assert store.save_question("alice", rid, {"id": "q_1", "question": "What do the photos show?"})["id"] == "q_1"
    assert len(store.list_questions("alice", rid)) == 1
    rec = Recorder({"default": ANSWER})
    out = questions.process_questions(store, make_llm(rec))
    assert out[0]["status"] == "answered"
    sent = json.dumps(rec.calls[0]["messages"], ensure_ascii=False)
    assert "What do the photos show?" in sent and "PMP-0101" in sent and "image_url" in sent      # this visit, with its photo
    got = store.list_questions("alice", rid)[0]
    assert got["status"] == "answered" and got["answer"]["answer"].startswith("The photo shows") and got["answer"]["photos_seen"] == 1
    # Case-specific: no learning events, no candidates, no rule changes.
    assert store.conn.execute("SELECT COUNT(*) FROM learning_events").fetchone()[0] == 0
    assert store.conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0] == 0


def test_questions_are_owner_scoped_and_validated(store, tmp_path):
    rid = _visit(store, tmp_path)
    with pytest.raises(db.NotFound):
        store.save_question("bob", rid, {"id": "q_b", "question": "Is this mine?"})
    for bad in ({"id": "q", "question": ""}, {"question": "no id"}, {"id": "q", "question": "x" * 2000},
                {"id": "q", "question": "ok", "attachment_ids": "att"}):
        with pytest.raises(db.Invalid):
            questions.validate_new(bad)
    store.save_question("alice", rid, {"id": "q_a", "question": "ok"})
    assert store.list_questions("bob") == [] and len(store.list_questions("alice")) == 1


def test_rate_limited_question_waits_and_model_without_images_answers_from_text(store, tmp_path):
    rid = _visit(store, tmp_path)
    store.save_question("alice", rid, {"id": "q_rl", "question": "Why is this flagged?"})

    class Busy(Exception):
        status_code = 429
    out = questions.process_questions(store, make_llm(Recorder(always_fail=Busy("429 retry_after: 600"))))
    assert out[0]["status"] == "queued" and 500 < out[0]["retry_in_s"] <= 600
    q = store.get_question(db.ALL, "q_rl")
    assert q["status"] == "queued" and q["attempts"] == 0
    store.conn.execute("UPDATE questions SET next_run_at=0")
    rec = Recorder({"default": ANSWER}, reject_images=RuntimeError("Error code: 400 - this model does not support image input"))
    assert questions.process_questions(store, make_llm(rec))[0]["status"] == "answered"
    assert store.get_question(db.ALL, "q_rl")["answer"]["photos_seen"] == 0


def test_chat_question_uses_history_and_is_saved_on_the_visit(store, tmp_path, monkeypatch):
    """"What do you think about this visit?" asked in Hermes chat: retrieves the photo and earlier visits of the same
    asset by itself, and the answer is stored on that visit for the phone ("fieldkit_ask_about_record")."""
    from fieldkit_core import runtime, tools
    store.sync_record("alice", "k-old", "dev", {"id": "rec_q_old001", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                               "base_revision": 0, "completed_at": "2026-11-01T08:00:00Z",
                                               "answers": {"asset_id": "PMP-0101", "condition": "fair", "bearing_temp": 70}}, auto_analyze=True)
    rid = _visit(store, tmp_path)
    store.conn.execute("UPDATE records SET completed_at='2026-11-10T08:00:00Z' WHERE id=?", (rid,))
    store.conn.commit()
    rec = Recorder({"default": ANSWER})
    monkeypatch.setattr(runtime, "llm", make_llm(rec))
    out = json.loads(tools.ask_about_record({"record_id": rid, "question": "What do you think about this visit?"}))
    assert out["ok"] and out["answer"].startswith("The photo shows") and out["photos_seen"] == 1
    sent = json.dumps(rec.calls[0]["messages"], ensure_ascii=False)
    assert "history_of_this_subject" in sent and "rec_q_old001" in sent and "image_url" in sent
    saved = store.list_questions("alice", rid)
    assert saved[0]["question"] == "What do you think about this visit?" and saved[0]["status"] == "answered"
