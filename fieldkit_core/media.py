"""Record attachments as evidence: what each file is, whether it is intact, and voice-note transcripts.

Before 0.2.4 the analysis counted every ``image/*`` attachment as a photo, so a signature (a PNG) was reported as
"2 photo(s) attached but NOT analysed" and was even sent to the vision model as a photo; voice notes were ignored
unless the phone had transcribed them. Attachments are now classified by the workflow field they answer.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

KINDS = ("photo", "audio", "signature")
NOUNS = {"photo": ("photo", "photos"), "audio": ("voice note", "voice notes"), "signature": ("signature", "signatures")}
AUDIO_EXT = {"audio/mp4": ".m4a", "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mpeg": ".mp3",
             "audio/wav": ".wav", "audio/x-wav": ".wav"}

Transcriber = Callable[[str], dict]


def _text(v: Any, lang: str = "en") -> str:
    if isinstance(v, dict):
        return str(v.get(lang) or v.get("en") or next(iter(v.values()), ""))
    return str(v or "")


def classify(record: dict, wf: Optional[dict], lang: str = "en") -> list[dict]:
    """One entry per attachment, typed by the field it answers (falls back to the MIME type)."""
    fields = {f["id"]: f for f in (wf or {}).get("fields", [])}
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
        out.append({
            "id": a["id"], "kind": kind, "field_id": a.get("field_id"), "field_label": _text(f.get("label"), lang) if f else "",
            "mime": mime, "size": a.get("size"), "sha256": a.get("sha256"), "status": a.get("status"),
            "referenced": a["id"] in answer_items,
            "signed_at": item.get("signed_at"), "captured_at": item.get("taken_at") or item.get("recorded_at") or item.get("signed_at"),
            "device_transcript": (item.get("transcript") or "").strip() or None,
            "ocr_text": (item.get("ocr_text") or "").strip() or None,
            "transcript": a.get("transcript"), "transcript_source": a.get("transcript_source"),
            "transcript_error": a.get("transcript_error"), "path": a.get("path"),
        })
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
    """'intact' | 'mismatch' | 'missing' — recomputed from the stored file, so a report can vouch for evidence."""
    if not path or not Path(path).exists():
        return "missing"
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return "intact" if sha256 and h.hexdigest() == sha256.lower() else "mismatch"


def hermes_transcriber() -> tuple[Optional[Transcriber], str]:
    """Hermes' own speech-to-text (the same service that transcribes voice messages), or (None, reason)."""
    try:
        from tools import transcription_tools as tt  # type: ignore[import-not-found]
    except Exception as exc:  # not running inside Hermes
        return None, f"Hermes speech-to-text is not available in this process ({type(exc).__name__})"
    try:
        if not tt.is_stt_enabled():
            return None, "speech-to-text is turned off in Hermes (stt.enabled: false)"
    except Exception:
        pass
    return (lambda path: tt.transcribe_audio(path, None, "fieldkit")), ""


