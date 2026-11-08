"""Plugin registration + tool handlers through the same entry point Hermes calls."""
import importlib.util
import json
import sys
import uuid
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from hermes_stub import GOOD_REPORT, Recorder, make_llm  # noqa: E402

from fieldkit_core import db, runtime, tools  # noqa: E402


class FakeCtx:
    def __init__(self, llm=None, config=None):
        self.tools, self.skills = {}, {}
        self.llm = llm
        self._config = config or {}

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False,
                      description="", emoji="", override=False):
        assert name not in self.tools
        assert schema["name"] == name and schema["parameters"]["type"] == "object"
        self.tools[name] = handler

    def register_skill(self, name, path, description="", frontmatter=None):
        assert Path(path).exists()
        self.skills[name] = Path(path)

    def get_config(self, key, default=None):
        return self._config.get(key, default)


def _load_plugin():
    spec = importlib.util.spec_from_file_location("hermes_plugins.fieldkit", ROOT / "__init__.py",
                                                  submodule_search_locations=[str(ROOT)])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_AUTO_ANALYZE", "false")  # no background thread in these tests
    db.set_store(db.Store(path=str(tmp_path / "t.db")))
    rec = Recorder({"default": GOOD_REPORT})
    llm = make_llm(rec)
    c = FakeCtx(llm=llm, config={"public_url": "https://hermes.example.org/"})
    _load_plugin().register(c)
    c.recorder = rec
    yield c
    db.set_store(None)
    runtime.llm = None


def call(ctx, name, **args):
    return json.loads(ctx.tools[name](args))


def test_manifest_matches_registration(ctx):
    manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest["name"] == "fieldkit"
    assert sorted(manifest["provides_tools"]) == sorted(ctx.tools) == sorted(tools.TOOL_NAMES)
    assert "fieldkit" in ctx.skills
    assert ctx.skills["fieldkit"].read_text(encoding="utf-8").startswith("---\nname: fieldkit")


def test_workflow_lifecycle_via_tools(ctx):
    wf = json.loads((ROOT / "examples/maintenance/workflow.json").read_text(encoding="utf-8"))
    r = call(ctx, "fieldkit_create_workflow", definition=wf, workflow_id="pump-check")
    assert r["ok"] and r["published"] is False and r["workflow"]["branching_fields"] >= 3
    r = call(ctx, "fieldkit_publish_workflow", workflow_id="pump-check")
    assert r["app_link"]["url"] == "https://hermes.example.org/api/plugins/fieldkit/app/#/workflow/pump-check"
    assert [w["id"] for w in call(ctx, "fieldkit_list_workflows")["workflows"]] == ["pump-check"]
    bad = call(ctx, "fieldkit_create_workflow", definition={"id": "x", "title": "X", "fields": [{"id": "a", "type": "eval", "label": "A"}]})
    assert bad["ok"] is False and bad["problems"]


def test_create_workflow_from_language_uses_ctx_llm(ctx):
    if ctx.llm is None:
        pytest.skip("Hermes source not available")
    generated = json.loads((ROOT / "examples/education/workflow.json").read_text(encoding="utf-8"))
    ctx.recorder.replies = {"fieldkit.workflow": generated, "default": GOOD_REPORT}
    r = call(ctx, "fieldkit_create_workflow", request="classroom observation with photos", languages=["en", "hi"], publish=True)
    assert r["ok"], r
    assert r["source"] == "generated" and r["published"] is True
    assert "JSON schema" in json.dumps(ctx.recorder.calls[-1]["messages"])  # schema-constrained request


def test_records_reports_followups_via_tools(ctx):
    call(ctx, "fieldkit_install_examples")
    store = db.get_store()
    rid = f"rec_{uuid.uuid4().hex[:12]}"
    store.sync_record("alice", "k1", "dev", {"id": rid, "workflow_id": "equipment-inspection", "workflow_version": 1,
                                              "base_revision": 0, "answers": {"condition": "poor", "guard_ok": False}},
                      auto_analyze=False)
    recs = call(ctx, "fieldkit_list_records")["records"]
    assert recs[0]["id"] == rid and recs[0]["analysis_status"] == "not_requested"
    got = call(ctx, "fieldkit_get_record", record_id=rid)["record"]
    assert {"field_id": "condition", "question": "Overall condition", "answer": "Poor", "unit": None} in got["answers_readable"]
    if ctx.llm is not None:
        rep = call(ctx, "fieldkit_generate_report", record_id=rid)
        assert rep["ok"] and rep["report"]["source"] == "hermes"
        again = call(ctx, "fieldkit_generate_report", record_id=rid)
        assert again["cached"] is True and again["report"]["version"] == 1
    own = call(ctx, "fieldkit_save_report", record_id=rid, report={k: GOOD_REPORT[k] for k in GOOD_REPORT})
    assert own["ok"] and own["report"]["generated_by"] == "hermes-agent"
    assert call(ctx, "fieldkit_save_report", record_id=rid, report={"summary": "x"})["ok"] is False  # schema enforced
    fu = call(ctx, "fieldkit_create_followup", title="Order bearing", record_id=rid, due_date="2026-11-20")
    assert fu["ok"]
    assert any(f["title"] == "Order bearing" for f in call(ctx, "fieldkit_list_followups")["followups"])
    st = call(ctx, "fieldkit_get_sync_status")
    assert st["status"]["records_by_sync_status"] == {"complete": 1}
    assert call(ctx, "fieldkit_get_record", record_id="nope")["ok"] is False


def test_knowledge_pack_tools(ctx):
    r = call(ctx, "fieldkit_create_knowledge_pack", pack_id="pod", title="Proof of delivery", use_llm=False,
             document="# Proof of delivery\nA signed confirmation that goods arrived.\n\n# Damaged goods\nPhotograph damage before signing.")
    assert r["ok"] and r["method"] == "chunked" and r["entries"] == 2
    res = call(ctx, "fieldkit_search_knowledge", query="what is proof of delivery")["results"]
    assert res[0]["title"] == "Proof of delivery"
    d = call(ctx, "fieldkit_create_dictionary_pack", pack_id="pod-terms", title="POD terms", languages=["en", "hi"],
             entries=[{"term": "consignee", "lang": "en", "definition": "The receiver of goods.", "translations": {"hi": "प्रेषिती"}}])
    assert d["ok"] and d["entries"] == 1
    kinds = {p["kind"] for p in call(ctx, "fieldkit_list_knowledge_packs")["packs"]}
    assert kinds == {"knowledge", "dictionary"}


def test_process_pending_without_llm_reports_clearly(ctx, monkeypatch):
    call(ctx, "fieldkit_install_examples")
    db.get_store().sync_record("alice", "k1", "dev", {"id": "rec_nollm_0001", "workflow_id": "equipment-inspection",
                                                       "workflow_version": 1, "base_revision": 0, "answers": {}}, auto_analyze=True)
    monkeypatch.setattr(runtime, "llm", None)
    r = call(ctx, "fieldkit_process_pending_jobs")
    assert r["ok"] and r["processed"][0]["status"] == "pending" and "not available" in r["processed"][0]["error"]
