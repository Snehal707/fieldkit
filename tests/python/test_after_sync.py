"""0.2.6: each workspace says what Hermes does when records sync: save only, summaries on request, or a report per
record. Only 'analyze' creates automatic report jobs; workflows outside a built workspace keep the old behaviour."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).parent))

from fieldkit_core import db, tools, workspace as ws  # noqa: E402
from workspace_fixtures import bundle  # noqa: E402


def _sync(s, rid):
    return s.sync_record("alice", "k-" + rid, "dev", {"id": rid, "workflow_id": "milk-collection-check", "workflow_version": 1,
                                                     "base_revision": 0, "answers": {"farmer_code": "F-1", "snf_pct": 8.0}},
                         auto_analyze=True)


def test_after_sync_mode_controls_automatic_reports(tmp_path):
    s = db.Store(path=str(tmp_path / "t.db"))
    b = bundle()
    b["report_policy"]["after_sync"] = "save"
    d = ws.build_draft(s, db.ALL, b)
    assert d["ok"], d["validation"]["errors"]
    ws.publish(s, b["id"], d["version"])
    assert s.after_sync_mode("milk-collection-check") == "save"
    assert _sync(s, "rec_save_0001")["analysis_status"] == "not_requested"
    assert s.job_counts().get("pending", 0) == 0
    # The user can still ask for one record.
    assert s.request_analysis("alice", "rec_save_0001")["analysis_status"] == "pending"
    # Switch the workspace to analyze: new records get a report job automatically.
    b2 = bundle()
    b2["report_policy"]["after_sync"] = "analyze"
    d2 = ws.build_draft(s, db.ALL, b2)
    ws.publish(s, b2["id"], d2["version"])
    assert _sync(s, "rec_ana_0001")["analysis_status"] == "pending"
    assert s.after_sync_mode("some-other-workflow") == "save"               # default since 0.2.6: sync only


def test_bad_mode_is_rejected_and_summaries_can_read_answers(tmp_path, monkeypatch):
    b = bundle()
    b["report_policy"]["after_sync"] = "sometimes"
    assert any("after_sync" in e for e in ws.validate_bundle(b)["errors"])
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    try:
        b = bundle()
        b["report_policy"]["after_sync"] = "summarize"
        d = ws.build_draft(s, db.ALL, b)
        ws.publish(s, b["id"], d["version"])
        _sync(s, "rec_sum_0001")
        out = json.loads(tools.list_records({"workflow_id": "milk-collection-check", "include_answers": True}))
        assert out["records"][0]["answers"]["snf_pct"] == 8.0 and out["records"][0]["analysis_status"] == "not_requested"
    finally:
        db.set_store(None)
