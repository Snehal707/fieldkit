"""SQLite persistence for FieldKit (server side).

Uses Hermes' ``plugins.plugin_storage.plugin_db("fieldkit")`` when running inside Hermes, so data
lives in ``<HERMES_HOME>/plugin-data/fieldkit/data.db`` and survives plugin update/remove. Outside
Hermes (tests, tooling) ``FIELDKIT_DATA_DIR`` or an explicit path is used.

One connection per process guarded by an RLock; every public method is a short transaction.
Every user-scoped query takes ``owner``; ``ALL`` is reserved for the instance owner acting
through Hermes tools (Hermes is single-tenant: the agent operator owns the instance).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

PLUGIN_NAME = "fieldkit"
ALL = object()  # sentinel: instance-owner scope (Hermes tools)

SYNC_STATES = ("received", "complete")  # received = record stored, attachments outstanding

MIGRATIONS: list[str] = [
    # v1
    """
    CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, email TEXT, first_seen REAL, last_seen REAL);
    CREATE TABLE devices (id TEXT NOT NULL, owner_user_id TEXT NOT NULL, label TEXT, first_seen REAL, last_seen REAL,
                          PRIMARY KEY (owner_user_id, id));
    CREATE TABLE workflows (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT, domain TEXT,
                            latest_version INTEGER NOT NULL, published_version INTEGER, status TEXT NOT NULL,
                            created_at REAL, updated_at REAL);
    CREATE TABLE workflow_versions (workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
                                    version INTEGER NOT NULL, definition TEXT NOT NULL, status TEXT NOT NULL,
                                    created_at REAL, created_by TEXT, PRIMARY KEY (workflow_id, version));
    CREATE TABLE packs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL, title TEXT, domain TEXT,
                        languages TEXT, owner_user_id TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL,
                        size INTEGER NOT NULL, source TEXT, created_at REAL, updated_at REAL);
    CREATE TABLE records (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, device_id TEXT, workflow_id TEXT NOT NULL,
                          workflow_version INTEGER NOT NULL, revision INTEGER NOT NULL, answers TEXT NOT NULL,
                          local_results TEXT, content_hash TEXT NOT NULL, created_local_at TEXT, completed_at TEXT,
                          received_at REAL, updated_at REAL, sync_status TEXT NOT NULL,
                          analysis_status TEXT NOT NULL DEFAULT 'not_requested', analysis_job_id TEXT,
                          report_id TEXT, report_version INTEGER);
    CREATE INDEX records_owner ON records(owner_user_id, received_at);
    CREATE INDEX records_workflow ON records(workflow_id);
    CREATE TABLE record_revisions (record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                                   revision INTEGER NOT NULL, answers TEXT NOT NULL, local_results TEXT,
                                   device_id TEXT, created_at REAL, PRIMARY KEY (record_id, revision));
    CREATE TABLE attachments (id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                              owner_user_id TEXT NOT NULL, field_id TEXT, mime TEXT, size INTEGER, sha256 TEXT NOT NULL,
                              path TEXT, status TEXT NOT NULL, created_at REAL, stored_at REAL);
    CREATE TABLE sync_ops (owner_user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, record_id TEXT, revision INTEGER,
                           response TEXT NOT NULL, created_at REAL, PRIMARY KEY (owner_user_id, idempotency_key));
    CREATE TABLE conflicts (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
                            base_revision INTEGER, server_revision INTEGER, client_payload TEXT NOT NULL,
                            status TEXT NOT NULL, resolution TEXT, created_at REAL, resolved_at REAL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
                       status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
                       next_run_at REAL NOT NULL, last_error TEXT, created_at REAL, updated_at REAL,
                       UNIQUE (kind, record_id, revision));
    CREATE INDEX jobs_ready ON jobs(status, next_run_at);
    CREATE TABLE reports (id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                          owner_user_id TEXT NOT NULL, version INTEGER NOT NULL, record_revision INTEGER,
                          content TEXT NOT NULL, provider TEXT, model TEXT, generated_by TEXT, created_at REAL,
                          UNIQUE (record_id, version));
    CREATE TABLE followups (id TEXT PRIMARY KEY, record_id TEXT, report_id TEXT, owner_user_id TEXT NOT NULL,
                            title TEXT NOT NULL, detail TEXT, due_date TEXT, status TEXT NOT NULL, source TEXT,
                            created_at REAL, updated_at REAL);
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, actor TEXT, action TEXT NOT NULL,
                               target TEXT, detail TEXT);
    """,
    # v2: a permanent random identity for THIS database file. Two installs that see different store ids are
    # talking to different FieldKit databases (e.g. several hosting machines with their own volumes, or a reset).
    """
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('store_id', 'fks_' || lower(hex(randomblob(8))));
    INSERT INTO meta(key, value) VALUES ('store_created_at', CAST(strftime('%s','now') AS TEXT));
    """,
    # v3: voice-note transcripts made by Hermes speech-to-text (the phone's own transcripts stay in the answers).
    """
    ALTER TABLE attachments ADD COLUMN transcript TEXT;
    ALTER TABLE attachments ADD COLUMN transcript_source TEXT;
    ALTER TABLE attachments ADD COLUMN transcript_error TEXT;
    ALTER TABLE attachments ADD COLUMN transcribed_at REAL;
    """,
    # v4 (0.2.5): workspaces built by Hermes, their briefs, and the learning loop. Additive only.
    """
    CREATE TABLE workspace_briefs (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, brief TEXT NOT NULL,
                                   confirmed INTEGER NOT NULL DEFAULT 0, created_at REAL, updated_at REAL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT, brief_id TEXT,
                             latest_version INTEGER NOT NULL, published_version INTEGER, starter INTEGER NOT NULL DEFAULT 0,
                             created_at REAL, updated_at REAL);
    CREATE TABLE workspace_versions (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                                     version INTEGER NOT NULL, bundle TEXT NOT NULL, validation TEXT NOT NULL,
                                     status TEXT NOT NULL, changelog TEXT, created_at REAL, created_by TEXT,
                                     PRIMARY KEY (workspace_id, version));
    CREATE TABLE learning_events (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, workspace_id TEXT, kind TEXT NOT NULL,
                                  ref_type TEXT, ref_id TEXT, payload TEXT NOT NULL, device_id TEXT,
                                  idempotency_key TEXT NOT NULL, created_at REAL, received_at REAL,
                                  UNIQUE (owner_user_id, idempotency_key));
    CREATE INDEX learning_events_ws ON learning_events(workspace_id, kind);
    CREATE TABLE candidates (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT,
                             payload TEXT NOT NULL, basis TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT,
                             created_at REAL, decided_at REAL, decided_by TEXT, decision_note TEXT);
    ALTER TABLE records ADD COLUMN workspace_id TEXT;
    """,
    # v5 (0.2.6): workspaces are built in checked parts that survive across Hermes chats; source pages fetched for the
    # excerpt check are cached so a build never re-downloads them inside one tool call. Additive only.
    """
    CREATE TABLE workspace_builds (workspace_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, brief_id TEXT NOT NULL,
                                   header TEXT NOT NULL, parts TEXT NOT NULL, created_at REAL, updated_at REAL);
    CREATE TABLE source_pages (url TEXT PRIMARY KEY, status TEXT NOT NULL, content TEXT, error TEXT, fetched_at REAL);
    """,
    # v6 (0.2.6): questions about one observation, answered by Hermes from that record's evidence. Additive only.
    """
    CREATE TABLE questions (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, record_id TEXT NOT NULL, workspace_id TEXT,
                            question TEXT NOT NULL, lang TEXT, attachment_ids TEXT, status TEXT NOT NULL,
                            answer TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_run_at REAL,
                            created_at REAL, answered_at REAL);
    CREATE INDEX questions_record ON questions(record_id);
    CREATE INDEX questions_status ON questions(status, next_run_at);
    """,
    # v7 (0.2.6 fix): descriptions of photos by Hermes' vision tool, for a text-only main model; reused across
    # questions about the same visit. Additive only.
    """
    CREATE TABLE photo_descriptions (attachment_id TEXT PRIMARY KEY, description TEXT NOT NULL, created_at REAL);
    """,
]




def preview(text: str, n: int) -> str:
    """Shorten to at most n characters on a word boundary, with an ellipsis when cut."""
    text = str(text or "").strip()
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(" ", 1)[0].rstrip(" ,;:.-")
    return (cut or text[:n]) + "…"


class NotFound(Exception):
    pass


class Conflict(Exception):
    def __init__(self, payload: dict):
        super().__init__("revision conflict")
        self.payload = payload


class Invalid(Exception):
    pass


def _now() -> float:
    return time.time()


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def _j(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _uj(v: Optional[str]) -> Any:
    return None if v is None else json.loads(v)


def content_hash(answers: Any, local_results: Any = None) -> str:
    return hashlib.sha256(_j({"a": answers}).encode()).hexdigest()


# Client-chosen identifiers that become file names (attachment ids) must be plain tokens: letters, digits, "_" and
# "-" only. Every id the phone has ever generated ("att_" + hex) matches; anything else is refused.
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")
# Limits on what one synced record may carry (real records are a few hundred bytes with a handful of files).
MAX_ANSWERS_BYTES = 512 * 1024
MAX_LOCAL_RESULTS_BYTES = 512 * 1024
MAX_ATTACHMENTS_PER_RECORD = 100


def is_safe_id(value: Any) -> bool:
    return isinstance(value, str) and SAFE_ID.fullmatch(value) is not None


def contained(path: Path | str, base: Path | str) -> Path:
    """``path`` resolved, if it lies inside ``base`` (resolved); otherwise :class:`Invalid`. Guards every file
    path built from, or stored for, an attachment."""
    p, b = Path(path).resolve(), Path(base).resolve()
    try:
        p.relative_to(b)
    except ValueError:
        raise Invalid("file path outside the FieldKit attachments folder") from None
    return p


def data_dir() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir  # type: ignore
        return plugin_data_dir(PLUGIN_NAME)
    except ImportError:
        p = Path(os.environ.get("FIELDKIT_DATA_DIR") or Path.home() / ".fieldkit-dev")
        p.mkdir(parents=True, exist_ok=True)
        return p


def _open_default() -> sqlite3.Connection:
    try:
        from plugins.plugin_storage import plugin_db  # type: ignore
        return plugin_db(PLUGIN_NAME)
    except ImportError:
        conn = sqlite3.connect(str(data_dir() / "data.db"), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn


class Store:
    def __init__(self, conn: Optional[sqlite3.Connection] = None, path: Optional[str] = None):
        if conn is None:
            if path:
                conn = sqlite3.connect(path, check_same_thread=False)
                conn.execute("PRAGMA foreign_keys=ON")
            else:
                conn = _open_default()
        conn.isolation_level = None  # autocommit; every write uses an explicit BEGIN IMMEDIATE in tx()
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        self.conn = conn
        self.lock = threading.RLock()
        self._migrate()

    # ------------------------------------------------------------------ infra
    def _migrate(self) -> None:
        with self.lock:
            ver = self.conn.execute("PRAGMA user_version").fetchone()[0]
            for i, sql in enumerate(MIGRATIONS[ver:], start=ver + 1):
                self.conn.executescript("BEGIN;" + sql + f"PRAGMA user_version={i};COMMIT;")

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    @staticmethod
    def _owner_clause(owner: Any, col: str = "owner_user_id") -> tuple[str, tuple]:
        if owner is ALL:
            return "1=1", ()
        return f"{col}=?", (owner,)

    def audit(self, c: sqlite3.Connection, actor: Any, action: str, target: str = "", detail: Any = None) -> None:
        c.execute("INSERT INTO audit_events(at, actor, action, target, detail) VALUES (?,?,?,?,?)",
                  (_now(), "hermes" if actor is ALL else str(actor), action, target, _j(detail or {})))

    # ------------------------------------------------------------------ users/devices
    def touch_user(self, user_id: str, display_name: str = "", email: str = "") -> None:
        now = _now()
        with self.tx() as c:
            c.execute("INSERT INTO users(id, display_name, email, first_seen, last_seen) VALUES (?,?,?,?,?) "
                      "ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, "
                      "display_name=COALESCE(NULLIF(excluded.display_name,''), users.display_name)",
                      (user_id, display_name, email, now, now))

    def touch_device(self, c: sqlite3.Connection, owner: str, device_id: str, label: str = "") -> None:
        now = _now()
        c.execute("INSERT INTO devices(id, owner_user_id, label, first_seen, last_seen) VALUES (?,?,?,?,?) "
                  "ON CONFLICT(owner_user_id, id) DO UPDATE SET last_seen=excluded.last_seen",
                  (device_id, owner, label, now, now))

    def register_device(self, owner: str, device_id: str, label: str) -> dict:
        """Name one of the signed-in user's devices. Scoped by (owner, id): a user can only ever name their own."""
        import re as _re
        if not isinstance(device_id, str) or not _re.fullmatch(r"dev_[A-Za-z0-9]{4,40}", device_id):
            raise Invalid("device_id must look like dev_<letters/digits>")
        label = _re.sub(r"[\x00-\x1f\x7f]", "", str(label or "")).strip()[:80]
        now = _now()
        with self.tx() as c:
            c.execute("INSERT INTO devices(id, owner_user_id, label, first_seen, last_seen) VALUES (?,?,?,?,?) "
                      "ON CONFLICT(owner_user_id, id) DO UPDATE SET label=excluded.label, last_seen=excluded.last_seen",
                      (device_id, owner, label, now, now))
        return {"id": device_id, "label": label}

    def store_info(self, owner: Any) -> dict:
        """Which database answered, and how many records it holds for this account (never other accounts' counts)."""
        meta = {r["key"]: r["value"] for r in self._q("SELECT key, value FROM meta")}
        path = next((r["file"] for r in self._q("PRAGMA database_list") if r["name"] == "main"), "")
        clause, args = self._owner_clause(owner)
        mine = self._q(f"SELECT COUNT(*) AS n, MAX(received_at) AS last FROM records WHERE {clause}", args)[0]
        created = meta.get("store_created_at")
        return {"store_id": meta.get("store_id", ""), "created_at": float(created) if created else None, "path": path or "",
                "records_for_you": int(mine["n"]), "last_received_at": mine["last"]}

    def list_devices(self, owner: Any) -> list[dict]:
        clause, args = self._owner_clause(owner)
        sql = f"SELECT id, label, first_seen, last_seen FROM devices WHERE {clause} ORDER BY last_seen DESC LIMIT 100"
        return [dict(r) for r in self._q(sql, args)]

    # ------------------------------------------------------------------ workflows
    def save_workflow(self, owner: Any, definition: dict, publish: bool, actor: Any = None) -> dict:
        """Store a new version of a workflow. Ownership of an existing id is enforced."""
        wid = definition["id"]
        now = _now()
        owner_id = "owner" if owner is ALL else owner
        with self.tx() as c:
            row = c.execute("SELECT * FROM workflows WHERE id=?", (wid,)).fetchone()
            if row and owner is not ALL and row["owner_user_id"] != owner:
                raise NotFound(wid)
            version = (row["latest_version"] + 1) if row else 1
            definition = dict(definition, version=version, status="published" if publish else "draft")
            title = _title(definition.get("title"))
            if row:
                c.execute("UPDATE workflows SET title=?, domain=?, latest_version=?, "
                          "published_version=CASE WHEN ? THEN ? ELSE published_version END, status=?, updated_at=? WHERE id=?",
                          (title, definition.get("domain", ""), version, publish, version,
                           "published" if publish or row["published_version"] else "draft", now, wid))
            else:
                c.execute("INSERT INTO workflows(id, owner_user_id, title, domain, latest_version, published_version, status, "
                          "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                          (wid, owner_id, title, definition.get("domain", ""), version,
                           version if publish else None, "published" if publish else "draft", now, now))
            c.execute("INSERT INTO workflow_versions(workflow_id, version, definition, status, created_at, created_by) "
                      "VALUES (?,?,?,?,?,?)", (wid, version, _j(definition), definition["status"], now, str(actor or owner_id)))
            self.audit(c, actor or owner, "workflow.publish" if publish else "workflow.draft", wid, {"version": version})
        return definition

    def restore_workflow_version(self, owner: str, definition: dict) -> dict:
        """Put back one exact workflow version that this database lacks (e.g. after its data was reset), using the
        copy a device downloaded earlier, so that device's records can be uploaded again. Never overwrites an existing
        version, never touches a workflow owned by another user, and never publishes: a version newer than the
        workflow's latest is refused (new versions are published only through Hermes, with the user's approval), and
        the published version is never changed. Returns {"restored": bool, "version": n}."""
        wid = definition.get("id")
        version = definition.get("version")
        if not isinstance(wid, str) or not wid or not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= 100000:
            raise Invalid("definition needs an id and an integer version")
        now = _now()
        definition = dict(definition, status="restored")
        with self.tx() as c:
            row = c.execute("SELECT * FROM workflows WHERE id=?", (wid,)).fetchone()
            if row and row["owner_user_id"] not in (owner, "owner", "local"):
                raise NotFound(wid)
            if c.execute("SELECT 1 FROM workflow_versions WHERE workflow_id=? AND version=?", (wid, version)).fetchone():
                return {"restored": False, "version": version}
            if row and version > row["latest_version"]:
                raise Invalid(f"version {version} is newer than this workflow's latest ({row['latest_version']}): "
                              "new versions are published through Hermes, not restored")
            if not row:   # the whole workflow was lost (data reset): back as an unpublished record of that version
                c.execute("INSERT INTO workflows(id, owner_user_id, title, domain, latest_version, published_version, status, "
                          "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                          (wid, owner, _title(definition.get("title")), definition.get("domain", ""), version, None, "draft", now, now))
            c.execute("INSERT INTO workflow_versions(workflow_id, version, definition, status, created_at, created_by) "
                      "VALUES (?,?,?,?,?,?)", (wid, version, _j(definition), "restored", now, str(owner)))
            self.audit(c, owner, "workflow.restore", wid, {"version": version})
        return {"restored": True, "version": version}

    def list_workflows(self, owner: Any, published_only: bool = False) -> list[dict]:
        clause, args = self._owner_clause(owner)
        extra = " AND published_version IS NOT NULL" if published_only else ""
        rows = self._q(f"SELECT * FROM workflows WHERE {clause}{extra} ORDER BY updated_at DESC", args)
        return [dict(r) for r in rows]

    def get_workflow(self, owner: Any, wid: str, version: Optional[int] = None, published: bool = False) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT * FROM workflows WHERE id=? AND {clause}", (wid, *args))
        if not rows:
            raise NotFound(wid)
        row = rows[0]
        v = version or (row["published_version"] if published else row["latest_version"])
        if v is None:
            raise NotFound(f"{wid} has no published version")
        vrows = self._q("SELECT definition FROM workflow_versions WHERE workflow_id=? AND version=?", (wid, v))
        if not vrows:
            raise NotFound(f"{wid}@{v}")
        return _uj(vrows[0]["definition"])

    def get_workflow_any_owner(self, wid: str, version: int) -> Optional[dict]:
        rows = self._q("SELECT definition FROM workflow_versions WHERE workflow_id=? AND version=?", (wid, version))
        return _uj(rows[0]["definition"]) if rows else None

    # ------------------------------------------------------------------ packs
    def save_pack(self, owner: Any, pack: dict, actor: Any = None) -> dict:
        pid, kind = pack["id"], pack["kind"]
        owner_id = "owner" if owner is ALL else owner
        now = _now()
        with self.tx() as c:
            row = c.execute("SELECT owner_user_id, version FROM packs WHERE id=?", (pid,)).fetchone()
            if row and owner is not ALL and row["owner_user_id"] != owner:
                raise NotFound(pid)
            version = (row["version"] + 1) if row else int(pack.get("version") or 1)
            pack = dict(pack, version=version)
            body = _j(pack)
            sha = hashlib.sha256(body.encode()).hexdigest()
            c.execute("INSERT INTO packs(id, kind, version, title, domain, languages, owner_user_id, content, sha256, size, "
                      "source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                      "version=excluded.version, title=excluded.title, domain=excluded.domain, languages=excluded.languages, "
                      "content=excluded.content, sha256=excluded.sha256, size=excluded.size, source=excluded.source, "
                      "updated_at=excluded.updated_at",
                      (pid, kind, version, _title(pack.get("title")), pack.get("domain", ""), _j(pack.get("languages", [])),
                       row["owner_user_id"] if row else owner_id, body, sha, len(body.encode()), _j(pack.get("source", {})),
                       now, now))
            self.audit(c, actor or owner, "pack.save", pid, {"kind": kind, "version": version})
        return {"id": pid, "kind": kind, "version": version, "sha256": sha, "size": len(body.encode())}

    def get_pack(self, owner: Any, pid: str) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT content, sha256 FROM packs WHERE id=? AND {clause}", (pid, *args))
        if not rows:
            raise NotFound(pid)
        return {"content": rows[0]["content"], "sha256": rows[0]["sha256"]}

    def get_pack_content(self, pid: str) -> Optional[dict]:
        rows = self._q("SELECT content FROM packs WHERE id=?", (pid,))
        return _uj(rows[0]["content"]) if rows else None

    # ------------------------------------------------------------------ workspaces
    def save_workspace_draft(self, owner: Any, bundle: dict, validation: dict, brief_id: Optional[str] = None,
                             changelog: Optional[list] = None, starter: bool = False) -> dict:
        wid = bundle["id"]
        owner_id = "owner" if owner is ALL else owner
        now = _now()
        with self.tx() as c:
            row = c.execute("SELECT * FROM workspaces WHERE id=?", (wid,)).fetchone()
            if row and owner is not ALL and row["owner_user_id"] not in (owner, "owner"):
                raise NotFound(wid)
            version = (row["latest_version"] + 1) if row else 1
            if row:
                c.execute("UPDATE workspaces SET title=?, latest_version=?, brief_id=COALESCE(?, brief_id), updated_at=? WHERE id=?",
                          (_title(bundle.get("title")), version, brief_id, now, wid))
            else:
                c.execute("INSERT INTO workspaces(id, owner_user_id, title, brief_id, latest_version, published_version, starter, "
                          "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                          (wid, owner_id, _title(bundle.get("title")), brief_id, version, None, int(starter), now, now))
            c.execute("INSERT INTO workspace_versions(workspace_id, version, bundle, validation, status, changelog, created_at, created_by) "
                      "VALUES (?,?,?,?,?,?,?,?)", (wid, version, _j(dict(bundle, version=version)), _j(validation), "draft",
                                                   _j(changelog or []), now, str(owner_id)))
            self.audit(c, owner, "workspace.draft", wid, {"version": version, "ok": validation.get("ok")})
        return {"workspace_id": wid, "version": version, "status": "draft"}

    def get_workspace_version(self, wid: str, version: Optional[int] = None) -> dict:
        row = self._q("SELECT * FROM workspaces WHERE id=?", (wid,))
        if not row:
            raise NotFound(wid)
        v = version or row[0]["published_version"] or row[0]["latest_version"]
        vr = self._q("SELECT * FROM workspace_versions WHERE workspace_id=? AND version=?", (wid, v))
        if not vr:
            raise NotFound(f"{wid}@{v}")
        r = dict(vr[0])
        return {"workspace_id": wid, "version": v, "status": r["status"], "bundle": _uj(r["bundle"]),
                "validation": _uj(r["validation"]), "changelog": _uj(r["changelog"] or "[]"), "created_at": r["created_at"],
                "published_version": row[0]["published_version"], "latest_version": row[0]["latest_version"],
                "starter": bool(row[0]["starter"]), "owner_user_id": row[0]["owner_user_id"]}

    def list_workspaces(self, published_only: bool = True) -> list[dict]:
        sql = "SELECT * FROM workspaces" + (" WHERE published_version IS NOT NULL" if published_only else "") + " ORDER BY starter, updated_at DESC"
        return [{"id": r["id"], "title": r["title"], "latest_version": r["latest_version"], "published_version": r["published_version"],
                 "starter": bool(r["starter"]), "updated_at": r["updated_at"]} for r in self._q(sql)]

    def mark_workspace_published(self, wid: str, version: int, manifest_pack: str) -> None:
        now = _now()
        with self.tx() as c:
            c.execute("UPDATE workspace_versions SET status='superseded' WHERE workspace_id=? AND status='published'", (wid,))
            c.execute("UPDATE workspace_versions SET status='published' WHERE workspace_id=? AND version=?", (wid, version))
            c.execute("UPDATE workspaces SET published_version=?, updated_at=? WHERE id=?", (version, now, wid))
            self.audit(c, ALL, "workspace.publish", wid, {"version": version, "pack": manifest_pack})

    # ------------------------------------------------------------------ questions about one observation (0.2.6)
    def _question_dict(self, r: sqlite3.Row) -> dict:
        d = dict(r)
        d["attachment_ids"] = _uj(d.get("attachment_ids")) or []
        d["answer"] = _uj(d.get("answer")) if d.get("answer") else None
        return d

    def get_question(self, owner: Any, qid: str) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT * FROM questions WHERE id=? AND {clause}", (qid, *args))
        if not rows:
            raise NotFound(qid)
        return self._question_dict(rows[0])

    def list_questions(self, owner: Any, record_id: Optional[str] = None, status: Optional[str] = None, limit: int = 100) -> list[dict]:
        clause, args = self._owner_clause(owner)
        sql = f"SELECT * FROM questions WHERE {clause}"
        if record_id:
            sql += " AND record_id=?"
            args = (*args, record_id)
        if status:
            sql += " AND status=?"
            args = (*args, status)
        sql += " ORDER BY created_at DESC LIMIT ?"
        return [self._question_dict(r) for r in self._q(sql, (*args, max(1, min(limit, 500))))]


    # ------------------------------------------------------------------ sync
    def sync_record(self, owner: str, idempotency_key: str, device_id: str, rec: dict,
                    attachments_dir: Optional[Path] = None) -> dict:
        """Durably receive one record revision. Idempotent per (owner, idempotency_key).

        Optimistic concurrency: ``base_revision`` must equal the server revision (0 for new).
        A mismatch whose content differs raises :class:`Conflict` and records it — never an overwrite.
        """
        if not idempotency_key or len(idempotency_key) > 128:
            raise Invalid("idempotency_key required (<=128 chars)")
        rid = rec.get("id")
        if not isinstance(rid, str) or not (8 <= len(rid) <= 64):
            raise Invalid("record.id must be a stable client-generated id (8-64 chars)")
        answers = rec.get("answers")
        if not isinstance(answers, dict):
            raise Invalid("record.answers must be an object")
        if len(_j(answers).encode("utf-8")) > MAX_ANSWERS_BYTES:
            raise Invalid(f"record.answers is too large (limit {MAX_ANSWERS_BYTES // 1024} KB)")
        if len(_j(rec.get("local_results") or {}).encode("utf-8")) > MAX_LOCAL_RESULTS_BYTES:
            raise Invalid(f"record.local_results is too large (limit {MAX_LOCAL_RESULTS_BYTES // 1024} KB)")
        atts = rec.get("attachments")
        if atts is not None and (not isinstance(atts, list) or len(atts) > MAX_ATTACHMENTS_PER_RECORD):
            raise Invalid(f"record.attachments must be a list of at most {MAX_ATTACHMENTS_PER_RECORD} files")
        base = int(rec.get("base_revision") or 0)
        local_results = rec.get("local_results") or {}
        chash = content_hash(answers)
        now = _now()
        conflict: Optional[dict] = None
        ws_id, ws_note = self.resolve_record_workspace(rec.get("workflow_id"), rec.get("workspace_id"))
        rec = dict(rec, workspace_id=ws_id)
        with self.tx() as c:
            resp = self._sync_tx(c, owner, idempotency_key, device_id, rec, rid, answers, base, local_results, chash, now)
            if ws_note and "__conflict__" not in resp:
                resp = dict(resp, workspace_note=ws_note)
            if "__conflict__" in resp:
                conflict = resp["__conflict__"]
        if conflict is not None:  # raised only after the conflict row is committed
            raise Conflict(conflict)
        return resp

    def _sync_tx(self, c, owner, idempotency_key, device_id, rec, rid, answers, base, local_results, chash, now) -> dict:
        prior = c.execute("SELECT response FROM sync_ops WHERE owner_user_id=? AND idempotency_key=?",
                          (owner, idempotency_key)).fetchone()
        if prior:
            return dict(_uj(prior["response"]), duplicate=True)
        wf_row = c.execute("SELECT 1 FROM workflow_versions WHERE workflow_id=? AND version=?",
                           (rec.get("workflow_id"), int(rec.get("workflow_version") or 0))).fetchone()
        if not wf_row:
            raise Invalid("unknown workflow_id/workflow_version")
        self.touch_device(c, owner, device_id)
        row = c.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
        if row and row["owner_user_id"] != owner:
            raise NotFound(rid)  # never reveal another user's record
        if row is None and base != 0:
            raise Invalid("base_revision must be 0 for a new record")
        if row is not None and base != row["revision"]:
            if row["content_hash"] == chash:  # same content re-sent under a new key: acknowledge
                resp = self._sync_response(c, row["id"])
                self._remember(c, owner, idempotency_key, rid, row["revision"], resp)
                return resp
            cid = _id("cfl")
            c.execute("INSERT INTO conflicts(id, record_id, owner_user_id, base_revision, server_revision, "
                      "client_payload, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
                      (cid, rid, owner, base, row["revision"], _j({"device_id": device_id, "record": rec}), "open", now))
            self.audit(c, owner, "sync.conflict", rid, {"conflict_id": cid, "base": base, "server": row["revision"]})
            return {"__conflict__": {"conflict_id": cid, "record_id": rid, "base_revision": base,
                                     "server_revision": row["revision"], "server_answers": _uj(row["answers"])}}
        revision = base + 1
        att_meta = rec.get("attachments") or []
        if row is None:
            c.execute("INSERT INTO records(id, owner_user_id, device_id, workflow_id, workflow_version, revision, answers, "
                      "local_results, content_hash, created_local_at, completed_at, received_at, updated_at, sync_status, "
                      "workspace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (rid, owner, device_id, rec["workflow_id"], int(rec["workflow_version"]), revision, _j(answers),
                       _j(local_results), chash, rec.get("created_local_at"), rec.get("completed_at"), now, now, "received",
                       rec.get("workspace_id")))
        else:  # an edit never clears a known workspace
            c.execute("UPDATE records SET revision=?, answers=?, local_results=?, content_hash=?, completed_at=?, "
                      "updated_at=?, device_id=?, sync_status='received', workflow_version=?, "
                      "workspace_id=COALESCE(?, workspace_id) WHERE id=?",
                      (revision, _j(answers), _j(local_results), chash, rec.get("completed_at"), now, device_id,
                       int(rec["workflow_version"]), rec.get("workspace_id"), rid))
            if rec.get("workspace_id"):
                c.execute("UPDATE questions SET workspace_id=? WHERE record_id=?", (rec["workspace_id"], rid))
        c.execute("INSERT INTO record_revisions(record_id, revision, answers, local_results, device_id, created_at) "
                  "VALUES (?,?,?,?,?,?)", (rid, revision, _j(answers), _j(local_results), device_id, now))
        for a in att_meta:
            self._declare_attachment(c, owner, rid, a)
        self._mark_complete_if_files_stored(c, rid)
        self.audit(c, owner, "sync.record", rid, {"revision": revision, "device": device_id})
        resp = self._sync_response(c, rid)
        self._remember(c, owner, idempotency_key, rid, revision, resp)
        return resp

    def _remember(self, c, owner, key, rid, revision, resp) -> None:
        c.execute("INSERT INTO sync_ops(owner_user_id, idempotency_key, record_id, revision, response, created_at) "
                  "VALUES (?,?,?,?,?,?)", (owner, key, rid, revision, _j(resp), _now()))

    @staticmethod
    def _declare_attachment(c, owner: str, rid: str, a: dict) -> None:
        aid, sha = a.get("id"), a.get("sha256")
        if not is_safe_id(aid) or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha):
            raise Invalid("attachment needs an id of 8-64 letters, digits, '_' or '-', and a sha256 (64 hex)")
        existing = c.execute("SELECT record_id, owner_user_id, sha256 FROM attachments WHERE id=?", (aid,)).fetchone()
        if existing:
            if existing["owner_user_id"] != owner or existing["record_id"] != rid or existing["sha256"] != sha:
                raise Invalid(f"attachment {aid} already declared differently")
            return
        c.execute("INSERT INTO attachments(id, record_id, owner_user_id, field_id, mime, size, sha256, status, created_at) "
                  "VALUES (?,?,?,?,?,?,?,?,?)",
                  (aid, rid, owner, a.get("field_id"), a.get("mime"), int(a.get("size") or 0), sha.lower(), "pending", _now()))

    def _mark_complete_if_files_stored(self, c, rid: str) -> None:
        """A record is 'complete' once every declared file is stored. Syncing never starts any processing."""
        pending = c.execute("SELECT COUNT(*) FROM attachments WHERE record_id=? AND status!='stored'", (rid,)).fetchone()[0]
        if not pending:
            c.execute("UPDATE records SET sync_status='complete', updated_at=? WHERE id=?", (_now(), rid))

    def _sync_response(self, c, rid: str) -> dict:
        row = c.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
        need = [r["id"] for r in c.execute("SELECT id FROM attachments WHERE record_id=? AND status!='stored'", (rid,))]
        return {"record_id": rid, "revision": row["revision"], "received_at": row["received_at"],
                "sync_status": row["sync_status"], "attachments_needed": need, "workspace_id": row["workspace_id"]}

    # ------------------------------------------------------------------ record ↔ workspace (0.2.6 fix)
    def workspaces_with_workflow(self, workflow_id: Any) -> list[str]:
        """Published workspaces whose published or earlier published versions contain this workflow (own or referenced).
        Workspaces are instance-wide, like published workflows; drafts never count."""
        if not isinstance(workflow_id, str) or not workflow_id:
            return []
        key = tuple(self._q("SELECT COUNT(*) AS n, MAX(w.updated_at) AS u FROM workspace_versions v "
                            "JOIN workspaces w ON w.id = v.workspace_id")[0])
        cache = getattr(self, "_ws_members", None)
        if not cache or cache[0] != key:
            members: dict[str, set] = {}
            for r in self._q("SELECT v.workspace_id, v.bundle FROM workspace_versions v JOIN workspaces w ON w.id = v.workspace_id "
                             "WHERE w.published_version IS NOT NULL AND v.status IN ('published', 'superseded')"):
                b = _uj(r["bundle"]) or {}
                ids = [w.get("id") for w in (b.get("workflows") or []) if isinstance(w, dict)] + list(b.get("workflow_refs") or [])
                for wf in ids:
                    if isinstance(wf, str):
                        members.setdefault(wf, set()).add(r["workspace_id"])
            cache = (key, members)
            self._ws_members = cache
        return sorted(cache[1].get(workflow_id, set()))

    def resolve_record_workspace(self, workflow_id: Any, claimed: Any) -> tuple[Optional[str], str]:
        """The workspace a record belongs to: the phone's claim when that published workspace contains the record's
        workflow; otherwise the only published workspace containing it; otherwise none (never a guess)."""
        members = self.workspaces_with_workflow(workflow_id)
        if isinstance(claimed, str) and claimed:
            if claimed in members:
                return claimed, ""
            note = f"workspace {claimed!r} is not a published workspace containing workflow {workflow_id!r}"
            if len(members) == 1:
                return members[0], note + f"; stored as {members[0]!r}, the only workspace that contains it"
            return None, note + "; not stored"
        if len(members) == 1:
            return members[0], ""
        if len(members) > 1:
            return None, f"workflow {workflow_id!r} is in {len(members)} workspaces and the phone did not say which; not stored"
        return None, ""

    def repair_record_workspaces(self) -> dict:
        """Fill in the workspace of records synced without one, only where exactly one published workspace contains the
        record's workflow. Never overwrites a stored workspace; ambiguous records stay empty. Idempotent."""
        out = {"repaired": 0, "ambiguous": 0, "no_workspace": 0}
        rows = self._q("SELECT id, owner_user_id, workflow_id FROM records WHERE workspace_id IS NULL")
        for r in rows:
            members = self.workspaces_with_workflow(r["workflow_id"])
            if len(members) != 1:
                out["ambiguous" if members else "no_workspace"] += 1
                continue
            with self.tx() as c:
                n = c.execute("UPDATE records SET workspace_id=? WHERE id=? AND workspace_id IS NULL",
                              (members[0], r["id"])).rowcount
                if n:
                    c.execute("UPDATE questions SET workspace_id=? WHERE record_id=?", (members[0], r["id"]))
                    self.audit(c, r["owner_user_id"], "record.workspace_repaired", r["id"],
                               {"workspace_id": members[0], "workflow_id": r["workflow_id"], "basis": "only workspace containing the workflow"})
                    out["repaired"] += 1
        return out

    def store_attachment(self, owner: str, aid: str, body: bytes, mime: str, base_dir: Path) -> dict:
        if not is_safe_id(aid):
            raise NotFound(str(aid)[:64])   # never a valid declared id (also covers rows declared before 0.3.1)
        sha = hashlib.sha256(body).hexdigest()
        with self.tx() as c:
            row = c.execute("SELECT * FROM attachments WHERE id=? AND owner_user_id=?", (aid, owner)).fetchone()
            if not row:
                raise NotFound(aid)
            if row["status"] == "stored":
                if row["sha256"] != sha:
                    raise Invalid("attachment already stored with different content")
                return {"attachment_id": aid, "status": "stored", "duplicate": True, **self._sync_response(c, row["record_id"])}
            if row["sha256"] != sha:
                raise Invalid("sha256 mismatch: upload corrupted or incomplete")
            user_dir = base_dir / hashlib.sha256(owner.encode()).hexdigest()[:16]
            path = contained(user_dir / aid, base_dir)
            user_dir.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            tmp.write_bytes(body)
            os.replace(tmp, path)
            c.execute("UPDATE attachments SET status='stored', path=?, mime=?, size=?, stored_at=? WHERE id=?",
                      (str(path), mime, len(body), _now(), aid))
            self._mark_complete_if_files_stored(c, row["record_id"])
            self.audit(c, owner, "sync.attachment", aid, {"record": row["record_id"], "size": len(body)})
            return {"attachment_id": aid, "status": "stored", **self._sync_response(c, row["record_id"])}

    def get_attachment(self, owner: Any, aid: str) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT * FROM attachments WHERE id=? AND {clause}", (aid, *args))
        if not rows or rows[0]["status"] != "stored":
            raise NotFound(aid)
        return dict(rows[0])

    # ------------------------------------------------------------------ records
    def _record_dict(self, r: sqlite3.Row, full: bool = True) -> dict:
        d = dict(r)
        d.pop("content_hash", None)
        if full:
            d["answers"] = _uj(d["answers"])
            d["local_results"] = _uj(d["local_results"])
            d["attachments"] = [dict(a) for a in self._q(
                "SELECT id, field_id, mime, size, sha256, status, created_at, stored_at, transcript, transcript_source, "
                "transcript_error FROM attachments WHERE record_id=?", (d["id"],))]
        else:
            d.pop("answers", None)
            d.pop("local_results", None)
        return d

    def _records_where(self, owner: Any, workflow_id: Optional[str], since: Optional[str], until: Optional[str]) -> tuple[str, tuple]:
        clause, args = self._owner_clause(owner)
        sql = f" WHERE {clause}"
        if workflow_id:
            sql += " AND workflow_id=?"
            args = (*args, workflow_id)
        if since:
            sql += " AND COALESCE(completed_at, created_local_at, '') >= ?"
            args = (*args, since)
        if until:
            sql += " AND COALESCE(completed_at, created_local_at, '') <= ?"
            args = (*args, until)
        return sql, args

    def count_records(self, owner: Any, workflow_id: Optional[str] = None, since: Optional[str] = None,
                      until: Optional[str] = None) -> int:
        where, args = self._records_where(owner, workflow_id, since, until)
        return self._q(f"SELECT COUNT(*) n FROM records{where}", args)[0]["n"]

    def list_records(self, owner: Any, workflow_id: Optional[str] = None, limit: int = 50, full: bool = False,
                     since: Optional[str] = None, until: Optional[str] = None, offset: int = 0) -> list[dict]:
        """Newest first, in a stable order (received time, then id) so pages never skip or repeat a record.
        ``since``/``until`` filter on when the entry was completed on the phone (ISO date/time)."""
        where, args = self._records_where(owner, workflow_id, since, until)
        sql = f"SELECT * FROM records{where} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?"
        return [self._record_dict(r, full) for r in self._q(sql, (*args, max(1, min(limit, 500)), max(0, int(offset))))]

    def get_record(self, owner: Any, rid: str) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT * FROM records WHERE id=? AND {clause}", (rid, *args))
        if not rows:
            raise NotFound(rid)
        return self._record_dict(rows[0])

    # ------------------------------------------------------------------ reports & followups
    def get_report(self, owner: Any, report_id: Optional[str] = None, record_id: Optional[str] = None) -> dict:
        clause, args = self._owner_clause(owner)
        if report_id:
            rows = self._q(f"SELECT content FROM reports WHERE id=? AND {clause}", (report_id, *args))
        else:
            rows = self._q(f"SELECT content FROM reports WHERE record_id=? AND {clause} ORDER BY version DESC LIMIT 1",
                           (record_id, *args))
        if not rows:
            raise NotFound(report_id or record_id or "")
        return _uj(rows[0]["content"])

    def record_answers(self, owner: Any, ids: list[str]) -> dict:
        """{record_id: (workflow_id, workflow_version, answers)} for building readable list labels."""
        if not ids:
            return {}
        clause, args = self._owner_clause(owner)
        marks = ",".join("?" * len(ids))
        rows = self._q(f"SELECT id, workflow_id, workflow_version, answers FROM records WHERE id IN ({marks}) AND {clause}",
                       (*ids, *args))
        return {r["id"]: (r["workflow_id"], r["workflow_version"], _uj(r["answers"])) for r in rows}

    # ------------------------------------------------------------------ conflicts
    def list_conflicts(self, owner: Any, status: str = "open") -> list[dict]:
        clause, args = self._owner_clause(owner)
        return [dict(r, client_payload=_uj(r["client_payload"])) for r in
                self._q(f"SELECT * FROM conflicts WHERE status=? AND {clause} ORDER BY created_at DESC", (status, *args))]

    def resolve_conflict(self, owner: Any, cid: str, resolution: str, merged_answers: Optional[dict] = None) -> dict:
        """keep_server: discard client copy. use_client / merge: write a new revision on top of the server's."""
        if resolution not in ("keep_server", "use_client", "merge"):
            raise Invalid("resolution must be keep_server|use_client|merge")
        with self.tx() as c:
            clause, args = self._owner_clause(owner)
            cf = c.execute(f"SELECT * FROM conflicts WHERE id=? AND status='open' AND {clause}", (cid, *args)).fetchone()
            if not cf:
                raise NotFound(cid)
            rec = c.execute("SELECT * FROM records WHERE id=?", (cf["record_id"],)).fetchone()
            new_rev = rec["revision"]
            if resolution != "keep_server":
                payload = _uj(cf["client_payload"])["record"]
                answers = merged_answers if resolution == "merge" else payload["answers"]
                if not isinstance(answers, dict):
                    raise Invalid("merge needs merged_answers object")
                new_rev = rec["revision"] + 1
                c.execute("UPDATE records SET revision=?, answers=?, local_results=?, content_hash=?, updated_at=? WHERE id=?",
                          (new_rev, _j(answers), _j(payload.get("local_results") or {}), content_hash(answers), _now(), rec["id"]))
                c.execute("INSERT INTO record_revisions(record_id, revision, answers, local_results, device_id, created_at) "
                          "VALUES (?,?,?,?,?,?)", (rec["id"], new_rev, _j(answers), _j(payload.get("local_results") or {}),
                                                   _uj(cf["client_payload"]).get("device_id"), _now()))
            c.execute("UPDATE conflicts SET status='resolved', resolution=?, resolved_at=? WHERE id=?", (resolution, _now(), cid))
            self.audit(c, owner, "sync.conflict.resolve", cid, {"resolution": resolution, "revision": new_rev})
        return {"conflict_id": cid, "resolution": resolution, "record_id": cf["record_id"], "revision": new_rev}

    # ------------------------------------------------------------------ overview
    def sync_status(self, owner: Any) -> dict:
        clause, args = self._owner_clause(owner)
        rec = {r["sync_status"]: r["n"] for r in self._q(
            f"SELECT sync_status, COUNT(*) n FROM records WHERE {clause} GROUP BY sync_status", args)}
        att = self._q(f"SELECT COUNT(*) n FROM attachments WHERE status!='stored' AND {clause}", args)[0]["n"]
        conf = self._q(f"SELECT COUNT(*) n FROM conflicts WHERE status='open' AND {clause}", args)[0]["n"]
        last = self._q(f"SELECT MAX(received_at) t FROM records WHERE {clause}", args)[0]["t"]
        devices = [dict(r) for r in self._q(
            f"SELECT id, label, last_seen FROM devices WHERE {clause} ORDER BY last_seen DESC LIMIT 20", args)]
        return {"records_by_sync_status": rec, "attachments_outstanding": att,
                "open_conflicts": conf, "last_received_at": last, "devices": devices}

def _title(v: Any) -> str:
    if isinstance(v, dict):
        return v.get("en") or next(iter(v.values()), "")
    return str(v or "")


_store: Optional[Store] = None
_store_lock = threading.Lock()


def get_store() -> Store:
    global _store
    with _store_lock:
        if _store is None:
            _store = Store()
            try:   # records synced without their workspace (before 0.2.6's fix): fill in only unambiguous ones
                _store.repair_record_workspaces()
            except Exception:  # pragma: no cover - never block opening the store
                pass
        return _store


def set_store(store: Optional[Store]) -> None:
    """Test hook."""
    global _store
    with _store_lock:
        _store = store
