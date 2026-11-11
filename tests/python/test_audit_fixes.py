"""Fixes from the final audit (0.3.1): workspace links, unknown ids refused, conflicts described for the dashboard,
Hermes' session note covers new kinds of data collection, and the subject question is never GPS or media."""
import json

from fieldkit_core import forms, tools, workspace
from test_api import PREFIX, H, _install, _record, _sync, env  # noqa: F401  (fixture)


def call(name, **args):
    return json.loads(tools.handler_for(name)(args))


def test_app_link_opens_a_workspace_and_refuses_unknown_ids(env):
    _install(env)
    ws = call("fieldkit_get_app_link", workspace_id="starter-equipment-inspection")
    assert ws["ok"] and ws["url"].endswith("#/workspace/starter-equipment-inspection") and ws["workspace_title"]
    form = call("fieldkit_get_app_link", workflow_id="equipment-inspection")
    assert form["ok"] and form["url"].endswith("#/workflow/equipment-inspection")
    bad = call("fieldkit_get_app_link", workspace_id="road-condition-survey")
    assert not bad["ok"] and "no published workspace" in bad["error"]
    # A workspace id passed as a form id (what Hermes did in the audit) is refused with the fix in the message.
    mixed = call("fieldkit_get_app_link", workflow_id="starter-equipment-inspection")
    assert not mixed["ok"] and "pass it as workspace_id" in mixed["error"]
    assert call("fieldkit_get_app_link")["url"].endswith("index.html")


def test_dashboard_conflicts_are_described(env):
    _install(env)
    rec = _record(rid="rec_dashconf_001")
    assert _sync(env, rec).status_code == 200
    assert _sync(env, dict(rec, base_revision=1, answers=dict(rec["answers"], condition="fair"))).status_code == 200
    assert _sync(env, dict(rec, base_revision=1, answers=dict(rec["answers"], condition="good"))).status_code == 409
    c = env.client.get(f"{PREFIX}/sync/conflicts", headers=H()).json()["conflicts"][0]
    assert c["record_id"] == "rec_dashconf_001" and c["form_title"] == "Equipment inspection" and c["subject"] == "PMP-0042"
    assert c["workspace_title"] and c["completed_at"] and c["client_payload"]["record"]["answers"]["condition"] == "good"
    assert env.client.get(f"{PREFIX}/sync/conflicts", headers=H("bob")).json()["conflicts"] == []   # per account


def test_session_note_sends_new_collection_needs_to_the_builder(env):
    _install(env)
    form = {"id": "pump-check", "title": {"en": "Pump check"}, "fields": [{"id": "pump", "type": "text", "label": {"en": "Pump"}}]}
    env.store.save_workspace_draft(tools.ALL, {"id": "pumps", "title": {"en": "Pumps"}, "profile": {"purpose": "Pump checks"},
                                               "languages": {"content": ["en"]}, "workflows": [form]}, {"ok": True})
    workspace.publish(env.store, "pumps", 1, actor=tools.ALL)
    note = workspace.prompt_section(env.store)
    assert "fieldkit-workspace-builder" in note and "something new" in note and len(note) <= 1500


def test_subject_question_must_be_searchable(env):
    base = {"id": "f", "title": {"en": "F"}, "fields": [{"id": "where", "type": "gps", "label": {"en": "Where"}},
                                                        {"id": "code", "type": "text", "label": {"en": "Code"}}]}
    bad = forms.check_form(dict(base, metadata={"subject_field": "where"}))
    assert any("subject field" in e["error"] for e in bad)
    assert not [e for e in forms.check_form(dict(base, metadata={"subject_field": "code"})) if "subject" in e["error"]]
    assert "never guess ranges" in forms.RULES and "never" in forms.RULES
    assert "not a limit" in forms.RULES and "help text" in forms.RULES          # normal ranges never block saving


def test_published_link_is_the_full_workspace_url_only(env, monkeypatch):
    # A bare path next to the full link was once passed on by Hermes as "C:/dashboard-plugins/...".
    from fieldkit_core import tools
    monkeypatch.setenv("FIELDKIT_PUBLIC_URL", "https://fk.example.com")
    link = tools.app_link(workspace_id="road-survey")
    assert link == {**link, "url": "https://fk.example.com/dashboard-plugins/fieldkit/app_dist/index.html#/workspace/road-survey",
                    "absolute": True} and "path" not in link
