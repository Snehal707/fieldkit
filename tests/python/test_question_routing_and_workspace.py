"""Fixes from iPhone testing on hosted 0.2.6.

1. A queued question with photos failed 3 times with "NotFoundError 404": photos went to Hermes' main model, which
   on Nous Portal answers 404 to images when the model is text-only, and FieldKit did not read a 404 as "no image
   input". Questions with photos now use FieldKit's fieldkit_vision slot first, then the main model, then the text
   evidence; failures say what each route returned; a failed question can be asked again.
2. Records were synced without their workspace. The phone now sends it; the server validates it (a published
   workspace containing the record's form), repairs old records only when exactly one workspace fits, and never guesses.
"""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).parent))

from hermes_stub import Recorder, load_plugin_llm, make_llm  # noqa: E402

from fieldkit_core import db, examples, questions, tools  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"fake-photo-bytes" * 20
ANSWER = {"answer": "The guard is missing in the photo.", "confidence": "medium", "uncertainty": "",
          "evidence_used": ["photo 1"], "next_steps": []}


class NotFoundError(Exception):
    """Shape of the OpenAI client's error for an HTTP 404 (what the iPhone test showed)."""
    status_code = 404


NOUS_404 = NotFoundError("Error code: 404 - {'error': {'message': 'Not Found'}}")


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FIELDKIT_VISION_TASK", raising=False)
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    examples.install(s, db.ALL)
    yield s
    db.set_store(None)


@pytest.fixture()
def slot_registered(monkeypatch):
    """As in Hermes after register(ctx), with the operator's auxiliary.fieldkit_vision configured (vision_task: true):
    FieldKit owns the fieldkit_vision auxiliary task and uses it for photos."""
    mod = load_plugin_llm()
    monkeypatch.setattr(mod, "_resolve_task_ownership", lambda pid: (frozenset({"fieldkit_vision"}), frozenset()))
    monkeypatch.setenv("FIELDKIT_VISION_TASK", "true")


class Describer:
    """Stands in for Hermes' vision tool (tools.vision_tools.vision_analyze_tool), which picks a vision model itself."""
    def __init__(self, ok=True):
        self.ok, self.calls = ok, []

    def __call__(self, path, prompt):
        self.calls.append((path, prompt))
        return ({"success": True, "analysis": "A fridge thermometer reading 8 C; the door seal is torn."} if self.ok
                else {"success": False, "error": "no vision model configured"})


@pytest.fixture()
def describer(monkeypatch):
    from fieldkit_core import media
    d = Describer()
    monkeypatch.setattr(media, "hermes_photo_describer", lambda: (d, ""))
    return d


def _visit(store, tmp_path, rid="rec_r_000001", owner="alice", workspace_id=None, photo=True):
    sha = hashlib.sha256(JPEG).hexdigest()
    rec = {"id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0,
           "answers": {"asset_id": "PMP-0101", "condition": "poor", "guard_ok": False}}
    if workspace_id is not None:
        rec["workspace_id"] = workspace_id
    if photo:
        rec["answers"]["photos"] = [{"attachment_id": "att_" + rid[-6:] + "_ph", "sha256": sha}]
        rec["attachments"] = [{"id": "att_" + rid[-6:] + "_ph", "field_id": "photos", "mime": "image/jpeg", "size": len(JPEG), "sha256": sha}]
    ack = store.sync_record(owner, "k-" + rid, "dev", rec, auto_analyze=False)
    if photo:
        store.store_attachment(owner, "att_" + rid[-6:] + "_ph", JPEG, "image/jpeg", tmp_path / "att", auto_analyze=False)
    return ack


# ----------------------------------------------------------------------------- 1. model routing
def test_photo_question_uses_the_vision_slot(store, tmp_path, slot_registered):
    _visit(store, tmp_path)
    store.save_question("alice", "rec_r_000001", {"id": "q_v1", "question": "What do the photos show?"})
    rec = Recorder({"default": ANSWER})
    assert questions.process_questions(store, make_llm(rec))[0]["status"] == "answered"
    assert len(rec.calls) == 1 and rec.calls[0]["task"] == "fieldkit_vision" and Recorder.has_image(rec.calls[0])
    a = store.get_question(db.ALL, "q_v1")["answer"]
    assert a["route"] == "vision_slot" and a["photos_seen"] == 1 and "fallbacks" not in a


