"""Process-wide FieldKit runtime: plugin settings and the public URL Hermes uses for app links.

FieldKit runs no background processing and never calls a model: Hermes analyses synced data when the user asks.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Callable, Optional

log = logging.getLogger("fieldkit")

config_get: Callable[[str, Any], Any] = lambda key, default=None: default
registered_at: Optional[float] = None


def setting(key: str, default: Any = None) -> Any:
    env = os.environ.get(f"FIELDKIT_{key.upper()}")
    if env is not None:
        return env.lower() in ("1", "true", "yes") if isinstance(default, bool) else env
    try:
        return config_get(key, default)
    except Exception:  # config access must never break a request
        return default


def public_url() -> str:
    """Base URL for links Hermes hands out: the explicit setting, else the origin users were last seen at."""
    explicit = str(setting("public_url", "") or "").rstrip("/")
    return explicit or observed_url()


_OBSERVED_FILE = "public_origin.json"
_observed_cache: dict[str, Any] = {"mtime": None, "url": ""}


def _observed_path():
    from .db import data_dir
    return data_dir() / _OBSERVED_FILE


def observed_url() -> str:
    try:
        p = _observed_path()
        m = (str(p), p.stat().st_mtime)
        if _observed_cache["mtime"] != m:
            import json
            _observed_cache.update(mtime=m, url=str(json.loads(p.read_text(encoding="utf-8")).get("url", "")))
        return _observed_cache["url"]
    except Exception:
        return ""


def record_observed_url(url: str) -> None:
    """Remember the public base URL an authenticated user reached FieldKit at (shared by all processes via the
    plugin data dir). https wins over http; loopback hosts are never recorded."""
    import json
    from urllib.parse import urlsplit
    url = url.rstrip("/")
    try:
        parts = urlsplit(url)
    except ValueError:
        return
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or not host or host in ("localhost", "::1") or host.startswith("127."):
        return
    current = observed_url()
    if current == url or (current.startswith("https://") and parts.scheme == "http"):
        return
    try:
        p = _observed_path()
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"url": url, "recorded_at": time.time()}), encoding="utf-8")
        os.replace(tmp, p)
    except Exception as exc:  # never break a request over this
        log.debug("fieldkit: could not record public url: %s", exc)


def bind(ctx: Any) -> None:
    """Called from register(ctx): plugin settings come from Hermes' config."""
    global config_get, registered_at
    getter = getattr(ctx, "get_config", None)
    if callable(getter):
        config_get = lambda key, default=None: getter(key, default=default)
    registered_at = time.time()
