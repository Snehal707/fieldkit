"""Install the bundled synthetic example workflows and packs (education, maintenance, agriculture)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import engine, packs as packs_mod
from .db import ALL, Store

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


def install(store: Store, owner: Any) -> dict:
    """Idempotent: existing workflows/packs with the same id are left untouched."""
    out: dict[str, list] = {"workflows": [], "packs": [], "skipped": []}
    existing_wf = {w["id"] for w in store.list_workflows(ALL)}
    for domain_dir in sorted(p for p in EXAMPLES.iterdir() if p.is_dir()):
        for name in ("knowledge.json", "dictionary.json"):
            f = domain_dir / name
            if not f.exists():
                continue
            pack = json.loads(f.read_text(encoding="utf-8"))
            if packs_mod.validate_pack(pack):
                out["skipped"].append(f"{domain_dir.name}/{name}")
            elif store.get_pack_content(pack["id"]) is None:
                out["packs"].append(store.save_pack(owner, pack)["id"])
        wf_file = domain_dir / "workflow.json"
        if wf_file.exists():
            wf = json.loads(wf_file.read_text(encoding="utf-8"))
            if engine.validate_definition(wf):
                out["skipped"].append(f"{domain_dir.name}/workflow.json")
            elif wf["id"] not in existing_wf:
                out["workflows"].append(store.save_workflow(owner, wf, publish=True)["id"])
    return out
