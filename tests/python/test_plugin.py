"""Plugin registration + tool handlers through the same entry point Hermes calls."""
import importlib.util
import json
import sys
import uuid
from pathlib import Path

import pytest
import yaml



@pytest.fixture(autouse=True)
def _review_every_record(monkeypatch):
    """These tests exercise the report job queue, which since 0.2.6 no sync triggers (test-only hook)."""
    from fieldkit_core import db as _db
    monkeypatch.setattr(_db, "_AUTO_REVIEW_FOR_TESTS", True)

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
    fn = ctx.tools.get(name) or tools.handler_for(name)     # retired tools: still tested, no longer registered
    return json.loads(fn(args))


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
    assert r["ok"] is False and "what is recorded" in " ".join(r["missing"]) and "country" not in " ".join(r["missing"])
    brief = {**BUNDLE["profile"], "languages": BUNDLE["languages"], "escalation": ["centre manager"]}
    r = call(ctx, "fieldkit_save_workspace_brief", brief=brief)
    assert r["ok"] and r["confirmed"] is False and "Maharashtra" in r["summary"] and r["missing"] == []
    bid = r["brief_id"]
    # Research/build cannot happen before the user confirms.
    assert "not confirmed" in call(ctx, "fieldkit_build_workspace", brief_id=bid, bundle=bundle())["error"]
    assert call(ctx, "fieldkit_save_workspace_brief", brief=brief, brief_id=bid, confirmed=True)["confirmed"] is True
    # Build: quotes are checked against pages (fake fetch); a quote missing from its page stops counting.
    filler = "<p>General background about milk testing at village collection centres.</p>" * 10
    pages = {"https://www.nddb.coop/information/milk-testing": filler + "<p>ILLUSTRATIVE TEST TEXT: re-test borderline samples once.</p>",
             "https://icar.org.in/dairy-quality": "<html>" + filler + "nothing relevant here</html>"}
    pages["https://www.fssai.gov.in/upload/uploadfiles/files/Dairy_Regulations.pdf"] = filler + (
        "ILLUSTRATIVE TEST TEXT: cow milk minimum SNF 8.5 percent. ILLUSTRATIVE TEST TEXT: buffalo milk fat minimum A. "
        "ILLUSTRATIVE TEST TEXT: rule for a different state.")
    monkeypatch.setattr(ws, "default_fetch", lambda url: ("text/html", pages.get(url, "")))
    out = call(ctx, "fieldkit_build_workspace", brief_id=bid, bundle=bundle())
    assert out["workspace_id"] == "dairy-collection-mh" and out["version"] == 1
    assert out["research_report"]["quote_check"]["not_found"] >= 1        # the ICAR quote is not on its page
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
    assert "quoted qualifying source" in out["next"]
    for url in ("http://127.0.0.1/x", "http://localhost:9300/api", "file:///etc/passwd", "http://169.254.169.254/latest"):
        with pytest.raises(ValueError):
            ws.default_fetch(url)


# ----------------------------------------------------------------------------- phase F: learning loop via tools
def _milk_record(store, rid, checks=None, answers=None):
    store.sync_record("alice", f"k-{rid}", "dev", {"id": rid, "workflow_id": "milk-collection-check", "workflow_version": 1,
                                                   "base_revision": 0, "answers": answers or {"farmer_code": "F-7", "milk_type": "cow",
                                                                                              "fat_pct": 3.5, "snf_pct": 8.3},
                                                   "local_results": {"followup_checks": checks or []}}, auto_analyze=False)


