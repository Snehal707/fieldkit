"""Hermes tools for creating and editing FieldKit workspaces (used by the fieldkit-workspace-builder skill).

Flow: a short interview in chat → fieldkit_draft_workspace (create, or edit an existing workspace: only what the user
asked) → show the user the change list → fieldkit_publish_workspace after they approve. fieldkit_undo_workspace_update
republishes the previous version. Every version is kept, so entries made with any version stay readable.
"""
from __future__ import annotations

import json
from typing import Any

from . import forms
from . import workspace as ws
from .db import ALL, NotFound, get_store


def _ok(**d: Any) -> str:
    return json.dumps({"ok": True, **d}, ensure_ascii=False, default=str)


def _fail(msg: str, **d: Any) -> str:
    return json.dumps({"ok": False, "error": msg, **d}, ensure_ascii=False, default=str)


def workspace_format(a: dict) -> str:
    return _ok(format=forms.format_doc())


def _current(store: Any, wid: str) -> tuple[dict | None, dict | None]:
    """(latest version's bundle, published bundle) of a workspace, or (None, None)."""
    try:
        latest = store.get_workspace_version(wid)
    except NotFound:
        return None, None
    published = store.get_workspace_version(wid, latest["published_version"])["bundle"] if latest.get("published_version") else None
    return store.get_workspace_version(wid, latest["latest_version"])["bundle"], published


def draft(a: dict) -> str:
    """Create a workspace or change one. Starts from the latest version; changes only what is passed."""
    store = get_store()
    wid = str(a.get("workspace_id") or "").strip()
    if not ws.SLUG.match(wid):
        return _fail("workspace_id must be a lowercase slug of 2-48 characters, e.g. home-visits-2026")
    base, published = _current(store, wid)
    new = base is None
    if new and not (a.get("title") and a.get("purpose") and a.get("forms")):
        return _fail("a new workspace needs title, purpose (in the user's words) and at least one form")
    b = {k: v for k, v in (base or {}).items() if k not in ws.LEGACY_PARTS and k != "version"}
    b["id"] = wid
    if a.get("title"):
        b["title"] = a["title"] if isinstance(a["title"], dict) else {"en": str(a["title"])}
    profile = dict(b.get("profile") or {}) if not new else {}
    if new:   # earlier interview briefs had many keys; a new workspace keeps what the user said
        profile = {}
    if isinstance(a.get("profile"), dict):
        profile.update(a["profile"])
    if a.get("purpose"):
        profile["purpose"] = str(a["purpose"])
    b["profile"] = profile
    if a.get("languages") or new:
        b["languages"] = ws.normalize_languages(a.get("languages") or ["en"])
    fixes: dict = {}
    current = {w["id"]: w for w in b.get("workflows") or [] if isinstance(w, dict) and w.get("id")}
    for i, raw in enumerate(a.get("forms") or []):
        form, f = forms.normalize_form(raw)
        key = form.get("id") if isinstance(form, dict) else f"forms[{i}]"
        if f:
            fixes[str(key)] = f[:20]
        if isinstance(form, dict) and form.get("id"):
            current[form["id"]] = form
    for fid in a.get("remove_forms") or []:
        current.pop(fid, None)
        b["workflow_refs"] = [x for x in b.get("workflow_refs") or [] if x != fid]
    b["workflows"] = list(current.values())
    if "workflow_refs" in a:
        b["workflow_refs"] = list(a.get("workflow_refs") or [])
    changes = ws.workspace_changes(published, b) if published else ["New workspace."]
    dropped_signatures = _dropped_signatures(published, b) if published else []
    d = ws.build_draft(store, ALL, b, changelog=a.get("changelog") or (changes[:12] if published else None))
    v = d["validation"]
    if not v["ok"]:
        nxt = "Fix the errors (send the whole corrected form again), then call fieldkit_draft_workspace again."
    elif published:
        nxt = ("Show the user changes_since_published as a short list and ask \"Publish these changes?\". Publish only "
               "after they say yes. Old entries keep their original form version and answers.")
    else:
        nxt = "Show the user in a few lines what the phone will record (each form and its questions). Publish only after they approve."
    warnings = v["warnings"][:10] + [f"signature field {x!r} would be removed: keep it unless the user asked to remove it"
                                     for x in dropped_signatures]
    out = dict(workspace_id=wid, version=d["version"], valid=v["ok"], errors=v["errors"][:30], warnings=warnings,
               summary=v["summary"], changes_since_published=changes if published else None,
               forms=[{"id": w["id"], "title": w.get("title"), "questions": [f.get("id") for f in w.get("fields") or []
                                                                           if isinstance(f, dict)]} for w in b["workflows"]],
               next=nxt)
    if fixes:
        out["fixed_automatically"] = fixes
    return _ok(**out)


