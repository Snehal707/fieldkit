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

    def register_system_prompt_section(self, id, content, position="after_memory", max_chars=4000):
        self.prompt_sections = getattr(self, "prompt_sections", {})
        self.prompt_sections[id] = (content, max_chars)


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
    assert r["app_link"]["url"] == "https://hermes.example.org/dashboard-plugins/fieldkit/app_dist/index.html#/workflow/pump-check"
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


# ----------------------------------------------------------------------------- phase C: workspace builder via tools
def _ws_fixture():
    sys.path.insert(0, str(Path(__file__).parent))
    from workspace_fixtures import BUNDLE, bundle
    return BUNDLE, bundle


def test_builder_skill_and_onboarding_prompt_are_registered(ctx):
    assert "fieldkit-workspace-builder" in ctx.skills
    text = ctx.skills["fieldkit-workspace-builder"].read_text(encoding="utf-8")
    assert "web_extract" in text and "Never present model knowledge as verified guidance" in text
    content, max_chars = ctx.prompt_sections["fieldkit.workspace"]
    assert max_chars <= 1500
    first = content({})
    assert "no workspace has been built" in first and "fieldkit-workspace-builder" in first


def test_workspace_builder_flow_through_tools(ctx, monkeypatch):
    from fieldkit_core import workspace as ws
    BUNDLE, bundle = _ws_fixture()
    fmt = call(ctx, "fieldkit_workspace_format")
    assert fmt["ok"] and "verified" in fmt["format"]["evidence_rules"]
    # Interview: incomplete brief cannot be confirmed.
    r = call(ctx, "fieldkit_save_workspace_brief", brief={"role": "Milk collection checker"}, confirmed=True)
    assert r["ok"] is False and "country" in " ".join(r["missing"])
    brief = {**BUNDLE["profile"], "languages": BUNDLE["languages"], "escalation": ["centre manager"]}
    r = call(ctx, "fieldkit_save_workspace_brief", brief=brief)
    assert r["ok"] and r["confirmed"] is False and "Maharashtra" in r["summary"] and r["missing"] == []
    bid = r["brief_id"]
    # Research/build cannot happen before the user confirms.
    assert "not confirmed" in call(ctx, "fieldkit_build_workspace", brief_id=bid, bundle=bundle())["error"]
    assert call(ctx, "fieldkit_save_workspace_brief", brief=brief, brief_id=bid, confirmed=True)["confirmed"] is True
    # Build: quotes are checked against pages (fake fetch); a quote missing from its page stops counting.
    pages = {"https://www.nddb.coop/information/milk-testing": "<p>ILLUSTRATIVE TEST TEXT: re-test borderline samples once.</p>",
             "https://icar.org.in/dairy-quality": "<html>nothing relevant here</html>"}
    monkeypatch.setattr(ws, "default_fetch", lambda url: ("text/html", pages.get(url, "")))
    out = call(ctx, "fieldkit_build_workspace", brief_id=bid, bundle=bundle())
    assert out["workspace_id"] == "dairy-collection-mh" and out["version"] == 1
    assert out["research_report"]["excerpt_check"]["not_found"] >= 1        # the ICAR quote is not on its page
    # ev_two_t2 now has only one found tier-2 quote (NDDB) → supported, not verified.
    got = call(ctx, "fieldkit_get_workspace", workspace_id="dairy-collection-mh", include_bundle=True)
    assert got["ok"] and got["status"] == "draft"
    st = {e["id"] for e in got["research_report"]["evidence"]["supported"]}
    assert "ev_two_t2" in st
    assert out["valid"] is True, out["errors"]
    assert [s["id"] for s in out["research_report"]["excluded_sources"]] == ["s_forum"]
    assert out["research_report"]["gaps"][0]["topic"] == "Ammonium sulphate limit"
    # Publish needs the user's approval.
    assert "user_approved" in call(ctx, "fieldkit_publish_workspace", workspace_id="dairy-collection-mh", user_approved=False)["error"]
    pub = call(ctx, "fieldkit_publish_workspace", workspace_id="dairy-collection-mh", user_approved=True)
    assert pub["ok"] and pub["app_link"]["url"].endswith("#/workspace/dairy-collection-mh")
    lst = call(ctx, "fieldkit_list_workspaces")
    assert [w["id"] for w in lst["workspaces"]] == ["dairy-collection-mh"]
    assert len(call(ctx, "fieldkit_list_workspaces", include_drafts=True)["workspaces"]) == 1
    # The next session's prompt now summarises the workspace instead of onboarding.
    content, _ = ctx.prompt_sections["fieldkit.workspace"]
    assert "Dairy collection QA" in content({}) and "no workspace" not in content({})


def test_invalid_build_reports_errors_and_unsafe_urls_are_never_fetched(ctx):
    from fieldkit_core import workspace as ws
    BUNDLE, bundle = _ws_fixture()
    brief = {**BUNDLE["profile"], "languages": BUNDLE["languages"], "escalation": ["manager"]}
    bid = call(ctx, "fieldkit_save_workspace_brief", brief=brief, confirmed=True)["brief_id"]
    b = bundle()
    b["guides"][0]["nodes"]["o_accept"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_model_only"]
    out = call(ctx, "fieldkit_build_workspace", brief_id=bid, bundle=b, check_excerpts=False)
    assert out["valid"] is False and any("no supporting evidence" in e for e in out["errors"])
    assert "find and quote a qualifying source" in out["next"]
    for url in ("http://127.0.0.1/x", "http://localhost:9300/api", "file:///etc/passwd", "http://169.254.169.254/latest"):
        with pytest.raises(ValueError):
            ws.default_fetch(url)
