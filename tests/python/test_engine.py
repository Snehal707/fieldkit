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
    findings = engine.classify(wf, case["answers"])
    assert [f["id"] for f in findings] == exp["finding_ids"]
    assert all(f["source"] == "local" for f in findings)
    by_id = {f["id"]: f for f in findings}
    for fid, sev in exp.get("severities", {}).items():
        assert by_id[fid]["severity"] == sev
    for fid, score in exp.get("scores", {}).items():
        assert by_id[fid]["score"] == score
    for fid, detail in exp.get("details", {}).items():
        assert by_id[fid]["detail"] == detail
    if "cleaned_keys" in exp:
        assert sorted(engine.clean_answers(wf, case["answers"])) == exp["cleaned_keys"]


@pytest.mark.parametrize("path", sorted(ROOT.glob("examples/*/workflow.json")))
def test_examples_are_valid(path):
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


def test_decision_tree_depth_guard():
    node = {"result": {"label": "deep"}}
    for _ in range(40):
        node = {"if": {"op": "always"}, "then": node, "else": node}
    wf = {"fields": [{"id": "a", "type": "text", "label": "A"}],
          "classification": {"decision_trees": [{"id": "t", "label": "T", "root": node}]}}
    assert engine.classify(wf, {}) == []


def test_model_catalog_has_no_placeholders():
    """Only installable packs are offered; no 'unavailable' language placeholders (owner decision 2026-11-09)."""
    catalog = json.loads((ROOT / "fieldkit_core" / "models.json").read_text(encoding="utf-8"))
    assert "unavailable" not in catalog
    assert [p["id"] for p in catalog["packs"]] == ["translate-en-hi", "translate-hi-en", "stt-whisper-tiny", "stt-whisper-small",
                                                   "ocr-eng", "ocr-hin"]
    langs = {lang for p in catalog["packs"] for lang in p["languages"]}
    assert langs == {"en", "hi"}
    # Every Transformers.js model file is pinned to a commit and verified by size and SHA-256 after download.
    for p in catalog["packs"]:
        if p["capability"] in ("stt", "translation"):
            assert len(p["revision"]) == 40
            for f in p["files"]:
                assert f"/resolve/{p['revision']}/" in f["url"] and f["size"] > 0 and len(f["sha256"]) == 64
            assert p["download_size"] == sum(f["size"] for f in p["files"]) or p["capability"] == "translation"


def test_whisper_tiny_is_english_only_and_hindi_has_a_pack():
    """Measured (tests/eval/stt_eval.mjs): Whisper tiny romanises Hindi, so it must not claim Hindi; Hindi uses small."""
    packs = {p["id"]: p for p in json.loads((ROOT / "fieldkit_core" / "models.json").read_text(encoding="utf-8"))["packs"]}
    assert packs["stt-whisper-tiny"]["languages"] == ["en"] and packs["stt-whisper-tiny"]["version"] == 2
    assert packs["stt-whisper-tiny"]["dtype"] == {"encoder_model": "fp32", "decoder_model_merged": "q8"}
    assert "hi" in packs["stt-whisper-small"]["languages"]