def _dropped_signatures(old: dict, new: dict) -> list[str]:
    """Signature fields of the published version that a draft no longer has (a user configured them; never silently)."""
    def sigs(b: dict) -> set:
        return {f"{w.get('id')}/{f.get('id')}" for w in b.get("workflows") or [] if isinstance(w, dict)
                for f in w.get("fields") or [] if isinstance(f, dict) and f.get("type") == "signature"}
    return sorted(sigs(old) - sigs(new))


def publish(a: dict) -> str:
    if not a.get("user_approved"):
        return _fail("publish only after the user has seen what changes and approved it (user_approved=true)")
    from .tools import app_link
    store = get_store()
    _, prev = _current(store, a["workspace_id"])
    out = ws.publish(store, a["workspace_id"], a.get("version"), actor=ALL)
    new_bundle = store.get_workspace_version(a["workspace_id"], out["version"])["bundle"]
    out["changes"] = ws.workspace_changes(prev, new_bundle)
    link = app_link(workspace_id=a["workspace_id"])
    return _ok(**out, app_link=link, next="Give the user app_link.url exactly as returned. On the phone: open the workspace and tap "
               "'Update from Hermes' (or 'Download everything for offline' the first time). Old entries keep their version.")


def undo_update(a: dict) -> str:
    """Undo the last published change: republish an earlier published version as a NEW version (so phones see an
    update), after the user confirmed."""
    store = get_store()
    wid = a.get("workspace_id") or ""
    rows = store._q("SELECT version, status FROM workspace_versions WHERE workspace_id=? ORDER BY version DESC", (wid,))
    if not rows:
        return _fail(f"unknown workspace {wid!r}")
    cur = next((r["version"] for r in rows if r["status"] == "published"), None)
    earlier = [r["version"] for r in rows if r["status"] == "superseded" and (cur is None or r["version"] < cur)]
    if cur is None or not earlier:
        return _fail("there is no earlier published version to go back to")
    target = int(a.get("to_version") or earlier[0])
    old = store.get_workspace_version(wid, target)["bundle"]
    now = store.get_workspace_version(wid, cur)["bundle"]
    changes = ws.workspace_changes(now, old)
    if not a.get("user_confirmed"):
        return _ok(would_restore_version=target, current_version=cur, changes=changes,
                   next="Show the user these changes and ask to confirm; then call again with user_confirmed=true.")
    bundle = {k: v for k, v in old.items() if k != "version"}
    d = ws.build_draft(store, ALL, bundle, changelog=[f"Undo: back to version {target} (replaces version {cur})"])
    if not d["ok"]:
        return _fail("the earlier version no longer validates: " + "; ".join(d["validation"]["errors"][:5]))
    out = ws.publish(store, wid, d["version"], actor=ALL)
    return _ok(**out, restored_from_version=target, undid_version=cur, changes=changes,
               next="Tell the user it is undone and list exactly what changed back (the 'changes' list, in plain words); on "
                    "the phone, tap 'Update from Hermes'. Entries made with any version stay readable.")


