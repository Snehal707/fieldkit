"""Record attachments: what each file is (by the form field it answers), whether it is intact, and a readable copy
of the file for Hermes' own tools (vision, speech-to-text, OCR). FieldKit itself never analyses attachments."""
from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path
from typing import Any, Optional

KINDS = ("photo", "audio", "signature")
NOUNS = {"photo": ("photo", "photos"), "audio": ("voice note", "voice notes"), "signature": ("signature", "signatures")}
EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "audio/mp4": ".m4a", "audio/webm": ".webm",
       "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav"}


def _text(v: Any, lang: str = "en") -> str:
    if isinstance(v, dict):
        return str(v.get(lang) or v.get("en") or next(iter(v.values()), ""))
    return str(v or "")


def classify(record: dict, wf: Optional[dict], lang: str = "en") -> list[dict]:
    """One entry per attachment, typed by the field it answers (falls back to the MIME type)."""
    fields = {f["id"]: f for f in (wf or {}).get("fields", []) if isinstance(f, dict) and f.get("id")}
    answer_items: dict[str, dict] = {}
    for fid, f in fields.items():
        if f.get("type") not in KINDS:
            continue
        v = (record.get("answers") or {}).get(fid)
        for it in (v if isinstance(v, list) else [v]):
            if isinstance(it, dict) and it.get("attachment_id"):
                answer_items[it["attachment_id"]] = {**it, "_field": fid}
    out = []
    for a in record.get("attachments") or []:
        item = answer_items.get(a["id"], {})
        f = fields.get(a.get("field_id") or item.get("_field") or "")
        mime = str(a.get("mime") or "")
        kind = f["type"] if f and f.get("type") in KINDS else ("audio" if mime.startswith("audio/") else "photo")
        out.append({"id": a["id"], "kind": kind, "field_id": a.get("field_id"),
                    "field_label": _text(f.get("label"), lang) if f else "", "mime": mime, "size": a.get("size"),
                    "sha256": a.get("sha256"), "status": a.get("status"),
                    "captured_at": item.get("taken_at") or item.get("recorded_at") or item.get("signed_at"),
                    "signed_at": item.get("signed_at"),
                    "phone_transcript": (item.get("transcript") or "").strip() or None,
                    "phone_ocr_text": (item.get("ocr_text") or "").strip() or None,
                    "earlier_transcript": a.get("transcript")})
    return out


def counts(items: list[dict]) -> dict:
    c = {k: 0 for k in KINDS}
    for it in items:
        c[it["kind"]] += 1
    return c


def describe_counts(c: dict) -> str:
    parts = [f"{c[k]} {NOUNS[k][0 if c[k] == 1 else 1]}" for k in KINDS if c.get(k)]
    return " · ".join(parts) if parts else "no attachments"


def verify_file(path: Optional[str], sha256: Optional[str]) -> str:
    """'intact' | 'mismatch' | 'missing', recomputed from the stored file."""
    if not path or not Path(path).exists():
        return "missing"
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return "intact" if sha256 and h.hexdigest() == sha256.lower() else "mismatch"


def annotate(record: dict, wf: Optional[dict], lang: str = "en") -> dict:
    """Add each attachment's kind/field and per-kind counts to a record returned by the API or a tool."""
    items = {it["id"]: it for it in classify(record, wf, lang)}
    for a in record.get("attachments") or []:
        it = items.get(a["id"], {})
        a["kind"] = it.get("kind")
        a["field_label"] = it.get("field_label")
        for k in ("captured_at", "signed_at", "phone_transcript", "phone_ocr_text"):
            if it.get(k):
                a[k] = it[k]
    c = counts(list(items.values()))
    record["attachment_counts"] = c
    record["attachment_summary"] = describe_counts(c)
    return record


def readable_copy(stored_path: str, aid: str, mime: str, export_dir: Path) -> str:
    """A copy of a stored attachment with the right file extension (stored files have none, and tools such as
    speech-to-text pick the decoder by extension). Re-created if missing; never modifies the stored file."""
    from .db import Invalid, contained, is_safe_id
    if not is_safe_id(aid):
        raise Invalid("unsafe attachment id")
    export_dir.mkdir(parents=True, exist_ok=True)
    target = contained(export_dir / f"{aid}{EXT.get(mime.split(';')[0].strip().lower(), '')}", export_dir)
    if not target.exists() or target.stat().st_size != Path(stored_path).stat().st_size:
        tmp = target.with_suffix(target.suffix + ".part")
        shutil.copyfile(stored_path, tmp)
        os.replace(tmp, target)
    return str(target)