def test_learning_loop_through_tools(ctx):
    from fieldkit_core import learning, workspace as ws
    BUNDLE, _ = _ws_fixture()
    store = db.get_store()
    d = ws.build_draft(store, db.ALL, BUNDLE)
    ws.publish(store, BUNDLE["id"], d["version"])
    # An AI suggestion alone (a report action) creates nothing.
    _milk_record(store, "rec_learn_00000")
    store.save_report_direct("rec_learn_00000", {"summary": "x", "next_actions": [{"action": "Re-test the sample", "verify_by": "2nd reading",
                                                                                   "origin": "ai_suggestion"}]}, False, generated_by="test")
    assert call(ctx, "fieldkit_propose_workspace_changes", workspace_id="dairy-collection-mh")["new"] == []
    # Two verified outcomes: still not enough. A "can't check" never counts.
    chk = lambda i, result: [{"id": f"fc_{i}", "what": "Re-test the sample", "how": "2nd reading recorded", "result": result,
                              "value": "8.4", "report_id": "rep_1", "record_id": "rec_learn_00000"}]
    for i, res in enumerate(["done", "done", "cannot_check"]):
        _milk_record(store, f"rec_learn_0000{i + 1}", chk(i, res))
        learning.record_outcomes(store, "alice", f"rec_learn_0000{i + 1}")
    assert learning.record_outcomes(store, "alice", "rec_learn_00001") == 0          # idempotent
    assert [c["kind"] for c in call(ctx, "fieldkit_propose_workspace_changes", workspace_id="dairy-collection-mh")["new"]] == []
    # A third verified success → a local-practice candidate labelled with its evidence.
    _milk_record(store, "rec_learn_00004", chk(4, "done"))
    learning.record_outcomes(store, "alice", "rec_learn_00004")
    # Feedback and gaps from the phone (as the API stores them).
    learning.save_events(store, "alice", "dev", [
        {"kind": "knowledge_gap", "idempotency_key": "g1", "workspace_id": "dairy-collection-mh", "payload": {"question": "How do I clean the milk analyser?", "lang": "en"}},
        {"kind": "knowledge_gap", "idempotency_key": "g2", "workspace_id": "dairy-collection-mh", "payload": {"question": "how to clean the analyser", "lang": "en"}},
        {"kind": "user_feedback", "idempotency_key": "f1", "workspace_id": "dairy-collection-mh", "payload": {"question": "What is SNF?", "answer": "...", "helpful": False}},
        {"kind": "user_feedback", "idempotency_key": "f2", "workspace_id": "dairy-collection-mh", "payload": {"question": "Accept or reject?", "answer": "...", "helpful": True}}])
    r = call(ctx, "fieldkit_propose_workspace_changes", workspace_id="dairy-collection-mh")
    kinds = sorted(c["kind"] for c in r["new"])
    assert kinds == ["local_practice", "research_gap", "review_content"]               # helpful feedback creates nothing
    by = {c["kind"]: c for c in r["new"]}
    assert by["local_practice"]["basis"]["n"] == 3 and by["local_practice"]["basis"]["done"] == 3
    assert "verified outcomes" in by["local_practice"]["payload"]["label"]
    assert by["research_gap"]["payload"]["asked"] == 2                                   # similar questions clustered
    assert call(ctx, "fieldkit_propose_workspace_changes", workspace_id="dairy-collection-mh")["new"] == []   # no duplicates
    # Decisions need the user's confirmation; a rejection is remembered.
    assert "ask the user" in call(ctx, "fieldkit_decide_candidate", candidate_id=by["review_content"]["id"], decision="reject")["error"]
    assert call(ctx, "fieldkit_decide_candidate", candidate_id=by["review_content"]["id"], decision="reject", user_confirmed=True)["status"] == "rejected"
    learning.save_events(store, "alice", "dev", [{"kind": "user_feedback", "idempotency_key": "f3", "workspace_id": "dairy-collection-mh",
                                                  "payload": {"question": "What is SNF?", "answer": "...", "helpful": False}}])
    assert call(ctx, "fieldkit_propose_workspace_changes", workspace_id="dairy-collection-mh")["new"] == []   # not re-proposed
    # Accepting the practice makes a valid new draft; the entry is labelled as learned, with status local_practice.
    acc = call(ctx, "fieldkit_decide_candidate", candidate_id=by["local_practice"]["id"], decision="accept", user_confirmed=True)
    assert acc["status"] == "accepted" and acc["draft"]["valid"] is True and acc["draft"]["version"] == 2
    got = call(ctx, "fieldkit_get_workspace", workspace_id="dairy-collection-mh", version=2)
    assert any(e["id"].startswith("ev_outcomes_") for e in got["research_report"]["evidence"]["local_practice"])
    assert "local practice" in " ".join(got["changelog"]).lower()
    pub = call(ctx, "fieldkit_publish_workspace", workspace_id="dairy-collection-mh", version=2, user_approved=True)
    assert pub["ok"] and pub["version"] == 2
    lst = call(ctx, "fieldkit_list_learning", workspace_id="dairy-collection-mh")
    assert lst["summary"]["verified_outcome"] == 4 and lst["summary"]["knowledge_gap"] == 2
    content, _ = ctx.prompt_sections["fieldkit.workspace"]
    assert "improvement candidate(s)" in content({})


