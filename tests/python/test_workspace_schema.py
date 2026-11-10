"""0.2.6: schema-aware workspace parts. The examples Hermes is shown are valid; the shape mistakes seen in the hosted
dairy build (field types, option formats, condition ASTs, evidence ids, guide node structures) are repaired when the
intent is unambiguous and otherwise rejected with a path and a hint; values are type-checked against fields; and a
bundle that skips the per-part path is held to the same checks before it can be published."""
import copy
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).parent))

from fieldkit_core import workspace as ws  # noqa: E402
from fieldkit_core import workspace_schema as S  # noqa: E402
from workspace_fixtures import BUNDLE, bundle  # noqa: E402


def _ctx(**kw):
    base = {"sources": {}, "evidence": {}, "workflows": {}, "existing_workflows": {}, "decisions": set(), "statuses": {},
            "responsibilities": {"r_accept"}, "guides": {}, "entries": {}, "languages": ["en", "hi"]}
    base.update(kw)
    return base


def _example_ctx():
    c = _ctx()
    for p in S.PARTS:
        it = S.EXAMPLES[p]
        k = S.item_key(p, it)
        {"sources": c["sources"], "evidence": c["evidence"], "workflows": c["workflows"], "guides": c["guides"],
         "knowledge": c["entries"]}.get(p, {})[k] = it
        if p == "evidence":
            c["statuses"][k] = "verified"
        if p == "report_policy":
            c["decisions"] = {d["id"] for d in it["decision_scale"]}
    return c


def test_every_example_shown_to_hermes_is_valid_in_order():
    c = _ctx()
    for p in S.PARTS:
        item, fixes = S.normalize(p, S.EXAMPLES[p])
        assert fixes == [], (p, fixes)
        assert S.check_item(p, item, c) == [], p
        k = S.item_key(p, item)
        {"sources": c["sources"], "evidence": c["evidence"], "workflows": c["workflows"], "guides": c["guides"],
         "knowledge": c["entries"]}.get(p, {})[k] = item
        if p == "evidence":
            c["statuses"][k] = "verified"
        if p == "report_policy":
            c["decisions"] = {d["id"] for d in item["decision_scale"]}


def test_format_doc_gives_schema_example_and_rules_per_part():
    over = S.format_doc()
    assert over["part_order"] == list(S.PARTS) and "fieldkit_start_workspace_build" in over["steps"][0]
    g = S.format_doc("guides")
    assert g["schema"]["required"] == ["id", "title", "start", "nodes"] and g["example"]["start"] == "n_snf"
    assert "condition" in g["hints"] and "op" in g["hints"]["condition"]
    assert "check_requirement" in S.format_doc("intents")["rules"]
    assert S.format_doc("nope")["error"]


def test_hosted_style_workflow_mistakes_are_repaired_and_reported():
    wf = {"id": "milk-check", "title": "Milk check", "fields": [
        {"name": "milk_type", "type": "select", "label": "Milk", "choices": ["cow", "buffalo"]},
        {"id": "snf", "type": "float", "label": "SNF", "min": 0, "max": 15},
        {"id": "count", "type": "integer", "label": "Cans"},
        {"id": "clean", "type": "yes_no", "label": "Cans clean?"},
        {"id": "smell_ok", "type": "boolean", "label": "Smell OK"},
        {"id": "note", "type": "textarea", "label": "Notes"},
        {"id": "pic", "type": "image", "label": "Photo"}],
        "classification": {"rules": [
            {"id": "low", "label": "Low SNF", "condition": {"and": [{"==": [{"var": "milk_type"}, "cow"]},
                                                                     {"field": "snf", "operator": "<", "value": 8.5}]}},
            {"id": "dirty", "label": "Dirty cans", "when": {"op": "==", "field": "clean", "value": "no"}},
            {"id": "smell", "label": "Smell", "when": {"op": "AND", "conditions": [{"op": "eq", "field": "smell_ok", "value": False}]}}]}}
    item, fixes = S.normalize("workflows", wf)
    f = {x["id"]: x for x in item["fields"]}
    assert f["milk_type"]["type"] == "single_choice" and f["milk_type"]["options"][0] == {"value": "cow", "label": "cow"}
    assert f["snf"]["type"] == "number" and f["snf"]["validation"] == {"min": 0, "max": 15}
    assert f["count"]["validation"]["integer"] is True
    assert f["clean"]["type"] == "single_choice" and [o["value"] for o in f["clean"]["options"]] == ["yes", "no"]
    assert f["smell_ok"]["type"] == "checkbox" and f["note"]["type"] == "multiline" and f["pic"]["type"] == "photo"
    r = {x["id"]: x for x in item["classification"]["rules"]}
    assert r["low"]["when"] == {"op": "and", "all": [{"op": "eq", "field": "milk_type", "value": "cow"},
                                                     {"op": "lt", "field": "snf", "value": 8.5}]}
    assert r["smell"]["when"] == {"op": "and", "all": [{"op": "eq", "field": "smell_ok", "value": False}]}
    assert any("type 'select'" in x for x in fixes) and any("JSONLogic" in x for x in fixes)
    assert S.check_item("workflows", item, _ctx()) == []
    assert ws.engine.validate_definition(item) == []


