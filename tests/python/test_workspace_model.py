"""Phase B (0.2.5): workspace model, evidence rules, guide validation, publishing, starters, compatibility."""
import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from workspace_fixtures import BUNDLE, bundle  # noqa: E402

from fieldkit_core import db, examples, packs, workspace as ws  # noqa: E402


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    yield s
    db.set_store(None)


def test_source_tiers_check_the_domain_not_just_the_label():
    src = {s["id"]: s for s in BUNDLE["sources"]}
    assert ws.source_tier(src["s_fssai"])[0] == 1                       # .gov.in regulator
    assert ws.source_tier(src["s_nddb"])[0] == 2
    assert ws.source_tier(src["s_forum"])[0] == 0                       # forum, even if it claims "government"
    tier, notes = ws.source_tier(src["s_fake_gov"])
    assert tier == 2 and "not an official government domain" in notes[0]
    assert ws.source_tier(src["s_sop"])[0] == 1                         # the user's own document


def test_evidence_status_is_computed_from_sources():
    v = ws.validate_bundle(BUNDLE)
    st = v["statuses"]
    assert st["ev_snf_cow"] == "verified"          # tier-1, applicable, quoted
    assert st["ev_two_t2"] == "verified"           # two independent tier-2 publishers
    assert st["ev_single_t2"] == "supported"
    assert st["ev_conflict"] == "conflicting"
    assert st["ev_model_only"] == "unverified"     # model knowledge, no source
    assert st["ev_forum"] == "unverified"          # excluded source supports nothing
    assert st["ev_fake_gov"] == "supported"        # downgraded: not verified
    assert st["ev_sop"] == "user_procedure"
    assert st["ev_wrong_place"] == "supported" and any("does not (fully) apply" in n for n in v["evidence_notes"]["ev_wrong_place"])
    assert v["ok"], v["errors"]


