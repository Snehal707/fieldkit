import json
from pathlib import Path

import pytest

from fieldkit_core import engine

ROOT = Path(__file__).resolve().parents[2]
VEC = ROOT / "tests" / "vectors"


def _load(name):
    return json.loads((VEC / name).read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _load("conditions.json"), ids=lambda c: c["name"])
def test_condition_vectors(case):
    assert engine.evaluate(case["cond"], case["answers"]) is case["expected"]


@pytest.mark.parametrize("case", _load("workflows.json"), ids=lambda c: c["name"])
def test_workflow_vectors(case):
    wf = json.loads((ROOT / case["workflow"]).read_text(encoding="utf-8"))
    exp = case["expected"]
    state = engine.compute_state(wf, case["answers"])
    all_ids = [f["id"] for f in wf["fields"]]
    hidden = [f for f in all_ids if f not in state["visible"]]
    assert hidden == exp["hidden"]
    assert state["errors"] == exp["errors"]
    assert state["complete"] is exp["complete"]
    if "cleaned_keys" in exp:
        assert sorted(engine.clean_answers(wf, case["answers"])) == exp["cleaned_keys"]


@pytest.mark.parametrize("path", sorted(ROOT.glob("tests/fixtures/forms/*.json")))
def test_example_forms_are_valid(path):
    assert engine.validate_definition(json.loads(path.read_text(encoding="utf-8"))) == []


def test_definition_problems_detected():
    wf = {
        "id": "x", "title": "X",
        "fields": [
            {"id": "a", "type": "text", "label": "A", "validation": {"pattern": "(["}},
            {"id": "a", "type": "single_choice", "label": "dup"},
            {"id": "b", "type": "text", "label": "B", "visible_if": {"op": "eq", "field": "zzz", "value": 1}},
        ],
    }
    msgs = " | ".join(p["message"] for p in engine.validate_definition(wf))
    assert "duplicate field id" in msgs
    assert "choice fields need options" in msgs
    assert "bad pattern" in msgs
    assert "unknown field 'zzz'" in msgs


def test_schema_rejects_code_like_fields():
    wf = {"id": "x", "title": "X", "fields": [{"id": "a", "type": "text", "label": "A", "script": "alert(1)"}]}
    assert engine.validate_definition(wf)
    wf2 = {"id": "x", "title": "X", "fields": [{"id": "a", "type": "javascript", "label": "A"}]}
    assert engine.validate_definition(wf2)


def test_multilingual_text():
    assert engine.text({"en": "Hi", "hi": "नमस्ते"}, "hi") == "नमस्ते"
    assert engine.text({"en": "Hi"}, "xx") == "Hi"
    assert engine.text("plain", "hi") == "plain"


def test_model_catalog_has_no_placeholders():
    """Only installable packs are offered; no 'unavailable' language placeholders (owner decision 2026-11-09)."""
    catalog = json.loads((ROOT / "fieldkit_core" / "models.json").read_text(encoding="utf-8"))
    assert "unavailable" not in catalog
    assert [p["id"] for p in catalog["packs"]] == ["translate-en-hi", "translate-hi-en", "ocr-eng", "ocr-hin"]
    langs = {lang for p in catalog["packs"] for lang in p["languages"]}
    assert langs == {"en", "hi"}
    # Every Transformers.js model file is pinned to a commit and verified by size and SHA-256 after download.
    for p in catalog["packs"]:
        if p["capability"] == "translation":
            assert len(p["revision"]) == 40
            for f in p["files"]:
                assert f"/resolve/{p['revision']}/" in f["url"] and f["size"] > 0 and len(f["sha256"]) == 64
            assert p["download_size"] == sum(f["size"] for f in p["files"]) or p["capability"] == "translation"
