"""Plugin registration and the workspace tools, through the same entry point Hermes calls (register(ctx))."""
import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from fieldkit_core import db, tools, workspace as ws  # noqa: E402


class FakeCtx:
    """Hermes' PluginContext surface FieldKit uses. Touching ``llm`` fails the test: FieldKit never calls a model."""

    def __init__(self, config=None):
        self.tools, self.skills, self.prompt_sections, self.hooks = {}, {}, {}, []
        self._config = config or {}

    @property
    def llm(self):
        raise AssertionError("FieldKit must not use Hermes' model (ctx.llm)")

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False,
                      description="", emoji="", override=False):
        assert name not in self.tools
        assert schema["name"] == name and schema["parameters"]["type"] == "object"
        self.tools[name] = handler

    def register_skill(self, name, path, description="", frontmatter=None):
        assert Path(path).exists()
        self.skills[name] = Path(path)

    def get_config(self, key, default=None):
        return self._config.get(key, default)

    def register_system_prompt_section(self, id, content, position="after_memory", max_chars=4000):
        self.prompt_sections[id] = (content, max_chars)

    def register_hook(self, *a, **k):
        self.hooks.append(a)

    def register_auxiliary_task(self, *a, **k):
        raise AssertionError("FieldKit registers no model slots")


def _load_plugin():
    spec = importlib.util.spec_from_file_location("hermes_plugins.fieldkit", ROOT / "__init__.py",
                                                  submodule_search_locations=[str(ROOT)])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDKIT_DATA_DIR", str(tmp_path))
    db.set_store(db.Store(path=str(tmp_path / "t.db")))
    c = FakeCtx(config={"public_url": "https://hermes.example.org/"})
    _load_plugin().register(c)
    yield c
    db.set_store(None)


def call(ctx, name, **args):
    return json.loads(ctx.tools[name](args))


VISITS = {"id": "home-visit", "title": {"en": "Home visit"}, "languages": ["en"], "default_language": "en",
          "metadata": {"subject_field": "household_id"},
          "fields": [{"id": "household_id", "type": "text", "label": {"en": "Household ID"}, "required": True},
                     {"id": "visit_date", "type": "date", "label": {"en": "Visit date"}, "required": True},
                     {"id": "concern", "type": "select", "label": "Main concern", "options": ["None", "Water", "Food"]},
                     {"id": "concern_notes", "type": "multiline", "label": {"en": "Describe the concern"},
                      "visible_if": {"op": "!=", "field": "concern", "value": "None"}},
                     {"id": "photos", "type": "photo", "label": {"en": "Photos"}},
                     {"id": "voice_note", "type": "audio", "label": {"en": "Voice note"}}]}


# ----------------------------------------------------------------------------- registration
def test_manifest_matches_registration(ctx):
    manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest["name"] == "fieldkit" and manifest["version"] == "0.3.2"
    assert sorted(manifest["provides_tools"]) == sorted(ctx.tools) == sorted(tools.TOOL_NAMES)
    assert len(ctx.tools) == 12
    assert sorted(ctx.skills) == ["fieldkit", "fieldkit-workspace-builder"]
    assert "fieldkit.workspace" in ctx.prompt_sections
    assert ctx.hooks == [] and "provides_hooks" not in manifest           # nothing runs in the background
    assert manifest["config_keys"] == ["public_url"]


def test_skills_and_session_note_name_only_registered_tools(ctx):
    # Removed tools (fieldkit_save_workspace_brief, fieldkit_build_workspace, ...) must not be suggested to Hermes.
    texts = {str(p.parent.name): p.read_text(encoding="utf-8") for p in ROOT.glob("skills/*/SKILL.md")}
    texts["prompt_section"] = ws.prompt_section(db.get_store())
    for name, text in texts.items():
        named = set(re.findall(r"\bfieldkit_[a-z_]+\b", text))
        assert named <= set(ctx.tools), (name, sorted(named - set(ctx.tools)))


def test_fieldkit_never_calls_a_model_or_runs_background_work():
    """The product boundary, checked in the code itself: no model calls, no worker, no Hermes hooks."""
    code = "\n".join(p.read_text(encoding="utf-8") for p in [ROOT / "__init__.py", ROOT / "dashboard" / "plugin_api.py",
                                                            *sorted((ROOT / "fieldkit_core").glob("*.py"))])
    for banned in ("complete_structured", "ctx.llm", "register_hook", "register_auxiliary_task", "threading.Thread",
                   "vision_tools", "transcription_tools", "start_worker"):
        assert banned not in code, banned


