"""Data access for Hermes: list and read synced entries, open their files, history of a subject, the workspace each
entry belongs to (validated on sync, repaired only when unambiguous), and data from earlier FieldKit versions."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fieldkit_core import db, tools, workspace as ws  # noqa: E402
from seed import example_forms, seed  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"photo-bytes" * 30
WEBM = b"\x1aE\xdf\xa3" + b"voice-bytes" * 30


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    seed(s)
    yield s
    db.set_store(None)


def call(name, **args):
    return json.loads(tools.handler_for(name)(args))


def _visit(store, tmp_path, rid, asset="PMP-0101", owner="alice", workspace_id=None, completed="2026-11-10T09:00:00Z",
           photo=False, voice=False, extra=None):
    answers = {"asset_id": asset, "inspection_date": completed[:10], "condition": "poor", **(extra or {})}
    atts = []
    if photo:
        answers["photos"] = [{"attachment_id": f"att_{rid[-6:]}_ph", "sha256": hashlib.sha256(JPEG).hexdigest()}]
        atts.append({"id": f"att_{rid[-6:]}_ph", "field_id": "photos", "mime": "image/jpeg", "size": len(JPEG),
                     "sha256": hashlib.sha256(JPEG).hexdigest()})
    if voice:
        answers["voice_note"] = {"attachment_id": f"att_{rid[-6:]}_vn", "sha256": hashlib.sha256(WEBM).hexdigest(),
                                 "transcript": "bearing is noisy"}
        atts.append({"id": f"att_{rid[-6:]}_vn", "field_id": "voice_note", "mime": "audio/webm", "size": len(WEBM),
                     "sha256": hashlib.sha256(WEBM).hexdigest()})
    rec = {"id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0, "answers": answers,
           "completed_at": completed, "attachments": atts}
    if workspace_id is not None:
        rec["workspace_id"] = workspace_id
    ack = store.sync_record(owner, "k-" + rid, "dev", rec)
    if photo:
        store.store_attachment(owner, f"att_{rid[-6:]}_ph", JPEG, "image/jpeg", tmp_path / "attachments")
    if voice:
        store.store_attachment(owner, f"att_{rid[-6:]}_vn", WEBM, "audio/webm", tmp_path / "attachments")
    return ack


def _second_workspace_with_same_form(store):
    form = example_forms()["maintenance"]
    d = ws.build_draft(store, db.ALL, {"id": "plant-rounds", "title": {"en": "Plant rounds"}, "profile": {"purpose": "Rounds"},
                                       "languages": {"content": ["en"]}, "workflow_refs": [form["id"]]})
    assert d["ok"], d["validation"]
    ws.publish(store, "plant-rounds", d["version"], actor=db.ALL)


# ----------------------------------------------------------------------------- reading entries
def test_get_record_gives_answers_files_history_and_never_calls_a_model(store, tmp_path):
    _visit(store, tmp_path, "rec_hist_00001", completed="2026-11-01T09:00:00Z")
    _visit(store, tmp_path, "rec_other_0001", asset="PMP-9999", completed="2026-11-05T09:00:00Z")
    _visit(store, tmp_path, "rec_now_000001", completed="2026-11-10T09:00:00Z", photo=True, voice=True)
    out = call("fieldkit_get_record", record_id="rec_now_000001")
    assert out["ok"] and out["form"]["id"] == "equipment-inspection"
    by_field = {a["field_id"]: a for a in out["answers"]}
    assert by_field["asset_id"]["question"] and by_field["condition"]["answer"] == "Poor"          # labels, not raw values
    kinds = {a["kind"]: a for a in out["record"]["attachments"]}
    assert kinds["photo"]["integrity"] == "intact" and kinds["audio"]["phone_transcript"] == "bearing is noisy"
    assert out["record"]["attachment_summary"] == "1 photo · 1 voice note"
    assert out["subject"] == {"field_id": "asset_id", "value": "PMP-0101",
                              "earlier_entries": [{"record_id": "rec_hist_00001", "completed_at": "2026-11-01T09:00:00Z"}]}
    assert out["revisions"][0]["revision"] == 1 and "from_earlier_fieldkit_versions" not in out
    assert "analysis_status" not in out["record"] and "fieldkit_get_attachment" in out["next"]


def test_get_attachment_gives_a_readable_file_for_hermes_tools(store, tmp_path):
    _visit(store, tmp_path, "rec_files_0001", photo=True, voice=True)
    ph = call("fieldkit_get_attachment", attachment_id="att_s_0001_ph")
    assert ph["ok"] and ph["kind"] == "photo" and ph["integrity"] == "intact" and ph["path"].endswith(".jpg")
    assert Path(ph["path"]).read_bytes() == JPEG
    vn = call("fieldkit_get_attachment", attachment_id="att_s_0001_vn")
    assert vn["path"].endswith(".webm") and vn["phone_transcript"] == "bearing is noisy"
    stored = store.get_attachment(db.ALL, "att_s_0001_ph")["path"]
    assert Path(stored).read_bytes() == JPEG and not stored.endswith(".jpg")                # original untouched
    store.sync_record("alice", "k-up", "dev", {"id": "rec_files_0002", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                               "base_revision": 0, "answers": {"asset_id": "X"},
                                               "attachments": [{"id": "att_pending_01", "field_id": "photos", "mime": "image/jpeg",
                                                                "size": 9, "sha256": "0" * 64}]})
    pending = call("fieldkit_get_attachment", attachment_id="att_pending_01")
    assert not pending["ok"] and "not finished uploading" in pending["error"]


def test_list_records_filters_by_subject_period_and_gives_answers(store, tmp_path):
    _visit(store, tmp_path, "rec_list_00001", asset="PMP-0101", completed="2026-11-01T09:00:00Z")
    _visit(store, tmp_path, "rec_list_00002", asset="PMP-0202", completed="2026-11-05T09:00:00Z")
    _visit(store, tmp_path, "rec_list_00003", asset="PMP-0101", completed="2026-11-09T09:00:00Z")
    assert [r["id"] for r in call("fieldkit_list_records", subject="0101")["records"]] == ["rec_list_00003", "rec_list_00001"]
    assert [r["id"] for r in call("fieldkit_list_records", since="2026-11-04", until="2026-11-06")["records"]] == ["rec_list_00002"]
    full = call("fieldkit_list_records", workspace_id="starter-equipment-inspection", include_answers=True, limit=1)
    assert full["count"] == 1 and full["records"][0]["answers"][0]["question"]


def test_sync_status_and_conflict_resolution_tools(store, tmp_path):
    _visit(store, tmp_path, "rec_conf_00001")
    store.sync_record("alice", "k-e1", "dev", {"id": "rec_conf_00001", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                               "base_revision": 1, "answers": {"asset_id": "PMP-0101", "condition": "fair"}})
    with pytest.raises(db.Conflict):
        store.sync_record("alice", "k-e2", "dev2", {"id": "rec_conf_00001", "workflow_id": "equipment-inspection",
                                                    "workflow_version": 1, "base_revision": 1, "answers": {"asset_id": "PMP-0101", "condition": "good"}})
    st = call("fieldkit_get_sync_status")
    assert st["status"]["open_conflicts"] == 1 and "jobs" not in st["status"]
    res = call("fieldkit_resolve_conflict", conflict_id=st["conflicts"][0]["id"], resolution="keep_server")
    assert res["ok"] and store.get_record(db.ALL, "rec_conf_00001")["answers"]["condition"] == "fair"


# ----------------------------------------------------------------------------- workspace on records
def test_sync_stores_the_phones_workspace_when_valid(store, tmp_path):
    _second_workspace_with_same_form(store)
    ack = _visit(store, tmp_path, "rec_ws_000001", workspace_id="plant-rounds")
    assert ack["workspace_id"] == "plant-rounds" and "workspace_note" not in ack
    bad = _visit(store, tmp_path, "rec_ws_000002", workspace_id="starter-classroom-observation")
    assert bad["workspace_id"] is None and "not stored" in bad["workspace_note"]           # ambiguous → never guessed


def test_unique_workspace_is_filled_in_and_edits_never_clear_it(store, tmp_path):
    assert _visit(store, tmp_path, "rec_ws_000003")["workspace_id"] == "starter-equipment-inspection"
    store.sync_record("alice", "k-edit", "dev", {"id": "rec_ws_000003", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                                 "base_revision": 1, "answers": {"asset_id": "PMP-0101", "condition": "fair"}})
    assert store.get_record(db.ALL, "rec_ws_000003")["workspace_id"] == "starter-equipment-inspection"
    _second_workspace_with_same_form(store)
    ack = _visit(store, tmp_path, "rec_ws_000004")
    assert ack["workspace_id"] is None and "2 workspaces" in ack["workspace_note"]


def test_historical_repair_only_where_unambiguous(store, tmp_path):
    _visit(store, tmp_path, "rec_rep_00001")
    _visit(store, tmp_path, "rec_rep_00002")
    store.conn.execute("UPDATE records SET workspace_id=NULL")                  # as synced before the fix
    store.conn.commit()
    before = store.conn.execute("SELECT id, answers, revision FROM records ORDER BY id").fetchall()
    assert store.repair_record_workspaces() == {"repaired": 2, "ambiguous": 0, "no_workspace": 0}
    after = store.conn.execute("SELECT id, answers, revision FROM records ORDER BY id").fetchall()
    assert [tuple(r) for r in before] == [tuple(r) for r in after]
    assert store.repair_record_workspaces()["repaired"] == 0
    _second_workspace_with_same_form(store)
    store.conn.execute("UPDATE records SET workspace_id=NULL WHERE id='rec_rep_00001'")
    store.conn.commit()
    assert store.repair_record_workspaces() == {"repaired": 0, "ambiguous": 1, "no_workspace": 0}


def test_list_by_workspace_reports_unassigned_entries(store, tmp_path):
    _second_workspace_with_same_form(store)
    _visit(store, tmp_path, "rec_lw_000001", workspace_id="plant-rounds")
    _visit(store, tmp_path, "rec_lw_000002", workspace_id="starter-equipment-inspection")
    _visit(store, tmp_path, "rec_lw_000003")                                       # ambiguous, unassigned
    out = call("fieldkit_list_records", workspace_id="plant-rounds")
    assert [r["id"] for r in out["records"]] == ["rec_lw_000001"] and out["unassigned_records"] == 1


# ----------------------------------------------------------------------------- data from earlier versions
def test_reports_questions_and_findings_from_earlier_versions_stay_readable(store, tmp_path):
    _visit(store, tmp_path, "rec_old_000001")
    store.conn.execute("UPDATE records SET local_results=? WHERE id='rec_old_000001'",
                       (json.dumps({"findings": [{"id": "guard_missing", "severity": "critical", "label": "Guard missing"}]}),))
    store.conn.execute("INSERT INTO reports(id, record_id, owner_user_id, version, record_revision, content, generated_by, created_at) "
                       "VALUES ('rep_old_1','rec_old_000001','alice',1,1,?, 'fieldkit 0.2.5', 1.0)",
                       (json.dumps({"report_id": "rep_old_1", "version": 1, "summary": "Old summary", "source": "hermes"}),))
    store.conn.execute("INSERT INTO questions(id, owner_user_id, record_id, question, status, answer, attempts, created_at) "
                       "VALUES ('q_old_1','alice','rec_old_000001','What next?','answered',?,1,1.0)",
                       (json.dumps({"answer": "Refit the guard."}),))
    store.conn.execute("INSERT INTO questions(id, owner_user_id, record_id, question, status, attempts, created_at) "
                       "VALUES ('q_old_2','alice','rec_old_000001','Still queued?','queued',0,2.0)")
    store.conn.commit()
    legacy = call("fieldkit_get_record", record_id="rec_old_000001")["from_earlier_fieldkit_versions"]
    assert legacy["report"]["summary"] == "Old summary" and legacy["on_phone_findings"][0]["label"] == "Guard missing"
    assert {q["question"]: q["answer"] for q in legacy["questions"]} == {"What next?": "Refit the guard.", "Still queued?": None}
    # Syncing never creates processing work: the old job queue is never written again.
    _visit(store, tmp_path, "rec_new_000001")
    assert store.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert store.get_question(db.ALL, "q_old_2")["status"] == "queued"            # nothing picks it up; still readable