def test_text_only_main_model_answers_from_hermes_vision_descriptions(store, tmp_path, describer):
    """The iPhone failure: the main model is text-only and answers 404 to images → before the fix, 3 failed attempts.
    Now, in the same attempt: Hermes' vision tool describes the photo and the main model answers from it."""
    _visit(store, tmp_path)
    store.save_question("alice", "rec_r_000001", {"id": "q_404", "question": "What do the photos show?"})
    rec = Recorder({"default": ANSWER}, reject_images=NOUS_404)
    out = questions.process_questions(store, make_llm(rec))
    assert out[0]["status"] == "answered"
    a = store.get_question(db.ALL, "q_404")["answer"]
    assert a["route"] == "photo_descriptions" and a["photos_seen"] == 1
    assert a["fallbacks"][0].startswith("main_model_with_photos: NotFoundError 404")
    assert len(rec.calls) == 2 and [c.get("task") for c in rec.calls] == [None, None]   # no wasted slot call
    sent = json.dumps(rec.calls[-1]["messages"], ensure_ascii=False)
    assert "photo_descriptions" in sent and "door seal is torn" in sent and not Recorder.has_image(rec.calls[-1])
    assert len(describer.calls) == 1 and describer.calls[0][0].endswith(".jpg")   # a typed copy, never the stored file
    # A second question about the same visit reuses the description: no second vision call.
    store.save_question("alice", "rec_r_000001", {"id": "q_404b", "question": "Is the seal damaged?"})
    questions.process_questions(store, make_llm(Recorder({"default": ANSWER}, reject_images=NOUS_404)))
    assert store.get_question(db.ALL, "q_404b")["answer"]["route"] == "photo_descriptions" and len(describer.calls) == 1


def test_without_any_vision_the_answer_uses_text_and_says_so(store, tmp_path, monkeypatch):
    from fieldkit_core import media
    monkeypatch.setattr(media, "hermes_photo_describer", lambda: (Describer(ok=False), ""))
    _visit(store, tmp_path)
    store.save_question("alice", "rec_r_000001", {"id": "q_txt", "question": "What do the photos show?"})
    rec = Recorder({"default": ANSWER}, reject_images=NOUS_404)
    assert questions.process_questions(store, make_llm(rec))[0]["status"] == "answered"
    a = store.get_question(db.ALL, "q_txt")["answer"]
    assert a["route"] == "text_only" and a["photos_seen"] == 0
    assert any(f.startswith("photo_descriptions: photo 1: no vision model configured") for f in a["fallbacks"])
    assert "photos_not_seen" in json.dumps(rec.calls[-1]["messages"])         # the model is told it can't see them


def test_vision_slot_failure_falls_back_to_main_model_with_photos(store, tmp_path, slot_registered):
    _visit(store, tmp_path)
    store.save_question("alice", "rec_r_000001", {"id": "q_vf", "question": "What do the photos show?"})

    class SlotFails:
        def __init__(self):
            self.calls = []

        def __call__(self, **kw):
            self.calls.append(kw)
            if kw.get("task") == "fieldkit_vision":
                raise NOUS_404
            return Recorder({"default": ANSWER})(**kw)
    rec = SlotFails()
    assert questions.process_questions(store, make_llm(rec))[0]["status"] == "answered"
    assert [c.get("task") for c in rec.calls] == ["fieldkit_vision", None] and Recorder.has_image(rec.calls[1])
    a = store.get_question(db.ALL, "q_vf")["answer"]
    assert a["route"] == "main_model_with_photos" and a["photos_seen"] == 1 and a["fallbacks"][0].startswith("vision_slot")


def test_unconfigured_slot_is_not_tried(store, tmp_path, monkeypatch):
    """Without auxiliary.fieldkit_vision configured, Hermes would route the slot to the main model: not tried."""
    assert questions.use_vision_slot() is False


def test_vision_slot_can_be_turned_off(store, tmp_path, slot_registered, monkeypatch):
    monkeypatch.setenv("FIELDKIT_VISION_TASK", "false")
    _visit(store, tmp_path)
    store.save_question("alice", "rec_r_000001", {"id": "q_off", "question": "What do the photos show?"})
    rec = Recorder({"default": ANSWER})
    questions.process_questions(store, make_llm(rec))
    assert rec.calls[0].get("task") in (None, "") and Recorder.has_image(rec.calls[0])


def test_rate_limit_on_the_slot_waits_instead_of_downgrading(store, tmp_path, slot_registered):
    _visit(store, tmp_path)
    store.save_question("alice", "rec_r_000001", {"id": "q_rl", "question": "What do the photos show?"})

    class Busy(Exception):
        status_code = 429
    rec = Recorder(always_fail=Busy("429 retry_after: 120"))
    out = questions.process_questions(store, make_llm(rec))
    assert out[0]["status"] == "queued" and len(rec.calls) == 1               # no extra routes burnt
    assert store.get_question(db.ALL, "q_rl")["attempts"] == 0