def test_type_errors_in_conditions_are_caught_with_hints():
    wf = copy.deepcopy(S.EXAMPLES["workflows"])
    wf["classification"]["rules"] = [
        {"id": "a", "label": "x", "when": {"op": "lt", "field": "snf_pct", "value": "8.5"}},             # number vs text
        {"id": "b", "label": "x", "when": {"op": "eq", "field": "milk_type", "value": "Cow"}},          # not an option value
        {"id": "c", "label": "x", "when": {"op": "eq", "field": "smell_ok", "value": "no"}},            # checkbox vs text
        {"id": "d", "label": "x", "when": {"op": "eq", "field": "sample_photo", "value": "x"}},         # media field
        {"id": "e", "label": "x", "when": {"op": "gt", "field": "fat_pct", "value": 3}},                # unknown field
        {"id": "f", "label": "x", "when": {"op": "eq", "field": "snf_pct", "value": 8}, "evidence_ids": ["ev_ghost"]}]
    errs = S.check_item("workflows", wf, _example_ctx())
    msgs = " | ".join(e["error"] for e in errs)
    assert "compare it with a number, not '8.5'" in msgs
    assert "'Cow' is not an option value of 'milk_type'; options are ['cow', 'buffalo']" in msgs
    assert "compare with true or false" in msgs and "only exists/empty" in msgs
    assert "unknown field" in msgs and "unknown evidence ids ['ev_ghost']" in msgs
    assert all(e["path"] for e in errs) and any(e["hint"].startswith("A condition is") for e in errs)


