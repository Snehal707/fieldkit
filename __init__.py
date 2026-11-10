"""FieldKit — Hermes Agent plugin entry point.

Registers FieldKit's tools (create and edit workspaces; read synced entries, attachments and sync state), its two
skills and a short session note. FieldKit never calls a model and runs nothing in the background. The dashboard tab and
the offline phone app live under ``dashboard/``.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    # Absolute import name shared with dashboard/plugin_api.py → one fieldkit_core per process.
    sys.path.insert(0, str(_ROOT))

log = logging.getLogger("fieldkit")


def register(ctx) -> None:
    from fieldkit_core import runtime, tools

    runtime.bind(ctx)
    tools.register_all(ctx)
    for name, description in (
            ("fieldkit", "Find and read FieldKit entries, photos and voice notes synced from the offline phone app."),
            ("fieldkit-workspace-builder", "Set up or change a FieldKit workspace (offline observation forms) through a "
                                           "short conversation, with the user's approval.")):
        path = _ROOT / "skills" / name / "SKILL.md"
        if hasattr(ctx, "register_skill") and path.exists():
            ctx.register_skill(name, path, description=description)
    if hasattr(ctx, "register_system_prompt_section"):
        try:
            ctx.register_system_prompt_section("fieldkit.workspace", _workspace_prompt, max_chars=1500)
        except Exception as exc:  # optional on older Hermes versions
            log.warning("fieldkit: could not register prompt section: %s", exc)


def _workspace_prompt(_info=None) -> str:
    try:
        from fieldkit_core import workspace
        from fieldkit_core.db import get_store
        return workspace.prompt_section(get_store())
    except Exception as exc:  # never break a session prompt
        log.warning("fieldkit: workspace prompt unavailable: %s", exc)
        return ""