def test_no_domain_specific_content_in_the_product():
    """Forms must work for any profession: no dairy, FSSAI, India-specific or inspection-specific content."""
    paths = [*sorted((ROOT / "fieldkit_core").glob("*.py")), *sorted((ROOT / "skills").rglob("*.md")),
             *sorted((ROOT / "app" / "src").glob("*.ts")), ROOT / "__init__.py", ROOT / "dashboard" / "plugin_api.py"]
    text = "\n".join(p.read_text(encoding="utf-8") for p in paths).lower()
    for word in ("fssai", "dairy", "milk", r"\bsnf\b", "maharashtra"):
        assert not re.search(word, text), word


def test_session_note_is_short_and_lists_workspaces(ctx):
    content, max_chars = ctx.prompt_sections["fieldkit.workspace"]
    assert "No workspace yet" in content({}) and max_chars == 1500
    call(ctx, "fieldkit_draft_workspace", workspace_id="family-visits", title="Family visits", purpose="Record home visits",
         languages=["English"], forms=[VISITS])
    call(ctx, "fieldkit_publish_workspace", workspace_id="family-visits", user_approved=True)
    text = content({})
    assert "family-visits" in text and len(text) <= 1500 and "analyse them with your own tools" in text


# ----------------------------------------------------------------------------- create, edit, undo
def test_create_workspace_repairs_shapes_and_needs_approval(ctx):
    fmt = call(ctx, "fieldkit_workspace_format")["format"]
    from fieldkit_core import forms
    assert forms.check_form(fmt["example_form"]) == []
    bad = call(ctx, "fieldkit_draft_workspace", workspace_id="family-visits", title="Family visits", forms=[VISITS])
    assert not bad["ok"] and "purpose" in bad["error"]
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="family-visits", title="Family visits",
             purpose="Record what I see on home visits", languages=["English", "Hindi"], forms=[VISITS])
    assert d["ok"] and d["valid"], d
    fixes = " ".join(d["fixed_automatically"]["home-visit"])
    assert "'select' → 'single_choice'" in fixes and "plain option" in fixes and "op '!=' → 'neq'" in fixes
    assert d["summary"]["languages"] == ["en", "hi"] and d["changes_since_published"] is None
    assert not call(ctx, "fieldkit_publish_workspace", workspace_id="family-visits")["ok"]        # needs approval
    pub = call(ctx, "fieldkit_publish_workspace", workspace_id="family-visits", user_approved=True)
    assert pub["ok"] and pub["forms"] == {"home-visit": 1}
    assert pub["app_link"]["url"].endswith("#/workspace/family-visits")
    m = db.get_store().get_pack_content("ws-family-visits")
    assert m["kind"] == "workspace" and m["workflows"] == [{"id": "home-visit", "version": 1}]
    assert m["profile"]["purpose"] == "Record what I see on home visits"
    assert set(m) == {"kind", "id", "workspace_id", "title", "languages", "profile", "workflows", "packs", "starter",
                      "version_of_workspace", "version"}                                   # no evidence, guides, decisions
    got = call(ctx, "fieldkit_get_workspace", workspace_id="family-visits")
    assert got["forms"][0]["fields"][2]["type"] == "single_choice" and got["versions"][0]["status"] == "published"


def test_type_errors_in_conditions_are_precise(ctx):
    form = json.loads(json.dumps(VISITS))
    form["fields"].append({"id": "people", "type": "number", "label": {"en": "People"},
                           "visible_if": {"op": "eq", "field": "concern", "value": "drought"}})
    form["fields"].append({"id": "x", "type": "text", "label": {"en": "X"}, "visible_if": {"op": "gt", "field": "people", "value": "five"}})
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="family-visits", title="F", purpose="p", forms=[form])
    assert not d["valid"]
    joined = " ".join(d["errors"])
    assert "'drought' is not an option value of 'concern'" in joined and "'people' is a number" in joined


