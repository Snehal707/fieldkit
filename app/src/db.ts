// IndexedDB schema for everything FieldKit keeps on the device.
// Unsynchronised records and their media are never deleted automatically.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Answers, Finding, Workflow } from "./engine";

export type SyncStatus = "local" | "pending" | "syncing" | "received" | "synced" | "conflict" | "error";
export type AnalysisStatus = "not_requested" | "pending" | "processing" | "completed" | "failed" | "requires_review";

export interface Reference { pack_id: string; entry_id: string; title: string; source: string; excerpt?: string }
export interface LocalResults {
  followup_checks?: import("./followups").FollowupCheck[];   // answers to the previous report's checks (0.2.5)
  generated_at: string;
  source: "local";
  validation: { complete: boolean; errors: Record<string, string[]>; messages: Record<string, string[]> };
  questions_answered: number;
  questions_visible: number;
  findings: Finding[];
  references: Reference[];
  explanations: { field_id: string; title: string; text: string; source: string }[];
}

export interface Draft {
  id: string; workflow_id: string; workflow_version: number; answers: Answers; started_at: string; updated_at: string; lang: string;
  workspace_id?: string | null;  // the workspace this entry was started in (null when it can't be known for sure)
  followup_checks?: import("./followups").FollowupCheck[];
  questions?: string[];        // questions for Hermes written while filling in the form (0.2.6)
}

export interface LocalRecord {
  id: string;
  workflow_id: string;
  workspace_id?: string | null;
  workflow_version: number;
  workflow_title: string;
  device_id: string;
  answers: Answers;
  local_results: LocalResults;
  created_local_at: string;
  completed_at: string;
  lang: string;
  // synchronisation
  sync_status: SyncStatus;
  server_revision: number;
  server_ack?: { received_at: number; revision: number; sync_status: string };
  sync_error?: string;
  last_sync_attempt?: string;
  conflict?: { conflict_id: string; server_revision: number; server_answers: Answers };
  // analysis
  analysis_status: AnalysisStatus;
  analysis_job_id?: string | null;
  report_id?: string | null;
  report_version?: number | null;
  report_downloaded_at?: string;
}

export interface Attachment {
  id: string; record_id: string; field_id: string; kind: "photo" | "audio" | "signature";
  mime: string; size: number; sha256: string; blob: Blob; created_at: string; uploaded: boolean;
  meta?: { width?: number; height?: number; duration_s?: number; ocr_text?: string; ocr_confidence?: number; transcript?: string; transcript_engine?: string };
}

export interface OutboxOp {
  seq?: number; kind: "record" | "attachment"; record_id: string; attachment_id?: string;
  idempotency_key: string; created_at: string; attempts: number; next_attempt_at: number;
}

export interface InstalledPack {
  id: string; kind: "knowledge" | "dictionary" | "classification" | "workspace"; version: number; sha256: string; size: number;
  title: string; languages: string[]; domain: string; installed_at: string; content: any;
}

export interface InstalledModel {
  id: string; capability: "translation" | "ocr" | "stt" | "embedding"; version: number; title: string; installed_at: string;
  verified: boolean; verify_detail?: string; size?: number; manifest: any;
}

export interface StoredReport { record_id: string; report_id: string; version: number; downloaded_at: string; report: any }
/** A read-only offline copy of a record made on ANOTHER device (kept apart from this device's own records). */
export interface RemoteCopy {
  id: string; workflow_id: string; workflow_title: string; workflow_version: number; device_id: string; device_label: string;
  completed_at?: string; received_at?: number; revision: number; analysis_status: string; answers: Record<string, unknown>;
  local_results: any; report: any | null; report_id?: string | null; downloaded_at: string;
  owner?: string;        // Hermes account that downloaded it; only shown to that account
  attachments?: { id: string; field_id?: string; mime: string; size?: number; sha256?: string; status?: string }[];   // metadata only; files load from Hermes on demand
}
export interface StoredWorkflow {
  id: string; version: number; downloaded_at: string; definition: Workflow;
  /** Earlier versions kept when an update is downloaded, so old records show their own questions (0.2.6). */
  previous?: Record<string, Workflow>;
}

/** The form definition a record was made with (falls back to the current one). */
export function definitionFor(stored: StoredWorkflow | undefined, version: number | undefined): Workflow | undefined {
  if (!stored) return undefined;
  if (version !== undefined && version !== stored.version && stored.previous?.[String(version)]) return stored.previous[String(version)];
  return stored.definition;
}

interface FieldKitDB extends DBSchema {
  settings: { key: string; value: { key: string; value: unknown } };
  workflows: { key: string; value: StoredWorkflow };
  packs: { key: string; value: InstalledPack; indexes: { by_kind: string } };
  models: { key: string; value: InstalledModel };
  drafts: { key: string; value: Draft };
  records: { key: string; value: LocalRecord; indexes: { by_sync: string; by_workflow: string } };
  attachments: { key: string; value: Attachment; indexes: { by_record: string } };
  outbox: { key: number; value: OutboxOp; indexes: { by_record: string } };
  reports: { key: string; value: StoredReport };
  remote: { key: string; value: RemoteCopy };
  learning: { key: string; value: LearningEvent; indexes: { by_sent: number } };
  vectors: { key: string; value: { key: string; vec: number[] } };
  questions: { key: string; value: LocalQuestion; indexes: { by_record: string } };
}