def transcribe_file(transcriber: Transcriber, path: str, mime: str) -> dict:
    """Run a transcriber on a stored attachment. Stored files have no extension, and Hermes picks the decoder by
    extension, so a temporary copy with the right one is used."""
    ext = AUDIO_EXT.get(mime.split(";")[0].strip().lower(), ".m4a")
    tmpdir = tempfile.mkdtemp(prefix="fieldkit-stt-")
    try:
        tmp = os.path.join(tmpdir, "voice-note" + ext)
        shutil.copyfile(path, tmp)
        res = transcriber(tmp)
        return res if isinstance(res, dict) else {"success": False, "error": "transcriber returned no result"}
    except Exception as exc:  # never fail an analysis because of a voice note
        return {"success": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def ensure_transcripts(store: Any, items: list[dict], transcriber: Optional[Transcriber], unavailable: str = "") -> None:
    """Fill ``transcript`` for every stored voice note: the phone's transcript first, then a transcript Hermes made
    earlier, then Hermes speech-to-text now (result cached on the attachment). Failures are recorded, not raised."""
    for it in items:
        if it["kind"] != "audio":
            continue
        if it.get("device_transcript"):
            it["transcript"], it["transcript_source"], it["transcript_error"] = it["device_transcript"], "device", None
            continue
        if it.get("transcript"):
            continue
        if it.get("status") != "stored" or not it.get("path"):
            it["transcript_error"] = "the voice note has not finished uploading"
            continue
        if transcriber is None:
            # Keep the reason Hermes recorded when the file arrived (more specific than "not available in this
            # process"), unless transcription has been switched off since.
            off = "turned off" in (unavailable or "")
            it["transcript_error"] = (it.get("transcript_error") if it.get("transcript_error") and not off else None)                 or unavailable or "no speech-to-text available"
            store.set_attachment_transcript(it["id"], None, None, it["transcript_error"])
            continue
        res = transcribe_file(transcriber, it["path"], it.get("mime") or "")
        text = str(res.get("transcript") or "").strip()
        if res.get("success") and text:
            it["transcript"], it["transcript_source"], it["transcript_error"] = text, "hermes", None
            store.set_attachment_transcript(it["id"], text, "hermes", None)
        else:
            it["transcript_error"] = str(res.get("error") or "no speech recognised")[:300]
            store.set_attachment_transcript(it["id"], None, None, it["transcript_error"])


def evidence(items: list[dict]) -> list[dict]:
    """Report-safe description of every attachment (no server paths), with an integrity check of the stored file."""
    out = []
    for it in items:
        e = {"attachment_id": it["id"], "kind": it["kind"], "field_id": it.get("field_id"), "field_label": it.get("field_label"),
             "mime": it.get("mime"), "size": it.get("size"), "sha256": it.get("sha256"),
             "stored": it.get("status") == "stored",
             "integrity": verify_file(it.get("path"), it.get("sha256")) if it.get("status") == "stored" else "not_uploaded",
             "url": f"attachments/{it['id']}"}
        if it["kind"] == "signature":
            e["signed_at"] = it.get("signed_at")
        if it["kind"] == "audio":
            e["transcript"] = it.get("transcript")
            e["transcript_source"] = it.get("transcript_source")
            if not it.get("transcript"):
                e["transcript_error"] = it.get("transcript_error")
        if it["kind"] == "photo" and it.get("ocr_text"):
            e["ocr_text"] = it["ocr_text"]
        out.append(e)
    return out


def annotate(record: dict, wf: Optional[dict], lang: str = "en") -> dict:
    """Add each attachment's kind/field and correct per-kind counts to a record returned by the API or a tool."""
    items = {it["id"]: it for it in classify(record, wf, lang)}
    for a in record.get("attachments") or []:
        it = items.get(a["id"], {})
        a["kind"] = it.get("kind")
        a["field_label"] = it.get("field_label")
        if it.get("signed_at"):
            a["signed_at"] = it["signed_at"]
    c = counts(list(items.values()))
    record["attachment_counts"] = c
    record["attachment_summary"] = describe_counts(c)
    return record


def transcribe_record(store: Any, owner: Any, rid: str, transcriber: Any = None, why: str = "") -> list[dict]:
    """Transcribe a record's stored voice notes now (the dashboard calls this right after an audio upload, so the
    transcript is on Hermes for the dashboard, Hermes tools and Hermes Mobile before any analysis runs)."""
    rec = store.get_record(owner, rid)
    for a in rec.get("attachments") or []:
        try:
            a["path"] = store.get_attachment(owner, a["id"]).get("path")
        except Exception:
            a["path"] = None
    wf = store.get_workflow_any_owner(rec["workflow_id"], rec["workflow_version"])
    items = [it for it in classify(rec, wf) if it["kind"] == "audio"]
    if transcriber is None and not why:
        transcriber, why = hermes_transcriber()
    ensure_transcripts(store, items, transcriber, why)
    return items
