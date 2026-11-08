"""Process-wide FieldKit runtime: the host LLM handle, plugin config and the analysis worker.

``register(ctx)`` stores ``ctx.llm`` (Hermes' host-owned ``PluginLlm``) here. The dashboard
backend (``plugin_api.py``) imports this same module (``fieldkit_core.runtime``), so if Hermes
loads the plugin in the dashboard process the worker can drain analysis jobs automatically.
If no LLM handle exists in a process, jobs stay durable and ``pending`` until a Hermes tool
call (``fieldkit_process_pending_jobs``) or a Hermes cron job drains them — both run inside a
real agent context where ``ctx.llm`` is valid. ``/status`` reports which mode is active.
"""
from __future__ import annotations

import contextvars
import logging
import os
import threading
import time
from typing import Any, Callable, Optional

log = logging.getLogger("fieldkit")

llm: Any = None              # PluginLlm or None
config_get: Callable[[str, Any], Any] = lambda key, default=None: default
registered_at: Optional[float] = None
_worker: Optional[threading.Thread] = None
_worker_stop = threading.Event()
_worker_ctx: Optional[contextvars.Context] = None
worker_state: dict[str, Any] = {"running": False, "last_tick": None, "last_error": None, "processed": 0}


def setting(key: str, default: Any = None) -> Any:
    env = os.environ.get(f"FIELDKIT_{key.upper()}")
    if env is not None:
        return env.lower() in ("1", "true", "yes") if isinstance(default, bool) else env
    try:
        return config_get(key, default)
    except Exception:  # config access must never break a request
        return default


def auto_analyze() -> bool:
    return bool(setting("auto_analyze", True))


def public_url() -> str:
    return str(setting("public_url", "") or "").rstrip("/")


def bind(ctx: Any) -> None:
    """Called from register(ctx)."""
    global llm, config_get, registered_at, _worker_ctx
    llm = getattr(ctx, "llm", None)
    getter = getattr(ctx, "get_config", None)
    if callable(getter):
        config_get = lambda key, default=None: getter(key, default=default)
    registered_at = time.time()
    _worker_ctx = contextvars.copy_context()  # keeps the profile scope ctx.llm reads (Hermes docs)


def mode() -> str:
    if llm is None:
        return "deferred"  # jobs wait for a tool call / cron
    return "automatic" if worker_state["running"] else "on-demand"


def start_worker(interval_s: float = 15.0) -> bool:
    """Start the background analysis worker once per process (daemon thread, never on the event loop)."""
    global _worker
    if llm is None or not auto_analyze():
        return False
    if _worker and _worker.is_alive():
        return True
    _worker_stop.clear()
    ctx = _worker_ctx or contextvars.copy_context()

    def loop():
        from . import analysis
        from .db import get_store
        worker_state["running"] = True
        try:
            get_store().recover_stale_jobs()
        except Exception as exc:  # pragma: no cover
            worker_state["last_error"] = str(exc)
        while not _worker_stop.is_set():
            worker_state["last_tick"] = time.time()
            try:
                worker_state["processed"] += len(analysis.process_pending(get_store(), llm, limit=2))
                worker_state["last_error"] = None
            except Exception as exc:  # keep the worker alive; errors are per-job in the DB
                worker_state["last_error"] = str(exc)[:300]
                log.warning("fieldkit worker tick failed: %s", exc)
            _worker_stop.wait(interval_s)
        worker_state["running"] = False

    _worker = threading.Thread(target=lambda: ctx.run(loop), name="fieldkit-analysis", daemon=True)
    _worker.start()
    return True


def stop_worker() -> None:
    _worker_stop.set()
