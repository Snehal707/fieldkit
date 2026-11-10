"""Test data: three synthetic example workspaces (equipment inspection, classroom observation, crop survey), each with
one form from ``tests/fixtures/forms``. Not part of the product: tests and the local E2E Hermes use it.

    python tests/fixtures/seed.py <FieldKit data dir>     # seeds <dir>/data.db (idempotent)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fieldkit_core import db, workspace as ws  # noqa: E402

FORMS = ROOT / "tests" / "fixtures" / "forms"


def example_forms() -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(FORMS.glob("*.json"))}


def seed(store: "db.Store") -> list[str]:
    """Publish one starter workspace per example form (``starter-<form id>``). Existing ones are left alone."""
    done = []
    for form in example_forms().values():
        wid = f"starter-{form['id']}"[:48]
        try:
            if store.get_workspace_version(wid).get("published_version"):
                continue
        except db.NotFound:
            pass
        bundle = {"id": wid, "title": form["title"], "starter": True,
                  "profile": {"purpose": "Synthetic example: " + (ws.engine.text(form.get("description")) or ws.engine.text(form["title"]))},
                  "languages": {"content": form.get("languages") or ["en"]}, "workflows": [form]}
        d = ws.build_draft(store, db.ALL, bundle, changelog=["Synthetic example"])
        assert d["ok"], d["validation"]["errors"]
        ws.publish(store, wid, d["version"], actor=db.ALL)
        done.append(wid)
    return done


if __name__ == "__main__":
    target = Path(sys.argv[1])
    s = db.Store(path=str(target / "data.db"))
    print(json.dumps({"seeded": seed(s)}))
