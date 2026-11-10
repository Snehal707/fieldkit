"""Schema-aware workspace building (0.2.6).

Hermes builds a workspace in small, separately checked parts instead of one huge bundle:
sources → evidence → report_policy → workflows → guides → knowledge → vocabulary → intents → gaps → traceability.

For every part this module provides
  * a strict JSON Schema (Draft 2020-12) that Hermes reads before writing (``part_schema``),
  * a small valid example (``EXAMPLES``; tests prove each example passes),
  * ``normalize``: deterministic repair of unambiguous shape mistakes (e.g. ``"options": ["Yes", "No"]``,
    ``"type": "select"``, ``{"op": ">"}``), each reported back so the model learns the correct form,
  * ``check_item``: schema errors with a JSON path and a fix hint, plus cross-reference and type checks against
    the rest of the draft (unknown evidence ids, unknown fields, a number compared with text, a choice value that is
    not an option, an outcome decision missing from the decision scale...).

Nothing here decides evidence status; ``workspace.validate_bundle`` still computes it from the sources.
"""
from __future__ import annotations

import copy
import re
from typing import Any

from . import engine
from .workspace import GUIDANCE_ENTRY_TYPES, SOURCE_TYPES, STATUS_RANK

PARTS = ("sources", "evidence", "report_policy", "workflows", "guides", "knowledge", "vocabulary", "intents", "gaps",
         "traceability")
# The phone's offline assistant only understands these intent ids (app/src/assistant_intents.ts).
INTENT_IDS = ("explain_issue", "what_next", "why", "is_it_safe", "how_to", "troubleshoot", "define_term",
              "check_requirement", "explain_report", "compare_to_previous", "translate")
FIELD_TYPES = ("text", "multiline", "number", "date", "time", "checkbox", "single_choice", "multi_choice", "photo", "gps",
               "audio", "signature", "instruction")
ENTRY_TYPES = ("explanation", "procedure", "faq", "troubleshooting", "term", "reference")
GUIDE_INPUTS = ("yes_no", "choice", "number", "text")
SEVERITIES = ("info", "low", "medium", "high", "critical")