def test_edit_changes_only_what_was_asked_then_undo(ctx):
    store = db.get_store()
    call(ctx, "fieldkit_draft_workspace", workspace_id="family-visits", title="Family visits", purpose="Home visits", forms=[VISITS])
    call(ctx, "fieldkit_publish_workspace", workspace_id="family-visits", user_approved=True)
    store.sync_record("alice", "k1", "dev", {"id": "rec_visit_000001", "workflow_id": "home-visit", "workflow_version": 1,
                                             "base_revision": 0, "workspace_id": "family-visits",
                                             "answers": {"household_id": "H-12", "visit_date": "2026-11-10", "concern": "Water",
                                                         "concern_notes": "Tank leaking"}})
    edited = json.loads(json.dumps(VISITS))
    edited["fields"] = [f for f in edited["fields"] if f["id"] != "concern_notes"]
    edited["fields"].append({"id": "follow_up_needed", "type": "checkbox", "label": {"en": "Follow-up needed"}})
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="family-visits", forms=[edited])
    changes = d["changes_since_published"]
    assert any('added question "Follow-up needed"' in c for c in changes)
    assert any('removed question "Describe the concern" (old records keep this answer)' in c for c in changes)
    assert not any("Title" in c or "Purpose" in c for c in changes)
    pub = call(ctx, "fieldkit_publish_workspace", workspace_id="family-visits", user_approved=True)
    assert pub["forms"] == {"home-visit": 2}
    rec = call(ctx, "fieldkit_get_record", record_id="rec_visit_000001")
    assert rec["form"]["version"] == 1 and any(a["question"] == "Describe the concern" and a["answer"] == "Tank leaking"
                                               for a in rec["answers"])                       # old form version kept
    preview = call(ctx, "fieldkit_undo_workspace_update", workspace_id="family-visits")
    assert preview["would_restore_version"] == 1 and "user_confirmed" in preview["next"]
    undone = call(ctx, "fieldkit_undo_workspace_update", workspace_id="family-visits", user_confirmed=True)
    assert undone["ok"] and undone["restored_from_version"] == 1 and undone["version"] == 3
    assert [f["id"] for f in store.get_workflow(db.ALL, "home-visit")["fields"]] == [f["id"] for f in VISITS["fields"]]


def test_profile_title_and_language_edits(ctx):
    call(ctx, "fieldkit_draft_workspace", workspace_id="oral-history", title="Oral history", purpose="Interviews with elders",
         forms=[{"id": "interview", "title": "Interview", "languages": ["en"], "fields": [
             {"id": "participant", "type": "text", "label": "Participant code", "required": True},
             {"id": "recording", "type": "audio", "label": "Recording"},
             {"id": "consent", "type": "signature", "label": "Consent"}]}])
    call(ctx, "fieldkit_publish_workspace", workspace_id="oral-history", user_approved=True)
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="oral-history", title="Oral history archive",
             purpose="Interviews with elders in two villages", languages={"en": "English", "hi": "Hindi"})
    assert d["valid"]
    assert d["changes_since_published"][:3] == ['Title: "Oral history" → "Oral history archive"',
                                                'Purpose: "Interviews with elders" → "Interviews with elders in two villages"',
                                                "Languages: en → en, hi"]


def test_workspace_made_before_0_3_stays_usable(ctx):
    """An old research-style workspace (sources, evidence, decision guides, classification rules) can be read,
    edited (old parts dropped from the NEW version, stored versions untouched) and undone back to it."""
    store = db.get_store()
    legacy_form = json.loads(json.dumps(VISITS))
    legacy_form["fields"][2] = {"id": "concern", "type": "single_choice", "label": {"en": "Main concern"},
                                "options": [{"value": "none", "label": "None"}, {"value": "water", "label": "Water"}]}
    legacy_form["fields"][3]["visible_if"] = {"op": "neq", "field": "concern", "value": "none"}
    legacy_form["classification"] = {"rules": [{"id": "r1", "label": "Water concern", "severity": "high",
                                                "when": {"op": "eq", "field": "concern", "value": "water"}}]}
    bundle = {"id": "old-visits", "title": {"en": "Old visits"}, "profile": {"role": "Community worker", "purpose": "Visits"},
              "languages": {"content": ["en"]}, "workflows": [legacy_form],
              "sources": [{"id": "s_user", "type": "user_statement", "title": "Interview"}],
              "evidence": [{"id": "ev1", "claim": "x", "applicability": {"matches_profile": True}}],
              "report_policy": {"decision_scale": [{"id": "act", "label": "Act", "severity": "high"}]},
              "guides": [{"id": "g1", "title": "Guide", "nodes": {}}], "gaps": [{"topic": "t"}]}
    store.save_workspace_draft(db.ALL, bundle, {"ok": True}, changelog=["built by 0.2.6"])
    ws.publish(store, "old-visits", 1, actor=db.ALL)
    got = call(ctx, "fieldkit_get_workspace", workspace_id="old-visits")
    assert got["ok"] and set(got["legacy_parts_not_used"]) == {"sources", "evidence", "report_policy", "guides", "gaps"}
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="old-visits", purpose="Home visits in two villages")
    assert d["valid"]
    assert any(c.startswith("Removed parts FieldKit no longer uses: sources, evidence, report_policy, guides, gaps")
               for c in d["changes_since_published"])
    assert "guides" not in store.get_workspace_version("old-visits", 2)["bundle"]
    assert store.get_workspace_version("old-visits", 1)["bundle"]["guides"]                  # stored version untouched
    call(ctx, "fieldkit_publish_workspace", workspace_id="old-visits", user_approved=True)
    undone = call(ctx, "fieldkit_undo_workspace_update", workspace_id="old-visits", user_confirmed=True)
    assert undone["ok"] and undone["restored_from_version"] == 1


