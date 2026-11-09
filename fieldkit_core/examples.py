"""Install the bundled synthetic example workflows and packs (education, maintenance, agriculture)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from . import engine, packs as packs_mod
from .db import ALL, Store

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"

#: Content hashes of earlier bundled example workflows. An installed example is upgraded to the bundled version only
#: if its latest version is byte-for-byte one of these (i.e. nobody edited it); edited examples are never touched.
PREVIOUS_EXAMPLES: dict[str, set[str]] = {
    "equipment-inspection": {"7725fc02dec3e81f7abbcc270cf4d3dc79a21ba429aacc56b2ae1801b3f2d6a6"},   # 0.1.0-0.2.4
    "crop-health-survey": {"e963578b335dfb94cebc0da9f7bbd290c6836d56f076002cee63123246c705a3"},     # 0.1.0-0.2.4
}


def content_hash(definition: dict) -> str:
    core = {k: v for k, v in definition.items() if k not in ("version", "status")}
    return hashlib.sha256(json.dumps(core, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def install(store: Store, owner: Any) -> dict:
    """Idempotent: existing workflows/packs with the same id are left untouched."""
    out: dict[str, list] = {"workflows": [], "packs": [], "skipped": [], "upgraded": []}
    existing = {w["id"]: w for w in store.list_workflows(ALL)}
    existing_wf = set(existing)
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
            else:
                cur = store.get_workflow_any_owner(wf["id"], existing[wf["id"]]["latest_version"])
                if cur and content_hash(cur) in PREVIOUS_EXAMPLES.get(wf["id"], set()) and content_hash(cur) != content_hash(wf):
                    out["upgraded"].append(store.save_workflow(ALL, wf, publish=True, actor=owner)["id"])
    from . import workspace
    out["workspaces"] = workspace.ensure_starters(store)
    return out