def test_local_practice_needs_real_outcomes():
    from fieldkit_core import workspace as ws
    src = {"s": {"id": "s", "type": "user_document"}}
    weak = {"id": "e", "claim": "x", "local_practice": True, "outcomes": {"n": 2, "done": 2, "records": ["a", "b"]}}
    assert ws.evidence_status(weak, src)[0] == "unverified"
    fake = {"id": "e", "claim": "x", "local_practice": True, "outcomes": {"n": 5, "done": 5, "records": ["a"]}}   # claims more than it has
    assert ws.evidence_status(fake, src)[0] == "unverified"
    ok = {"id": "e", "claim": "x", "local_practice": True, "outcomes": {"n": 3, "done": 3, "records": ["a", "b", "c"]}}
    assert ws.evidence_status(ok, src)[0] == "local_practice"


# ----------------------------------------------------------------------------- 0.2.6: part-by-part builds
def test_workspace_built_part_by_part_survives_chats_and_rejects_bad_items(ctx, monkeypatch):
    """The hosted failure mode: one huge bundle with wrong shapes. Now each part is checked as it is added, saved
    server-side (a later chat resumes it), and the final build waits only a bounded time for source pages."""
    from fieldkit_core import workspace as ws, workspace_schema as S, workspace_tools as wst
    BUNDLE, bundle = _ws_fixture()
    b = bundle()
    filler = "<p>General background about milk testing at village collection centres.</p>" * 10
    monkeypatch.setattr(ws, "default_fetch", lambda url: ("text/html", filler + "<p>ILLUSTRATIVE TEST TEXT: re-test borderline samples once.</p>"
                                                          "<p>ILLUSTRATIVE TEST TEXT: cow milk minimum SNF 8.5 percent</p>"
                                                          "<p>ILLUSTRATIVE TEST TEXT: buffalo milk fat minimum A</p>"))
    brief = {**BUNDLE["profile"], "languages": BUNDLE["languages"], "escalation": ["centre manager"]}
    bid = call(ctx, "fieldkit_save_workspace_brief", brief=brief, confirmed=True)["brief_id"]
    unconfirmed = call(ctx, "fieldkit_save_workspace_brief", brief=brief)["brief_id"]
    assert "not confirmed" in call(ctx, "fieldkit_start_workspace_build", brief_id=unconfirmed, workspace_id="dairy-x")["error"]
    assert "slug" in call(ctx, "fieldkit_start_workspace_build", brief_id=bid, workspace_id="Dairy X")["error"]
    st = call(ctx, "fieldkit_start_workspace_build", brief_id=bid, workspace_id=b["id"], title=b["title"], languages=b["languages"])
    assert st["ok"] and st["started"] and "sources: researched sources" in st["missing"]
    fmt = call(ctx, "fieldkit_workspace_format", part="guides")["format"]
    assert fmt["schema"]["properties"]["nodes"] and fmt["example"]["nodes"]

    def add(part, items, **kw):
        return call(ctx, "fieldkit_add_workspace_parts", workspace_id=b["id"], part=part, items=items, **kw)
    # Evidence before its sources: rejected with the path and what to do.
    r = add("evidence", b["evidence"][:1])
    assert r["accepted"] == [] and "add it to sources first" in r["rejected"][0]["errors"][0]["error"]
    assert add("sources", b["sources"])["accepted"] == [s["id"] for s in b["sources"]]
    r = add("evidence", b["evidence"])
    assert len(r["accepted"]) == len(b["evidence"]) and r["quote_check"]["found"] >= 1 and r["evidence_status"]
    # A guide before the report policy: decision unknown. Then the hosted-style broken workflow: repaired + type errors.
    assert "add report_policy first" in str(add("guides", b["guides"])["rejected"])
    assert add("report_policy", [b["report_policy"]])["accepted"] == ["report_policy"]
    broken = {"id": "milk-collection-check", "title": "Milk", "fields": [
        {"name": "farmer_code", "type": "string", "label": "Farmer"},
        {"id": "milk_type", "type": "dropdown", "label": "Milk", "options": ["cow", "buffalo"]},
        {"id": "snf_pct", "type": "decimal", "label": "SNF"}],
        "classification": {"rules": [{"id": "snf_low", "label": "Low", "when": {"op": "<", "field": "snf_pct", "value": "8.5"},
                                      "evidence_ids": ["ev_snf_cow"]}]}}
    r = add("workflows", [broken], dry_run=True)
    assert r["dry_run"] and r["fixed_automatically"]["milk-collection-check"]
    assert "compare it with a number" in r["rejected"][0]["errors"][0]["error"] and r["rejected"][0]["errors"][0]["hint"]
    assert call(ctx, "fieldkit_workspace_build_status", workspace_id=b["id"])["parts"]["workflows"] == 0   # dry run saved nothing
    assert add("workflows", b["workflows"])["accepted"] == ["milk-collection-check"]
    # --- the chat ends here; a new chat finds the build and continues ---
    lst = call(ctx, "fieldkit_workspace_build_status")
    assert [x["workspace_id"] for x in lst["builds"]] == [b["id"]]
    again = call(ctx, "fieldkit_start_workspace_build", brief_id=bid, workspace_id=b["id"])
    assert again["resumed"] and again["parts"]["evidence"] == len(b["evidence"])
    for part in ("guides", "knowledge", "vocabulary", "gaps", "traceability"):
        items = b[part]["entries"] if part in ("knowledge", "vocabulary") else b[part]
        r = add(part, items)
        assert r["rejected"] == [], (part, r["rejected"])
    r = add("intents", [{"id": "check_requirement", "examples": ["Minimum SNF for cow milk?"]}])
    assert r["accepted"] == ["check_requirement"] and r["fixed_automatically"]
    assert add("knowledge", [], remove=["k_retest"])["removed"] == ["k_retest"]
    out = call(ctx, "fieldkit_build_workspace", workspace_id=b["id"])
    assert out["valid"] is False and any("k_retest" in str(e) for e in out["errors"])      # traceability now dangles
    forged = dict(b["evidence"][0], id="ev_fake", local_practice=True, outcomes={"n": 9, "done": 9, "records": ["a"] * 9})
    assert "only by FieldKit" in str(add("evidence", [forged])["rejected"])
    add("knowledge", b["knowledge"]["entries"])
    out = call(ctx, "fieldkit_build_workspace", workspace_id=b["id"])
    assert out.get("valid") is True and out["checks_pending"] == 0, out
    assert out["research_report"]["summary"]["workflows"] == 1
    pub = call(ctx, "fieldkit_publish_workspace", workspace_id=b["id"], user_approved=True)
    assert pub["ok"] and pub["version"] == out["version"]
    assert call(ctx, "fieldkit_workspace_build_status")["builds"] == []            # finished builds are closed
    # Updating later starts from the published version.
    upd = call(ctx, "fieldkit_start_workspace_build", brief_id=bid, workspace_id=b["id"])
    assert upd["from_version"] == out["version"] and upd["parts"]["guides"] == 1
    assert wst.BUILD_WAIT_S <= 25 and S.PARTS[0] == "sources"



