"""The Hermes Mobile journey as the agent performs it: every tool call in the demo script, in order, through the
real register(ctx) and Hermes' real PluginLlm (provider round-trip stubbed). Also checks that every tool result
is compact JSON a mobile conversation can carry."""
import json
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from hermes_stub import GOOD_REPORT, Recorder, make_llm  # noqa: E402
from test_plugin import FakeCtx, _load_plugin  # noqa: E402

from fieldkit_core import db, runtime  # noqa: E402

MAX_TOOL_RESULT = 60_000  # characters; keeps tool results well inside a mobile turn


@pytest.fixture()
def hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_AUTO_ANALYZE", "true")
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    db.set_store(db.Store(path=str(tmp_path / "j.db")))
    rec = Recorder({"default": GOOD_REPORT})
    llm = make_llm(rec)
    if llm is None:
        pytest.skip("Hermes source not available for PluginLlm")
    ctx = FakeCtx(llm=llm)
    _load_plugin().register(ctx)
    runtime.stop_worker()
    ctx.recorder = rec
    yield ctx
    runtime.stop_worker()
    db.set_store(None)
    runtime.llm = None


def say(ctx, tool, **args):
    raw = ctx.tools[tool](args)
    assert isinstance(raw, str) and len(raw) < MAX_TOOL_RESULT, f"{tool} result too large ({len(raw)} chars)"
    out = json.loads(raw)
    assert out["ok"], f"{tool} failed: {out}"
    return out


def phone_sync(asset: str, condition: str, guard: bool, photo: bool = False) -> str:
    store = db.get_store()
    rid = f"rec_{uuid.uuid4().hex[:16]}"
    store.sync_record("phone-user", f"k-{rid}", "iphone", {
        "id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1, "base_revision": 0,
        "answers": {"asset_id": asset, "inspection_date": "2026-11-09", "condition": condition, "guard_ok": guard,
                    "notes": "vibration near the coupling"},
        "local_results": {"findings": [] if guard else [{"id": "guard_missing", "label": "Safety guard problem",
                                                           "severity": "critical", "source": "local"}]}},
        auto_analyze=True)
    return rid


def test_demo_conversation(hermes, monkeypatch):
    monkeypatch.setenv("FIELDKIT_PUBLIC_URL", "https://hermes.example.org")
    # "Install the FieldKit examples."
    assert len(say(hermes, "fieldkit_install_examples")["installed"]["workflows"]) == 3
    # "Create an equipment inspection workflow with troubleshooting instructions and photographs … publish it."
    gen = json.loads((ROOT / "examples/maintenance/workflow.json").read_text(encoding="utf-8"))
    hermes.recorder.replies = {"fieldkit.workflow": gen, "default": GOOD_REPORT}
    created = say(hermes, "fieldkit_create_workflow", request="equipment inspection with troubleshooting and photos",
                  languages=["en", "hi"], workflow_id="pump-inspection")
    assert created["workflow"]["fields"] > 5 and created["published"] is False
    published = say(hermes, "fieldkit_publish_workflow", workflow_id="pump-inspection")
    assert published["app_link"]["url"] == "https://hermes.example.org/api/plugins/fieldkit/app/#/workflow/pump-inspection"
    assert say(hermes, "fieldkit_get_app_link", workflow_id="pump-inspection")["absolute"] is True
    # "Make a knowledge pack from this guide."
    pack = say(hermes, "fieldkit_create_knowledge_pack", pack_id="pump-guide", title="Pump guide", use_llm=False,
               document="# Seals\nWorn seals leak oil.\n\n# Bearings\nHot bearings need grease.")
    assert pack["entries"] == 2

    # Two inspections arrive from the phone.
    r1 = phone_sync("PMP-0050", "poor", False)
    r2 = phone_sync("PMP-0051", "good", True)

    # "Process pending FieldKit jobs." (deferred mode) → real reports
    done = say(hermes, "fieldkit_process_pending_jobs", retry_failed=True)
    assert {d["status"] for d in done["processed"]} <= {"completed", "requires_review"} and len(done["processed"]) == 2
    # "Analyse my latest FieldKit inspection."
    latest = say(hermes, "fieldkit_list_records", limit=5)["records"]
    assert {r["id"] for r in latest} == {r1, r2}
    rec = say(hermes, "fieldkit_get_record", record_id=r1)["record"]
    assert any(a["field_id"] == "condition" and a["answer"] == "Poor" for a in rec["answers_readable"])
    report = say(hermes, "fieldkit_get_report", record_id=r1)["report"]
    assert report["source"] == "hermes" and report["summary"]
    # "Compare my last two inspections." → Hermes compares, then keeps it
    say(hermes, "fieldkit_get_report", record_id=r2)
    saved = say(hermes, "fieldkit_save_report", record_id=r1, report={**GOOD_REPORT, "summary": "PMP-0050 worse than PMP-0051."})
    assert saved["report"]["version"] == 2
    assert len(say(hermes, "fieldkit_list_reports", record_id=r1)["reports"]) == 2
    # "What should I do next?" → follow-up
    say(hermes, "fieldkit_create_followup", title="Refit guard on PMP-0050", record_id=r1, due_date="2026-11-12")
    fus = say(hermes, "fieldkit_list_followups", status="open")["followups"]
    assert any(f["title"] == "Refit guard on PMP-0050" for f in fus)
    # "How is sync going?"
    st = say(hermes, "fieldkit_get_sync_status")
    assert st["status"]["records_by_sync_status"] == {"complete": 2}
    # Search knowledge for grounding
    assert say(hermes, "fieldkit_search_knowledge", query="hot bearings")["results"][0]["title"] == "Bearings"