ID = {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$"}
SLOT = {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$"}
IDS = {"type": "array", "items": ID, "maxItems": 50}
STR = {"type": "string", "minLength": 1}

HINTS = {
    "condition": "A condition is {\"op\": eq|neq|gt|gte|lt|lte|in|contains|exists|empty, \"field\": \"<field or slot id>\", "
                 "\"value\": ...}, or {\"op\": \"and\", \"all\": [conditions]}, {\"op\": \"or\", \"any\": [conditions]}, "
                 "{\"op\": \"not\", \"cond\": condition}. 'in' takes a list value; exists/empty take no value.",
    "label": "Text is a string or an object of language → text, e.g. {\"en\": \"Fat (%)\", \"hi\": \"वसा (%)\"}.",
    "option": "Options are a list of {\"value\": \"cow\", \"label\": {\"en\": \"Cow\", \"hi\": \"गाय\"}}; conditions compare "
              "against the value.",
    "field_type": "Field type is one of " + ", ".join(FIELD_TYPES) + ". Yes/no questions: checkbox (true/false) or "
                  "single_choice with yes/no options.",
    "node": "A guide's nodes is an object keyed by node id. Question node: {\"slot\": \"snake_case\", \"field\"?: "
            "\"<workflow field id to read from the record>\", \"question\"?: {lang: text}, \"input\": yes_no|choice|number|text, "
            "\"options\"?: [{value, label}], \"next\": [{\"when\": condition, \"to\": \"<node id>\"}], \"default\": \"<node id>\"}. "
            "Outcome node: {\"outcome\": {\"decision\": \"<decision_scale id>\", \"title\": {lang: text}, \"actions\": "
            "[{\"text\": {lang: text}, \"evidence_ids\": [...]} or {\"kind\": \"escalate\", \"text\": {...}}], \"escalate_to\"?: \"role\"}}.",
    "excerpt": "Excerpts are [{\"source_id\": \"<an id from sources>\", \"quote\": \"exact sentence(s) copied from the page, "
               "≥20 chars\", \"locator\": \"section / clause / page\"}].",
    "evidence_ids": "evidence_ids is a list of ids of evidence items you already added, e.g. [\"ev_snf_cow\"].",
}


# ----------------------------------------------------------------------------- schemas
def _defs() -> dict:
    return copy.deepcopy(engine._schema()["$defs"])


def _refs(node: Any, out: set) -> set:
    if isinstance(node, dict):
        r = node.get("$ref")
        if isinstance(r, str) and r.startswith("#/$defs/"):
            out.add(r.rsplit("/", 1)[1])
        for v in node.values():
            _refs(v, out)
    elif isinstance(node, list):
        for v in node:
            _refs(v, out)
    return out


def _with_defs(item: dict) -> dict:
    """The item schema plus only the shared definitions it uses (keeps tool results small for long chats)."""
    defs = _defs()
    need, todo = set(), _refs(item, set())
    while todo:
        n = todo.pop()
        if n in need or n not in defs:
            continue
        need.add(n)
        todo |= _refs(defs[n], set()) - need
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": {k: defs[k] for k in sorted(need)}, **item}


LABEL = {"$ref": "#/$defs/label"}
COND = {"$ref": "#/$defs/condition"}

SOURCE = {
    "type": "object", "required": ["id", "title", "type"], "additionalProperties": False,
    "properties": {"id": ID, "url": {"type": "string", "maxLength": 2000}, "title": STR, "publisher": {"type": "string"},
                   "type": {"enum": list(SOURCE_TYPES)}, "published_at": {"type": "string"}, "retrieved_at": {"type": "string"},
                   "language": {"type": "string"}, "notes": {"type": "string"}},
    "if": {"properties": {"type": {"not": {"enum": ["user_document", "user_statement"]}}}}, "then": {"required": ["url"]},
}
EVIDENCE = {
    "type": "object", "required": ["id", "claim", "applicability"], "additionalProperties": False,
    "properties": {
        "id": ID, "claim": STR,
        "excerpts": {"type": "array", "items": {
            "type": "object", "required": ["source_id", "quote"], "additionalProperties": False,
            "properties": {"source_id": ID, "quote": {"type": "string", "minLength": 3, "maxLength": 3000},
                           "locator": {"type": "string"}, "language": {"type": "string"},
                           "check": {"type": "string"}, "check_note": {"type": "string"}}}},
        "applicability": {"type": "object", "required": ["matches_profile"], "additionalProperties": False,
                          "properties": {"jurisdiction": {"type": "string"}, "industry": {"type": "string"},
                                         "subject": {"type": "string"}, "matches_profile": {"type": "boolean"},
                                         "notes": {"type": "string"}}},
        "conflicts": {"type": "array", "items": {"type": "object", "required": ["source_id", "claim"], "additionalProperties": False,
                                                 "properties": {"source_id": ID, "claim": STR, "quote": {"type": "string"},
                                                                "locator": {"type": "string"}}}},
        "user_procedure": {"type": "boolean"},
        # Written only by FieldKit's learning loop (learning.decide); the build tools refuse them from Hermes.
        "local_practice": {"type": "boolean"}, "outcomes": {"type": "object"},
    },
}
REPORT_POLICY = {
    "type": "object", "required": ["decision_scale"], "additionalProperties": False,
    "properties": {
        "decision_scale": {"type": "array", "minItems": 2, "items": {
            "type": "object", "required": ["id", "label", "severity"], "additionalProperties": False,
            "properties": {"id": SLOT, "label": LABEL, "severity": {"enum": list(SEVERITIES)}, "description": LABEL}}},
        "after_sync": {"enum": ["save", "summarize", "analyze"]},
        "review_triggers": {"type": "array", "items": {"type": ["string", "object"]}},
        "escalation_rules": {"type": "array", "items": {"type": ["string", "object"]}},
    },
}
QUESTION_NODE = {
    "type": "object", "required": ["slot"], "additionalProperties": False,
    "properties": {"slot": SLOT, "field": SLOT, "question": LABEL, "help": LABEL, "input": {"enum": list(GUIDE_INPUTS)},
                   "unit": {"type": "string"}, "options": {"type": "array", "items": {"$ref": "#/$defs/option"}},
                   "next": {"type": "array", "items": {"type": "object", "required": ["to"], "additionalProperties": False,
                                                       "properties": {"when": COND, "to": ID}}},
                   "default": ID},
}
OUTCOME_NODE = {
    "type": "object", "required": ["outcome"], "additionalProperties": False,
    "properties": {"outcome": {
        "type": "object", "required": ["decision", "title"], "additionalProperties": False,
        "properties": {"decision": SLOT, "title": LABEL, "summary": LABEL, "escalate_to": {"type": "string"}, "evidence_ids": IDS,
                       "actions": {"type": "array", "items": {
                           "type": "object", "required": ["text"], "additionalProperties": False,
                           "properties": {"text": LABEL, "evidence_ids": IDS, "kind": {"enum": ["action", "escalate"]},
                                          "due": {"type": "string"}, "verify": LABEL}}}}}},
}
GUIDE = {
    "type": "object", "required": ["id", "title", "start", "nodes"], "additionalProperties": False,
    "properties": {"id": ID, "title": LABEL, "description": LABEL, "workflow_id": {"$ref": "#/$defs/slug"}, "start": ID,
                   "evidence_ids": IDS,
                   "nodes": {"type": "object", "minProperties": 1, "propertyNames": ID,
                             "additionalProperties": {"if": {"required": ["outcome"]}, "then": OUTCOME_NODE, "else": QUESTION_NODE}}},
}
KNOWLEDGE = {
    "type": "object", "required": ["id", "type", "title", "text"], "additionalProperties": False,
    "properties": {"id": ID, "type": {"enum": list(ENTRY_TYPES)}, "title": LABEL, "text": LABEL, "evidence_ids": IDS,
                   "learned": {"type": "boolean"},
                   "keywords": {"type": "array", "items": {"type": "string"}}, "tags": {"type": "array", "items": {"type": "string"}}},
}
VOCABULARY = {
    "type": "object", "required": ["term", "lang", "definition"], "additionalProperties": False,
    "properties": {"term": STR, "lang": {"$ref": "#/$defs/lang"}, "definition": STR,
                   "translations": {"type": "object", "additionalProperties": {"type": "string"}},
                   "synonyms": {"type": "array", "items": {"type": "string"}}},
}
INTENT = {
    "type": "object", "required": ["id", "examples"], "additionalProperties": False,
    "properties": {"id": {"enum": list(INTENT_IDS)},
                   "examples": {"type": "object", "minProperties": 1, "propertyNames": {"$ref": "#/$defs/lang"},
                                "additionalProperties": {"type": "array", "minItems": 1, "items": STR}}},
}
GAP = {
    "type": "object", "required": ["topic", "note"], "additionalProperties": False,
    "properties": {"topic": STR, "searched": {"type": "array", "items": {"type": "string"}}, "note": STR,
                   "suggestion": {"type": "string"}},
}
TRACE = {
    "type": "object", "required": ["responsibility_id"], "additionalProperties": False,
    "properties": {"responsibility_id": {"type": "string"}, "workflow_ids": IDS, "guide_ids": IDS, "entry_ids": IDS},
}
ITEM_SCHEMAS = {"sources": SOURCE, "evidence": EVIDENCE, "report_policy": REPORT_POLICY, "guides": GUIDE,
                "knowledge": KNOWLEDGE, "vocabulary": VOCABULARY, "intents": INTENT, "gaps": GAP, "traceability": TRACE}


def part_schema(part: str) -> dict:
    """The JSON Schema for ONE item of a part (workflows: the FieldKit workflow schema)."""
    if part == "workflows":
        s = engine._schema()
        return {k: v for k, v in s.items() if k != "$id"}
    return _with_defs(ITEM_SCHEMAS[part])


def item_key(part: str, item: Any) -> str:
    if not isinstance(item, dict):
        return "?"
    if part == "report_policy":
        return "report_policy"
    if part == "vocabulary":
        return f"{item.get('term', '?')}|{item.get('lang', '?')}"
    if part == "gaps":
        return str(item.get("topic") or "?")[:80]
    if part == "traceability":
        return str(item.get("responsibility_id") or "?")
    return str(item.get("id") or "?")


# ----------------------------------------------------------------------------- examples (proved valid in tests)
EXAMPLES: dict[str, Any] = {
    "sources": {"id": "s_fssai_dairy", "url": "https://www.fssai.gov.in/upload/uploadfiles/files/Compendium_Dairy.pdf",
                "title": "Food Safety and Standards (Food Products Standards) Regulations — milk and milk products",
                "publisher": "FSSAI", "type": "regulator", "retrieved_at": "2026-11-10"},
    "evidence": {"id": "ev_cow_snf", "claim": "Cow milk must have at least 8.5% milk solids-not-fat",
                 "excerpts": [{"source_id": "s_fssai_dairy", "quote": "<copy the exact sentence or table row from the page>",
                               "locator": "Appendix B, 2.1.2, table row 'Cow Milk'"}],
                 "applicability": {"jurisdiction": "IN (all states)", "subject": "raw cow milk", "matches_profile": True,
                                   "notes": "Applies to milk sold or collected for sale."}},
    "report_policy": {"decision_scale": [
        {"id": "reject", "label": {"en": "Reject", "hi": "अस्वीकार"}, "severity": "high"},
        {"id": "retest", "label": {"en": "Re-test", "hi": "दोबारा जाँच"}, "severity": "medium"},
        {"id": "accept", "label": {"en": "Accept", "hi": "स्वीकार"}, "severity": "low"}],
        "review_triggers": ["any reading below a legal minimum"], "escalation_rules": ["adulteration suspected → centre manager"]},
    "workflows": {"id": "milk-collection-check", "title": {"en": "Milk collection check", "hi": "दूध संग्रह जाँच"},
                  "languages": ["en", "hi"], "default_language": "en", "fields": [
                      {"id": "farmer_code", "type": "text", "label": {"en": "Farmer code", "hi": "किसान कोड"}, "required": True},
                      {"id": "milk_type", "type": "single_choice", "label": {"en": "Milk", "hi": "दूध"}, "required": True,
                       "options": [{"value": "cow", "label": {"en": "Cow", "hi": "गाय"}},
                                   {"value": "buffalo", "label": {"en": "Buffalo", "hi": "भैंस"}}]},
                      {"id": "snf_pct", "type": "number", "unit": "%", "label": {"en": "SNF (%)", "hi": "SNF (%)"},
                       "required": True, "validation": {"min": 0, "max": 15}},
                      {"id": "smell_ok", "type": "checkbox", "label": {"en": "Smell and colour normal", "hi": "गंध और रंग सामान्य"}},
                      {"id": "sample_photo", "type": "photo", "label": {"en": "Photo of the reading", "hi": "रीडिंग की फोटो"}}],
                  "classification": {"rules": [
                      {"id": "cow_snf_low", "label": {"en": "SNF below the legal minimum", "hi": "SNF कानूनी न्यूनतम से कम"},
                       "severity": "high", "evidence_ids": ["ev_cow_snf"],
                       "when": {"op": "and", "all": [{"op": "eq", "field": "milk_type", "value": "cow"},
                                                     {"op": "lt", "field": "snf_pct", "value": 8.5}]}},
                      {"id": "smell_off", "label": {"en": "Abnormal smell or colour", "hi": "असामान्य गंध या रंग"},
                       "severity": "medium", "when": {"op": "eq", "field": "smell_ok", "value": False}}]}},
    "guides": {"id": "g_accept", "title": {"en": "Accept, re-test or reject", "hi": "स्वीकार, दोबारा जाँच या अस्वीकार"},
               "workflow_id": "milk-collection-check", "start": "n_snf", "nodes": {
                   "n_snf": {"slot": "snf_pct", "field": "snf_pct", "input": "number",
                             "next": [{"when": {"op": "lt", "field": "snf_pct", "value": 8.5}, "to": "n_retested"}],
                             "default": "o_accept"},
                   "n_retested": {"slot": "retested", "input": "yes_no",
                                  "question": {"en": "Was the sample mixed and re-tested?", "hi": "क्या नमूना मिलाकर दोबारा जाँचा गया?"},
                                  "next": [{"when": {"op": "eq", "field": "retested", "value": True}, "to": "o_reject"}],
                                  "default": "o_retest"},
                   "o_retest": {"outcome": {"decision": "retest", "title": {"en": "Re-test once", "hi": "एक बार दोबारा जाँचें"},
                                            "actions": [{"kind": "escalate", "text": {"en": "Mix and re-test; if still low, ask the centre manager",
                                                                                     "hi": "मिलाकर दोबारा जाँचें; फिर भी कम हो तो केंद्र प्रबंधक से पूछें"}}]}},
                   "o_reject": {"outcome": {"decision": "reject", "title": {"en": "Reject", "hi": "अस्वीकार करें"}, "actions": [
                       {"text": {"en": "Reject the milk and record the reading", "hi": "दूध अस्वीकार करें और रीडिंग लिखें"},
                        "evidence_ids": ["ev_cow_snf"]}]}},
                   "o_accept": {"outcome": {"decision": "accept", "title": {"en": "Accept", "hi": "स्वीकार करें"}, "actions": [
                       {"text": {"en": "Accept the milk", "hi": "दूध स्वीकार करें"}, "evidence_ids": ["ev_cow_snf"]}]}}}},
    "knowledge": {"id": "k_snf_limit", "type": "explanation", "evidence_ids": ["ev_cow_snf"],
                  "title": {"en": "Minimum SNF for cow milk", "hi": "गाय के दूध में न्यूनतम SNF"},
                  "text": {"en": "Cow milk must have at least 8.5% SNF.", "hi": "गाय के दूध में कम से कम 8.5% SNF होना चाहिए।"}},
    "vocabulary": {"term": "SNF", "lang": "en", "definition": "Solids-not-fat: milk solids other than fat",
                   "translations": {"hi": "वसा-रहित ठोस"}, "synonyms": ["solids not fat"]},
    "intents": {"id": "check_requirement", "examples": {"en": ["What is the minimum SNF for cow milk?"],
                                                         "hi": ["गाय के दूध में न्यूनतम SNF कितना है?"]}},
    "gaps": {"topic": "Maharashtra-specific collection rules", "searched": ["Maharashtra dairy development milk collection SNF"],
             "note": "No state rule found beyond the national standard.", "suggestion": "Ask the union office for its SOP."},
    "traceability": {"responsibility_id": "r_accept", "workflow_ids": ["milk-collection-check"], "guide_ids": ["g_accept"],
                     "entry_ids": ["k_snf_limit"]},
}

RULES = {
    "sources": "type is one of " + ", ".join(SOURCE_TYPES) + ". For the user's own rules use one source "
               "{\"id\": \"s_user\", \"type\": \"user_statement\", \"title\": \"Stated by the user in the setup interview\"} "
               "(no url). Forums, Q&A, social media and unattributed blogs are excluded. 'regulator'/'government' on a "
               "non-official domain is downgraded. url is required except for user_document and user_statement. Add only "
               "pages/documents you actually opened.",
    "evidence": "Each excerpt quote must be copied verbatim from the page you opened with web_extract (FieldKit re-fetches "
                "web pages in the background and drops quotes it cannot find; PDFs are read with Hermes' extractor). source_id must be "
                "added in sources first. Do NOT send a status: FieldKit computes it. If sources disagree, add conflicts. "
                "Model knowledge without a quote = no excerpts → 'unverified' (background only).",
    "report_policy": "One object. 2+ decisions ordered from most to least severe; decision ids are snake_case and are what "
                     "guide outcomes and reports use. after_sync: leave it out (or 'save') so records only "
                     "sync and Hermes helps when asked; set 'analyze' only if the user wants Hermes to review every record.",
    "workflows": "Use the user's units and terms. Choice fields need options [{value, label}]. Conditions use field ids of "
                 "this workflow; numbers are compared with numbers, checkbox with true/false, choices with an option value. "
                 "Classification rules with thresholds cite evidence_ids (evidence must be at least 'supported').",
    "guides": "Every question node needs a slot, and either a field (read from the record) or a question. Conditions may use "
              "slots of this guide and fields of its workflow. Every path ends in an outcome whose decision is in the "
              "decision_scale. Every outcome action cites supported evidence, or is {\"kind\": \"escalate\"}. No cycles.",
    "knowledge": "procedure and troubleshooting entries need evidence that is at least 'supported'. Write text in every "
                 "content language.",
    "vocabulary": "One entry per term and language; definition required.",
    "intents": "Optional extra example questions for the phone's offline assistant. id must be one of: " + ", ".join(INTENT_IDS) + ".",
    "gaps": "Everything you searched for but could not find an authoritative source for.",
    "traceability": "One per responsibility in the confirmed brief; each must point at a workflow, guide or knowledge entry.",
}


# ----------------------------------------------------------------------------- normalisation
_OPS = {"==": "eq", "=": "eq", "===": "eq", "equals": "eq", "equal": "eq", "is": "eq", "!=": "neq", "<>": "neq", "!==": "neq",
        "ne": "neq", "not_equals": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", "ge": "gte", "le": "lte",
        "&&": "and", "||": "or", "!": "not", "includes": "contains", "has": "contains", "is_empty": "empty",
        "not_empty": "exists", "is_set": "exists", "present": "exists", "one_of": "in", "any_of": "in"}
_VALID_OPS = {"eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "exists", "empty", "and", "or", "not", "always"}
_FIELD_TYPES = {"select": "single_choice", "dropdown": "single_choice", "radio": "single_choice", "choice": "single_choice",
                "single_select": "single_choice", "enum": "single_choice", "singlechoice": "single_choice",
                "multiselect": "multi_choice", "multi_select": "multi_choice", "checkboxes": "multi_choice",
                "multiple_choice": "multi_choice", "multichoice": "multi_choice",
                "boolean": "checkbox", "bool": "checkbox", "toggle": "checkbox", "switch": "checkbox",
                "integer": "number", "int": "number", "float": "number", "decimal": "number", "numeric": "number",
                "textarea": "multiline", "long_text": "multiline", "paragraph": "multiline", "notes": "multiline",
                "string": "text", "short_text": "text", "image": "photo", "camera": "photo", "picture": "photo",
                "location": "gps", "geo": "gps", "geolocation": "gps", "voice": "audio", "recording": "audio",
                "voice_note": "audio", "note": "instruction", "info": "instruction", "header": "instruction", "heading": "instruction"}
_INPUTS = {"boolean": "yes_no", "bool": "yes_no", "yesno": "yes_no", "yes/no": "yes_no", "checkbox": "yes_no",
           "select": "choice", "single_choice": "choice", "dropdown": "choice", "radio": "choice", "enum": "choice",
           "numeric": "number", "integer": "number", "float": "number", "decimal": "number", "string": "text", "free_text": "text"}
_DROP_LABELS = ("status", "evidence_status", "computed_status", "tier")   # FieldKit computes these; never trusted from input


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
    # JSONLogic: {">": [{"var": "x"}, 3]}, {"and": [...]}, {"!": {...}}
    if "op" not in c and len(c) == 1:
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
    for alt in ("var", "slot", "key", "variable", "field_id", "name"):
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
            out.append({"value": o if not isinstance(o, str) else o, "label": str(o)})
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
        n = _FIELD_TYPES.get(t.strip().lower().replace("-", "_"))
        if t.strip().lower() in ("yes_no", "yesno", "yes/no"):
            f["type"] = "single_choice"
            f.setdefault("options", [{"value": "yes", "label": {"en": "Yes", "hi": "हाँ"}},
                                     {"value": "no", "label": {"en": "No", "hi": "नहीं"}}])
            fixes.append(f"{path}: type {t!r} → single_choice with yes/no options (compare with \"yes\"/\"no\")")
        elif n:
            f["type"] = n
            if t.strip().lower() in ("integer", "int"):
                f.setdefault("validation", {})["integer"] = True
            fixes.append(f"{path}: type {t!r} → {n!r}")
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
    for alt, key in (("min", "min"), ("max", "max")):
        if alt in f and f.get("type") == "number":
            f.setdefault("validation", {})[key] = f.pop(alt)
            fixes.append(f"{path}: '{alt}' moved into validation")
    for k in ("visible_if", "required_if"):
        if k in f:
            f[k] = normalize_condition(f[k], fixes, f"{path}/{k}")
    return f


def _norm_workflow(w: dict, fixes: list) -> dict:
    w = dict(w)
    if isinstance(w.get("fields"), list):
        w["fields"] = [_norm_field(f, fixes, f"fields/{i}") for i, f in enumerate(w["fields"])]
    cls = w.get("classification")
    if isinstance(cls, list):
        w["classification"] = cls = {"rules": cls}
        fixes.append("classification: a list was taken as classification.rules")
    if isinstance(cls, dict):
        cls = w["classification"] = dict(cls)
        for i, r in enumerate(cls.get("rules") or []):
            if isinstance(r, dict):
                for alt in ("condition", "if", "where"):
                    if "when" not in r and alt in r:
                        r["when"] = r.pop(alt)
                        fixes.append(f"classification/rules/{i}: '{alt}' renamed to 'when'")
                if "when" in r:
                    r["when"] = normalize_condition(r["when"], fixes, f"classification/rules/{i}/when")
                if isinstance(r.get("evidence_ids"), str):
                    r["evidence_ids"] = [r["evidence_ids"]]
        for i, s in enumerate(cls.get("scores") or []):
            for j, it in enumerate((s or {}).get("items") or []):
                if isinstance(it, dict) and "when" in it:
                    it["when"] = normalize_condition(it["when"], fixes, f"classification/scores/{i}/items/{j}/when")
    for k in _DROP_LABELS:
        w.pop(k, None)
    return w


def _norm_guide(g: dict, fixes: list) -> dict:
    g = dict(g)
    nodes = g.get("nodes")
    if isinstance(nodes, list):
        if all(isinstance(n, dict) and n.get("id") for n in nodes):
            g["nodes"] = {n["id"]: {k: v for k, v in n.items() if k != "id"} for n in nodes}
            fixes.append("nodes: a list was converted to an object keyed by node id")
            if "start" not in g and nodes:
                g["start"] = nodes[0]["id"]
                fixes.append("start: set to the first node")
    if isinstance(g.get("nodes"), dict):
        # Guide-level keys written inside "nodes" (seen in a real Hermes build): lift them out.
        nodes = g["nodes"]
        for k in ("title", "start", "workflow_id", "description", "evidence_ids", "id"):
            v = nodes.get(k)
            is_node = isinstance(v, dict) and ("outcome" in v or "slot" in v or "next" in v or "question" in v or "field" in v)
            if k in nodes and not is_node and (k not in g or g.get(k) in (None, "", {})):
                g[k] = nodes.pop(k)
                fixes.append(f"'{k}' was inside nodes; moved to the guide")
            elif k in nodes and not is_node:
                nodes.pop(k)
                fixes.append(f"'{k}' inside nodes duplicated the guide's own; removed")
    if "start" not in g:
        for alt in ("start_node", "root", "entry"):
            if alt in g:
                g["start"] = g.pop(alt)
                fixes.append(f"'{alt}' renamed to 'start'")
                break
    if isinstance(g.get("nodes"), dict):
        out = {}
        for nid, n in g["nodes"].items():
            p = f"nodes/{nid}"
            if not isinstance(n, dict):
                out[nid] = n
                continue
            n = dict(n)
            if n.pop("type", None) is not None:
                fixes.append(f"{p}: 'type' removed (a node is a question or has an outcome)")
            n.pop("id", None)
            if isinstance(n.get("outcome"), dict):
                o = dict(n["outcome"])
                for alt in ("decision_id", "result", "id"):
                    if "decision" not in o and isinstance(o.get(alt), str):
                        o["decision"] = o.pop(alt)
                        fixes.append(f"{p}/outcome: '{alt}' renamed to 'decision'")
                if "title" not in o:
                    for alt in ("label", "text", "message"):
                        if alt in o:
                            o["title"] = o.pop(alt)
                            fixes.append(f"{p}/outcome: '{alt}' renamed to 'title'")
                            break
                acts = o.get("actions")
                if isinstance(acts, list):
                    na = []
                    for i, a in enumerate(acts):
                        if isinstance(a, str):
                            fixes.append(f"{p}/outcome/actions/{i}: plain text action → {{text}} (it still needs evidence_ids or kind 'escalate')")
                            a = {"text": a}
                        elif isinstance(a, dict):
                            a = dict(a)
                            for alt in ("action", "label", "title", "description"):
                                if "text" not in a and alt in a:
                                    a["text"] = a.pop(alt)
                                    fixes.append(f"{p}/outcome/actions/{i}: '{alt}' renamed to 'text'")
                            if isinstance(a.get("evidence_ids"), str):
                                a["evidence_ids"] = [a["evidence_ids"]]
                        na.append(a)
                    o["actions"] = na
                for k in _DROP_LABELS:
                    o.pop(k, None)
                n["outcome"] = o
                out[nid] = n
                continue
            if "slot" not in n:
                if isinstance(n.get("field"), str):
                    n["slot"] = n["field"]
                    fixes.append(f"{p}: slot set to its field '{n['field']}'")
                elif re.match(r"^[a-z][a-z0-9_]{0,63}$", str(nid)):
                    n["slot"] = nid
                    fixes.append(f"{p}: slot set to the node id")
            if "question" not in n:
                for alt in ("text", "prompt", "label", "ask"):
                    if alt in n:
                        n["question"] = n.pop(alt)
                        fixes.append(f"{p}: '{alt}' renamed to 'question'")
                        break
            if isinstance(n.get("input"), str) and n["input"] not in GUIDE_INPUTS:
                m = _INPUTS.get(n["input"].strip().lower())
                if m:
                    fixes.append(f"{p}: input {n['input']!r} → {m!r}")
                    n["input"] = m
            for alt in ("choices", "values"):
                if "options" not in n and isinstance(n.get(alt), list):
                    n["options"] = n.pop(alt)
                    fixes.append(f"{p}: '{alt}' renamed to 'options'")
            if "options" in n:
                n["options"] = _norm_options(n["options"], fixes, f"{p}/options")
            for alt in ("edges", "transitions", "branches", "routes"):
                if "next" not in n and isinstance(n.get(alt), list):
                    n["next"] = n.pop(alt)
                    fixes.append(f"{p}: '{alt}' renamed to 'next'")
            if isinstance(n.get("next"), str):
                n["default"] = n.pop("next")
                fixes.append(f"{p}: 'next' was a node id; moved to 'default'")
            if isinstance(n.get("next"), dict) and all(isinstance(v, str) for v in n["next"].values()):
                # {"yes": "o_reject", "no": "o_accept"} → edges on the slot's value
                slot, edges = n.get("slot"), []
                for val, to in n["next"].items():
                    lv = str(val).lower()
                    if lv in ("default", "else", "otherwise", "*"):
                        n["default"] = to
                        continue
                    v: Any = {"yes": True, "true": True, "no": False, "false": False}.get(lv, val) if n.get("input") == "yes_no" else val
                    edges.append({"when": {"op": "eq", "field": slot, "value": v}, "to": to})
                n["next"] = edges
                fixes.append(f"{p}: 'next' mapping of answer → node converted to conditional edges")
            if isinstance(n.get("next"), list):
                ne = []
                for i, e in enumerate(n["next"]):
                    if isinstance(e, dict):
                        e = dict(e)
                        for alt in ("condition", "if"):
                            if "when" not in e and alt in e:
                                e["when"] = e.pop(alt)
                                fixes.append(f"{p}/next/{i}: '{alt}' renamed to 'when'")
                        for alt in ("goto", "next", "target", "node", "then"):
                            if "to" not in e and isinstance(e.get(alt), str):
                                e["to"] = e.pop(alt)
                                fixes.append(f"{p}/next/{i}: '{alt}' renamed to 'to'")
                        if "when" in e:
                            e["when"] = normalize_condition(e["when"], fixes, f"{p}/next/{i}/when")
                        if e.get("when") is None and "when" in e:
                            e.pop("when")
                    ne.append(e)
                n["next"] = ne
            for alt in ("else", "otherwise", "fallback"):
                if "default" not in n and isinstance(n.get(alt), str):
                    n["default"] = n.pop(alt)
                    fixes.append(f"{p}: '{alt}' renamed to 'default'")
            out[nid] = n
        g["nodes"] = out
    if isinstance(g.get("evidence_ids"), str):
        g["evidence_ids"] = [g["evidence_ids"]]
    return g


def normalize(part: str, item: Any) -> tuple[Any, list[str]]:
    """Repair unambiguous shape mistakes. Returns (item, fixes). Never invents content or evidence."""
    fixes: list[str] = []
    if not isinstance(item, dict):
        return item, fixes
    item = copy.deepcopy(item)
    if part != "workflows":
        for k in _DROP_LABELS:
            if k in item:
                item.pop(k)
                fixes.append(f"'{k}' removed: FieldKit computes evidence status itself")
    if part == "workflows":
        return _norm_workflow(item, fixes), fixes
    if part == "guides":
        return _norm_guide(item, fixes), fixes
    if part == "evidence":
        ex = item.get("excerpts")
        if isinstance(ex, dict):
            item["excerpts"] = ex = [ex]
            fixes.append("excerpts: a single object was wrapped in a list")
        for i, x in enumerate(ex or []):
            if isinstance(x, dict):
                for alt in ("text", "excerpt", "quotation"):
                    if "quote" not in x and isinstance(x.get(alt), str):
                        x["quote"] = x.pop(alt)
                        fixes.append(f"excerpts/{i}: '{alt}' renamed to 'quote'")
                for alt in ("source", "src", "source_ref"):
                    if "source_id" not in x and isinstance(x.get(alt), str):
                        x["source_id"] = x.pop(alt)
                        fixes.append(f"excerpts/{i}: '{alt}' renamed to 'source_id'")
                for alt in ("location", "page", "section", "clause"):
                    if "locator" not in x and alt in x:
                        x["locator"] = str(x.pop(alt))
                        fixes.append(f"excerpts/{i}: '{alt}' renamed to 'locator'")
        if "applicability" not in item and "matches_profile" in item:
            item["applicability"] = {"matches_profile": item.pop("matches_profile")}
            fixes.append("matches_profile moved into applicability")
        if isinstance((item.get("applicability") or {}).get("matches_profile"), str):
            item["applicability"]["matches_profile"] = item["applicability"]["matches_profile"].lower() in ("true", "yes")
            fixes.append("applicability.matches_profile → boolean")
    if part == "sources":
        t = item.get("type")
        if isinstance(t, str) and t not in SOURCE_TYPES:
            m = {"gov": "government", "govt": "government", "regulation": "regulator", "regulatory": "regulator",
                 "law": "regulator", "standard": "standards_body", "standards": "standards_body", "manual": "manufacturer",
                 "university": "academic", "research": "academic", "journal": "academic", "ngo": "extension_or_ngo",
                 "extension": "extension_or_ngo", "intergovernmental": "international_body", "news": "trade_media",
                 "sop": "user_document", "user": "user_statement", "interview": "user_statement",
                 "user_stated": "user_statement", "stated": "user_statement", "industry": "industry_body"}.get(t.strip().lower())
            if m:
                item["type"] = m
                fixes.append(f"type {t!r} → {m!r}")
        if "url" not in item and isinstance(item.get("link"), str):
            item["url"] = item.pop("link")
            fixes.append("'link' renamed to 'url'")
    if part == "knowledge":
        if isinstance(item.get("evidence_ids"), str):
            item["evidence_ids"] = [item["evidence_ids"]]
            fixes.append("evidence_ids wrapped in a list")
        t = item.get("type")
        if isinstance(t, str) and t not in ENTRY_TYPES:
            m = {"how_to": "procedure", "steps": "procedure", "sop": "procedure", "definition": "term", "glossary": "term",
                 "background": "explanation", "info": "explanation", "fault": "troubleshooting", "question": "faq"}.get(t.lower())
            if m:
                item["type"] = m
                fixes.append(f"type {t!r} → {m!r}")
    if part == "vocabulary" and "definition" not in item:
        for alt in ("meaning", "description"):
            if isinstance(item.get(alt), str):
                item["definition"] = item.pop(alt)
                fixes.append(f"'{alt}' renamed to 'definition'")
                break
    if part == "intents" and isinstance(item.get("examples"), list):
        item["examples"] = {"en": item["examples"]}
        fixes.append("examples: a list was taken as English examples ({\"en\": [...]})")
    if part == "traceability":
        for k in ("workflow_ids", "guide_ids", "entry_ids"):
            if isinstance(item.get(k), str):
                item[k] = [item[k]]
                fixes.append(f"{k} wrapped in a list")
    return item, fixes


# ----------------------------------------------------------------------------- checking
def _hint_for(path: list, message: str) -> str:
    keys = [str(p) for p in path]
    last = next((k for k in reversed(keys) if not k.isdigit()), "")
    if any(k in ("when", "visible_if", "required_if", "cond", "all", "any") for k in keys):
        return HINTS["condition"]
    if last == "options" or "options" in keys:
        return HINTS["option"]
    if last == "type" and "fields" in keys:
        return HINTS["field_type"]
    if "nodes" in keys:
        return HINTS["node"]
    if "excerpts" in keys:
        return HINTS["excerpt"]
    if last == "evidence_ids":
        return HINTS["evidence_ids"]
    if last in ("label", "title", "text", "question", "help", "description", "summary"):
        return HINTS["label"]
    return ""


def schema_errors(part: str, item: Any, limit: int = 15) -> list[dict]:
    import jsonschema
    validator = jsonschema.Draft202012Validator(part_schema(part))
    out, seen = [], set()
    for err in sorted(validator.iter_errors(item), key=lambda e: (len(list(e.absolute_path)), list(map(str, e.absolute_path)))):
        best = err
        if err.validator in ("oneOf", "anyOf") and err.context:
            best = jsonschema.exceptions.best_match(err.context) or err
        path = list(best.absolute_path) or list(err.absolute_path)
        msg = best.message
        if len(msg) > 220:
            msg = msg[:200] + "…"
        key = ("/".join(map(str, path)), msg)
        if key in seen:
            continue
        seen.add(key)
        out.append({"path": "/".join(map(str, path)), "error": msg, "hint": _hint_for(path, msg)})
        if len(out) >= limit:
            break
    return out


def _types_from_workflow(w: dict) -> dict:
    out = {}
    for f in w.get("fields") or []:
        if not isinstance(f, dict) or not f.get("id"):
            continue
        t = f.get("type")
        opts = [o.get("value") for o in f.get("options") or [] if isinstance(o, dict)]
        kind = {"number": "number", "checkbox": "bool", "single_choice": "choice", "multi_choice": "multi", "date": "date",
                "time": "date", "text": "text", "multiline": "text"}.get(t, "media")
        out[f["id"]] = (kind, opts)
    return out


def condition_type_errors(cond: Any, types: dict, path: str) -> list[dict]:
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
        if f not in types:
            err(p, f"unknown field/slot {f!r}; known: {sorted(types)[:30]}")
            return
        kind, opts = types[f]
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


def _ref_errors(ids: Any, known: set, path: str, what: str, hint: str = "") -> list[dict]:
    if not ids:
        return []
    if not isinstance(ids, list):
        return [{"path": path, "error": f"{what} must be a list", "hint": hint}]
    bad = [x for x in ids if x not in known]
    if bad:
        return [{"path": path, "error": f"unknown {what} {bad}; add them first. Known: {sorted(known)[:40]}", "hint": hint}]
    return []


def check_item(part: str, item: Any, ctx: dict) -> list[dict]:
    """Schema + cross-reference + type checks for one normalised item. ``ctx``: {sources, evidence, workflows (id→def),
    existing_workflows (id→def), decisions (set), statuses (evidence id→status), responsibilities (set), guides,
    entries, languages}."""
    if part not in PARTS:
        return [{"path": "", "error": f"unknown part {part!r}; one of {PARTS}", "hint": ""}]
    bundle_mode = bool(ctx.get("bundle_mode"))
    errs = schema_errors(part, item)
    if errs or not isinstance(item, dict):
        return errs
    ev_ids = set(ctx.get("evidence") or {})
    statuses = ctx.get("statuses") or {}
    if part == "evidence":
        for i, x in enumerate(item.get("excerpts") or []):
            src = (ctx.get("sources") or {}).get(x["source_id"]) or {}
            if src and src.get("type") not in ("user_document", "user_statement") and len(x["quote"].strip()) < 20:
                errs.append({"path": f"excerpts/{i}/quote", "error": "a quote from a published source must be at least 20 "
                             "characters, copied exactly", "hint": HINTS["excerpt"]})
            if x["source_id"] not in (ctx.get("sources") or {}):
                errs.append({"path": f"excerpts/{i}/source_id", "error": f"unknown source {x['source_id']!r}; add it to sources first. "
                             f"Known: {sorted(ctx.get('sources') or {})[:40]}", "hint": HINTS["excerpt"]})
        for i, x in enumerate(item.get("conflicts") or []):
            if x["source_id"] not in (ctx.get("sources") or {}):
                errs.append({"path": f"conflicts/{i}/source_id", "error": f"unknown source {x['source_id']!r}", "hint": ""})
    elif part == "workflows":
        if not bundle_mode:
            errs += [{"path": p["path"], "error": p["message"], "hint": _hint_for(p["path"].split("/"), p["message"])}
                     for p in engine.validate_definition(item)]
        types = _types_from_workflow(item)
        for i, f in enumerate(item.get("fields") or []):
            for k in ("visible_if", "required_if"):
                if k in f:
                    errs += condition_type_errors(f[k], types, f"fields/{i}/{k}")
            for j, r in enumerate((f.get("validation") or {}).get("rules") or []):
                errs += condition_type_errors(r.get("when"), types, f"fields/{i}/validation/rules/{j}/when")
        cls = item.get("classification") or {}
        for kind in ("rules", "keywords", "scores", "decision_trees"):
            for j, r in enumerate(cls.get(kind) or []):
                errs += _ref_errors(r.get("evidence_ids"), ev_ids, f"classification/{kind}/{j}/evidence_ids", "evidence ids", HINTS["evidence_ids"])
                if kind == "rules":
                    errs += condition_type_errors(r.get("when"), types, f"classification/{kind}/{j}/when")
                    ids = r.get("evidence_ids") or []
                    if not bundle_mode and ids and all(x in ev_ids for x in ids) and \
                            max(STATUS_RANK.get(statuses.get(x, "unverified"), 1) for x in ids) < STATUS_RANK["supported"]:
                        errs.append({"path": f"classification/rules/{j}/evidence_ids", "error":
                                     "this threshold rests only on unverified evidence; quote a qualifying source or drop evidence_ids "
                                     "and the threshold", "hint": ""})
                if kind == "scores":
                    for k2, it in enumerate(r.get("items") or []):
                        errs += condition_type_errors(it.get("when"), types, f"classification/scores/{j}/items/{k2}/when")
    elif part == "guides":
        wfs = {**(ctx.get("existing_workflows") or {}), **(ctx.get("workflows") or {})}
        wf = wfs.get(item.get("workflow_id") or "")
        if item.get("workflow_id") and not wf:
            errs.append({"path": "workflow_id", "error": f"unknown workflow {item['workflow_id']!r}; add it first. Known: {sorted(wfs)[:30]}", "hint": ""})
        types = _types_from_workflow(wf or {})
        nodes = item["nodes"]
        for nid, n in nodes.items():
            if "outcome" in n or not n.get("slot"):
                continue
            if n.get("field"):
                if wf and n["field"] not in types:
                    errs.append({"path": f"nodes/{nid}/field", "error": f"{n['field']!r} is not a field of workflow {item.get('workflow_id')!r}; "
                                 f"fields: {sorted(types)}", "hint": ""})
                    continue
                if not wf:
                    errs.append({"path": f"nodes/{nid}/field", "error": "a node that reads a record field needs the guide's workflow_id", "hint": ""})
                    continue
                types[n["slot"]] = types[n["field"]]
            else:
                inp = n.get("input")
                opts = [o.get("value") for o in n.get("options") or []]
                if not inp:
                    errs.append({"path": f"nodes/{nid}/input", "error": "a question node needs input: yes_no, choice, number or text", "hint": HINTS["node"]})
                if inp == "choice" and not opts:
                    errs.append({"path": f"nodes/{nid}/options", "error": "a choice question needs options", "hint": HINTS["option"]})
                types[n["slot"]] = ({"yes_no": "bool", "number": "number", "choice": "choice", "text": "text"}.get(inp or "text", "text"), opts)
        for nid, n in nodes.items():
            for i, e in enumerate(n.get("next") or []):
                if "when" in e:
                    errs += condition_type_errors(e["when"], types, f"nodes/{nid}/next/{i}/when")
                if e["to"] not in nodes:
                    errs.append({"path": f"nodes/{nid}/next/{i}/to", "error": f"unknown node {e['to']!r}; nodes: {sorted(nodes)}", "hint": HINTS["node"]})
            if n.get("default") and n["default"] not in nodes:
                errs.append({"path": f"nodes/{nid}/default", "error": f"unknown node {n['default']!r}", "hint": HINTS["node"]})
            o = n.get("outcome")
            if o:
                if ctx.get("decisions") is not None and o["decision"] not in ctx["decisions"]:
                    errs.append({"path": f"nodes/{nid}/outcome/decision", "error": f"{o['decision']!r} is not in report_policy.decision_scale "
                                 f"{sorted(ctx['decisions'])}" + ("; add report_policy first" if not ctx["decisions"] else ""), "hint": ""})
                errs += _ref_errors(o.get("evidence_ids"), ev_ids, f"nodes/{nid}/outcome/evidence_ids", "evidence ids", HINTS["evidence_ids"])
                for i, a in enumerate(o.get("actions") or []):
                    errs += _ref_errors(a.get("evidence_ids"), ev_ids, f"nodes/{nid}/outcome/actions/{i}/evidence_ids", "evidence ids", HINTS["evidence_ids"])
        errs += _ref_errors(item.get("evidence_ids"), ev_ids, "evidence_ids", "evidence ids", HINTS["evidence_ids"])
        if not errs and not bundle_mode:   # structural rules shared with publishing (reachability, cycles, dead ends, action support)
            from .workspace import validate_guide
            e2, _ = validate_guide(item, wfs, set(ctx.get("decisions") or []), statuses, ctx.get("languages") or [])
            errs += [{"path": "", "error": m, "hint": ""} for m in e2]
    elif part == "knowledge":
        errs += _ref_errors(item.get("evidence_ids"), ev_ids, "evidence_ids", "evidence ids", HINTS["evidence_ids"])
        ids = [x for x in item.get("evidence_ids") or [] if x in ev_ids]
        best = max((STATUS_RANK.get(statuses.get(x, "unverified"), 1) for x in ids), default=1)
        if not bundle_mode and item["type"] in GUIDANCE_ENTRY_TYPES and best < STATUS_RANK["supported"]:
            errs.append({"path": "evidence_ids", "error": f"a {item['type']} entry is an instruction and needs evidence that is at least "
                         "'supported'; quote a qualifying source, or make it an 'explanation' (shown as unverified background)", "hint": ""})
    elif part == "traceability":
        resp = ctx.get("responsibilities")
        if resp is not None and item["responsibility_id"] not in resp:
            errs.append({"path": "responsibility_id", "error": f"unknown responsibility {item['responsibility_id']!r}; the brief has {sorted(resp)}", "hint": ""})
        wfs = set(ctx.get("workflows") or {}) | set(ctx.get("existing_workflows") or {})
        errs += _ref_errors(item.get("workflow_ids"), wfs, "workflow_ids", "workflows")
        errs += _ref_errors(item.get("guide_ids"), set(ctx.get("guides") or {}), "guide_ids", "guides")
        errs += _ref_errors(item.get("entry_ids"), set(ctx.get("entries") or {}), "entry_ids", "knowledge entries")
        if not (item.get("workflow_ids") or item.get("guide_ids") or item.get("entry_ids")):
            errs.append({"path": "", "error": "point at least one workflow, guide or knowledge entry", "hint": ""})
    return errs


def format_doc(part: str | None = None) -> dict:
    """What fieldkit_workspace_format returns: an overview, or one part's schema, example and rules."""
    if part:
        if part not in PARTS:
            return {"error": f"unknown part {part!r}", "parts": list(PARTS)}
        return {"part": part, "rules": RULES[part], "schema": part_schema(part), "example": EXAMPLES[part],
                "hints": {k: v for k, v in HINTS.items() if k in ("condition", "label", "option", "field_type", "node", "excerpt", "evidence_ids")}}
    return {
        "overview": "Build a workspace in parts, each checked as you add it, so nothing is lost if the chat ends and no single "
                    "call is huge. FieldKit validates every item, repairs unambiguous shape mistakes (reported as 'fixes'), "
                    "and COMPUTES evidence status from your sources: labels you assign are ignored and unverified model "
                    "knowledge can never become an instruction or threshold.",
        "steps": ["fieldkit_start_workspace_build(brief_id, workspace_id, title, languages)",
                  "build from the interview, no up-front web research: the user's stated rules are a 'user_statement' source "
                  "(quote their words) and their documents 'user_document'; both count as their procedure",
                  "add parts in one or two calls: fieldkit_add_workspace_parts(workspace_id, parts={part: [items], ...}) "
                  "(fieldkit_workspace_format(part) gives each part's schema and example); fix every rejected item",
                  "fieldkit_build_workspace(workspace_id) → validation + report (quotes from web sources, if any, are checked "
                  "in the background; if checks are pending, call it again after a minute)",
                  "show the research report; fieldkit_publish_workspace(workspace_id, user_approved=true) only after approval",
                  "a new chat can continue any time: fieldkit_workspace_build_status()"],
        "part_order": list(PARTS),
        "parts": {p: RULES[p] for p in PARTS},
        "evidence_rules": {
            "verified": "a tier-1 source (regulator/government on an official domain, standards body, manufacturer, the user's "
                        "own document) quoted and applicable to the profile, or two independent tier-2 publishers",
            "supported": "one tier-2/3 source, or a tier-1 source that does not fully apply",
            "conflicting": "applicable sources disagree (record both); guide actions must name escalate_to",
            "user_procedure": "the user's own process: their documents (user_document) or rules they stated or approved "
                              "in the conversation (user_statement, quote their words). Labelled 'Your procedure' on the phone",
            "unverified": "no qualifying quoted source: background only, never an instruction or threshold",
        },
    }


def bundle_errors(b: dict, statuses: dict, existing_workflows: dict) -> list[str]:
    """Run every part check over a complete bundle (used by validate_bundle, so publishing is as strict as adding
    parts one by one). Returns readable strings."""
    def items(p: str) -> list:
        v = b.get(p)
        if p in ("knowledge", "vocabulary"):
            v = (v or {}).get("entries") if isinstance(v, dict) else v
        if p == "report_policy":
            return [v] if v is not None else []
        return v if isinstance(v, list) else []
    keyed = {p: {item_key(p, x): x for x in items(p)} for p in PARTS}
    pol = b.get("report_policy") if isinstance(b.get("report_policy"), dict) else {}
    ctx = {"bundle_mode": True, "sources": keyed["sources"], "evidence": keyed["evidence"], "workflows": keyed["workflows"],
           "existing_workflows": {k: v for k, v in (existing_workflows or {}).items() if isinstance(v, dict)},
           "decisions": {d.get("id") for d in pol.get("decision_scale") or [] if isinstance(d, dict)}, "statuses": statuses,
           "guides": keyed["guides"], "entries": keyed["knowledge"],
           "responsibilities": {r.get("id") for r in (b.get("profile") or {}).get("responsibilities") or [] if isinstance(r, dict)},
           "languages": (b.get("languages") or {}).get("content") or []}
    out = []
    for p in PARTS:
        for x in items(p):
            for e in check_item(p, x, ctx):
                out.append(f"{p} {item_key(p, x)}: {e['path'] + ' ' if e['path'] else ''}{e['error']}")
    return out