def test_fast_setup_from_the_interview_in_one_call(ctx):
    """0.2.6 fast setup: the user's stated rules, the form, decisions and guide in ONE add call, then build: no web."""
    import copy
    from fieldkit_core import workspace_schema as S
    brief = {"role": "Milk collection checker", "country": "IN", "region": "Maharashtra", "industry": "dairy",
             "responsibilities": [{"id": "r_accept", "description": "Accept or reject milk", "decisions": ["accept", "reject"]}],
             "languages": {"content": ["en", "hi"]}, "tools_and_instruments": [], "procedures_in_use": [], "escalation": ["in-charge"]}
    bid = call(ctx, "fieldkit_save_workspace_brief", brief=brief, confirmed=True)["brief_id"]
    call(ctx, "fieldkit_start_workspace_build", brief_id=bid, workspace_id="dairy-fast", title={"en": "Dairy", "hi": "डेयरी"},
         languages={"content": ["en", "hi"]})
    wf = copy.deepcopy(S.EXAMPLES["workflows"])
    wf["classification"] = {"rules": [dict(S.EXAMPLES["workflows"]["classification"]["rules"][0], evidence_ids=["ev_user_snf"])]}
    guide = copy.deepcopy(S.EXAMPLES["guides"])
    for n in guide["nodes"].values():
        for act in (n.get("outcome") or {}).get("actions") or []:
            if act.get("evidence_ids"):
                act["evidence_ids"] = ["ev_user_snf"]
    r = call(ctx, "fieldkit_add_workspace_parts", workspace_id="dairy-fast", parts={
        "sources": [{"id": "s_user", "type": "user_statement", "title": "Stated by the user in the setup interview"}],
        "evidence": [{"id": "ev_user_snf", "claim": "Reject cow milk below 8.5% SNF", "applicability": {"matches_profile": True},
                      "excerpts": [{"source_id": "s_user", "quote": "we reject cow milk below 8.5 SNF"}]}],
        "report_policy": [S.EXAMPLES["report_policy"]], "workflows": [wf], "guides": [guide],
        "traceability": [{"responsibility_id": "r_accept", "workflow_ids": ["milk-collection-check"], "guide_ids": ["g_accept"]}],
        "nonsense": []})
    assert r["ok"] and r["unknown_parts"] == ["nonsense"], r
    assert all(not v.get("rejected") for v in r["results"].values()), r["results"]
    assert r["results"]["evidence"]["evidence_status"] == {"ev_user_snf": "user_procedure"}
    out = call(ctx, "fieldkit_build_workspace", workspace_id="dairy-fast")
    assert out.get("valid") is True and out["checks_pending"] == 0, out
    assert out["research_report"]["summary"]["user_procedure"] == 1 and out["research_report"]["summary"]["verified"] == 0