def test_a_real_failure_says_what_each_route_returned_and_can_be_asked_again(store, tmp_path, slot_registered, describer):
    _visit(store, tmp_path)
    store.save_question("alice", "rec_r_000001", {"id": "q_bad", "question": "What do the photos show?"})
    rec = Recorder(always_fail=NotFoundError("Error code: 404 - model 'nous/does-not-exist' not found"))
    for _ in range(3):
        store.conn.execute("UPDATE questions SET next_run_at=0")
        store.conn.commit()
        questions.process_questions(store, make_llm(rec))
    q = store.get_question(db.ALL, "q_bad")
    assert q["status"] == "failed"
    for route in ("vision_slot: NotFoundError 404", "main_model_with_photos: NotFoundError 404", "photo_descriptions: NotFoundError 404"):
        assert route in q["error"], q["error"]
    # "Ask again" from the phone: same id, retry flag → a fresh set of attempts; other users can't.
    with pytest.raises(db.NotFound):
        store.save_question("bob", "rec_r_000001", questions.validate_new({"id": "q_bad", "question": "x", "retry": True}))
    again = store.save_question("alice", "rec_r_000001", questions.validate_new({"id": "q_bad", "question": "What do the photos show?", "retry": True}))
    assert again["status"] == "queued" and again["attempts"] == 0
    assert questions.process_questions(store, make_llm(Recorder({"default": ANSWER})))[0]["status"] == "answered"
    # Without the flag, re-sending the same id stays idempotent (no re-queue of an answered question).
    assert store.save_question("alice", "rec_r_000001", {"id": "q_bad", "question": "x"})["status"] == "answered"


def test_question_waits_until_the_visits_photo_has_uploaded(store, tmp_path, slot_registered):
    """On a phone the record arrives first and its photo after; a question sent in between must not be answered
    without the photo. After 30 minutes it is answered with what arrived."""
    sha = hashlib.sha256(JPEG).hexdigest()
    store.sync_record("alice", "k-wait", "dev", {"id": "rec_r_wait01", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                                 "base_revision": 0, "answers": {"asset_id": "PMP-0101", "photos": [{"attachment_id": "att_wait_ph1", "sha256": sha}]},
                                                 "attachments": [{"id": "att_wait_ph1", "field_id": "photos", "mime": "image/jpeg", "size": len(JPEG), "sha256": sha}]},
                      auto_analyze=False)
    store.save_question("alice", "rec_r_wait01", {"id": "q_wait", "question": "What do the photos show?"})
    rec = Recorder({"default": ANSWER})
    assert questions.process_questions(store, make_llm(rec)) == [] and rec.calls == []        # photo not here yet
    store.store_attachment("alice", "att_wait_ph1", JPEG, "image/jpeg", tmp_path / "att", auto_analyze=False)
    assert questions.process_questions(store, make_llm(rec))[0]["status"] == "answered"
    assert store.get_question(db.ALL, "q_wait")["answer"]["photos_seen"] == 1
    # A file that never arrives does not block the question for ever.
    store.sync_record("alice", "k-wait2", "dev", {"id": "rec_r_wait02", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                                  "base_revision": 0, "answers": {"asset_id": "PMP-0102"},
                                                  "attachments": [{"id": "att_wait_ph2", "field_id": "photos", "mime": "image/jpeg", "size": 9, "sha256": sha}]},
                      auto_analyze=False)
    store.save_question("alice", "rec_r_wait02", {"id": "q_wait2", "question": "Anything unusual?"})
    assert questions.process_questions(store, make_llm(rec)) == []
    store.conn.execute("UPDATE questions SET created_at=created_at-1801 WHERE id='q_wait2'")
    store.conn.commit()
    assert questions.process_questions(store, make_llm(rec))[0]["status"] == "answered"


# ----------------------------------------------------------------------------- 2. workspace association
def _second_workspace_with_same_form(store):
    """A built workspace that references the example form too → that form is in two workspaces (ambiguous)."""
    from fieldkit_core import workspace as ws
    b = json.loads(json.dumps(store.get_workspace_version("starter-equipment-inspection")["bundle"]))
    b["id"] = "plant-rounds"
    b["title"] = {"en": "Plant rounds"}
    b["starter"] = False
    d = ws.build_draft(store, db.ALL, b, changelog=["test"])
    ws.publish(store, "plant-rounds", d["version"], actor=db.ALL)