/** A question about one visit, queued on the phone and answered by Hermes from that record (0.2.6). */
export interface LocalQuestion {
  id: string; record_id: string; workspace_id: string | null; question: string; lang: string; attachment_ids: string[];
  status: "queued" | "sent" | "answered" | "failed"; created_at: string; sent_at?: string; answered_at?: string;
  answer?: { answer: string; confidence?: string; uncertainty?: string; evidence_used?: string[]; next_steps?: string[];
    photos_seen?: number; model?: string };
  error?: string;
  retry?: boolean;   // "Ask again" after Hermes could not answer: sent again with the same id
}

/** Feedback, follow-up outcomes and unanswered questions, queued for Hermes (0.2.5). */
export interface LearningEvent {
  id: string; kind: "knowledge_gap" | "user_feedback" | "verified_outcome"; workspace_id?: string; ref_type?: string; ref_id?: string;
  payload: Record<string, unknown>; created_at: string; sent: 0 | 1; idempotency_key: string;
}

export const DB_NAME = "fieldkit";
export const DB_VERSION = 4;
let dbp: Promise<IDBPDatabase<FieldKitDB>> | null = null;

export function db(): Promise<IDBPDatabase<FieldKitDB>> {
  if (!dbp) {
    dbp = openDB<FieldKitDB>(DB_NAME, DB_VERSION, {
      upgrade(d, oldVersion) {
        // Forward-only migrations; each block runs once per device.
        if (oldVersion < 1) {
          d.createObjectStore("settings", { keyPath: "key" });
          d.createObjectStore("workflows", { keyPath: "id" });
          d.createObjectStore("packs", { keyPath: "id" }).createIndex("by_kind", "kind");
          d.createObjectStore("models", { keyPath: "id" });
          d.createObjectStore("drafts", { keyPath: "id" });
          const r = d.createObjectStore("records", { keyPath: "id" });
          r.createIndex("by_sync", "sync_status");
          r.createIndex("by_workflow", "workflow_id");
          d.createObjectStore("attachments", { keyPath: "id" }).createIndex("by_record", "record_id");
          d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("by_record", "record_id");
          d.createObjectStore("reports", { keyPath: "record_id" });
        }
        if (oldVersion < 2) {
          // v2: offline copies of records from the user's OTHER devices. Separate store: never mixed with
          // this device's own records, never queued for sync, never touched by the outbox.
          d.createObjectStore("remote", { keyPath: "id" });
        }
        if (oldVersion < 3) {
          // v3 (0.2.5): learning events for Hermes, and cached sentence vectors for the offline assistant.
          d.createObjectStore("learning", { keyPath: "id" }).createIndex("by_sent", "sent");
          d.createObjectStore("vectors", { keyPath: "key" });
        }
        if (oldVersion < 4) {
          // v4 (0.2.6): questions about one visit, answered by Hermes after sync. Existing stores are untouched.
          d.createObjectStore("questions", { keyPath: "id" }).createIndex("by_record", "record_id");
        }
      },
      blocked() { console.warn("FieldKit DB upgrade blocked by another tab"); },
      terminated() { dbp = null; },
    });
  }
  return dbp;
}

/** Test hook: forget the cached connection (fake-indexeddb resets between tests). */
export function _resetDbForTests(): void { dbp = null; }

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await (await db()).get("settings", key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put("settings", { key, value });
}

export async function deviceId(): Promise<string> {
  let id = await getSetting<string>("device_id", "");
  if (!id) {
    id = `dev_${crypto.getRandomValues(new Uint32Array(2)).join("")}`;
    await setSetting("device_id", id);
  }
  return id;
}

export async function unsyncedCount(): Promise<number> {
  const all = await (await db()).getAll("records");
  return all.filter((r) => !["synced", "received"].includes(r.sync_status)).length;
}

/** Only synced records may be removed without an explicit unsafe confirmation. */
export async function deleteRecord(id: string, allowUnsynced = false): Promise<void> {
  const d = await db();
  const rec = await d.get("records", id);
  if (!rec) return;
  if (rec.sync_status !== "synced" && !allowUnsynced) throw new Error("Record has not been synchronised; refusing to delete.");
  const tx = d.transaction(["records", "attachments", "outbox", "reports"], "readwrite");
  for (const a of await tx.objectStore("attachments").index("by_record").getAll(id)) await tx.objectStore("attachments").delete(a.id);
  for (const o of await tx.objectStore("outbox").index("by_record").getAll(id)) await tx.objectStore("outbox").delete(o.seq!);
  await tx.objectStore("reports").delete(id);
  await tx.objectStore("records").delete(id);
  await tx.done;
}