def test_questions_reach_hermes_chat_tools(ctx):
    """Users' questions about a visit are visible to Hermes in chat ("fieldkit_list_questions") and answered by the
    worker or by "fieldkit_process_pending_jobs"; direct record access stays available (fieldkit_get_record)."""
    from fieldkit_core import examples
    store = db.get_store()
    examples.install(store, db.ALL)
    store.sync_record("alice", "k-qv", "dev", {"id": "rec_qv_000001", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                               "base_revision": 0, "answers": {"asset_id": "PMP-7"}}, auto_analyze=True)
    store.save_question("alice", "rec_qv_000001", {"id": "q_tool_1", "question": "Is anything missing?"})
    r = call(ctx, "fieldkit_list_questions", record_id="rec_qv_000001")
    assert r["ok"] and r["questions"][0]["status"] == "queued" and r["questions"][0]["question"] == "Is anything missing?"
    assert call(ctx, "fieldkit_list_questions", status="answered")["questions"] == []


def test_ask_about_record_tool_through_registration(ctx, monkeypatch):
    """Hermes chat: "what do you think about this visit?" goes through "fieldkit_ask_about_record" (evidence retrieved
    by the tool itself; full behaviour in test_questions.py). Without Hermes' model the tool says so clearly."""
    from fieldkit_core import examples
    store = db.get_store()
    examples.install(store, db.ALL)
    store.sync_record("alice", "k-ask", "dev", {"id": "rec_ask_000001", "workflow_id": "equipment-inspection", "workflow_version": 1,
                                                "base_revision": 0, "answers": {"asset_id": "PMP-8"}}, auto_analyze=False)
    monkeypatch.setattr(runtime, "llm", None)
    r = call(ctx, "fieldkit_ask_about_record", record_id="rec_ask_000001", question="What do you think about this visit?")
    assert r["ok"] is False and "not available" in r["error"]
    monkeypatch.setattr(runtime, "llm", make_llm(Recorder({"default": {"answer": "Looks routine.", "confidence": "low",
        "uncertainty": "No photos.", "evidence_used": ["asset_id"], "next_steps": []}})))
    r = call(ctx, "fieldkit_ask_about_record", record_id="rec_ask_000001", question="What do you think about this visit?")
    assert r["ok"] and r["answer"] == "Looks routine." and r["record_id"] == "rec_ask_000001"


