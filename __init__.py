"""FieldKit — Hermes Agent plugin entry point.

Registers the FieldKit tools and the bundled skill, and binds Hermes' host-owned LLM access
(``ctx.llm``) for analysis. The dashboard tab and the mobile PWA live under ``dashboard/``.
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
    skill = _ROOT / "skills" / "fieldkit" / "SKILL.md"
    if hasattr(ctx, "register_skill") and skill.exists():
        ctx.register_skill("fieldkit", skill, description="Create offline FieldKit workflows and analyse synchronised field records.")
    builder = _ROOT / "skills" / "fieldkit-workspace-builder" / "SKILL.md"
    if hasattr(ctx, "register_skill") and builder.exists():
        ctx.register_skill("fieldkit-workspace-builder", builder,
                           description="Interview a user about their field job, research reliable sources, and build their FieldKit workspace.")
    # Onboarding: each new session learns whether this user has a workspace yet (bounded, computed lazily, no I/O here).
    if hasattr(ctx, "register_system_prompt_section"):
        try:
            ctx.register_system_prompt_section("fieldkit.workspace", _workspace_prompt, max_chars=1500)
        except Exception as exc:  # optional on older Hermes versions
            log.warning("fieldkit: could not register prompt section: %s", exc)
    # Plugin-owned model slot for photo analysis. Operators may point auxiliary.fieldkit_vision at a
    # vision-capable model (and set plugin setting vision_task: true) without changing the default model.
    if hasattr(ctx, "register_auxiliary_task"):
        try:
            from fieldkit_core.analysis import VISION_TASK
            ctx.register_auxiliary_task(
                VISION_TASK, display_name="FieldKit photo analysis",
                description="Model used to analyse photos in FieldKit records (falls back to text-only).",
                inherit_from="vision")
        except Exception as exc:  # registration is optional; analysis falls back automatically
            log.warning("fieldkit: could not register auxiliary task: %s", exc)
    # register() does no I/O (no DB open, no threads). The analysis worker starts lazily on the
    # first session or FieldKit tool call in this process, and from the dashboard backend.
    if hasattr(ctx, "register_hook"):
        ctx.register_hook("on_session_start", _on_session_start)


def _on_session_start(**_kwargs) -> None:
    from fieldkit_core import runtime
    try:
        runtime.start_worker()
    except Exception as exc:  # never break a session over the optional worker
        log.warning("fieldkit: analysis worker not started: %s", exc)


def _workspace_prompt(_info=None) -> str:
    try:
        from fieldkit_core import workspace
        from fieldkit_core.db import get_store
        return workspace.prompt_section(get_store())
    except Exception as exc:  # never break a session prompt
        log.warning("fieldkit: workspace prompt unavailable: %s", exc)
        return ""
