"""Load Hermes' real ``agent.plugin_llm`` module and build a PluginLlm with an injected caller.

This exercises Hermes' genuine trust gate, structured-message building, JSON parsing and schema
validation. Only the provider round-trip is replaced (per the user's "mock LLM only" decision for
automated tests). The Hermes source path comes from ``FIELDKIT_HERMES_SRC`` or the local install.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

DEFAULT_SRC = (r"D:\WindowsApps\NousResearchInc.HermesAgent_2026.7411.3516.0_x64__sznbd6dv1j3v4"
               r"\app\resources\agent-payload\hermes-agent")


def hermes_src() -> Path | None:
    p = Path(os.environ.get("FIELDKIT_HERMES_SRC", DEFAULT_SRC))
    return p if (p / "agent" / "plugin_llm.py").exists() else None


def load_plugin_llm():
    src = hermes_src()
    if src is None:
        return None
    name = "hermes_agent_plugin_llm_for_tests"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, src / "agent" / "plugin_llm.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _response(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
                           usage={"prompt_tokens": 100, "completion_tokens": 50})


class Recorder:
    """sync_caller replacement: records the host kwargs and returns canned JSON per purpose."""

    def __init__(self, replies: dict[str, object] | None = None, fail_times: int = 0,
                 reject_images: Exception | None = None, always_fail: Exception | None = None):
        self.calls: list[dict] = []
        self.replies = replies or {}
        self.fail_times = fail_times
        self.reject_images = reject_images  # raised whenever a request carries an image part
        self.always_fail = always_fail

    @staticmethod
    def has_image(kw) -> bool:
        return "image_url" in json.dumps(kw.get("messages", []), default=str)

    def __call__(self, **kw):
        self.calls.append(kw)
        if self.always_fail is not None:
            raise self.always_fail
        if self.reject_images is not None and self.has_image(kw):
            raise self.reject_images
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("provider 503 (test)")
        text = json.dumps(self.replies.get("default", {}))
        for key, reply in self.replies.items():
            joined = json.dumps(kw.get("messages", []), ensure_ascii=False)
            if key != "default" and key in joined:
                text = reply if isinstance(reply, str) else json.dumps(reply)
                break
        return ("test-provider", "test-model", _response(text))


def make_llm(recorder: Recorder, plugin_id: str = "fieldkit"):
    mod = load_plugin_llm()
    if mod is None:
        return None
    policy = mod._TrustPolicy(plugin_id=plugin_id)
    return mod.make_plugin_llm_for_test(plugin_id=plugin_id, policy=policy, sync_caller=recorder)


GOOD_REPORT = {
    "summary": "Guard missing and vibration above alarm level; stop the machine and repair.",
    "issues": [{"title": "Safety guard missing", "severity": "critical", "evidence": "guard_ok = false", "field_ids": ["guard_ok"]},
               {"title": "High vibration", "severity": "high", "evidence": "9 mm/s", "field_ids": ["vibration_level"]}],
    "missing_information": ["Bearing temperature was not measured."],
    "references": [{"title": "Common reasons for equipment vibration", "source": "Demo maintenance guide §1"}],
    "suggested_actions": [{"action": "Tag out the machine until the guard is refitted.", "priority": "urgent"}],
    "followups": [{"title": "Re-inspect after alignment", "detail": "Measure vibration at both bearings.", "due_in_days": 7}],
    "requires_review": True,
    "review_reason": "Safety-critical finding.",
    # Report v2 (0.2.5): decision-focused.
    "decision": {"outcome": "stop", "rationale": "The guard is missing and vibration is above the alarm level, so running "
                 "the machine risks injury and further damage.", "confidence": "high", "deadline_days": 0,
                 "escalate_to": "maintenance supervisor"},
    "next_actions": [{"order": 1, "action": "Tag out the machine until the guard is refitted.", "who": "inspector",
                      "by_when_days": 0, "verify_by": "Guard refitted and the tag removed by the supervisor", "origin": "ai_suggestion"},
                     {"order": 2, "action": "Check alignment and bearings.", "who": "technician", "by_when_days": 7,
                      "verify_by": "Vibration below 4.5 mm/s at both bearings", "origin": "ai_suggestion"}],
    "uncertainty": [{"unknown": "Bearing temperature", "impact": "could raise urgency", "how_to_resolve": "Measure with the IR thermometer"}],
    "follow_up_verification": [{"what": "Vibration after alignment", "how": "Measure at both bearings", "due_in_days": 7}],
}
for _i, _ev in zip(GOOD_REPORT["issues"], (("answer", "guard_ok"), ("measurement", "vibration_level"))):
    _i["interpretation"] = "This is a direct safety or damage risk: it decides whether the machine may keep running."
    _i["evidence_refs"] = [{"kind": _ev[0], "ref": _ev[1]}, {"kind": "answer", "ref": "condition"}]