def test_edit_workspace_by_chat_with_change_summary_and_undo(ctx):
    """Editing without a new interview: start a build on the existing workspace, change one form, build (shows what
    changed), publish with approval, then "fieldkit_undo_workspace_update" restores the previous version as a NEW
    version. Records keep their original form version and answers, including a removed field's answer."""
    import copy
    from fieldkit_core import workspace as ws
    BUNDLE, bundle = _ws_fixture()
    store = db.get_store()
    b = bundle()
    d = ws.build_draft(store, db.ALL, b)
    ws.publish(store, b["id"], d["version"])
    store.sync_record("alice", "k-old", "dev", {"id": "rec_edit_00001", "workflow_id": "milk-collection-check", "workflow_version": 1,
                                                "base_revision": 0, "answers": {"farmer_code": "F-1", "smell_ok": True}}, auto_analyze=False)
    st = call(ctx, "fieldkit_start_workspace_build", workspace_id=b["id"])            # no brief_id: an edit
    assert st["ok"] and st["from_version"] == 1
    wf = copy.deepcopy(BUNDLE["workflows"][0])
    wf["fields"] = [f for f in wf["fields"] if f["id"] != "smell_ok"] + [
        {"id": "door_seal_ok", "type": "checkbox", "label": {"en": "Can lid sealed", "hi": "ढक्कन बंद"}}]
    assert call(ctx, "fieldkit_add_workspace_parts", workspace_id=b["id"], part="workflows", items=[wf])["accepted"]
    out = call(ctx, "fieldkit_build_workspace", workspace_id=b["id"], check_excerpts=False)
    assert out["valid"], out["errors"]
    joined = " | ".join(out["changes_since_published"])
    assert 'added question "Can lid sealed"' in joined and 'removed question "Smell and colour normal"' in joined
    assert "approve" in out["next"]
    pub = call(ctx, "fieldkit_publish_workspace", workspace_id=b["id"], user_approved=True)
    assert pub["version"] == 2 and any("Can lid sealed" in c for c in pub["changes"])
    # the old record still has its version and the removed field's answer
    old = store.get_record("alice", "rec_edit_00001")
    assert old["workflow_version"] == 1 and old["answers"]["smell_ok"] is True
    assert store.get_workflow_any_owner("milk-collection-check", 1)["fields"][-1]["id"] == "smell_ok"
    # undo: first a preview, then confirmed → version 3 equals version 1's content
    prev = call(ctx, "fieldkit_undo_workspace_update", workspace_id=b["id"])
    assert prev["would_restore_version"] == 1 and any("Can lid sealed" in c for c in prev["changes"])
    done = call(ctx, "fieldkit_undo_workspace_update", workspace_id=b["id"], user_confirmed=True)
    assert done["version"] == 3 and done["restored_from_version"] == 1 and done["undid_version"] == 2
    fields = [f["id"] for f in store.get_workspace_version(b["id"], 3)["bundle"]["workflows"][0]["fields"]]
    assert "smell_ok" in fields and "door_seal_ok" not in fields
