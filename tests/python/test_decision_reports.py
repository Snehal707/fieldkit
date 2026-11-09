"""Phase D (0.2.5): reports that help a user decide, enforced after the model answers, with one repair pass."""
import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from hermes_stub import GOOD_REPORT, Recorder, make_llm  # noqa: E402
from workspace_fixtures import BUNDLE  # noqa: E402

from fieldkit_core import analysis, db, decision, examples, workspace as ws  # noqa: E402

SCALE = [{"id": "stop", "severity": "critical"}, {"id": "act_soon", "severity": "medium"}, {"id": "monitor", "severity": "low"}]
REFS = {"guard_ok", "vibration_level", "condition"}


def _ctx(call):
    for part in call["messages"][-1]["content"]:
        t = part.get("text", "") if isinstance(part, dict) else ""
        if t.lstrip().startswith("{") and "decision_scale" in t:
            return json.loads(t)
    raise AssertionError("record context not found in the prompt")


def _rep(**kw):
    return {**copy.deepcopy(GOOD_REPORT), **kw}


def test_good_report_passes():
    assert decision.check_report(_rep(), SCALE, REFS, set(), set()) == []


@pytest.mark.parametrize("change,problem", [
    (lambda r: r["decision"].update(outcome="maybe"), "is not one of"),
    (lambda r: r["decision"].pop("escalate_to"), "must name escalate_to"),
    (lambda r: r["issues"][0].update(evidence_refs=[{"kind": "answer", "ref": "not_a_field"}]), "cites no evidence"),
    (lambda r: r["issues"][0].update(interpretation="guard_ok = false", evidence="guard_ok = false"), "restates the answer"),
    (lambda r: r["next_actions"][0].update(verify_by=""), "has no verify_by"),
    (lambda r: r["next_actions"][0].update(origin="guide", guide_id="g_made_up"), "not in workspace_guides"),
    (lambda r: r["next_actions"][0].update(origin="knowledge", entry_id="k_made_up"), "not in workspace_knowledge"),
    (lambda r: r.update(next_actions=[]), "next_actions is empty"),
    (lambda r: r.update(uncertainty=[{"unknown": "x", "impact": "decisive for the decision", "how_to_resolve": "y"}]), "lower the confidence"),
])
def test_quality_rules(change, problem):
    r = _rep()
    change(r)
    assert any(problem in p for p in decision.check_report(r, SCALE, REFS, set(), set())), decision.check_report(r, SCALE, REFS, set(), set())


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    examples.install(s, db.ALL)
    yield s
    db.set_store(None)


def _llm(rec):
    llm = make_llm(rec)
    if llm is None:
        pytest.skip("Hermes source not available")
    return llm


def _pump(store, rid="rec_dec_000001", answers=None, local=None):
    store.sync_record("alice", f"k-{rid}", "dev", {"id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1,
                                                   "base_revision": 0, "answers": answers or {"condition": "poor", "guard_ok": False},
                                                   "local_results": local or {}}, auto_analyze=False)
    return rid


def test_bad_report_is_repaired_once(store):
    bad = _rep(issues=[{"title": "Guard", "severity": "critical", "evidence": "guard_ok = false", "interpretation": "guard_ok = false",
                        "evidence_refs": [{"kind": "answer", "ref": "nope"}]}])
    rec = Recorder({"default": bad, "REPAIR THESE PROBLEMS": _rep()})
    report, review, *_ = analysis.analyze_record(store, _llm(rec), _pump(store))
    assert len(rec.calls) == 2
    assert "cites no evidence" in json.dumps(rec.calls[1]["messages"], ensure_ascii=False)
    assert report["quality"] == {"problems": [], "repaired": True}
    assert report["decision"]["outcome"] == "stop" and report["schema_version"] == 2


def test_unrepaired_problems_are_shown_and_trigger_review(store):
    bad = _rep(issues=[{"title": "Rust", "severity": "low", "evidence": "rust", "interpretation": "rust",
                        "evidence_refs": [{"kind": "answer", "ref": "nope"}]}],
               decision={"outcome": "act_soon", "rationale": "Rust seen.", "confidence": "medium"})
    rec = Recorder({"default": bad})
    report, review, *_ = analysis.analyze_record(store, _llm(rec), _pump(store, answers={"condition": "fair", "guard_ok": True}))
    assert len(rec.calls) == 2 and report["quality"]["repaired"] is True and report["quality"]["problems"]
    assert review is True and any("quality check" in t for t in report["review_triggers"])


def test_workspace_context_limits_what_can_be_cited(store):
    d = ws.build_draft(store, db.ALL, BUNDLE)
    ws.publish(store, BUNDLE["id"], d["version"])
    store.sync_record("alice", "k-milk", "dev", {"id": "rec_milk_000001", "workflow_id": "milk-collection-check", "workflow_version": 1,
                                                 "base_revision": 0, "answers": {"farmer_code": "F-12", "milk_type": "cow",
                                                                                 "fat_pct": 3.4, "snf_pct": 8.2}}, auto_analyze=False)
    good = _rep(issues=[{"title": "SNF below minimum", "severity": "medium", "evidence": "snf_pct 8.2",
                         "interpretation": "8.2% is under the 8.5% minimum for cow milk, so the sample may be watered or poor quality.",
                         "evidence_refs": [{"kind": "measurement", "ref": "snf_pct"}]}],
                decision={"outcome": "retest", "rationale": "Below minimum once; re-test before rejecting.", "confidence": "medium"},
                next_actions=[{"order": 1, "action": "Re-test the sample", "verify_by": "Second reading recorded", "origin": "guide",
                               "guide_id": "g_accept"},
                              {"order": 2, "action": "Follow the re-test procedure", "verify_by": "Procedure done", "origin": "knowledge",
                               "entry_id": "k_retest"}])
    rec = Recorder({"default": good})
    report, *_ = analysis.analyze_record(store, _llm(rec), "rec_milk_000001")
    ctx = _ctx(rec.calls[0])
    assert [d["id"] for d in ctx["decision_scale"]] == ["reject", "retest", "accept"]
    assert [g["id"] for g in ctx["workspace_guides"]] == ["g_accept"]
    assert [e["id"] for e in ctx["workspace_knowledge"]] == ["k_retest"]          # unverified background is not citable
    assert ctx["report_languages"] == ["en", "hi"] and "_evidence_status" not in ctx
    assert len(rec.calls) == 1 and report["quality"]["problems"] == []
    assert report["workspace"]["id"] == "dairy-collection-mh"


def test_followup_check_results_reach_the_next_analysis(store):
    checks = [{"id": "fc_1", "what": "Vibration after alignment", "result": "done", "value": "3.9 mm/s", "report_id": "rep_x"}]
    rec = Recorder({"default": _rep()})
    analysis.analyze_record(store, _llm(rec), _pump(store, local={"followup_checks": checks}))
    ctx = _ctx(rec.calls[0])
    assert ctx["previous_followup_checks"][0]["value"] == "3.9 mm/s"


def test_v1_readers_still_get_suggested_actions():
    r = analysis._normalize_report(_rep(suggested_actions=None), {"decision_scale": SCALE, "workflow": {}, "record": {"answers": []},
                                                                  "local_findings": [], "reference_passages": []})
    assert r["suggested_actions"][0] == {"action": "Tag out the machine until the guard is refitted.", "priority": "urgent"}
    assert [f["verify_by"] for f in r["followups"]][:1] == ["Guard refitted and the tag removed by the supervisor"]
