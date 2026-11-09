"""Downloadable intelligence packs: validation, document chunking and lightweight retrieval.

Pack kinds
----------
* ``knowledge``     – entries (explanations, procedures, FAQs, troubleshooting, terms) + sources
* ``dictionary``    – multilingual terms with definitions, translations, examples, synonyms
* ``classification``– reusable classification blocks (same AST as workflows)
* ``model``         – manifest of an upstream on-device model (translation / ocr / stt) — *metadata
                      only*; the browser fetches the pinned upstream files at setup time. No model
                      or WASM binary is ever stored in or served from this plugin.

Every pack is plain JSON; the server records its SHA-256 so the PWA can verify integrity.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any, Iterable

from .engine import text

PACK_KINDS = ("knowledge", "dictionary", "classification", "model", "workspace")
ENTRY_TYPES = ("explanation", "procedure", "faq", "troubleshooting", "term", "reference")
MODEL_CAPABILITIES = ("translation", "ocr", "stt", "embedding")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_WORD = re.compile(r"[\wऀ-ॿ]+", re.UNICODE)
STOP = set("a an the of to in on for and or is are was were be by with at from as it this that what why how "
           "which who when where do does can could should my your their its about into than then there these those".split())


def tokenize(s: str) -> list[str]:
    return [w for w in (m.group(0).lower() for m in _WORD.finditer(s or "")) if w not in STOP and len(w) > 1]


def validate_pack(pack: Any) -> list[str]:
    errs: list[str] = []
    if not isinstance(pack, dict):
        return ["pack must be an object"]
    if pack.get("kind") not in PACK_KINDS:
        errs.append(f"kind must be one of {PACK_KINDS}")
    if not isinstance(pack.get("id"), str) or not _SLUG.match(pack["id"]):
        errs.append("id must be a lowercase slug")
    if not pack.get("title"):
        errs.append("title required")
    langs = pack.get("languages", [])
    if not isinstance(langs, list) or not all(isinstance(x, str) for x in langs):
        errs.append("languages must be a list of language codes")
    kind = pack.get("kind")
    if kind == "knowledge":
        entries = pack.get("entries")
        if not isinstance(entries, list) or not entries:
            errs.append("knowledge pack needs entries")
        else:
            ids = set()
            for i, e in enumerate(entries):
                if not isinstance(e, dict) or not e.get("id") or not e.get("title") or not e.get("text"):
                    errs.append(f"entries[{i}] needs id, title, text")
                    continue
                if e["id"] in ids:
                    errs.append(f"entries[{i}] duplicate id {e['id']}")
                ids.add(e["id"])
                if e.get("type", "explanation") not in ENTRY_TYPES:
                    errs.append(f"entries[{i}].type must be one of {ENTRY_TYPES}")
                if len(text(e["text"])) > 20000:
                    errs.append(f"entries[{i}].text too long")
    elif kind == "dictionary":
        entries = pack.get("entries")
        if not isinstance(entries, list) or not entries:
            errs.append("dictionary pack needs entries")
        else:
            for i, e in enumerate(entries):
                if not isinstance(e, dict) or not e.get("term") or not e.get("lang") or not e.get("definition"):
                    errs.append(f"entries[{i}] needs term, lang, definition")
    elif kind == "model":
        cap = pack.get("capability")
        if cap not in MODEL_CAPABILITIES:
            errs.append(f"model pack capability must be one of {MODEL_CAPABILITIES}")
        files = pack.get("files")
        if not isinstance(files, list) or not files:
            errs.append("model pack needs a files list")
        else:
            for i, f in enumerate(files):
                url = f.get("url", "") if isinstance(f, dict) else ""
                if not url.startswith("https://"):
                    errs.append(f"files[{i}].url must be https upstream")
        if not pack.get("license"):
            errs.append("model pack must declare its license")
    elif kind == "workspace":
        if not isinstance(pack.get("workspace_id"), str) or not isinstance(pack.get("guides", []), list):
            errs.append("workspace pack needs workspace_id and a guides list")
        if not isinstance(pack.get("workflows"), list):
            errs.append("workspace pack needs a workflows list")
    elif kind == "classification":
        if not isinstance(pack.get("classification"), dict):
            errs.append("classification pack needs a classification object")
    return errs


# ----------------------------------------------------------------------------- documents → pack
def chunk_document(doc: str, max_chars: int = 1200) -> list[dict[str, str]]:
    """Split a plain-text/markdown document into titled sections for a knowledge pack.

    Headings (markdown ``#`` lines or short lines ending with ':') start a section; long
    sections are split at paragraph boundaries. Deterministic — no LLM involved.
    """
    sections: list[dict[str, str]] = []
    title, buf = "Introduction", []

    def flush():
        body = "\n".join(buf).strip()
        if not body:
            return
        paras, cur = re.split(r"\n\s*\n", body), ""
        part = 1
        for p in paras:
            if cur and len(cur) + len(p) > max_chars:
                sections.append({"title": title if part == 1 else f"{title} ({part})", "text": cur.strip()})
                part += 1
                cur = ""
            cur += p + "\n\n"
        if cur.strip():
            sections.append({"title": title if part == 1 else f"{title} ({part})", "text": cur.strip()})

    for line in (doc or "").splitlines():
        s = line.strip()
        heading = re.match(r"^#{1,6}\s+(.+)$", s)
        if heading or (0 < len(s) <= 80 and s.endswith(":") and not s.startswith("-")):
            flush()
            title, buf = (heading.group(1) if heading else s[:-1]).strip(), []
        else:
            buf.append(line)
    flush()
    return sections


def knowledge_pack_from_sections(pack_id: str, title: str, sections: list[dict], *, domain: str = "",
                                 language: str = "en", source: dict | None = None) -> dict:
    entries = []
    for i, s in enumerate(sections):
        entries.append({"id": f"{pack_id}-{i + 1}", "type": s.get("type", "reference"), "title": s["title"],
                        "text": s["text"], "tags": s.get("tags", []), "source": s.get("source") or (source or {}).get("title", "")})
    return {"kind": "knowledge", "id": pack_id, "version": 1, "title": title, "domain": domain,
            "languages": [language], "source": source or {}, "entries": entries}


# ----------------------------------------------------------------------------- retrieval (server)
class Bm25:
    """Small BM25 index (same scoring idea as the PWA's offline search)."""

    def __init__(self, docs: Iterable[tuple[str, str]], k1: float = 1.4, b: float = 0.75):
        self.ids: list[str] = []
        self.tfs: list[Counter] = []
        self.lens: list[int] = []
        df: Counter = Counter()
        for doc_id, body in docs:
            toks = tokenize(body)
            tf = Counter(toks)
            self.ids.append(doc_id)
            self.tfs.append(tf)
            self.lens.append(len(toks))
            df.update(tf.keys())
        n = max(1, len(self.ids))
        self.avg = (sum(self.lens) / n) if self.lens else 1
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}
        self.k1, self.b = k1, b

    def search(self, query: str, k: int = 5) -> list[tuple[str, float]]:
        q = tokenize(query)
        scores = []
        for i, tf in enumerate(self.tfs):
            s = 0.0
            for t in q:
                if t in tf:
                    f = tf[t]
                    s += self.idf.get(t, 0) * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * self.lens[i] / self.avg))
            if s > 0:
                scores.append((self.ids[i], s))
        return sorted(scores, key=lambda x: -x[1])[:k]


def search_knowledge(packs: list[dict], query: str, k: int = 5, lang: str = "en") -> list[dict]:
    entries: dict[str, tuple[dict, dict]] = {}
    docs = []
    for p in packs:
        for e in p.get("entries", []):
            key = f"{p['id']}::{e['id']}"
            entries[key] = (p, e)
            docs.append((key, f"{text(e['title'], lang)} {text(e['title'], lang)} {' '.join(e.get('tags', []))} {text(e['text'], lang)}"))
    if not docs:
        return []
    out = []
    for key, score in Bm25(docs).search(query, k):
        p, e = entries[key]
        out.append({"pack_id": p["id"], "entry_id": e["id"], "title": text(e["title"], lang), "type": e.get("type", "reference"),
                    "text": text(e["text"], lang), "source": e.get("source") or text(p.get("title"), lang),
                    "score": round(score, 3)})
    return out