def test_unverified_knowledge_cannot_become_an_instruction():
    b = bundle()
    b["guides"][0]["nodes"]["o_accept"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_model_only"]
    b["knowledge"]["entries"][0]["evidence_ids"] = ["ev_forum"]
    b["workflows"][0]["classification"]["rules"][0]["evidence_ids"] = ["ev_model_only"]
    errs = " | ".join(ws.validate_bundle(b)["errors"])
    assert "o_accept action 1 has no supporting evidence" in errs
    assert "k_retest: a procedure entry needs evidence" in errs
    assert "rule snf_low threshold rests only on unverified evidence" in errs


def test_unverified_background_is_allowed_but_flagged():
    v = ws.validate_bundle(BUNDLE)
    assert any("k_background: unverified background" in w for w in v["warnings"])


def test_conflicting_evidence_requires_escalation():
    b = bundle()
    b["guides"][0]["nodes"]["o_retest"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_conflict"]
    assert any("rests on conflicting evidence and must name an escalation" in e for e in ws.validate_bundle(b)["errors"])
    b["guides"][0]["nodes"]["o_retest"]["outcome"]["escalate_to"] = "centre manager"
    assert ws.validate_bundle(b)["ok"]


@pytest.mark.parametrize("mutate,expect", [
    (lambda g: g["nodes"].pop("o_accept"), "unknown node"),
    (lambda g: g["nodes"]["o_retest"].update(next=[{"to": "n_snf"}]), "outcome and further steps"),
    (lambda g: g["nodes"]["n_retested"]["next"][0].update(to="n_snf"), "cycle"),
    (lambda g: g["nodes"].update(orphan={"outcome": {"decision": "accept", "actions": []}}), "unreachable"),
    (lambda g: g["nodes"]["n_retested"]["next"][0]["when"].update(field="nonsense"), "unknown slot/field"),
    (lambda g: g["nodes"]["o_accept"]["outcome"].update(decision="maybe"), "not in the report policy"),
    (lambda g: g["nodes"]["n_snf"].update(field="no_such_field"), "unknown workflow field"),
])
def test_guide_structure_errors(mutate, expect):
    b = bundle()
    mutate(b["guides"][0])
    assert any(expect in e for e in ws.validate_bundle(b)["errors"]), ws.validate_bundle(b)["errors"]


def test_every_responsibility_must_be_served_and_brief_fields_required():
    b = bundle(traceability=[BUNDLE["traceability"][0]])
    assert any("r_adulteration is not served" in e for e in ws.validate_bundle(b)["errors"])
    p = copy.deepcopy(BUNDLE["profile"])
    p.pop("country")
    p["responsibilities"] = [{"id": "x", "description": "y"}]
    errs = ws.validate_bundle(bundle(profile=p, languages={"content": []}))["errors"]
    assert any("country" in e for e in errs) and any("decisions" in e for e in errs) and any("languages" in e for e in errs)


def test_missing_languages_are_flagged():
    b = bundle()
    b["knowledge"]["entries"][0]["text"] = {"en": "only English"}
    assert any("k_retest: missing languages ['hi']" in w for w in ws.validate_bundle(b)["warnings"])


def test_research_report_shows_tiers_statuses_conflicts_and_gaps():
    r = ws.research_report(BUNDLE, ws.validate_bundle(BUNDLE))
    assert {s["id"]: s["tier"] for s in r["sources"]}["s_forum"] == 0
    assert [e["id"] for e in r["evidence"]["conflicting"]] == ["ev_conflict"]
    assert r["gaps"][0]["topic"] == "Ammonium sulphate limit"
    assert r["summary"]["verified"] == 2 and r["summary"]["sources_excluded"] == 1


def test_draft_publish_and_manifest(store):
    d = ws.build_draft(store, db.ALL, BUNDLE)
    assert d["ok"] and d["version"] == 1
    out = ws.publish(store, "dairy-collection-mh")
    assert out["workflows"] == {"milk-collection-check": 1}
    assert set(out["packs"]) == {"ws-dairy-collection-mh-knowledge", "ws-dairy-collection-mh-dictionary"}
    m = json.loads(store.get_pack(db.ALL, "ws-dairy-collection-mh")["content"])
    assert m["kind"] == "workspace" and not packs.validate_pack(m)
    assert {e["id"]: e["status"] for e in m["evidence"]}["ev_snf_cow"] == "verified"
    assert m["guides"][0]["id"] == "g_accept" and m["workflows"] == [{"id": "milk-collection-check", "version": 1}]
    kp = json.loads(store.get_pack(db.ALL, "ws-dairy-collection-mh-knowledge")["content"])
    assert {e["id"]: e["evidence_status"] for e in kp["entries"]} == {"k_retest": "verified", "k_background": "unverified"}
    assert store.list_workspaces()[0]["published_version"] == 1
    # A second version supersedes the first; the first stays in history.
    ws.build_draft(store, db.ALL, bundle(title={"en": "Dairy QA v2", "hi": "दुग्ध गुणवत्ता v2"}), changelog=["renamed"])
    ws.publish(store, "dairy-collection-mh")
    assert store.get_workspace_version("dairy-collection-mh")["version"] == 2
    assert store.get_workspace_version("dairy-collection-mh", 1)["status"] == "superseded"


def test_invalid_draft_is_stored_but_cannot_be_published(store):
    b = bundle()
    b["guides"][0]["nodes"]["o_accept"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_model_only"]
    d = ws.build_draft(store, db.ALL, b)
    assert not d["ok"] and d["validation"]["errors"]
    with pytest.raises(db.Invalid):
        ws.publish(store, "dairy-collection-mh")


def test_examples_become_starter_workspaces_and_nothing_existing_changes(store):
    out = examples.install(store, db.ALL)
    assert sorted(out["workspaces"]) == ["starter-classroom-observation", "starter-crop-health-survey", "starter-equipment-inspection"]
    rec = store.sync_record("alice", "k1", "dev", {"id": "rec_after_ws_001", "workflow_id": "equipment-inspection",
                                                   "workflow_version": 1, "base_revision": 0, "answers": {"condition": "good"}},
                            auto_analyze=False)
    assert rec["sync_status"] == "complete"
    m = json.loads(store.get_pack(db.ALL, "ws-starter-equipment-inspection")["content"])
    wf = json.loads((Path(__file__).parents[2] / "examples" / "maintenance" / "workflow.json").read_text(encoding="utf-8"))
    assert m["starter"] is True and m["workflows"][0]["id"] == "equipment-inspection"
    assert set(m["packs"]) == set(wf["knowledge_packs"] + wf["dictionary_packs"])
    assert m["gaps"][0]["note"].startswith("Synthetic demo workspace")
    assert examples.install(store, db.ALL)["workspaces"] == []        # idempotent


def test_workspace_api_lists_and_reads(store):
    import importlib.util
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    spec = importlib.util.spec_from_file_location("fk_api_ws", Path(__file__).parents[2] / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    app = FastAPI()

    @app.middleware("http")
    async def fake(request, call_next):
        request.state.session = type("S", (), {"user_id": "alice"})()
        return await call_next(request)

    app.include_router(api.router, prefix="/api/plugins/fieldkit")
    c = TestClient(app)
    ws.build_draft(store, db.ALL, BUNDLE)
    assert c.get("/api/plugins/fieldkit/workspaces").json()["workspaces"] == []          # drafts are not listed
    ws.publish(store, "dairy-collection-mh")
    lst = c.get("/api/plugins/fieldkit/workspaces").json()["workspaces"]
    assert [w["id"] for w in lst] == ["dairy-collection-mh"]
    one = c.get("/api/plugins/fieldkit/workspaces/dairy-collection-mh").json()
    assert one["manifest_pack"] == "ws-dairy-collection-mh" and one["summary"]["gaps"] == 1
    got = c.get("/api/plugins/fieldkit/packs/ws-dairy-collection-mh")
    assert got.status_code == 200 and got.json()["kind"] == "workspace"