def test_sync_stores_the_phones_workspace_when_valid(store, tmp_path):
    _second_workspace_with_same_form(store)
    ack = _visit(store, tmp_path, workspace_id="plant-rounds")
    assert ack["workspace_id"] == "plant-rounds" and "workspace_note" not in ack
    assert store.get_record("alice", "rec_r_000001")["workspace_id"] == "plant-rounds"
    # A question takes the record's workspace, whatever the phone says.
    q = store.save_question("alice", "rec_r_000001", questions.validate_new({"id": "q_w", "question": "ok", "workspace_id": "nope"}))
    assert q["workspace_id"] == "plant-rounds"


def test_sync_rejects_a_workspace_that_does_not_contain_the_form(store, tmp_path):
    _second_workspace_with_same_form(store)
    ack = _visit(store, tmp_path, workspace_id="starter-classroom-observation")
    assert ack["workspace_id"] is None and "not stored" in ack["workspace_note"]   # ambiguous → not guessed
    ack2 = _visit(store, tmp_path, rid="rec_r_000002", workspace_id="made-up")
    assert ack2["workspace_id"] is None


def test_unique_workspace_is_filled_in_and_ambiguous_is_not(store, tmp_path):
    ack = _visit(store, tmp_path, photo=False)                    # old phone: no workspace sent; one workspace fits
    assert ack["workspace_id"] == "starter-equipment-inspection"
    _second_workspace_with_same_form(store)
    ack = _visit(store, tmp_path, rid="rec_r_000002", photo=False)  # now two fit → not guessed
    assert ack["workspace_id"] is None and "2 workspaces" in ack["workspace_note"]
    # An edit without a workspace never clears a stored one.
    store.sync_record("alice", "k-edit", "dev", {"id": "rec_r_000001", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                                 "base_revision": 1, "answers": {"asset_id": "PMP-0101", "condition": "fair"}}, auto_analyze=False)
    assert store.get_record("alice", "rec_r_000001")["workspace_id"] == "starter-equipment-inspection"


def test_historical_repair_only_where_unambiguous(store, tmp_path):
    _visit(store, tmp_path, photo=False)
    _visit(store, tmp_path, rid="rec_r_000002", photo=False)
    store.conn.execute("UPDATE records SET workspace_id=NULL")          # as synced by 0.2.6 before the fix
    store.conn.commit()
    store.save_question("alice", "rec_r_000002", {"id": "q_h", "question": "ok"})
    before = store.conn.execute("SELECT id, answers, revision FROM records ORDER BY id").fetchall()
    assert store.repair_record_workspaces() == {"repaired": 2, "ambiguous": 0, "no_workspace": 0}
    assert store.get_record("alice", "rec_r_000002")["workspace_id"] == "starter-equipment-inspection"
    assert store.get_question(db.ALL, "q_h")["workspace_id"] == "starter-equipment-inspection"
    after = store.conn.execute("SELECT id, answers, revision FROM records ORDER BY id").fetchall()
    assert [tuple(r) for r in before] == [tuple(r) for r in after]       # nothing else touched
    assert any(e["action"] == "record.workspace_repaired" for e in store.audit_log())
    assert store.repair_record_workspaces()["repaired"] == 0            # idempotent
    # With two candidate workspaces, a record without one stays empty.
    _second_workspace_with_same_form(store)
    store.conn.execute("UPDATE records SET workspace_id=NULL WHERE id='rec_r_000001'")
    store.conn.commit()
    assert store.repair_record_workspaces() == {"repaired": 0, "ambiguous": 1, "no_workspace": 0}
    assert store.get_record("alice", "rec_r_000001")["workspace_id"] is None


def test_answers_use_the_records_workspace_and_list_by_workspace(store, tmp_path):
    _second_workspace_with_same_form(store)
    _visit(store, tmp_path, workspace_id="plant-rounds", photo=False)
    _visit(store, tmp_path, rid="rec_r_000002", workspace_id="starter-equipment-inspection", photo=False)
    _visit(store, tmp_path, rid="rec_r_000003", photo=False)                    # ambiguous, unassigned
    store.save_question("alice", "rec_r_000001", {"id": "q_ctx", "question": "What next?"})
    rec = Recorder({"default": ANSWER})
    questions.process_questions(store, make_llm(rec))
    sent = json.dumps(rec.calls[0]["messages"], ensure_ascii=False)
    assert 'plant-rounds' in sent and 'Plant rounds' in sent                     # this record's workspace context
    out = json.loads(tools.list_records({"workspace_id": "plant-rounds"}))
    assert [r["id"] for r in out["records"]] == ["rec_r_000001"] and out["unassigned_records"] == 1