def test_hosted_style_guide_mistakes_are_repaired_or_rejected_precisely():
    g = {"id": "g1", "title": "Accept?", "workflow_id": "milk-collection-check", "nodes": [
        {"id": "q_snf", "type": "question", "field": "snf_pct", "next": [{"condition": {"field": "snf_pct", "operator": "<", "value": 8.5},
                                                                          "goto": "q_retest"}], "else": "o_accept"},
        {"id": "q_retest", "text": {"en": "Re-tested?", "hi": "दोबारा जाँचा?"}, "input": "boolean",
         "next": {"yes": "o_reject", "no": "o_retest"}},
        {"id": "o_reject", "type": "outcome", "outcome": {"decision_id": "reject", "label": "Reject",
                                                          "actions": [{"action": "Reject", "evidence_ids": "ev_cow_snf"}]}},
        {"id": "o_retest", "outcome": {"decision": "retest", "title": "Re-test", "actions": [{"kind": "escalate", "text": "Ask manager"}]}},
        {"id": "o_accept", "outcome": {"decision": "accept", "title": "Accept", "actions": [{"text": "Accept", "evidence_ids": ["ev_cow_snf"]}]}}]}
    item, fixes = S.normalize("guides", g)
    assert item["start"] == "q_snf" and set(item["nodes"]) == {"q_snf", "q_retest", "o_reject", "o_retest", "o_accept"}
    assert item["nodes"]["q_snf"]["slot"] == "snf_pct" and item["nodes"]["q_snf"]["default"] == "o_accept"
    assert item["nodes"]["q_retest"]["slot"] == "q_retest" and item["nodes"]["q_retest"]["input"] == "yes_no"
    assert item["nodes"]["q_retest"]["next"][0] == {"when": {"op": "eq", "field": "q_retest", "value": True}, "to": "o_reject"}
    assert item["nodes"]["o_reject"]["outcome"]["actions"][0] == {"text": "Reject", "evidence_ids": ["ev_cow_snf"]}
    c = _example_ctx()
    assert S.check_item("guides", item, c) == []
    # Not repairable: an unknown decision, an edge to nowhere, an unsupported action, evidence that does not exist.
    bad = copy.deepcopy(item)
    bad["nodes"]["o_accept"]["outcome"]["decision"] = "ok"
    bad["nodes"]["q_snf"]["next"][0]["to"] = "q_missing"
    msgs = " | ".join(e["error"] for e in S.check_item("guides", bad, c))
    assert "'ok' is not in report_policy.decision_scale" in msgs and "unknown node 'q_missing'" in msgs
    bad = copy.deepcopy(item)
    bad["nodes"]["o_accept"]["outcome"]["actions"] = [{"text": "Accept"}]
    assert "no supporting evidence" in " ".join(e["error"] for e in S.check_item("guides", bad, c))
    bad["nodes"]["o_accept"]["outcome"]["actions"] = [{"text": "Accept", "evidence_ids": ["ev_nope"]}]
    assert "unknown evidence ids ['ev_nope']" in " ".join(e["error"] for e in S.check_item("guides", bad, c))
    # A node that is neither a question nor an outcome gets the schema's error and the node hint.
    bad = copy.deepcopy(item)
    bad["nodes"]["o_accept"] = {"result": "accept"}
    errs = S.check_item("guides", bad, c)
    assert errs and errs[0]["path"].startswith("nodes/o_accept") and "Question node" in errs[0]["hint"]


def test_evidence_status_labels_are_dropped_and_ids_must_exist():
    ev = {"id": "ev1", "claim": "x is required", "status": "verified",
          "excerpts": {"source": "s_none", "text": "a quotation that is long enough to count"},
          "matches_profile": "yes"}
    item, fixes = S.normalize("evidence", ev)
    assert "status" not in item and item["applicability"] == {"matches_profile": True}
    assert item["excerpts"][0] == {"source_id": "s_none", "quote": "a quotation that is long enough to count"}
    errs = S.check_item("evidence", item, _example_ctx())
    assert errs[0]["path"] == "excerpts/0/source_id" and "add it to sources first" in errs[0]["error"]
    short = dict(item, excerpts=[{"source_id": "s_fssai_dairy", "quote": "too short"}])
    assert "at least 20 characters" in S.check_item("evidence", short, _example_ctx())[0]["error"]


def test_knowledge_intents_vocabulary_and_traceability_rules():
    c = _example_ctx()
    proc = {"id": "k1", "type": "procedure", "title": "Clean", "text": "Do it", "evidence_ids": []}
    assert "at least 'supported'" in S.check_item("knowledge", proc, c)[0]["error"]
    assert S.check_item("intents", {"id": "ask_limit", "examples": {"en": ["x"]}}, c)[0]["path"] == "id"
    item, _ = S.normalize("intents", {"id": "how_to", "examples": ["How do I re-test?"]})
    assert item["examples"] == {"en": ["How do I re-test?"]} and S.check_item("intents", item, c) == []
    assert "definition" in S.check_item("vocabulary", {"term": "SNF", "lang": "en"}, c)[0]["error"]
    assert "unknown responsibility" in S.check_item("traceability", {"responsibility_id": "r_x", "workflow_ids": ["milk-collection-check"]}, c)[0]["error"]
    assert "point at least one" in S.check_item("traceability", {"responsibility_id": "r_accept"}, c)[0]["error"]


