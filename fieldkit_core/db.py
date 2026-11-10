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
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

PLUGIN_NAME = "fieldkit"
ALL = object()  # sentinel: instance-owner scope (Hermes tools)

ANALYSIS_STATES = ("not_requested", "pending", "processing", "completed", "failed", "requires_review")
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
        copy a device downloaded earlier. Never overwrites an existing version and never touches a workflow owned by
        another user. Returns {"restored": bool, "version": n}."""
        wid = definition.get("id")
        version = definition.get("version")
        if not isinstance(wid, str) or not wid or not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= 100000:
            raise Invalid("definition needs an id and an integer version")
        now = _now()
        definition = dict(definition, status="published")
        with self.tx() as c:
            row = c.execute("SELECT * FROM workflows WHERE id=?", (wid,)).fetchone()
            if row and row["owner_user_id"] not in (owner, "owner", "local"):
                raise NotFound(wid)
            if c.execute("SELECT 1 FROM workflow_versions WHERE workflow_id=? AND version=?", (wid, version)).fetchone():
                return {"restored": False, "version": version}
            if row:
                latest = max(row["latest_version"], version)
                published = max(row["published_version"] or 0, version)
                c.execute("UPDATE workflows SET latest_version=?, published_version=?, status='published', updated_at=? WHERE id=?",
                          (latest, published, now, wid))
            else:
                c.execute("INSERT INTO workflows(id, owner_user_id, title, domain, latest_version, published_version, status, "
                          "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                          (wid, owner, _title(definition.get("title")), definition.get("domain", ""), version, version, "published", now, now))
            c.execute("INSERT INTO workflow_versions(workflow_id, version, definition, status, created_at, created_by) "
                      "VALUES (?,?,?,?,?,?)", (wid, version, _j(definition), "published", now, str(owner)))
            self.audit(c, owner, "workflow.restore", wid, {"version": version})
        return {"restored": True, "version": version}

    def publish_workflow(self, owner: Any, wid: str, version: Optional[int] = None) -> dict:
        with self.tx() as c:
            clause, args = self._owner_clause(owner)
            row = c.execute(f"SELECT * FROM workflows WHERE id=? AND {clause}", (wid, *args)).fetchone()
            if not row:
                raise NotFound(wid)
            v = version or row["latest_version"]
            vrow = c.execute("SELECT definition FROM workflow_versions WHERE workflow_id=? AND version=?", (wid, v)).fetchone()
            if not vrow:
                raise NotFound(f"{wid}@{v}")
            definition = dict(_uj(vrow["definition"]), status="published")
            c.execute("UPDATE workflow_versions SET status='published', definition=? WHERE workflow_id=? AND version=?",
                      (_j(definition), wid, v))
            c.execute("UPDATE workflows SET published_version=?, status='published', updated_at=? WHERE id=?", (v, _now(), wid))
            self.audit(c, owner, "workflow.publish", wid, {"version": v})
        return definition

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

    def list_packs(self, owner: Any, kind: Optional[str] = None) -> list[dict]:
        clause, args = self._owner_clause(owner)
        sql = f"SELECT id, kind, version, title, domain, languages, sha256, size, source, updated_at FROM packs WHERE {clause}"
        if kind:
            sql += " AND kind=?"
            args = (*args, kind)
        return [dict(r, languages=_uj(r["languages"]), source=_uj(r["source"])) for r in self._q(sql + " ORDER BY id", args)]

    def get_pack(self, owner: Any, pid: str) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT content, sha256 FROM packs WHERE id=? AND {clause}", (pid, *args))
        if not rows:
            raise NotFound(pid)
        return {"content": rows[0]["content"], "sha256": rows[0]["sha256"]}

    def get_pack_content(self, pid: str) -> Optional[dict]:
        rows = self._q("SELECT content FROM packs WHERE id=?", (pid,))
        return _uj(rows[0]["content"]) if rows else None

    def delete_pack(self, owner: Any, pid: str) -> None:
        with self.tx() as c:
            clause, args = self._owner_clause(owner)
            if not c.execute(f"DELETE FROM packs WHERE id=? AND {clause}", (pid, *args)).rowcount:
                raise NotFound(pid)
            self.audit(c, owner, "pack.delete", pid)

    # ------------------------------------------------------------------ workspaces
    def save_workspace_brief(self, owner: Any, brief: dict, brief_id: Optional[str] = None, confirmed: bool = False) -> dict:
        owner_id = "owner" if owner is ALL else owner
        now = _now()
        bid = brief_id or _id("brf")
        with self.tx() as c:
            row = c.execute("SELECT owner_user_id FROM workspace_briefs WHERE id=?", (bid,)).fetchone()
            if row and owner is not ALL and row["owner_user_id"] != owner:
                raise NotFound(bid)
            c.execute("INSERT INTO workspace_briefs(id, owner_user_id, brief, confirmed, created_at, updated_at) VALUES (?,?,?,?,?,?) "
                      "ON CONFLICT(id) DO UPDATE SET brief=excluded.brief, confirmed=excluded.confirmed, updated_at=excluded.updated_at",
                      (bid, row["owner_user_id"] if row else owner_id, _j(brief), int(confirmed), now, now))
            self.audit(c, owner, "workspace.brief", bid, {"confirmed": confirmed})
        return {"brief_id": bid, "confirmed": confirmed, "brief": brief}

    def get_workspace_brief(self, owner: Any, bid: str) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT * FROM workspace_briefs WHERE id=? AND {clause}", (bid, *args))
        if not rows:
            raise NotFound(bid)
        r = dict(rows[0])
        return {"brief_id": r["id"], "confirmed": bool(r["confirmed"]), "brief": _uj(r["brief"])}

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

    # ------------------------------------------------------------------ workspace builds (parts saved as Hermes adds them)
    def save_workspace_build(self, owner: Any, wid: str, brief_id: str, header: dict, parts: dict) -> None:
        owner_id = "owner" if owner is ALL else owner
        now = _now()
        with self.tx() as c:
            c.execute("INSERT INTO workspace_builds(workspace_id, owner_user_id, brief_id, header, parts, created_at, updated_at) "
                      "VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET brief_id=excluded.brief_id, "
                      "header=excluded.header, parts=excluded.parts, updated_at=excluded.updated_at",
                      (wid, owner_id, brief_id, _j(header), _j(parts), now, now))

    def get_workspace_build(self, wid: str) -> Optional[dict]:
        rows = self._q("SELECT * FROM workspace_builds WHERE workspace_id=?", (wid,))
        if not rows:
            return None
        r = dict(rows[0])
        return {"workspace_id": wid, "brief_id": r["brief_id"], "header": _uj(r["header"]), "parts": _uj(r["parts"]),
                "created_at": r["created_at"], "updated_at": r["updated_at"]}

    def list_workspace_builds(self) -> list[dict]:
        return [self.get_workspace_build(r["workspace_id"]) for r in
                self._q("SELECT workspace_id FROM workspace_builds ORDER BY updated_at DESC")]

    def delete_workspace_build(self, wid: str) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM workspace_builds WHERE workspace_id=?", (wid,))

    def get_source_page(self, url: str) -> Optional[dict]:
        rows = self._q("SELECT * FROM source_pages WHERE url=?", (url,))
        return dict(rows[0]) if rows else None

    def save_source_page(self, url: str, status: str, content: Optional[str], error: Optional[str]) -> None:
        with self.tx() as c:
            c.execute("INSERT INTO source_pages(url, status, content, error, fetched_at) VALUES (?,?,?,?,?) ON CONFLICT(url) "
                      "DO UPDATE SET status=excluded.status, content=excluded.content, error=excluded.error, "
                      "fetched_at=excluded.fetched_at", (url, status, content, error, _now()))

    # ------------------------------------------------------------------ sync
    def sync_record(self, owner: str, idempotency_key: str, device_id: str, rec: dict,
                    auto_analyze: bool, attachments_dir: Optional[Path] = None) -> dict:
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
        base = int(rec.get("base_revision") or 0)
        local_results = rec.get("local_results") or {}
        chash = content_hash(answers)
        now = _now()
        conflict: Optional[dict] = None
        with self.tx() as c:
            resp = self._sync_tx(c, owner, idempotency_key, device_id, rec, rid, answers, base, local_results, chash, now,
                                 auto_analyze)
            if "__conflict__" in resp:
                conflict = resp["__conflict__"]
        if conflict is not None:  # raised only after the conflict row is committed
            raise Conflict(conflict)
        return resp

    def _sync_tx(self, c, owner, idempotency_key, device_id, rec, rid, answers, base, local_results, chash, now,
                 auto_analyze) -> dict:
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
                      "local_results, content_hash, created_local_at, completed_at, received_at, updated_at, sync_status) "
                      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (rid, owner, device_id, rec["workflow_id"], int(rec["workflow_version"]), revision, _j(answers),
                       _j(local_results), chash, rec.get("created_local_at"), rec.get("completed_at"), now, now, "received"))
        else:
            c.execute("UPDATE records SET revision=?, answers=?, local_results=?, content_hash=?, completed_at=?, "
                      "updated_at=?, device_id=?, sync_status='received', workflow_version=? WHERE id=?",
                      (revision, _j(answers), _j(local_results), chash, rec.get("completed_at"), now, device_id,
                       int(rec["workflow_version"]), rid))
        c.execute("INSERT INTO record_revisions(record_id, revision, answers, local_results, device_id, created_at) "
                  "VALUES (?,?,?,?,?,?)", (rid, revision, _j(answers), _j(local_results), device_id, now))
        for a in att_meta:
            self._declare_attachment(c, owner, rid, a)
        self._maybe_complete(c, rid, auto_analyze)
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
        if not isinstance(aid, str) or not (8 <= len(aid) <= 64) or not isinstance(sha, str) or len(sha) != 64:
            raise Invalid("attachment needs id (8-64 chars) and sha256 (64 hex)")
        existing = c.execute("SELECT record_id, owner_user_id, sha256 FROM attachments WHERE id=?", (aid,)).fetchone()
        if existing:
            if existing["owner_user_id"] != owner or existing["record_id"] != rid or existing["sha256"] != sha:
                raise Invalid(f"attachment {aid} already declared differently")
            return
        c.execute("INSERT INTO attachments(id, record_id, owner_user_id, field_id, mime, size, sha256, status, created_at) "
                  "VALUES (?,?,?,?,?,?,?,?,?)",
                  (aid, rid, owner, a.get("field_id"), a.get("mime"), int(a.get("size") or 0), sha.lower(), "pending", _now()))

    def _maybe_complete(self, c, rid: str, auto_analyze: bool) -> None:
        pending = c.execute("SELECT COUNT(*) FROM attachments WHERE record_id=? AND status!='stored'", (rid,)).fetchone()[0]
        if pending:
            return
        row = c.execute("SELECT revision, sync_status FROM records WHERE id=?", (rid,)).fetchone()
        c.execute("UPDATE records SET sync_status='complete', updated_at=? WHERE id=?", (_now(), rid))
        if auto_analyze:
            self._enqueue(c, rid, row["revision"])

    def _enqueue(self, c, rid: str, revision: int) -> str:
        existing = c.execute("SELECT id FROM jobs WHERE kind='analyze' AND record_id=? AND revision=?", (rid, revision)).fetchone()
        if existing:
            return existing["id"]
        jid = _id("job")
        now = _now()
        c.execute("INSERT INTO jobs(id, kind, record_id, revision, status, next_run_at, created_at, updated_at) "
                  "VALUES (?,?,?,?,?,?,?,?)", (jid, "analyze", rid, revision, "pending", now, now, now))
        c.execute("UPDATE records SET analysis_status='pending', analysis_job_id=? WHERE id=?", (jid, rid))
        return jid

    def _sync_response(self, c, rid: str) -> dict:
        row = c.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
        need = [r["id"] for r in c.execute("SELECT id FROM attachments WHERE record_id=? AND status!='stored'", (rid,))]
        return {"record_id": rid, "revision": row["revision"], "received_at": row["received_at"],
                "sync_status": row["sync_status"], "analysis_status": row["analysis_status"],
                "analysis_job_id": row["analysis_job_id"], "attachments_needed": need}

    def store_attachment(self, owner: str, aid: str, body: bytes, mime: str, base_dir: Path, auto_analyze: bool) -> dict:
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
            user_dir.mkdir(parents=True, exist_ok=True)
            path = user_dir / aid
            tmp = path.with_suffix(".part")
            tmp.write_bytes(body)
            os.replace(tmp, path)
            c.execute("UPDATE attachments SET status='stored', path=?, mime=?, size=?, stored_at=? WHERE id=?",
                      (str(path), mime, len(body), _now(), aid))
            self._maybe_complete(c, row["record_id"], auto_analyze)
            self.audit(c, owner, "sync.attachment", aid, {"record": row["record_id"], "size": len(body)})
            return {"attachment_id": aid, "status": "stored", **self._sync_response(c, row["record_id"])}

    def set_attachment_transcript(self, aid: str, transcript: Optional[str], source: Optional[str], error: Optional[str]) -> None:
        with self.tx() as c:
            c.execute("UPDATE attachments SET transcript=?, transcript_source=?, transcript_error=?, transcribed_at=? WHERE id=?",
                      (transcript, source, error, _now(), aid))

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

    def list_records(self, owner: Any, workflow_id: Optional[str] = None, limit: int = 50,
                     analysis_status: Optional[str] = None, full: bool = False) -> list[dict]:
        clause, args = self._owner_clause(owner)
        sql = f"SELECT * FROM records WHERE {clause}"
        if workflow_id:
            sql += " AND workflow_id=?"
            args = (*args, workflow_id)
        if analysis_status:
            sql += " AND analysis_status=?"
            args = (*args, analysis_status)
        sql += " ORDER BY received_at DESC LIMIT ?"
        return [self._record_dict(r, full) for r in self._q(sql, (*args, max(1, min(limit, 500))))]

    def get_record(self, owner: Any, rid: str) -> dict:
        clause, args = self._owner_clause(owner)
        rows = self._q(f"SELECT * FROM records WHERE id=? AND {clause}", (rid, *args))
        if not rows:
            raise NotFound(rid)
        return self._record_dict(rows[0])

    def request_analysis(self, owner: Any, rid: str) -> dict:
        with self.tx() as c:
            clause, args = self._owner_clause(owner)
            row = c.execute(f"SELECT * FROM records WHERE id=? AND {clause}", (rid, *args)).fetchone()
            if not row:
                raise NotFound(rid)
            if row["sync_status"] != "complete":
                raise Invalid("record attachments are still uploading")
            job = c.execute("SELECT * FROM jobs WHERE kind='analyze' AND record_id=? AND revision=?",
                            (rid, row["revision"])).fetchone()
            if job and job["status"] in ("failed", "completed"):
                # explicit re-request: reset the same durable job (keeps uniqueness)
                c.execute("UPDATE jobs SET status='pending', attempts=0, next_run_at=?, last_error=NULL, updated_at=? WHERE id=?",
                          (_now(), _now(), job["id"]))
                c.execute("UPDATE records SET analysis_status='pending', analysis_job_id=? WHERE id=?", (job["id"], rid))
                jid = job["id"]
            else:
                jid = self._enqueue(c, rid, row["revision"])
            self.audit(c, owner, "analysis.request", rid, {"job": jid})
            return {"record_id": rid, "job_id": jid, "analysis_status": "pending"}

    # ------------------------------------------------------------------ jobs
    def claim_jobs(self, limit: int = 2) -> list[dict]:
        now = _now()
        with self.tx() as c:
            rows = c.execute("SELECT * FROM jobs WHERE status='pending' AND next_run_at<=? ORDER BY next_run_at LIMIT ?",
                             (now, limit)).fetchall()
            out = []
            for r in rows:
                c.execute("UPDATE jobs SET status='processing', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'",
                          (now, r["id"]))
                c.execute("UPDATE records SET analysis_status='processing' WHERE id=? AND analysis_job_id=?", (r["record_id"], r["id"]))
                out.append(dict(r, attempts=r["attempts"] + 1))
            return out

    def recover_stale_jobs(self, older_than_s: float = 900) -> int:
        """Jobs left 'processing' by a crashed process go back to pending."""
        with self.tx() as c:
            cutoff = _now() - older_than_s
            n = c.execute("UPDATE jobs SET status='pending', updated_at=? WHERE status='processing' AND updated_at<?",
                          (_now(), cutoff)).rowcount
            return n

    def fail_job(self, job: dict, error: str) -> str:
        with self.tx() as c:
            final = job["attempts"] >= job["max_attempts"]
            status = "failed" if final else "pending"
            delay = min(3600, 30 * (2 ** (job["attempts"] - 1)))
            c.execute("UPDATE jobs SET status=?, last_error=?, next_run_at=?, updated_at=? WHERE id=?",
                      (status, error[:2000], _now() + delay, _now(), job["id"]))
            c.execute("UPDATE records SET analysis_status=? WHERE id=? AND analysis_job_id=?",
                      ("failed" if final else "pending", job["record_id"], job["id"]))
            self.audit(c, ALL, "analysis.error", job["record_id"], {"job": job["id"], "final": final, "error": error[:300]})
            return status

    def complete_job(self, job: dict, report: dict, requires_review: bool, provider: str, model: str,
                     generated_by: str) -> dict:
        with self.tx() as c:
            rec = c.execute("SELECT owner_user_id, revision FROM records WHERE id=?", (job["record_id"],)).fetchone()
            res = self._insert_report(c, job["record_id"], rec["owner_user_id"], job["revision"], report, provider, model,
                                      generated_by, requires_review)
            c.execute("UPDATE jobs SET status='completed', updated_at=?, last_error=NULL WHERE id=?", (_now(), job["id"]))
            return res

    def _insert_report(self, c, rid, owner, revision, report, provider, model, generated_by, requires_review) -> dict:
        v = (c.execute("SELECT MAX(version) FROM reports WHERE record_id=?", (rid,)).fetchone()[0] or 0) + 1
        rep_id = _id("rep")
        report = dict(report, report_id=rep_id, version=v, record_id=rid, record_revision=revision,
                      generated_at=_now(), generated_by=generated_by, provider=provider, model=model)
        c.execute("INSERT INTO reports(id, record_id, owner_user_id, version, record_revision, content, provider, model, "
                  "generated_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (rep_id, rid, owner, v, revision, _j(report), provider, model, generated_by, _now()))
        c.execute("UPDATE records SET report_id=?, report_version=?, analysis_status=? WHERE id=?",
                  (rep_id, v, "requires_review" if requires_review else "completed", rid))
        for f in report.get("followups", []) or []:
            c.execute("INSERT INTO followups(id, record_id, report_id, owner_user_id, title, detail, due_date, status, source, "
                      "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (_id("fu"), rid, rep_id, owner, str(f.get("title", ""))[:300], str(f.get("detail", ""))[:2000],
                       f.get("due_date"), "open", "report", _now(), _now()))
        self.audit(c, ALL, "report.create", rid, {"report": rep_id, "version": v})
        return report

    def save_report_direct(self, rid: str, report: dict, requires_review: bool, generated_by: str) -> dict:
        """Persist a report written by the Hermes agent itself (fieldkit_save_report)."""
        with self.tx() as c:
            rec = c.execute("SELECT owner_user_id, revision, analysis_job_id FROM records WHERE id=?", (rid,)).fetchone()
            if not rec:
                raise NotFound(rid)
            res = self._insert_report(c, rid, rec["owner_user_id"], rec["revision"], report, "hermes-agent", "", generated_by,
                                      requires_review)
            if rec["analysis_job_id"]:
                c.execute("UPDATE jobs SET status='completed', updated_at=? WHERE id=? AND status!='completed'",
                          (_now(), rec["analysis_job_id"]))
            return res

    def report_for_revision(self, rid: str, revision: int) -> Optional[str]:
        rows = self._q("SELECT id FROM reports WHERE record_id=? AND record_revision=? ORDER BY version DESC LIMIT 1",
                       (rid, revision))
        return rows[0]["id"] if rows else None

    def finish_job_without_report(self, job: dict) -> None:
        """Mark a claimed job completed because its revision already has a report (no duplicate report)."""
        with self.tx() as c:
            c.execute("UPDATE jobs SET status='completed', last_error=NULL, updated_at=? WHERE id=?", (_now(), job["id"]))
            rec = c.execute("SELECT analysis_status, report_id FROM records WHERE id=?", (job["record_id"],)).fetchone()
            if rec and rec["analysis_status"] in ("pending", "processing") and rec["report_id"]:
                content = c.execute("SELECT content FROM reports WHERE id=?", (rec["report_id"],)).fetchone()
                review = bool(_uj(content["content"]).get("requires_review")) if content else False
                c.execute("UPDATE records SET analysis_status=? WHERE id=?",
                          ("requires_review" if review else "completed", job["record_id"]))

    def requeue_failed_jobs(self, limit: int = 50) -> int:
        """Give permanently failed analysis jobs one fresh set of attempts (e.g. after a plugin fix).
        Jobs whose revision already has a report are completed instead, so nothing is duplicated."""
        with self.tx() as c:
            rows = c.execute("SELECT * FROM jobs WHERE kind='analyze' AND status='failed' ORDER BY updated_at LIMIT ?",
                             (limit,)).fetchall()
            n = 0
            for j in rows:
                has = c.execute("SELECT 1 FROM reports WHERE record_id=? AND record_revision=?",
                                (j["record_id"], j["revision"])).fetchone()
                if has:
                    c.execute("UPDATE jobs SET status='completed', updated_at=? WHERE id=?", (_now(), j["id"]))
                    continue
                c.execute("UPDATE jobs SET status='pending', attempts=0, next_run_at=?, last_error=NULL, updated_at=? "
                          "WHERE id=?", (_now(), _now(), j["id"]))
                c.execute("UPDATE records SET analysis_status='pending' WHERE id=? AND analysis_job_id=?",
                          (j["record_id"], j["id"]))
                n += 1
            if n:
                self.audit(c, ALL, "analysis.requeue_failed", "", {"count": n})
            return n

    def job_counts(self) -> dict:
        return {r["status"]: r["n"] for r in self._q("SELECT status, COUNT(*) n FROM jobs GROUP BY status")}

    def list_jobs(self, limit: int = 50, owner: Any = ALL) -> list[dict]:
        """Analysis jobs, newest first. A user sees only jobs for their own records (ALL = instance owner)."""
        if owner is ALL:
            return [dict(r) for r in self._q("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?", (limit,))]
        return [dict(r) for r in self._q(
            "SELECT j.* FROM jobs j JOIN records r ON r.id = j.record_id WHERE r.owner_user_id=? "
            "ORDER BY j.updated_at DESC LIMIT ?", (owner, limit))]

    def job_counts_for(self, owner: str) -> dict:
        return {r["status"]: r["n"] for r in self._q(
            "SELECT j.status, COUNT(*) n FROM jobs j JOIN records r ON r.id = j.record_id WHERE r.owner_user_id=? "
            "GROUP BY j.status", (owner,))}

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

    def list_reports(self, owner: Any, record_id: Optional[str] = None, limit: int = 50) -> list[dict]:
        clause, args = self._owner_clause(owner, "r.owner_user_id")
        sql = (f"SELECT r.id, r.record_id, r.version, r.created_at, r.generated_by, r.content, rec.workflow_id "
               f"FROM reports r JOIN records rec ON rec.id=r.record_id WHERE {clause}")
        if record_id:
            sql += " AND r.record_id=?"
            args = (*args, record_id)
        out = []
        for r in self._q(sql + " ORDER BY r.created_at DESC LIMIT ?", (*args, limit)):
            content = _uj(r["content"])
            out.append({"id": r["id"], "record_id": r["record_id"], "workflow_id": r["workflow_id"], "version": r["version"],
                        "created_at": r["created_at"], "generated_by": r["generated_by"],
                        "summary": preview(content.get("summary", ""), 400), "requires_review": content.get("requires_review", False)})
        return out

    def record_answers(self, owner: Any, ids: list[str]) -> dict:
        """{record_id: (workflow_id, workflow_version, answers)} for building readable list labels."""
        if not ids:
            return {}
        clause, args = self._owner_clause(owner)
        marks = ",".join("?" * len(ids))
        rows = self._q(f"SELECT id, workflow_id, workflow_version, answers FROM records WHERE id IN ({marks}) AND {clause}",
                       (*ids, *args))
        return {r["id"]: (r["workflow_id"], r["workflow_version"], _uj(r["answers"])) for r in rows}

    def create_followup(self, owner: Any, title: str, detail: str = "", record_id: Optional[str] = None,
                        due_date: Optional[str] = None, source: str = "user") -> dict:
        with self.tx() as c:
            rec_owner = None
            if record_id:
                clause, args = self._owner_clause(owner)
                r = c.execute(f"SELECT owner_user_id FROM records WHERE id=? AND {clause}", (record_id, *args)).fetchone()
                if not r:
                    raise NotFound(record_id)
                rec_owner = r["owner_user_id"]
            own = rec_owner or ("owner" if owner is ALL else owner)
            fid = _id("fu")
            c.execute("INSERT INTO followups(id, record_id, owner_user_id, title, detail, due_date, status, source, created_at, "
                      "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (fid, record_id, own, title[:300], detail[:2000], due_date, "open", source, _now(), _now()))
            self.audit(c, owner, "followup.create", fid, {"record": record_id})
        return {"id": fid, "title": title, "record_id": record_id, "due_date": due_date, "status": "open"}

    def list_followups(self, owner: Any, record_id: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
        clause, args = self._owner_clause(owner)
        sql = f"SELECT * FROM followups WHERE {clause}"
        if record_id:
            sql += " AND record_id=?"
            args = (*args, record_id)
        if status:
            sql += " AND status=?"
            args = (*args, status)
        return [dict(r) for r in self._q(sql + " ORDER BY created_at DESC LIMIT 200", args)]

    def update_followup(self, owner: Any, fid: str, status: str) -> dict:
        if status not in ("open", "done"):
            raise Invalid("status must be open|done")
        with self.tx() as c:
            clause, args = self._owner_clause(owner)
            if not c.execute(f"UPDATE followups SET status=?, updated_at=? WHERE id=? AND {clause}",
                             (status, _now(), fid, *args)).rowcount:
                raise NotFound(fid)
        return {"id": fid, "status": status}

    # ------------------------------------------------------------------ conflicts
    def list_conflicts(self, owner: Any, status: str = "open") -> list[dict]:
        clause, args = self._owner_clause(owner)
        return [dict(r, client_payload=_uj(r["client_payload"])) for r in
                self._q(f"SELECT * FROM conflicts WHERE status=? AND {clause} ORDER BY created_at DESC", (status, *args))]

    def resolve_conflict(self, owner: Any, cid: str, resolution: str, auto_analyze: bool,
                         merged_answers: Optional[dict] = None) -> dict:
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
                if auto_analyze:
                    self._enqueue(c, rec["id"], new_rev)
            c.execute("UPDATE conflicts SET status='resolved', resolution=?, resolved_at=? WHERE id=?", (resolution, _now(), cid))
            self.audit(c, owner, "sync.conflict.resolve", cid, {"resolution": resolution, "revision": new_rev})
        return {"conflict_id": cid, "resolution": resolution, "record_id": cf["record_id"], "revision": new_rev}

    # ------------------------------------------------------------------ overview
    def sync_status(self, owner: Any) -> dict:
        clause, args = self._owner_clause(owner)
        rec = {r["sync_status"]: r["n"] for r in self._q(
            f"SELECT sync_status, COUNT(*) n FROM records WHERE {clause} GROUP BY sync_status", args)}
        ana = {r["analysis_status"]: r["n"] for r in self._q(
            f"SELECT analysis_status, COUNT(*) n FROM records WHERE {clause} GROUP BY analysis_status", args)}
        att = self._q(f"SELECT COUNT(*) n FROM attachments WHERE status!='stored' AND {clause}", args)[0]["n"]
        conf = self._q(f"SELECT COUNT(*) n FROM conflicts WHERE status='open' AND {clause}", args)[0]["n"]
        last = self._q(f"SELECT MAX(received_at) t FROM records WHERE {clause}", args)[0]["t"]
        devices = [dict(r) for r in self._q(
            f"SELECT id, label, last_seen FROM devices WHERE {clause} ORDER BY last_seen DESC LIMIT 20", args)]
        return {"records_by_sync_status": rec, "records_by_analysis_status": ana, "attachments_outstanding": att,
                "open_conflicts": conf, "last_received_at": last, "devices": devices, "jobs": self.job_counts()}

    def audit_log(self, limit: int = 100) -> list[dict]:
        return [dict(r, detail=_uj(r["detail"])) for r in
                self._q("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,))]


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
        return _store


def set_store(store: Optional[Store]) -> None:
    """Test hook."""
    global _store
    with _store_lock:
        _store = store
