// Backup files (Settings → Backup & recovery). Import is all-or-nothing: the whole file is checked first (structure,
// every file decoded and matched against its SHA-256), and only a sound backup is written, in ONE transaction that
// also queues unsent records for upload. A damaged backup changes nothing on the device.
import { db, type Attachment, type Draft, type LocalRecord, type StoredReport } from "./db";
import { sha256Hex, uuid, nowIso } from "./util";

export interface BackupFile {
  format: "fieldkit-backup"; version: number; exported_at: string; device_id: string;
  records: LocalRecord[]; drafts: Draft[]; reports: StoredReport[];
  attachments: (Omit<Attachment, "blob"> & { data_b64: string })[];
}

export class BackupError extends Error {}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

function decodeB64(s: unknown): Uint8Array | null {
  if (typeof s !== "string") return null;
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
}

/** The parts of a backup that will be written; everything checked. */
export interface ImportPlan {
  records: LocalRecord[]; drafts: Draft[]; reports: StoredReport[];
  attachments: (Omit<Attachment, "blob"> & { bytes: Uint8Array })[];
}

/** Read and check a backup file's text. Throws BackupError with a plain explanation; never partially succeeds. */
export async function parseBackup(text: string): Promise<ImportPlan> {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new BackupError("This file isn't a FieldKit backup (it isn't valid JSON, or it was cut off)."); }
  if (!isObj(data) || data.format !== "fieldkit-backup") throw new BackupError("This file isn't a FieldKit backup.");
  const list = (k: string) => {
    const v = data[k] ?? [];
    if (!Array.isArray(v)) throw new BackupError(`This backup is damaged: "${k}" is not a list. Nothing was imported.`);
    return v;
  };
  const records = list("records"), drafts = list("drafts"), reports = list("reports"), atts = list("attachments");
  const problems: string[] = [];
  records.forEach((r: any, i: number) => { if (!isObj(r) || !isId(r.id) || !isObj(r.answers) || !isId(r.workflow_id)) problems.push(`record ${i + 1}`); });
  drafts.forEach((r: any, i: number) => { if (!isObj(r) || !isId(r.id) || !isObj(r.answers) || !isId(r.workflow_id)) problems.push(`draft ${i + 1}`); });
  reports.forEach((r: any, i: number) => { if (!isObj(r) || !isId(r.record_id)) problems.push(`report ${i + 1}`); });
  const decoded: ImportPlan["attachments"] = [];
  for (const [i, a] of atts.entries()) {
    if (!isObj(a) || !isId(a.id) || !isId(a.record_id) || typeof a.sha256 !== "string") { problems.push(`file ${i + 1}`); continue; }
    const bytes = decodeB64(a.data_b64);
    if (!bytes) { problems.push(`file ${a.id} (unreadable)`); continue; }
    if ((await sha256Hex(bytes)) !== a.sha256) { problems.push(`file ${a.id} (content doesn't match its checksum)`); continue; }
    const { data_b64: _drop, ...rest } = a;
    decoded.push({ ...(rest as Omit<Attachment, "blob">), bytes });
  }
  if (problems.length) {
    throw new BackupError(`This backup is damaged (${problems.slice(0, 3).join(", ")}${problems.length > 3 ? `, and ${problems.length - 3} more` : ""}). Nothing was imported.`);
  }
  return { records, drafts, reports, attachments: decoded };
}

/** Write a checked backup: items already on the device are kept as they are (never overwritten). Unsent records are
 *  queued for upload in the same transaction. Returns what was added. */
export async function applyBackup(plan: ImportPlan): Promise<{ records: number; drafts: number; attachments: number; queued: number }> {
  const d = await db();
  const tx = d.transaction(["records", "drafts", "reports", "attachments", "outbox"], "readwrite");
  let records = 0, drafts = 0, attachments = 0, queued = 0;
  const toQueue: string[] = [];
  for (const r of plan.records) {
    if (await tx.objectStore("records").get(r.id)) continue;
    // A record still waiting (or mid-upload) on the old device must upload from this one. ("received" = Hermes has
    // the record but not all its files: re-sending makes Hermes ask for the rest.)
    const unsent = !["synced", "conflict", "error"].includes(r.sync_status);
    await tx.objectStore("records").put(unsent ? { ...r, sync_status: "pending" } : r);
    if (unsent) toQueue.push(r.id);
    records++;
  }
  for (const r of plan.drafts) if (!(await tx.objectStore("drafts").get(r.id))) { await tx.objectStore("drafts").put(r); drafts++; }
  for (const r of plan.reports) if (!(await tx.objectStore("reports").get(r.record_id))) await tx.objectStore("reports").put(r);
  for (const a of plan.attachments) {
    if (await tx.objectStore("attachments").get(a.id)) continue;
    const { bytes, ...rest } = a;
    await tx.objectStore("attachments").put({ ...rest, blob: new Blob([bytes as BlobPart], { type: a.mime }) });
    attachments++;
  }
  for (const id of toQueue) {   // in the same transaction: a restored record can never be left unqueued
    const ops = await tx.objectStore("outbox").index("by_record").getAll(id);
    if (!ops.some((o) => o.kind === "record")) {
      await tx.objectStore("outbox").add({ kind: "record", record_id: id, idempotency_key: uuid("idk"), created_at: nowIso(), attempts: 0, next_attempt_at: 0 });
    }
    queued++;
  }
  await tx.done;
  return { records, drafts, attachments, queued };
}