def test_language_shapes_from_real_models_are_understood():
    n = ws.normalize_languages
    assert n(["English", "Hindi"]) == {"content": ["en", "hi"]}
    assert n({"en": "English", "hi": "Hindi"}) == {"content": ["en", "hi"]}
    assert n({"primary": ["hi", "en"]}) == {"content": ["hi", "en"]}
    assert n("हिंदी") == {"content": ["hi"]} and n(None) == {"content": ["en"]}


# ----------------------------------------------------------------------------- signatures are optional
def test_signature_is_only_a_field_type_and_never_added_or_dropped_silently(ctx):
    from fieldkit_core import forms
    assert "signature" not in [f["type"] for f in forms.EXAMPLE["fields"]]                # the example has none
    assert "only when the user asks" in forms.RULES
    no_sig = {"id": "walk", "title": "Site walk", "fields": [{"id": "site", "type": "text", "label": "Site"}]}
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="walks", title="Walks", purpose="Site walks", forms=[no_sig])
    assert d["valid"] and call(ctx, "fieldkit_publish_workspace", workspace_id="walks", user_approved=True)["ok"]
    assert [f["type"] for f in db.get_store().get_workflow(db.ALL, "walk")["fields"]] == ["text"]   # nothing added
    with_sig = {**no_sig, "fields": no_sig["fields"] + [{"id": "consent", "type": "signature", "label": "Consent", "required": True}]}
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="walks", forms=[with_sig])
    assert any('added question "Consent" (signature)' in c for c in d["changes_since_published"])
    call(ctx, "fieldkit_publish_workspace", workspace_id="walks", user_approved=True)
    # An edit that would drop the signature is flagged (and listed), not silently applied.
    edited = {**no_sig, "fields": no_sig["fields"] + [{"id": "notes", "type": "multiline", "label": "Notes"}]}
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="walks", forms=[edited])
    assert any("signature field 'walk/consent' would be removed" in w for w in d["warnings"])
    assert any('removed question "Consent"' in c for c in d["changes_since_published"])
    # An edit of another field keeps the signature (the whole form is sent back unchanged apart from the edit).
    kept = {**with_sig, "fields": with_sig["fields"] + [{"id": "notes", "type": "multiline", "label": "Notes"}]}
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="walks", forms=[kept])
    assert not [w for w in d["warnings"] if "signature" in w]


def test_legacy_form_with_a_signature_stays_publishable_and_its_signatures_readable(ctx, tmp_path):
    import hashlib
    store = db.get_store()
    form = {"id": "audit", "title": "Audit", "version": 1, "fields": [
        {"id": "site", "type": "text", "label": "Site"}, {"id": "sign", "type": "signature", "label": "Auditor", "required": True}]}
    store.save_workspace_draft(db.ALL, {"id": "audits", "title": {"en": "Audits"}, "profile": {"purpose": "Audits"},
                                        "languages": {"content": ["en"]}, "workflows": [form]}, {"ok": True})
    ws.publish(store, "audits", 1, actor=db.ALL)
    png = b"\x89PNG\r\n\x1a\n" + b"sig" * 40
    sha = hashlib.sha256(png).hexdigest()
    store.sync_record("alice", "k-sig", "dev", {"id": "rec_sig_000001", "workflow_id": "audit", "workflow_version": 1, "base_revision": 0,
                                                "answers": {"site": "A1", "sign": {"attachment_id": "att_sig_00001", "signed_at": "2026-11-01T10:00:00Z"}},
                                                "attachments": [{"id": "att_sig_00001", "field_id": "sign", "mime": "image/png", "size": len(png), "sha256": sha}]})
    store.store_attachment("alice", "att_sig_00001", png, "image/png", tmp_path / "attachments")
    d = call(ctx, "fieldkit_draft_workspace", workspace_id="audits", purpose="Site audits")     # unrelated edit
    assert d["valid"] and not [w for w in d["warnings"] if "signature" in w]
    call(ctx, "fieldkit_publish_workspace", workspace_id="audits", user_approved=True)
    assert [f["type"] for f in store.get_workflow(db.ALL, "audit")["fields"]] == ["text", "signature"]
    rec = call(ctx, "fieldkit_get_record", record_id="rec_sig_000001")
    att = rec["record"]["attachments"][0]
    assert att["kind"] == "signature" and att["signed_at"] == "2026-11-01T10:00:00Z" and att["integrity"] == "intact"
    got = call(ctx, "fieldkit_get_attachment", attachment_id="att_sig_00001")
    assert got["kind"] == "signature" and got["path"].endswith(".png")
