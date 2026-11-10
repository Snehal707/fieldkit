"""0.2.5 phase A: example rules that see rust/leaks, safe example upgrades, calibrated "needs review"."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from hermes_stub import GOOD_REPORT, Recorder, make_llm  # noqa: E402

from fieldkit_core import analysis, db, engine, examples  # noqa: E402



@pytest.fixture(autouse=True)
def _review_every_record(monkeypatch):
    """These tests exercise the report job queue, which since 0.2.6 no sync triggers (test-only hook)."""
    from fieldkit_core import db as _db
    monkeypatch.setattr(_db, "_AUTO_REVIEW_FOR_TESTS", True)

ROOT = Path(__file__).resolve().parents[2]
WF = json.loads((ROOT / "examples" / "maintenance" / "workflow.json").read_text(encoding="utf-8"))
V1 = json.loads((Path(__file__).parent / "fixtures" / "equipment-inspection-v1.json").read_text(encoding="utf-8"))
# The real hosted inspection that exposed the gap (owner's iPhone, 2026-11-09), as answered on the phone.
PMP_0045 = {"asset_id": "PMP-0045", "running_hours": 1280, "condition": "fair", "symptoms": ["noise"], "guard_ok": True,
            "notes": "Rust on the housing, water leaking near the pump casing"}


def _by(findings, kind):
    return [f for f in findings if f["kind"] == kind]


def test_rust_and_leak_in_notes_raise_the_local_result():
    old = engine.classify(V1, PMP_0045)
    new = engine.classify(WF, PMP_0045)
    assert _by(old, "score")[0]["severity"] == "low" and _by(old, "decision_tree")[0]["detail"] == "Continue routine monitoring"
    assert _by(new, "score")[0]["severity"] == "medium"
    assert _by(new, "decision_tree")[0]["detail"] == "Repair within 7 days and re-inspect"
    assert any(f["id"] == "corrosion_leak_terms" for f in new)


@pytest.mark.parametrize("answers,decision", [
    ({"condition": "good", "symptoms": [], "guard_ok": True, "notes": "all normal"}, "Continue routine monitoring"),
    ({"condition": "fair", "guard_ok": True, "notes": "जंग लगी है"}, "Repair within 7 days and re-inspect"),
    ({"condition": "good", "guard_ok": True, "symptoms": ["vibration"], "vibration_level": 8.0}, "Repair within 7 days and re-inspect"),
    ({"condition": "poor", "guard_ok": True}, "Schedule repair this week"),
    ({"condition": "good", "guard_ok": False}, "Stop and tag out"),
])
def test_decision_tree_paths(answers, decision):
    assert _by(engine.classify(WF, answers), "decision_tree")[0]["detail"] == decision


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    yield s
    db.set_store(None)


def test_unedited_old_example_is_upgraded_and_old_records_keep_their_version(store):
    store.save_workflow(db.ALL, V1, publish=True)
    store.sync_record("alice", "k1", "dev", {"id": "rec_old_v1_0001", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                             "base_revision": 0, "answers": PMP_0045}, auto_analyze=False)
    out = examples.install(store, db.ALL)
    assert "equipment-inspection" in out["upgraded"]
    assert store.get_workflow_any_owner("equipment-inspection", 2)["classification"] == WF["classification"]
    assert store.get_workflow_any_owner("equipment-inspection", 1)["classification"] == V1["classification"]  # history kept
    assert store.get_record(db.ALL, "rec_old_v1_0001")["workflow_version"] == 1
    assert examples.install(store, db.ALL)["upgraded"] == []           # idempotent


def test_edited_example_is_never_overwritten(store):
    edited = json.loads(json.dumps(V1))
    edited["fields"][1]["label"]["en"] = "Pump tag"                     # the owner changed it
    store.save_workflow(db.ALL, edited, publish=True)
    assert examples.install(store, db.ALL)["upgraded"] == []
    assert store.get_workflow_any_owner("equipment-inspection", 1)["fields"][1]["label"]["en"] == "Pump tag"


def _report(**kw):
    return {**GOOD_REPORT,
            "issues": [{"title": "Leak at casing", "severity": "medium", "evidence": "notes",
                        "interpretation": "An active leak wastes water and wets the motor base; it should be repaired soon but is not dangerous.",
                        "evidence_refs": [{"kind": "answer", "ref": "notes"}]}],
            "decision": {"outcome": "act_soon", "rationale": "Leak and rust need repair within a week.", "confidence": "medium",
                         "deadline_days": 7},
            "next_actions": [{"order": 1, "action": "Find the leak source and replace the seal.", "who": "technician",
                              "by_when_days": 7, "verify_by": "No water at the casing after one hour of running", "origin": "ai_suggestion"}],
            **kw}


@pytest.mark.parametrize("report,local,flag", [
    (_report(requires_review=True, review_reason=""), [], False),                         # flag without a reason
    (_report(requires_review=False), [], False),                                          # routine, clear action
    (_report(requires_review=True, review_reason="(b) leak source unknown"), [], True),   # stated reason
    (_report(requires_review=False), [{"severity": "critical"}], True),                   # local critical finding
    ({**GOOD_REPORT, "requires_review": False}, [], True),                                # high/critical issue
])
def test_review_triggers(report, local, flag):
    t = analysis.review_triggers(report, {"local_findings": local})
    assert bool(t) is flag


def test_routine_leak_inspection_is_not_flagged_end_to_end(store):
    examples.install(store, db.ALL)
    store.sync_record("alice", "k2", "dev", {"id": "rec_leak_00001", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                             "base_revision": 0, "answers": PMP_0045,
                                             "local_results": {"findings": engine.classify(WF, PMP_0045)}}, auto_analyze=True)
    llm = make_llm(Recorder({"default": _report(requires_review=True, review_reason="")}))
    if llm is None:
        pytest.skip("Hermes source not available")
    out = analysis.process_pending(store, llm)
    assert out[0]["status"] == "completed"
    rep = store.get_report(db.ALL, record_id="rec_leak_00001")
    assert rep["requires_review"] is False and rep["review_triggers"] == []
    assert "Do not" not in json.dumps(rep["review_reason"])
    prompt_has_rule = "NOT a review case" in analysis.SYSTEM
    assert prompt_has_rule
