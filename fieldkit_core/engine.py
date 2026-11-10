"""Deterministic workflow engine (Python twin of ``app/src/engine.ts``).

Workflows are pure data. Conditions (when a question is shown or required) and validation are a small
JSON AST and evaluated here; nothing an LLM produces is ever executed as code. Behaviour is
pinned by the shared vectors in ``tests/vectors`` that the TypeScript engine also runs.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).with_name("schema") / "workflow.schema.json"

FIELD_TYPES = {
    "text", "multiline", "number", "date", "time", "checkbox", "single_choice",
    "multi_choice", "photo", "gps", "audio", "signature", "instruction",
}
INPUTLESS = {"instruction"}
MEDIA_TYPES = {"photo", "audio", "signature"}
COMPARE_OPS = {"eq", "neq", "gt", "gte", "lt", "lte"}
MAX_PATTERN_LEN = 200
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$")


# --------------------------------------------------------------------------- conditions
def _is_empty(v: Any) -> bool:
    return v is None or v == "" or (isinstance(v, (list, dict)) and len(v) == 0)


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _cmp(op: str, a: Any, b: Any) -> bool:
    if op == "eq":
        if isinstance(a, bool) or isinstance(b, bool):  # Python's False == 0; JS-consistent strictness
            return type(a) is type(b) and a == b
        return a == b or (_num(a) is not None and _num(a) == _num(b))
    if op == "neq":
        return not _cmp("eq", a, b)
    na, nb = _num(a), _num(b)
    if na is None or nb is None:
        if isinstance(a, str) and isinstance(b, str):  # ISO dates/times compare lexically
            na, nb = a, b  # type: ignore[assignment]
        else:
            return False
    return {"gt": na > nb, "gte": na >= nb, "lt": na < nb, "lte": na <= nb}[op]  # type: ignore[operator]


def evaluate(cond: Any, answers: dict[str, Any]) -> bool:
    """Evaluate a condition AST against answers. Unknown ops evaluate to False (fail closed)."""
    if cond is None:
        return True
    if not isinstance(cond, dict):
        return False
    op = cond.get("op")
    if op == "and":
        return all(evaluate(c, answers) for c in cond.get("all", []))
    if op == "or":
        return any(evaluate(c, answers) for c in cond.get("any", []))
    if op == "not":
        return not evaluate(cond.get("cond"), answers)
    if op == "always":
        return True
    value = answers.get(cond.get("field", ""))
    target = cond.get("value")
    if op in COMPARE_OPS:
        if isinstance(value, list):
            return False
        return _cmp(op, value, target)
    if op == "in":
        return isinstance(target, list) and any(_cmp("eq", value, t) for t in target)
    if op == "contains":
        if isinstance(value, list):
            return any(_cmp("eq", v, target) for v in value)
        if isinstance(value, str) and isinstance(target, str):
            return target.lower() in value.lower()
        return False
    if op == "exists":
        return not _is_empty(value)
    if op == "empty":
        return _is_empty(value)
    return False


def referenced_fields(cond: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(cond, dict):
        if "field" in cond:
            out.add(cond["field"])
        for key in ("all", "any"):
            for c in cond.get(key, []) or []:
                out |= referenced_fields(c)
        if "cond" in cond:
            out |= referenced_fields(cond["cond"])
    return out


# --------------------------------------------------------------------------- labels
def text(value: Any, lang: str = "en", fallback: str = "en") -> str:
    """Resolve a multilingual label: plain string or ``{lang: text}``."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get(lang) or value.get(fallback) or next(iter(value.values()), "")
    return ""


# --------------------------------------------------------------------------- structure
@lru_cache(maxsize=1)
def _schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_definition(workflow: Any) -> list[dict[str, str]]:
    """Validate a workflow definition. Returns a list of ``{path, message}`` problems."""
    problems: list[dict[str, str]] = []
    try:
        import jsonschema
        validator = jsonschema.Draft202012Validator(_schema())
        for err in sorted(validator.iter_errors(workflow), key=lambda e: list(e.path)):
            problems.append({"path": "/".join(str(p) for p in err.path), "message": err.message})
    except ImportError:  # pragma: no cover - jsonschema is a declared dependency
        if not isinstance(workflow, dict) or not isinstance(workflow.get("fields"), list):
            problems.append({"path": "", "message": "workflow must be an object with a fields list"})
    if problems or not isinstance(workflow, dict):
        return problems

    ids: set[str] = set()
    for i, f in enumerate(workflow["fields"]):
        fid = f.get("id", "")
        if fid in ids:
            problems.append({"path": f"fields/{i}/id", "message": f"duplicate field id {fid!r}"})
        ids.add(fid)
        if f.get("type") in ("single_choice", "multi_choice") and not f.get("options"):
            problems.append({"path": f"fields/{i}/options", "message": "choice fields need options"})
        pattern = (f.get("validation") or {}).get("pattern")
        if pattern:
            if len(pattern) > MAX_PATTERN_LEN:
                problems.append({"path": f"fields/{i}/validation/pattern", "message": "pattern too long"})
            else:
                try:
                    re.compile(pattern)
                except re.error as exc:
                    problems.append({"path": f"fields/{i}/validation/pattern", "message": f"bad pattern: {exc}"})
    for i, f in enumerate(workflow["fields"]):
        for key in ("visible_if", "required_if"):
            for ref in referenced_fields(f.get(key)) - ids:
                problems.append({"path": f"fields/{i}/{key}", "message": f"unknown field {ref!r}"})
    cls = workflow.get("classification") or {}
    for i, rule in enumerate(cls.get("rules", [])):
        for ref in referenced_fields(rule.get("when")) - ids:
            problems.append({"path": f"classification/rules/{i}", "message": f"unknown field {ref!r}"})
    for i, kw in enumerate(cls.get("keywords", [])):
        for ref in set(kw.get("fields", [])) - ids:
            problems.append({"path": f"classification/keywords/{i}", "message": f"unknown field {ref!r}"})
    return problems


