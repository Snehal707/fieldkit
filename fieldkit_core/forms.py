"""Observation forms written by Hermes: repair of unambiguous shape mistakes and precise, field-aware checks.

A form is a FieldKit workflow definition (``schema/workflow.schema.json``): fields with types, labels in the user's
languages, options, units, required/visible conditions and input validation. Forms only collect: FieldKit does not
classify, score or decide anything about an entry (Hermes analyses synced data when the user asks).
"""
from __future__ import annotations

import copy
import re
from typing import Any

from . import engine

FIELD_TYPES = ("text", "multiline", "number", "date", "time", "checkbox", "single_choice", "multi_choice", "photo", "gps",
               "audio", "signature", "instruction")
#: Keys of earlier form versions that no longer do anything. Stored versions keep them; new drafts drop them.
LEGACY_FORM_KEYS = ("classification", "knowledge_packs", "dictionary_packs", "analysis_instructions", "review_required")

HINTS = {
    "condition": "A condition is {\"op\": eq|neq|gt|gte|lt|lte|in|contains|exists|empty, \"field\": \"<field id>\", "
                 "\"value\": ...}, or {\"op\": \"and\", \"all\": [conditions]}, {\"op\": \"or\", \"any\": [conditions]}, "
                 "{\"op\": \"not\", \"cond\": condition}. 'in' takes a list value; exists/empty take no value.",
    "label": "Text is a string or an object of language → text, e.g. {\"en\": \"Notes\", \"hi\": \"टिप्पणी\"}.",
    "option": "Options are a list of {\"value\": \"minor\", \"label\": {\"en\": \"Minor\"}}; conditions compare against the value.",
    "field_type": "Field type is one of " + ", ".join(FIELD_TYPES) + ". Yes/no questions: checkbox (true/false) or "
                  "single_choice with yes/no options.",
}

EXAMPLE = {
    "id": "site-visit", "title": {"en": "Site visit"}, "languages": ["en"], "default_language": "en",
    "metadata": {"subject_field": "site_id"},
    "fields": [
        {"id": "site_id", "type": "text", "label": {"en": "Site / person / item ID"}, "required": True},
        {"id": "visit_date", "type": "date", "label": {"en": "Date"}, "required": True},
        {"id": "condition", "type": "single_choice", "label": {"en": "Overall condition"},
         "options": [{"value": "good", "label": {"en": "Good"}}, {"value": "fair", "label": {"en": "Fair"}},
                     {"value": "poor", "label": {"en": "Poor"}}]},
        {"id": "issues", "type": "multiline", "label": {"en": "Issues seen"},
         "visible_if": {"op": "in", "field": "condition", "value": ["fair", "poor"]}},
        {"id": "reading", "type": "number", "label": {"en": "Measurement"}, "unit": "°C",
         "validation": {"min": -50, "max": 150}},
        {"id": "photos", "type": "photo", "label": {"en": "Photos"}},
        {"id": "voice_note", "type": "audio", "label": {"en": "Voice note"}},
        {"id": "location", "type": "gps", "label": {"en": "Location"}},
        {"id": "notes", "type": "multiline", "label": {"en": "Notes"}},
    ],
}

RULES = ("Use the user's own words, units and categories; ask, never invent. Label text in every workspace language. "
         "Choice fields need options [{value, label}]. Conditions use field ids of the same form: numbers compare with "
         "numbers, checkbox with true/false, choices with an option value. Set metadata.subject_field to the field that "
         "identifies what an entry is about (a site, person, asset, plot...): a short text, number or choice question, never "
         "GPS or media. validation min/max block saving: use them only for values that cannot be entered at all (as the user "
         "said); never guess ranges. A normal, safe or expected range is not a limit (out-of-range readings must still be "
         "recordable): put it in the question's help text instead, e.g. \"Normal: 2-8 °C\". Notes and issues are "
         "ordinary fields (multiline text, choices). Media: photo, audio (voice note), gps; add a signature field only when "
         "the user asks for one (consent, sign-off).")