def test_whole_bundles_get_the_same_checks_at_validation():
    b = bundle()
    assert ws.validate_bundle(b)["ok"], ws.validate_bundle(b)["errors"]
    b["workflows"][0]["classification"]["rules"][0]["when"]["value"] = "8.5"       # a string threshold
    b["guides"][0]["nodes"]["o_accept"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_ghost"]
    v = ws.validate_bundle(b)
    assert not v["ok"]
    joined = " | ".join(v["errors"])
    assert "workflows milk-collection-check: classification/rules/0/when 'snf_pct' is a number" in joined
    assert "unknown evidence ids ['ev_ghost']" in joined


# ----------------------------------------------------------------------------- source checks: bounded and cached
PAGE = "<html><body>" + "<p>Background text about milk quality testing at collection centres.</p>" * 20 + \
       "<p>ILLUSTRATIVE TEST TEXT: re-test borderline samples once.</p></body></html>"


def test_slow_pages_do_not_block_and_results_are_reused():
    calls = []

    def slow(url):
        calls.append(url)
        time.sleep(1.0)
        return "text/html", PAGE
    b = {"sources": [{"id": "s1", "url": "https://slow.example.org/a", "type": "academic"}],
         "evidence": [{"id": "e1", "excerpts": [{"source_id": "s1", "quote": "re-test borderline samples once"}]}]}
    orig = ws.default_fetch
    try:
        ws.default_fetch = slow
        t0 = time.monotonic()
        counts = ws.check_excerpts(copy.deepcopy(b), wait_s=0.1)
        assert time.monotonic() - t0 < 0.8 and counts["pending"] == 1
        deadline = time.monotonic() + 5
        while ws._INFLIGHT and time.monotonic() < deadline:
            time.sleep(0.05)
        b2 = copy.deepcopy(b)
        assert ws.check_excerpts(b2, wait_s=0.1)["found"] == 1 and ws.pending_checks(b2) == 0
        assert calls == ["https://slow.example.org/a"]          # fetched once, then served from the cache
    finally:
        ws.default_fetch = orig


def test_thin_pages_are_not_judged_and_split_quotes_still_match():
    b = {"sources": [{"id": "s1", "url": "https://a.example.org/x", "type": "academic"},
                     {"id": "s2", "url": "https://b.example.org/y", "type": "academic"}],
         "evidence": [{"id": "e1", "excerpts": [{"source_id": "s1", "quote": "a sentence that is not on this page at all"}]},
                      {"id": "e2", "excerpts": [{"source_id": "s2", "quote": "Cow milk | minimum SNF | 8.5 percent by weight in the table"}]}]}
    pages = {"https://a.example.org/x": "<div id=app></div><script>render()</script>",
             "https://b.example.org/y": PAGE + "<table><tr><td>Cow milk</td><td>minimum SNF</td></tr><tr><td>8.5 percent by weight in the table</td></tr></table>"}
    ws.check_excerpts(b, fetch=lambda u: ("text/html", pages[u]))
    assert b["evidence"][0]["excerpts"][0]["check"] == "not_checked" and "no readable text" in b["evidence"][0]["excerpts"][0]["check_note"]
    assert b["evidence"][1]["excerpts"][0]["check"] == "found"


def test_redirects_into_private_networks_are_refused():
    h = ws._SafeRedirect()
    with pytest.raises(ValueError):
        h.redirect_request(None, None, 302, "Found", {}, "http://127.0.0.1:9300/api")
    with pytest.raises(ValueError):
        h.redirect_request(None, None, 302, "Found", {}, "file:///etc/passwd")


def test_publishing_is_blocked_while_quotes_are_still_being_checked(tmp_path):
    from fieldkit_core import db
    store = db.Store(path=str(tmp_path / "t.db"))
    b = bundle()
    b["evidence"][0]["excerpts"][0]["check"] = "pending"
    d = ws.build_draft(store, db.ALL, b)
    assert d["ok"]
    with pytest.raises(db.Invalid, match="still being checked"):
        ws.publish(store, b["id"], d["version"])
    assert BUNDLE["id"] == b["id"]


def test_pdf_quotes_use_hermes_document_extractor_when_available(monkeypatch):
    import types
    fake = types.ModuleType("tools.read_extract")
    fake.extract_document_bytes = lambda data, path: "Cow Milk | All India | 3.2 | 8.3 and other text" if data.startswith(b"%PDF") else ""
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.read_extract", fake)
    assert ws.pdf_text(b"%PDF-1.7 ...") .startswith("Cow Milk")
    monkeypatch.delitem(sys.modules, "tools.read_extract")
    monkeypatch.setitem(sys.modules, "tools.read_extract", None)       # not inside Hermes and no pypdf
    assert ws.pdf_text(b"%PDF-1.7 ...") in (None, "")
    b = {"sources": [{"id": "s1", "url": "https://fssai.gov.in/x/Chapter_2_1.pdf", "type": "regulator"}],
         "evidence": [{"id": "e1", "excerpts": [{"source_id": "s1", "quote": "Cow Milk | All India | 3.2 | 8.3"}]},
                      {"id": "e2", "excerpts": [{"source_id": "s1", "quote": "Cow Milk | All India | 3.5 | 8.5"}]}]}
    text = PAGE + "Cow Milk | All India | 3.2 | 8.3"
    ws.check_excerpts(b, fetch=lambda u: ("text/plain; source=pdf", text))
    assert b["evidence"][0]["excerpts"][0]["check"] == "found"
    assert b["evidence"][1]["excerpts"][0]["check"] == "not_found"          # a misquoted threshold is caught
    b2 = {"sources": b["sources"], "evidence": [{"id": "e1", "excerpts": [{"source_id": "s1", "quote": "Cow Milk | All India | 3.2 | 8.3"}]}]}
    ws.check_excerpts(b2, fetch=lambda u: ("application/pdf", ""))
    assert b2["evidence"][0]["excerpts"][0]["check"] == "not_checked" and "PDF" in b2["evidence"][0]["excerpts"][0]["check_note"]


def test_guide_keys_written_inside_nodes_are_lifted_out():
    """Seen in the real Hermes run (grok-4.7): title/start/workflow_id placed inside nodes."""
    g = copy.deepcopy(S.EXAMPLES["guides"])
    nodes = g.pop("nodes")
    nodes.update({"title": g.pop("title"), "start": g.pop("start"), "workflow_id": g.pop("workflow_id")})
    g["nodes"] = nodes
    item, fixes = S.normalize("guides", g)
    assert item["start"] == "n_snf" and item["workflow_id"] == "milk-collection-check" and item["title"]["en"]
    assert "title" not in item["nodes"] and any("inside nodes" in f for f in fixes)
    assert S.check_item("guides", item, _example_ctx()) == []


def test_scanned_pdf_text_matches_approximately_but_numbers_must_be_exact():
    """From the real run: a 1982 BIS standard scanned and OCR'd ("ii may he noted ... 111 milk is or routine purposes")."""
    page = PAGE + (" insert the following new clause after 0 3 0 3 1 ii may he noted that the lactometer estimation of solids "
                   "not fat 111 milk is or routine purposes and is only an estimate nearer 10 the gravrmetnc method all the "
                   "correction factors. Cow Milk All India 3 2 8 3 ")
    b = {"sources": [{"id": "s1", "url": "https://law.resource.org/x.pdf", "type": "standards_body"}],
         "evidence": [{"id": "e1", "excerpts": [{"source_id": "s1", "quote": "It may be noted that the lactometer estimation of "
                       "solids-not-fat in milk is for routine purposes and is only an estimate nearer to the gravimetric method."}]},
                      {"id": "e2", "excerpts": [{"source_id": "s1", "quote": "Cow Milk All India minimum fat 3.5 and SNF 8.3 percent"}]}]}
    counts = ws.check_excerpts(b, fetch=lambda u: ("text/plain; source=pdf", page))
    assert b["evidence"][0]["excerpts"][0]["check"] == "approximate" and "by eye" in b["evidence"][0]["excerpts"][0]["check_note"]
    assert b["evidence"][1]["excerpts"][0]["check"] == "not_found"          # 3.5 is not on the page: never approximate
    assert counts["approximate"] == 1 and counts["not_found"] == 1


def test_phone_guides_ask_record_fields_with_their_label_and_all_options():
    """From the real Hermes-built dairy guide: a node reading 'alcohol_test' only offered 'positive' on the phone."""
    wf = {"id": "w", "fields": [
        {"id": "alcohol_test", "type": "single_choice", "label": {"en": "Alcohol test", "hi": "अल्कोहल परीक्षण"},
         "options": [{"value": "negative", "label": {"en": "Negative"}}, {"value": "positive", "label": {"en": "Positive"}}]},
        {"id": "smell_ok", "type": "checkbox", "label": {"en": "Smell OK"}},
        {"id": "fat_pct", "type": "number", "unit": "%", "label": {"en": "Fat"}}]}
    g = {"id": "g", "workflow_id": "w", "start": "a", "nodes": {
        "a": {"slot": "alcohol_test", "field": "alcohol_test", "input": "choice",
              "next": [{"when": {"op": "eq", "field": "alcohol_test", "value": "positive"}, "to": "o"}], "default": "b"},
        "b": {"slot": "smell_ok", "field": "smell_ok", "default": "c"},
        "c": {"slot": "fat_pct", "field": "fat_pct", "question": {"en": "Fat reading?"}, "default": "o"},
        "o": {"outcome": {"decision": "x", "title": "x"}}}}
    out = ws.phone_guides([g], {"w": wf})[0]["nodes"]
    assert out["a"]["question"]["en"] == "Alcohol test" and [o["value"] for o in out["a"]["options"]] == ["negative", "positive"]
    assert out["b"]["input"] == "yes_no" and out["b"]["question"]["en"] == "Smell OK"
    assert out["c"]["input"] == "number" and out["c"]["question"]["en"] == "Fat reading?" and out["c"]["unit"] == "%"
    assert "question" not in g["nodes"]["a"]                                    # the stored bundle is unchanged


def test_rules_the_user_states_are_their_procedure_and_can_drive_the_guide():
    """Fast setup (0.2.6): no web research needed for the user's own rules; labelled 'Your procedure', never verified."""
    src = {"id": "s_user", "type": "user_statement", "title": "Stated by the user in the setup interview", "retrieved_at": "2026-11-10"}
    ev = {"id": "ev_union_snf", "claim": "Our union rejects cow milk below 8.3% SNF",
          "excerpts": [{"source_id": "s_user", "quote": "reject below 8.3"}], "applicability": {"matches_profile": True}}
    assert S.check_item("sources", src, _ctx()) == []
    c = _ctx(sources={"s_user": src})
    assert S.check_item("evidence", ev, c) == []
    assert ws.evidence_status(ev, {"s_user": src})[0] == "user_procedure"
    # Not checked against any page, and a published source still needs a real quote.
    b = {"sources": [src], "evidence": [copy.deepcopy(ev)]}
    ws.check_excerpts(b, fetch=lambda u: (_ for _ in ()).throw(AssertionError("must not fetch")))
    assert b["evidence"][0]["excerpts"][0]["check"] == "not_checked"
    ext = {"id": "s_web", "type": "academic", "url": "https://a.example.org/x", "title": "x"}
    c2 = _ctx(sources={"s_web": ext})
    assert "at least 20" in S.check_item("evidence", dict(ev, excerpts=[{"source_id": "s_web", "quote": "8.3"}]), c2)[0]["error"]
    # A guide action backed by the user's procedure is allowed (it is their own rule, labelled as such).
    c3 = _example_ctx()
    c3["evidence"]["ev_union_snf"] = ev
    c3["statuses"]["ev_union_snf"] = "user_procedure"
    g = copy.deepcopy(S.EXAMPLES["guides"])
    g["nodes"]["o_accept"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_union_snf"]
    assert S.check_item("guides", g, c3) == []


def test_language_shapes_from_real_models_are_normalised():
    from fieldkit_core.workspace_tools import normalize_languages as n
    assert n(["English", "Hindi"]) == {"content": ["en", "hi"]}
    assert n({"en": "English", "hi": "Hindi"}) == {"content": ["en", "hi"]}
    assert n({"primary": ["hi", "en"]}) == {"content": ["hi", "en"]}
    assert n({"content": ["en", "hi"], "speech": ["hi"]}) == {"content": ["en", "hi"], "speech": ["hi"]}
    assert n("hi") == {"content": ["hi"]} and n(None) == {"content": ["en"]}