def test_every_registered_tool_is_exercised_by_tests():
    """Guard: a tool added later must be covered by the journey or test_plugin."""
    sys.path.insert(0, str(ROOT))
    from fieldkit_core.tools import TOOL_NAMES
    here = Path(__file__).read_text(encoding="utf-8") + (Path(__file__).parent / "test_plugin.py").read_text(encoding="utf-8")
    missing = [t for t in TOOL_NAMES if f'"{t}"' not in here]
    assert missing == [], f"tools without a test: {missing}"


def test_remaining_tools(hermes):
    say(hermes, "fieldkit_install_examples")
    v = say(hermes, "fieldkit_validate_workflow", workflow_id="equipment-inspection")
    assert v["valid"] is True and v["problems"] == []
    bad = say(hermes, "fieldkit_validate_workflow", definition={"id": "x", "title": "X", "fields": []})
    assert bad["valid"] is False and bad["problems"]
    wf = say(hermes, "fieldkit_get_workflow", workflow_id="equipment-inspection")["workflow"]
    assert wf["id"] == "equipment-inspection" and wf["version"] == 1
    # "Analyse PMP-0060 now" — on-demand analysis creates the report and completes the queued job
    rid = phone_sync("PMP-0060", "fair", True)
    rep = say(hermes, "fieldkit_analyze_record", record_id=rid)["report"]
    assert rep["source"] == "hermes" and rep["version"] == 1
    assert db.get_store().list_jobs()[0]["status"] == "completed"
    # A phone edits an old revision while Hermes changed it → conflict; Hermes resolves on the user's choice
    store = db.get_store()
    base = {"id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1,
            "answers": {"asset_id": "PMP-0060", "inspection_date": "2026-11-09", "condition": "poor", "guard_ok": True}}
    store.sync_record("phone-user", "edit-1", "iphone", {**base, "base_revision": 1}, auto_analyze=False)
    with pytest.raises(db.Conflict) as exc:
        store.sync_record("phone-user", "edit-2", "ipad", {**base, "base_revision": 1,
                                                           "answers": {**base["answers"], "condition": "good"}}, auto_analyze=False)
    cid = exc.value.payload["conflict_id"]
    st = say(hermes, "fieldkit_get_sync_status")
    assert any(c["id"] == cid for c in st["conflicts"])
    res = say(hermes, "fieldkit_resolve_conflict", conflict_id=cid, resolution="keep_server")["result"]
    assert res["resolution"] == "keep_server" and res["revision"] == 2
    assert say(hermes, "fieldkit_get_sync_status")["conflicts"] == []
