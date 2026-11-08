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