# ----------------------------------------------------------------------------- normalisation
_OPS = {"==": "eq", "=": "eq", "===": "eq", "equals": "eq", "equal": "eq", "is": "eq", "!=": "neq", "<>": "neq", "!==": "neq",
        "ne": "neq", "not_equals": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", "ge": "gte", "le": "lte",
        "&&": "and", "||": "or", "!": "not", "includes": "contains", "has": "contains", "is_empty": "empty",
        "not_empty": "exists", "is_set": "exists", "present": "exists", "one_of": "in", "any_of": "in"}
_VALID_OPS = {"eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "exists", "empty", "and", "or", "not", "always"}
_TYPE_ALIASES = {"select": "single_choice", "dropdown": "single_choice", "radio": "single_choice", "choice": "single_choice",
                 "single_select": "single_choice", "enum": "single_choice", "singlechoice": "single_choice",
                 "multiselect": "multi_choice", "multi_select": "multi_choice", "checkboxes": "multi_choice",
                 "multiple_choice": "multi_choice", "multichoice": "multi_choice",
                 "boolean": "checkbox", "bool": "checkbox", "toggle": "checkbox", "switch": "checkbox",
                 "integer": "number", "int": "number", "float": "number", "decimal": "number", "numeric": "number",
                 "textarea": "multiline", "long_text": "multiline", "paragraph": "multiline", "notes": "multiline",
                 "string": "text", "short_text": "text", "image": "photo", "camera": "photo", "picture": "photo",
                 "location": "gps", "geo": "gps", "geolocation": "gps", "voice": "audio", "recording": "audio",
                 "voice_note": "audio", "note": "instruction", "info": "instruction", "header": "instruction",
                 "heading": "instruction"}


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", str(s).strip().lower()).strip("_")[:64] or "option"


def normalize_condition(c: Any, fixes: list, path: str) -> Any:
    """Rewrite common condition dialects into FieldKit's AST. Unknown shapes are left for the schema to reject."""
    if isinstance(c, list) and c and all(isinstance(x, dict) for x in c):
        fixes.append(f"{path}: a list of conditions was combined with op 'and'")
        return {"op": "and", "all": [normalize_condition(x, fixes, f"{path}/all/{i}") for i, x in enumerate(c)]}
    if not isinstance(c, dict):
        return c
    c = dict(c)
    if "op" not in c and len(c) == 1:      # JSONLogic: {">": [{"var": "x"}, 3]}, {"and": [...]}, {"!": {...}}
        (k, v), = c.items()
        kk = _OPS.get(str(k).lower(), str(k).lower())
        if kk in ("and", "or") and isinstance(v, list):
            fixes.append(f"{path}: {{{k!r}: [...]}} → op '{kk}'")
            key = "all" if kk == "and" else "any"
            return {"op": kk, key: [normalize_condition(x, fixes, f"{path}/{key}/{i}") for i, x in enumerate(v)]}
        if kk == "not":
            fixes.append(f"{path}: {{{k!r}: ...}} → op 'not'")
            inner = v[0] if isinstance(v, list) and len(v) == 1 else v
            return {"op": "not", "cond": normalize_condition(inner, fixes, f"{path}/cond")}
        if kk in _VALID_OPS and isinstance(v, list) and len(v) == 2 and isinstance(v[0], dict) and "var" in v[0]:
            fixes.append(f"{path}: JSONLogic {{{k!r}: [{{var}}, value]}} → op '{kk}'")
            return {"op": kk, "field": v[0]["var"], "value": v[1]}
    for alt in ("operator", "operation", "type", "comparison"):
        if "op" not in c and isinstance(c.get(alt), str):
            c["op"] = c.pop(alt)
            fixes.append(f"{path}: '{alt}' renamed to 'op'")
    if isinstance(c.get("op"), str):
        o = c["op"].strip()
        n = _OPS.get(o.lower(), o.lower())
        if n != o:
            fixes.append(f"{path}: op {o!r} → {n!r}")
        c["op"] = n
    for alt in ("var", "key", "variable", "field_id", "name"):
        if "field" not in c and isinstance(c.get(alt), str) and c.get("op") not in ("and", "or", "not"):
            c["field"] = c.pop(alt)
            fixes.append(f"{path}: '{alt}' renamed to 'field'")
    for alt in ("values", "val", "equals", "threshold", "target"):
        if "value" not in c and alt in c and c.get("op") not in ("and", "or", "not", "exists", "empty"):
            c["value"] = c.pop(alt)
            fixes.append(f"{path}: '{alt}' renamed to 'value'")
    if c.get("op") in ("and", "or"):
        want = "all" if c["op"] == "and" else "any"
        wrong = "any" if want == "all" else "all"
        for alt in ("conditions", "args", "items", "rules", "operands", "clauses", wrong):
            if want not in c and isinstance(c.get(alt), list):
                c[want] = c.pop(alt)
                fixes.append(f"{path}: '{alt}' renamed to '{want}'")
        if isinstance(c.get(want), list):
            c[want] = [normalize_condition(x, fixes, f"{path}/{want}/{i}") for i, x in enumerate(c[want])]
    if c.get("op") == "not":
        for alt in ("condition", "operand", "not", "arg"):
            if "cond" not in c and alt in c:
                c["cond"] = c.pop(alt)
                fixes.append(f"{path}: '{alt}' renamed to 'cond'")
        if isinstance(c.get("cond"), list) and len(c["cond"]) == 1:
            c["cond"] = c["cond"][0]
        if "cond" in c:
            c["cond"] = normalize_condition(c["cond"], fixes, f"{path}/cond")
    if c.get("op") == "in" and "value" in c and not isinstance(c["value"], list):
        c["value"] = [c["value"]]
        fixes.append(f"{path}: 'in' value wrapped in a list")
    if c.get("op") in ("exists", "empty") and "value" in c:
        c.pop("value")
        fixes.append(f"{path}: '{c['op']}' takes no value; removed")
    return c


def _norm_options(opts: Any, fixes: list, path: str) -> Any:
    if not isinstance(opts, list):
        return opts
    out = []
    for i, o in enumerate(opts):
        if isinstance(o, (str, int, float)) and not isinstance(o, bool):
            out.append({"value": o, "label": str(o)})
            fixes.append(f"{path}/{i}: plain option {o!r} → {{value, label}}")
        elif isinstance(o, dict):
            o = dict(o)
            if "value" not in o:
                for alt in ("id", "key", "code", "name"):
                    if alt in o:
                        o["value"] = o.pop(alt)
                        fixes.append(f"{path}/{i}: '{alt}' renamed to 'value'")
                        break
            if "label" not in o:
                for alt in ("text", "title", "name", "display"):
                    if alt in o:
                        o["label"] = o.pop(alt)
                        fixes.append(f"{path}/{i}: '{alt}' renamed to 'label'")
                        break
            if "value" in o and "label" not in o:
                o["label"] = str(o["value"])
                fixes.append(f"{path}/{i}: label copied from value")
            if "label" in o and "value" not in o and isinstance(o["label"], str):
                o["value"] = _slug(o["label"])
                fixes.append(f"{path}/{i}: value derived from label ({o['value']!r})")
            out.append(o)
        else:
            out.append(o)
    return out


def _norm_field(f: Any, fixes: list, path: str) -> Any:
    if not isinstance(f, dict):
        return f
    f = dict(f)
    if "id" not in f and isinstance(f.get("name"), str):
        f["id"] = f.pop("name")
        fixes.append(f"{path}: 'name' renamed to 'id'")
    if "label" not in f:
        for alt in ("question", "title", "prompt", "text"):
            if alt in f:
                f["label"] = f.pop(alt)
                fixes.append(f"{path}: '{alt}' renamed to 'label'")
                break
    t = f.get("type")
    if isinstance(t, str) and t not in FIELD_TYPES:
        low = t.strip().lower().replace("-", "_")
        if low in ("yes_no", "yesno", "yes/no"):
            f["type"] = "single_choice"
            f.setdefault("options", [{"value": "yes", "label": {"en": "Yes", "hi": "हाँ"}},
                                     {"value": "no", "label": {"en": "No", "hi": "नहीं"}}])
            fixes.append(f"{path}: type {t!r} → single_choice with yes/no options (compare with \"yes\"/\"no\")")
        elif low in _TYPE_ALIASES:
            f["type"] = _TYPE_ALIASES[low]
            if low in ("integer", "int"):
                f.setdefault("validation", {})["integer"] = True
            fixes.append(f"{path}: type {t!r} → {f['type']!r}")
    for alt in ("choices", "values", "enum"):
        if "options" not in f and isinstance(f.get(alt), list):
            f["options"] = f.pop(alt)
            fixes.append(f"{path}: '{alt}' renamed to 'options'")
    if "options" in f:
        f["options"] = _norm_options(f["options"], fixes, f"{path}/options")
    if isinstance(f.get("required"), str):
        f["required"] = f["required"].strip().lower() in ("true", "yes", "1")
        fixes.append(f"{path}: required → boolean")
    v = f.get("validation")
    if isinstance(v, dict):
        v = dict(v)
        for a, b in (("minimum", "min"), ("maximum", "max"), ("minLength", "min_length"), ("maxLength", "max_length")):
            if a in v and b not in v:
                v[b] = v.pop(a)
                fixes.append(f"{path}/validation: '{a}' → '{b}'")
        for r_i, r in enumerate(v.get("rules") or []):
            if isinstance(r, dict) and "when" in r:
                r["when"] = normalize_condition(r["when"], fixes, f"{path}/validation/rules/{r_i}/when")
        f["validation"] = v
    for key in ("min", "max"):
        if key in f and f.get("type") == "number":
            f.setdefault("validation", {})[key] = f.pop(key)
            fixes.append(f"{path}: '{key}' moved into validation")
    for k in ("visible_if", "required_if"):
        if k in f:
            f[k] = normalize_condition(f[k], fixes, f"{path}/{k}")
    return f


def normalize_form(form: Any) -> tuple[Any, list[str]]:
    """Repair unambiguous shape mistakes and drop keys that no longer do anything. Returns (form, fixes)."""
    fixes: list[str] = []
    if not isinstance(form, dict):
        return form, fixes
    w = copy.deepcopy(form)
    if isinstance(w.get("fields"), list):
        w["fields"] = [_norm_field(f, fixes, f"fields/{i}") for i, f in enumerate(w["fields"])]
    for k in LEGACY_FORM_KEYS:
        if k in w:
            w.pop(k)
            fixes.append(f"'{k}' removed: FieldKit forms only collect (Hermes analyses entries when asked)")
    for k in ("status", "version"):
        w.pop(k, None)
    return w, fixes


# ----------------------------------------------------------------------------- checking
def _field_kinds(form: dict) -> dict:
    out = {}
    for f in form.get("fields") or []:
        if not isinstance(f, dict) or not f.get("id"):
            continue
        opts = [o.get("value") for o in f.get("options") or [] if isinstance(o, dict)]
        kind = {"number": "number", "checkbox": "bool", "single_choice": "choice", "multi_choice": "multi", "date": "date",
                "time": "date", "text": "text", "multiline": "text"}.get(f.get("type"), "media")
        out[f["id"]] = (kind, opts)
    return out


def condition_type_errors(cond: Any, kinds: dict, path: str) -> list[dict]:
    """Field-aware checks: unknown fields, numbers vs text, checkbox vs true/false, choice values vs options."""
    errs: list[dict] = []

    def err(p: str, m: str) -> None:
        errs.append({"path": p, "error": m, "hint": HINTS["condition"]})

    def walk(c: Any, p: str) -> None:
        if not isinstance(c, dict):
            return
        op = c.get("op")
        for k in ("all", "any"):
            for i, x in enumerate(c.get(k) or []):
                walk(x, f"{p}/{k}/{i}")
        if "cond" in c:
            walk(c["cond"], f"{p}/cond")
        f = c.get("field")
        if op in ("and", "or", "not", "always") or not isinstance(f, str):
            return
        if f not in kinds:
            err(p, f"unknown field {f!r}; known: {sorted(kinds)[:30]}")
            return
        kind, opts = kinds[f]
        v = c.get("value")
        if op in ("exists", "empty"):
            return
        if kind == "media":
            err(p, f"{f!r} is a photo/audio/signature/gps/instruction field; only exists/empty can test it")
        elif op in ("gt", "gte", "lt", "lte"):
            if kind == "number" and (isinstance(v, bool) or not isinstance(v, (int, float))):
                err(p, f"{f!r} is a number; compare it with a number, not {v!r}")
            elif kind not in ("number", "date"):
                err(p, f"{op} needs a number or date field; {f!r} is {kind}")
        elif op in ("eq", "neq"):
            if kind == "number" and (isinstance(v, bool) or not isinstance(v, (int, float))):
                err(p, f"{f!r} is a number; compare it with a number, not {v!r}")
            elif kind == "bool" and not isinstance(v, bool):
                err(p, f"{f!r} is yes/no (checkbox); compare with true or false, not {v!r}")
            elif kind == "choice" and opts and v not in opts:
                err(p, f"{v!r} is not an option value of {f!r}; options are {opts}")
            elif kind == "multi":
                err(p, f"{f!r} allows several answers; use op 'contains' with one option value")
        elif op == "in":
            if not isinstance(v, list):
                err(p, "'in' needs a list value")
            elif kind in ("choice", "multi") and opts and any(x not in opts for x in v):
                err(p, f"values {[x for x in v if x not in opts]} are not options of {f!r}; options are {opts}")
        elif op == "contains":
            if kind == "multi" and opts and v not in opts:
                err(p, f"{v!r} is not an option value of {f!r}; options are {opts}")
            elif kind in ("number", "bool"):
                err(p, f"'contains' does not apply to {kind} field {f!r}")
    walk(cond, path)
    return errs


def _hint(path: str, message: str) -> str:
    keys = path.split("/")
    if any(k in ("visible_if", "required_if", "when", "cond", "all", "any") for k in keys):
        return HINTS["condition"]
    if "options" in keys:
        return HINTS["option"]
    if keys and keys[-1] == "type":
        return HINTS["field_type"]
    if keys and keys[-1] in ("label", "title", "help", "description"):
        return HINTS["label"]
    return ""


def check_form(form: Any) -> list[dict]:
    """Schema problems (with a JSON path and a fix hint) plus field-aware condition checks."""
    errs = [{"path": p["path"], "error": p["message"], "hint": _hint(p["path"], p["message"])}
            for p in engine.validate_definition(form)]
    if not isinstance(form, dict):
        return errs
    kinds = _field_kinds(form)
    for i, f in enumerate(form.get("fields") or []):
        if not isinstance(f, dict):
            continue
        for k in ("visible_if", "required_if"):
            if k in f:
                errs += condition_type_errors(f[k], kinds, f"fields/{i}/{k}")
        for j, r in enumerate((f.get("validation") or {}).get("rules") or []):
            if isinstance(r, dict):
                errs += condition_type_errors(r.get("when"), kinds, f"fields/{i}/validation/rules/{j}/when")
    sf = (form.get("metadata") or {}).get("subject_field")
    if sf and sf not in kinds:
        errs.append({"path": "metadata/subject_field", "error": f"{sf!r} is not a field of this form", "hint": ""})
    elif sf and (types := {f.get("id"): f.get("type") for f in form.get("fields") or [] if isinstance(f, dict)}).get(sf) in (
            "gps", "photo", "audio", "signature", "multiline"):
        errs.append({"path": "metadata/subject_field", "error": f"subject field {sf!r} is a {types[sf]} question",
                     "hint": "the subject must name what an entry is about (a code, name, site or ID the user can search "
                             "for): use a short text, number or choice question"})
    return errs


def format_doc() -> dict:
    """What fieldkit_workspace_format returns: the form schema, a valid example and the rules."""
    schema = {k: v for k, v in engine._schema().items() if k != "$id"}
    return {"rules": RULES, "field_types": list(FIELD_TYPES), "example_form": EXAMPLE, "form_schema": schema,
            "workspace": {"workspace_id": "lowercase slug, 2-48 chars", "title": "{lang: text}", "purpose": "one sentence in "
                          "the user's words", "languages": "[\"en\"] or [\"en\", \"hi\"] (the phone app supports English and Hindi)",
                          "forms": "list of forms like example_form (send the WHOLE form when changing it)"}}
