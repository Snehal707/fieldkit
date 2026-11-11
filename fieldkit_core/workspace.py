"""Workspaces: a user's work turned into offline observation forms, created and edited through Hermes conversations.

A workspace bundle is ``{id, title, profile: {purpose, ...}, languages: {content: [...]}, workflows: [forms],
workflow_refs?: [existing form ids]}``. Every change is stored as a new version (draft → published, superseded
versions kept), so records made with any version stay readable and an update can be undone.

Workspaces made before 0.2.7 may also contain research parts (sources, evidence, guides, decision scales, knowledge,
vocabulary, intents, gaps, traceability). Those stored versions are kept unchanged and stay readable; FieldKit no longer
uses them, and the next edit drops them from the new version.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from . import engine, forms

SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{1,47}$")
SUPPORTED_LANGUAGES = ("en", "hi")       # what the phone app can show
LEGACY_PARTS = ("sources", "evidence", "report_policy", "guides", "knowledge", "vocabulary", "intents", "gaps",
                "traceability", "pack_refs")
_LANG_NAMES = {"english": "en", "hindi": "hi", "marathi": "mr", "gujarati": "gu", "tamil": "ta", "telugu": "te",
               "kannada": "kn", "bengali": "bn", "punjabi": "pa", "urdu": "ur", "odia": "or", "malayalam": "ml",
               "हिंदी": "hi", "हिन्दी": "hi", "अंग्रेज़ी": "en", "अंग्रेजी": "en"}


def ALL_OWNERS():  # late import keeps this module importable without a store
    from .db import ALL
    return ALL


def normalize_languages(x: Any) -> dict:
    """Any reasonable shape → {"content": [codes]}. Seen from real models: ["English", "Hindi"], {"en": "English"},
    {"primary": ["hi", "en"]}."""
    def code(v: Any) -> Optional[str]:
        t = str(v or "").strip()
        if not t:
            return None
        low = t.lower()
        if low in _LANG_NAMES or t in _LANG_NAMES:
            return _LANG_NAMES.get(low) or _LANG_NAMES.get(t)
        return low if len(low) in (2, 3) and low.isalpha() else None

    def codes(vals: Any) -> list:
        out = []
        for v in vals if isinstance(vals, list) else [vals]:
            c = code(v)
            if c and c not in out:
                out.append(c)
        return out
    if isinstance(x, dict):
        if isinstance(x.get("content"), list) and codes(x["content"]):
            return {"content": codes(x["content"])}
        keys = [k for k in x if code(k) and not isinstance(x[k], list)]
        if keys:
            return {"content": codes(keys)}
        merged = [c for v in x.values() if isinstance(v, list) for c in codes(v)]
        return {"content": list(dict.fromkeys(merged)) or ["en"]}
    if isinstance(x, (list, str)):
        return {"content": codes(x) or ["en"]}
    return {"content": ["en"]}


def pack_ids(wid: str) -> dict:
    return {"workspace": f"ws-{wid}"}


def existing_workflow_defs(store: Any) -> dict:
    out = {}
    for w in store.list_workflows(ALL_OWNERS()):
        out[w["id"]] = store.get_workflow_any_owner(w["id"], w.get("published_version") or w["latest_version"]) or {}
    return out


def validate_bundle(b: Any, existing_workflow_ids: Optional[Any] = None) -> dict:
    """Validate a workspace bundle. Returns {ok, errors[], warnings[], summary{}}. Legacy research parts in old
    versions are ignored (they never block reading, undoing or republishing)."""
    errs: list[str] = []
    warns: list[str] = []
    if not isinstance(b, dict):
        return {"ok": False, "errors": ["workspace must be an object"], "warnings": [], "summary": {}}
    if not isinstance(b.get("id"), str) or not SLUG.match(b["id"]):
        errs.append("id must be a lowercase slug of 2-48 characters")
    if not engine.text(b.get("title")):
        errs.append("title required")
    langs = (b.get("languages") or {}).get("content") if isinstance(b.get("languages"), dict) else None
    if not isinstance(langs, list) or not langs:
        errs.append("languages.content: list of language codes required")
    elif any(x not in SUPPORTED_LANGUAGES for x in langs):
        warns.append(f"languages {[x for x in langs if x not in SUPPORTED_LANGUAGES]}: the phone app shows English and Hindi only")
    fields = 0
    seen: set = set()
    for i, w in enumerate(b.get("workflows") or []):
        if not isinstance(w, dict):
            errs.append(f"workflows[{i}] must be an object")
            continue
        errs += [f"form {w.get('id', i)}: {p['path']} {p['error']}".replace("  ", " ") for p in forms.check_form(w)[:10]]
        if w.get("id") in seen:
            errs.append(f"form {w.get('id')}: id used twice")
        seen.add(w.get("id"))
        fields += len(w.get("fields") or [])
    for ref in b.get("workflow_refs") or []:
        if existing_workflow_ids is not None and ref not in existing_workflow_ids:
            errs.append(f"workflow_refs: unknown form {ref}")
    n_forms = len(b.get("workflows") or []) + len(b.get("workflow_refs") or [])
    if not n_forms:
        errs.append("a workspace needs at least one form")
    return {"ok": not errs, "errors": errs, "warnings": warns,
            "summary": {"forms": n_forms, "fields": fields, "languages": langs or []}}


def manifest(bundle: dict, workflow_versions: dict[str, int], version: int) -> dict:
    """The ``workspace`` pack the phone downloads: what the workspace is for, its languages and its form versions."""
    return {"kind": "workspace", "id": pack_ids(bundle["id"])["workspace"], "workspace_id": bundle["id"],
            "title": bundle["title"], "languages": (bundle.get("languages") or {}).get("content", []),
            "profile": bundle.get("profile") or {},
            "workflows": [{"id": k, "version": ver} for k, ver in workflow_versions.items()],
            "packs": [], "starter": bool(bundle.get("starter")), "version_of_workspace": version}


def build_draft(store: Any, owner: Any, bundle: dict, changelog: Optional[list] = None) -> dict:
    """Validate and store a new draft version. Invalid drafts are stored too (so Hermes can fix them) but cannot be
    published."""
    v = validate_bundle(bundle, existing_workflow_defs(store))
    d = store.save_workspace_draft(owner, bundle, v, changelog=changelog, starter=bool(bundle.get("starter")))
    return {**d, "ok": v["ok"], "validation": v}


def publish(store: Any, wid: str, version: Optional[int] = None, actor: Any = None) -> dict:
    """Publish a valid draft: its forms become new form versions and the workspace manifest is updated."""
    from .db import Invalid
    rec = store.get_workspace_version(wid, version or store.get_workspace_version(wid)["latest_version"])
    bundle = rec["bundle"]
    existing = {w["id"]: w for w in store.list_workflows(ALL_OWNERS())}
    v = validate_bundle(bundle, existing)
    if not v["ok"]:
        raise Invalid("workspace is not valid: " + "; ".join(v["errors"][:8]))
    versions: dict[str, int] = {}
    for w in bundle.get("workflows") or []:
        versions[w["id"]] = store.save_workflow(ALL_OWNERS(), w, publish=True, actor=actor)["version"]
    for ref in bundle.get("workflow_refs") or []:
        versions[ref] = existing[ref].get("published_version") or existing[ref]["latest_version"]
    saved = store.save_pack(ALL_OWNERS(), manifest(bundle, versions, rec["version"]), actor=actor)
    store.mark_workspace_published(wid, rec["version"], saved["id"])
    return {"workspace_id": wid, "version": rec["version"], "manifest_pack": saved["id"], "forms": versions,
            "summary": v["summary"]}


def prompt_section(store: Any) -> str:
    """A short note for each new Hermes session: which FieldKit workspaces exist and how to reach the data."""
    built = [w for w in store.list_workspaces(published_only=True) if not w.get("starter")]
    if not built:
        return ("FieldKit (offline observation collection) is installed. No workspace yet: when the user talks about "
                "collecting observations, visits, inspections, surveys or field notes, offer once to set one up with "
                "the fieldkit-workspace-builder skill.")[:1500]
    names = "; ".join(f"{engine.text(w['title'])} (id {w['id']}, v{w['published_version']})" for w in built[:8])
    return ("FieldKit workspaces for this user: " + names + ". Synced entries, photos and voice notes are available "
            "through the fieldkit tools (fieldkit skill); analyse them with your own tools when the user asks. To change a "
            "workspace, or when the user wants to record something new on their phone (a checklist, survey, log, visit or "
            "inspection form, even without saying FieldKit), use the fieldkit-workspace-builder skill instead of writing a "
            "file (show the forms, publish only after approval)." + (f" They have {len(built)} workspaces; "
            "fieldkit_list_workspaces lists all of them." if len(built) > 8 else ""))[:1500]


def _lbl(v: Any) -> str:
    return engine.text(v) if v else ""


def workspace_changes(old: Optional[dict], new: dict) -> list[str]:
    """A short, plain-language list of what changed (shown to the user before publishing an edit or an undo)."""
    if not old:
        return ["New workspace."]
    out: list[str] = []
    if _lbl(old.get("title")) != _lbl(new.get("title")):
        out.append(f"Title: \"{_lbl(old.get('title'))}\" → \"{_lbl(new.get('title'))}\"")
    op, np_ = old.get("profile") or {}, new.get("profile") or {}
    scalar = (str, int, float, type(None))
    for k in sorted(set(op) | set(np_)):
        if isinstance(op.get(k), scalar) and isinstance(np_.get(k), scalar) and op.get(k) != np_.get(k) and (op.get(k) or np_.get(k)):
            out.append(f"{k.replace('_', ' ').capitalize()}: \"{op.get(k) or '—'}\" → \"{np_.get(k) or '—'}\"")
    ol = (old.get("languages") or {}).get("content") or []
    nl = (new.get("languages") or {}).get("content") or []
    if ol != nl:
        out.append(f"Languages: {', '.join(ol) or '—'} → {', '.join(nl) or '—'}")
    ow = {w.get("id"): w for w in old.get("workflows") or [] if isinstance(w, dict)}
    nw = {w.get("id"): w for w in new.get("workflows") or [] if isinstance(w, dict)}
    for k in nw.keys() - ow.keys():
        out.append(f"Added form: {_lbl(nw[k].get('title')) or k}")
    for k in ow.keys() - nw.keys():
        out.append(f"Removed form: {_lbl(ow[k].get('title')) or k} (existing records keep their answers)")
    for k in nw.keys() & ow.keys():
        form = _lbl(nw[k].get("title")) or k
        if _lbl(ow[k].get("title")) != _lbl(nw[k].get("title")):
            out.append(f"Form renamed: \"{_lbl(ow[k].get('title'))}\" → \"{form}\"")
        of = {f.get("id"): f for f in ow[k].get("fields") or [] if isinstance(f, dict)}
        nf = {f.get("id"): f for f in nw[k].get("fields") or [] if isinstance(f, dict)}
        for fid in [f.get("id") for f in nw[k].get("fields") or [] if isinstance(f, dict) and f.get("id") not in of]:
            out.append(f"{form}: added question \"{_lbl(nf[fid].get('label')) or fid}\" ({nf[fid].get('type')})")
        for fid in [f.get("id") for f in ow[k].get("fields") or [] if isinstance(f, dict) and f.get("id") not in nf]:
            out.append(f"{form}: removed question \"{_lbl(of[fid].get('label')) or fid}\" (old records keep this answer)")
        for fid in of.keys() & nf.keys():
            a, b = of[fid], nf[fid]
            bits = []
            if _lbl(a.get("label")) != _lbl(b.get("label")):
                bits.append(f"label \"{_lbl(a.get('label'))}\" → \"{_lbl(b.get('label'))}\"")
            if a.get("type") != b.get("type"):
                bits.append(f"type {a.get('type')} → {b.get('type')}")
            if [o.get("value") for o in a.get("options") or []] != [o.get("value") for o in b.get("options") or []]:
                bits.append("options changed")
            if bool(a.get("required")) != bool(b.get("required")):
                bits.append("now required" if b.get("required") else "now optional")
            if (a.get("validation") or {}) != (b.get("validation") or {}) or a.get("unit") != b.get("unit"):
                bits.append("limits/units changed")
            if a.get("visible_if") != b.get("visible_if"):
                bits.append("when it is shown changed")
            if bits:
                out.append(f"{form}: changed \"{_lbl(b.get('label')) or fid}\": " + ", ".join(bits))
        if (ow[k].get("metadata") or {}).get("subject_field") != (nw[k].get("metadata") or {}).get("subject_field"):
            out.append(f"{form}: each entry is now identified by \"{(nw[k].get('metadata') or {}).get('subject_field')}\"")
    if sorted(old.get("workflow_refs") or []) != sorted(new.get("workflow_refs") or []):
        out.append(f"Shared forms: {', '.join(old.get('workflow_refs') or []) or '—'} → "
                   f"{', '.join(new.get('workflow_refs') or []) or '—'}")
    dropped = [p for p in LEGACY_PARTS if old.get(p) and not new.get(p)]
    if dropped:
        out.append("Removed parts FieldKit no longer uses: " + ", ".join(dropped))
    return out or ["No visible changes."]