def get(a: dict) -> str:
    store = get_store()
    rec = store.get_workspace_version(a["workspace_id"], a.get("version"))
    b = rec["bundle"]
    out = {k: rec[k] for k in ("workspace_id", "version", "status", "published_version", "latest_version", "starter", "changelog")}
    out.update(title=b.get("title"), profile=b.get("profile") or {}, languages=(b.get("languages") or {}).get("content"),
               validation={k: rec["validation"].get(k) for k in ("ok", "errors", "warnings", "summary") if k in rec["validation"]})
    versions = store._q("SELECT version, status, changelog, created_at FROM workspace_versions WHERE workspace_id=? "
                        "ORDER BY version DESC LIMIT 20", (a["workspace_id"],))
    out["versions"] = [{"version": r["version"], "status": r["status"], "changelog": json.loads(r["changelog"] or "[]")[:6],
                        "created_at": r["created_at"]} for r in versions]
    forms_ = list(b.get("workflows") or [])
    for ref in b.get("workflow_refs") or []:
        try:
            forms_.append(store.get_workflow(ALL, ref))
        except NotFound:
            pass
    out["forms"] = forms_ if a.get("include_forms", True) else [{"id": w.get("id"), "title": w.get("title")} for w in forms_]
    legacy = [p for p in ws.LEGACY_PARTS if b.get(p)]
    if legacy:
        out["legacy_parts_not_used"] = legacy
    return _ok(**out)


def list_all(a: dict) -> str:
    return _ok(workspaces=get_store().list_workspaces(published_only=not a.get("include_drafts")))


def _s(name: str, description: str, props: dict, required: list | None = None) -> dict:
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": props, "required": required or []}}


OBJ, STR, INT, BOOL = {"type": "object"}, {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
TOOLS = [
    (_s("fieldkit_workspace_format", "The FieldKit form format: JSON Schema, a valid example form, field types and rules. "
        "Read it before writing forms.", {}), workspace_format),
    (_s("fieldkit_draft_workspace", "Create a FieldKit workspace or change one (a new draft version; nothing reaches the "
        "phone until published). New: workspace_id, title, purpose (the user's words), languages, forms. Edit: "
        "workspace_id plus only what changes: forms (send each changed form WHOLE; same id replaces it), remove_forms, "
        "title, purpose, profile, languages. Returns validation errors to fix, automatic shape fixes, and for an edit "
        "changes_since_published to show the user.",
        {"workspace_id": STR, "title": {"type": ["string", "object"]}, "purpose": STR, "profile": OBJ,
         "languages": {"type": ["array", "object", "string"]}, "forms": {"type": "array", "items": OBJ},
         "remove_forms": {"type": "array", "items": STR}, "workflow_refs": {"type": "array", "items": STR},
         "changelog": {"type": "array", "items": STR}}, ["workspace_id"]), draft),
    (_s("fieldkit_publish_workspace", "Publish a valid workspace draft so the user's phone can download it for offline use. "
        "Requires user_approved=true, set only when the user explicitly said to publish after seeing the drafted forms "
        "and their questions. A request to see or change the forms, or a yes to something else, is not approval.",
        {"workspace_id": STR, "version": INT, "user_approved": BOOL}, ["workspace_id", "user_approved"]), publish),
    (_s("fieldkit_undo_workspace_update", "Undo the last published change to a workspace. An explicit user request ('undo "
        "my last workspace update') is the approval: call with user_confirmed=true and tell them what changed back. If it "
        "is unclear what they mean, call without user_confirmed to preview and ask. Republishes the earlier version as a "
        "new version so phones update; entries keep their original version.",
        {"workspace_id": STR, "to_version": INT, "user_confirmed": BOOL}, ["workspace_id"]), undo_update),
    (_s("fieldkit_get_workspace", "A FieldKit workspace: purpose, languages, its forms (questions, options, units), "
        "version history and validation.", {"workspace_id": STR, "version": INT, "include_forms": BOOL}, ["workspace_id"]), get),
    (_s("fieldkit_list_workspaces", "List FieldKit workspaces (published; include_drafts for drafts too).",
        {"include_drafts": BOOL}), list_all),
]
