"""Fix from iPhone testing on hosted 0.2.6: the dairy workspace treated FSSAI point-of-sale fat/SNF standards as
mandatory rejection thresholds for farmer milk collection.

A standard that governs another stage or party is a REFERENCE for this work (status 'reference'). It may be shown for
information, but it can never alone drive a high/critical rule or the most severe decision (here: reject). The
collection decision rests on the user's own procurement standard ("Your procedure"). The workspace fixture below
reproduces the hosted mistake (FSSAI evidence cited by the reject action) with synthetic test text.
"""
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).parent))
from workspace_fixtures import BUNDLE, bundle  # noqa: E402

from fieldkit_core import db, workspace as ws, workspace_schema as S  # noqa: E402

SALE = {"jurisdiction": "IN", "subject": "milk offered for sale", "matches_profile": False,
        "governs": "milk sold to consumers (point of sale)", "binding_for_this_work": False}
UNION_RULE = {"id": "ev_union_rule", "claim": "Our union rejects cow milk below 8.3% SNF after one re-test",
              "user_procedure": True, "excerpts": [{"source_id": "s_user", "quote": "reject cow milk below 8.3 SNF after one re-test"}],
              "applicability": {"matches_profile": True, "governs": "acceptance at our collection centre", "binding_for_this_work": True}}
USER_SRC = {"id": "s_user", "type": "user_statement", "title": "Stated by the user in the setup interview", "retrieved_at": "2026-11-10"}


def _with_sale_standard(b):
    for e in b["evidence"]:
        if e["id"] == "ev_snf_cow":
            e["applicability"] = dict(SALE)
    return b


def test_hosted_mistake_is_rejected_once_applicability_is_recorded():
    b = _with_sale_standard(bundle())
    v = ws.validate_bundle(b)
    assert v["statuses"]["ev_snf_cow"] == "reference"
    assert any("governs milk sold to consumers" in n for n in v["evidence_notes"]["ev_snf_cow"])
    reject_errs = [e for e in v["errors"] if "'reject' action" in e]
    assert reject_errs and "rests only on evidence that governs milk sold to consumers (point of sale), not this work" in reject_errs[0]
    assert not v["ok"]
    # Accepting milk may still mention the sale standard (information); only the severe decision is blocked.
    assert not any("o_accept" in e and "rests only" in e for e in v["errors"])


def test_corrected_dairy_workspace_keeps_both_kinds_of_standard_apart():
    """The correction: the reject decision and the high rule cite the user's procurement standard; the FSSAI sale
    standard stays as a reference (it is not deleted, and not presented as binding)."""
    b = _with_sale_standard(bundle())
    b["sources"].append(USER_SRC)
    b["evidence"].append(copy.deepcopy(UNION_RULE))
    g = b["guides"][0]["nodes"]
    g["n_snf"]["next"][0]["when"]["value"] = 8.3
    g["o_reject"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_union_rule"]
    g["o_accept"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_union_rule", "ev_snf_cow"]
    rule = b["workflows"][0]["classification"]["rules"][0]
    rule.update(severity="high", evidence_ids=["ev_union_rule"], label={"en": "SNF below our procurement standard", "hi": "SNF हमारे खरीद मानक से कम"})
    rule["when"]["value"] = 8.3
    b["workflows"][0]["classification"]["rules"].append(
        {"id": "snf_below_sale_standard", "label": {"en": "Below the FSSAI sale standard (for information)", "hi": "FSSAI बिक्री मानक से कम (जानकारी)"},
         "severity": "low", "when": {"op": "lt", "field": "snf_pct", "value": 8.5}, "evidence_ids": ["ev_snf_cow"]})
    v = ws.validate_bundle(b)
    assert not [e for e in v["errors"] if "rests only" in e], v["errors"]
    assert v["statuses"]["ev_union_rule"] == "user_procedure" and v["statuses"]["ev_snf_cow"] == "reference"
    assert v["summary"]["reference"] == 1


def test_high_rule_on_a_reference_standard_is_an_error():
    b = _with_sale_standard(bundle())
    b["workflows"][0]["classification"]["rules"][0]["severity"] = "high"
    v = ws.validate_bundle(b)
    assert any("rule snf_low (high) rests only on evidence that governs" in e for e in v["errors"])


def test_legal_evidence_driving_reject_without_a_binding_statement_is_flagged():
    """Bundles built before this fix (like the hosted one) say nothing about binding_for_this_work: Hermes is told to
    state it when it rebuilds the workspace (a warning, so existing workspaces stay readable and publishable)."""
    v = ws.validate_bundle(bundle())
    assert any("cites legal evidence ev_snf_cow without applicability.binding_for_this_work" in w for w in v["warnings"])


def test_the_example_shown_to_hermes_teaches_the_distinction():
    ex = S.EXAMPLES
    assert ex["evidence"]["user_procedure"] is True and ex["evidence"]["applicability"]["binding_for_this_work"] is True
    assert "legal" not in ex["workflows"]["classification"]["rules"][0]["label"]["en"].lower()
    assert "binding_for_this_work" in S.RULES["evidence"] and "never a rejection threshold" in S.RULES["evidence"]
    assert "reference" in S.format_doc()["evidence_rules"]


def test_reference_status_reaches_the_phone_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    s = db.Store(path=str(tmp_path / "t.db"))
    db.set_store(s)
    try:
        b = _with_sale_standard(bundle())
        b["sources"].append(USER_SRC)
        b["evidence"].append(copy.deepcopy(UNION_RULE))
        b["guides"][0]["nodes"]["o_reject"]["outcome"]["actions"][0]["evidence_ids"] = ["ev_union_rule"]
        d = ws.build_draft(s, db.ALL, b)
        assert d["ok"], d["validation"]["errors"]
        ws.publish(s, b["id"], d["version"], actor=db.ALL)
        m = s.get_pack_content(ws.pack_ids(b["id"])["workspace"])
        ev = {e["id"]: e for e in m["evidence"]}
        assert ev["ev_snf_cow"]["status"] == "reference" and ev["ev_union_rule"]["status"] == "user_procedure"
    finally:
        db.set_store(None)