# --------------------------------------------------------------------------- execution
def visible_fields(workflow: dict, answers: dict[str, Any]) -> list[str]:
    return [f["id"] for f in workflow["fields"] if evaluate(f.get("visible_if"), answers)]


def _is_required(field: dict, answers: dict[str, Any]) -> bool:
    if field.get("type") in INPUTLESS:
        return False
    if field.get("required"):
        return True
    return "required_if" in field and evaluate(field["required_if"], answers)


def _value_errors(field: dict, value: Any) -> list[str]:
    """Type and constraint checks for a non-empty value. Returns error codes."""
    t = field["type"]
    v = field.get("validation") or {}
    errs: list[str] = []
    if t in ("text", "multiline"):
        if not isinstance(value, str):
            return ["type"]
        if "min_length" in v and len(value) < v["min_length"]:
            errs.append("min_length")
        if "max_length" in v and len(value) > v["max_length"]:
            errs.append("max_length")
        if v.get("pattern") and len(v["pattern"]) <= MAX_PATTERN_LEN and not re.fullmatch(v["pattern"], value):
            errs.append("pattern")
    elif t == "number":
        n = _num(value)
        if n is None:
            return ["type"]
        if v.get("integer") and n != int(n):
            errs.append("integer")
        if "min" in v and n < v["min"]:
            errs.append("min")
        if "max" in v and n > v["max"]:
            errs.append("max")
    elif t == "date":
        if not isinstance(value, str) or not _DATE_RE.match(value):
            return ["type"]
    elif t == "time":
        if not isinstance(value, str) or not _TIME_RE.match(value):
            return ["type"]
    elif t == "checkbox":
        if not isinstance(value, bool):
            return ["type"]
    elif t == "single_choice":
        if value not in [o["value"] for o in field.get("options", [])]:
            return ["option"]
    elif t == "multi_choice":
        allowed = [o["value"] for o in field.get("options", [])]
        if not isinstance(value, list) or any(x not in allowed for x in value):
            return ["option"]
        if "min_items" in v and len(value) < v["min_items"]:
            errs.append("min_items")
        if "max_items" in v and len(value) > v["max_items"]:
            errs.append("max_items")
    elif t == "gps":
        if not isinstance(value, dict) or _num(value.get("lat")) is None or _num(value.get("lon")) is None:
            return ["type"]
        if not (-90 <= float(value["lat"]) <= 90 and -180 <= float(value["lon"]) <= 180):
            return ["range"]
        if "max_accuracy_m" in v and _num(value.get("accuracy")) is not None and float(value["accuracy"]) > v["max_accuracy_m"]:
            errs.append("accuracy")
    elif t in MEDIA_TYPES:
        items = value if isinstance(value, list) else [value]
        if not all(isinstance(x, dict) and x.get("attachment_id") for x in items):
            return ["type"]
        if "max_items" in v and len(items) > v["max_items"]:
            errs.append("max_items")
    return errs


def compute_state(workflow: dict, answers: dict[str, Any]) -> dict[str, Any]:
    """Visibility, requiredness and validation for the current answers.

    Hidden fields are never required or validated. ``errors`` maps field id to a sorted list
    of error codes; rule-level messages come back in ``messages``.
    """
    visible = visible_fields(workflow, answers)
    vis = set(visible)
    errors: dict[str, list[str]] = {}
    messages: dict[str, list[str]] = {}
    required: list[str] = []
    for f in workflow["fields"]:
        fid = f["id"]
        if fid not in vis or f["type"] in INPUTLESS:
            continue
        value = answers.get(fid)
        req = _is_required(f, answers)
        if req:
            required.append(fid)
        # A required checkbox means "answered" (True or False), never "must be True", so a
        # negative safety attestation can still be recorded and classified.
        if _is_empty(value):
            if req:
                errors[fid] = ["required"]
            continue
        errs = _value_errors(f, value)
        for rule in (f.get("validation") or {}).get("rules", []):
            if evaluate(rule.get("when"), answers):
                errs.append("rule")
                messages.setdefault(fid, []).append(text(rule.get("message", "Invalid value")))
        if errs:
            errors[fid] = sorted(set(errs))
    return {"visible": visible, "required": required, "errors": errors, "messages": messages,
            "complete": not errors}


def clean_answers(workflow: dict, answers: dict[str, Any]) -> dict[str, Any]:
    """Drop answers to hidden or unknown fields (stale branches) before saving."""
    vis = set(visible_fields(workflow, answers))
    return {k: v for k, v in answers.items() if k in vis}


# --------------------------------------------------------------------------- classification
