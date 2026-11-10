"""0.2.6: saving or syncing a record never triggers AI work, whatever an older workspace's after_sync says; Hermes
works only on request (a question about a visit, or the Hermes chat). Summaries across records read the answers."""
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


def test_sync_never_triggers_ai_even_for_old_analyze_workspaces(tmp_path):
    s = db.Store(path=str(tmp_path / "t.db"))
    b = bundle()
    b["report_policy"]["after_sync"] = "analyze"          # an older workspace that asked for automatic review
    d = ws.build_draft(s, db.ALL, b)
    assert d["ok"], d["validation"]["errors"]            # still loads (migrated safely)
    ws.publish(s, b["id"], d["version"])
    assert _sync(s, "rec_old_0001")["analysis_status"] == "not_requested"
    assert s.job_counts().get("pending", 0) == 0 and s.list_questions(db.ALL) == []
    # Repeated sync of the same visit: still nothing queued.
    _sync(s, "rec_old_0001")
    assert s.job_counts().get("pending", 0) == 0


def test_summaries_read_answers_by_workflow_or_whole_workspace(tmp_path):
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    try:
        b = bundle()
        d = ws.build_draft(s, db.ALL, b)
        ws.publish(s, b["id"], d["version"])
        _sync(s, "rec_sum_0001")
        out = json.loads(tools.list_records({"workspace_id": b["id"], "include_answers": True}))
        assert out["records"][0]["answers"]["snf_pct"] == 8.0
        assert json.loads(tools.list_records({"workspace_id": "nope"}))["ok"] is False
    finally:
        db.set_store(None)
