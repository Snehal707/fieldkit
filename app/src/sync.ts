// Durable synchronisation queue.
//
// * Every completed record gets one outbox op with a stable idempotency key (kept across retries).
// * A record is only marked synced after the server acknowledges it; media stays on the device until
//   the server confirms each attachment's SHA-256.
// * 401 pauses the queue (nothing is dropped) until the user signs in again.
// * 409 marks a conflict for the user to resolve; the server never overwrites silently.
// * A browser "online" event only triggers an attempt — reachability is proven by the request itself.
import { memoryBlob } from "./media";
import { AuthRequired, HttpError, Offline, api, loggedFetch } from "./api";
import { apiUrl } from "./config";
import { db, deviceId, getSetting, setSetting, type LocalRecord, type OutboxOp } from "./db";
import { nowIso, uuid } from "./util";

export interface SyncState {
  running: boolean; last_run?: string; last_ok?: string; auth_required: boolean; offline: boolean;
  /** Internal outbox entries (records + individual media uploads). Not shown to users. */
  pending: number;
  /** Records on this device the server has NOT yet fully confirmed (record + every file). */
  awaiting: number;
  /** Of those, records that need the user (conflict or rejected by the server). */
  attention: number;
  /** Inspections started but NOT submitted (still drafts) — never "confirmed", never uploaded. */
  drafts: number;
  /** Last proven reachability of the Hermes FieldKit API — independent of navigator.onLine. */
  reachable: boolean | null;
  last_contact?: string;
  /** When the server last confirmed a record or file. */
  last_confirmed?: string;
  last_error?: string; uploaded: number;
}

let running = false;
const listeners = new Set<(s: SyncState) => void>();
let state: SyncState = { running: false, auth_required: false, offline: false, pending: 0, awaiting: 0, attention: 0, drafts: 0,
  reachable: null, uploaded: 0 };

export function onSyncState(fn: (s: SyncState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function emit(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function getSyncState(): SyncState { return state; }

export async function enqueueRecord(recordId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(["outbox", "records"], "readwrite");
  const existing = await tx.objectStore("outbox").index("by_record").getAll(recordId);
  if (!existing.some((o) => o.kind === "record")) {
    await tx.objectStore("outbox").add({ kind: "record", record_id: recordId, idempotency_key: uuid("idk"),
      created_at: nowIso(), attempts: 0, next_attempt_at: 0 });
  }
  const rec = await tx.objectStore("records").get(recordId);
  if (rec && rec.sync_status !== "conflict") {
    rec.sync_status = "pending";
    await tx.objectStore("records").put(rec);
  }
  await tx.done;
  await refreshPending();
}

/** Recompute counters from durable state. Returns the number of records awaiting server confirmation. */
export async function refreshPending(): Promise<number> {
  const d = await db();
  const [ops, recs, drafts] = await Promise.all([d.count("outbox"), d.getAll("records"), d.count("drafts")]);
  const awaiting = recs.filter((r) => r.sync_status !== "synced").length;
  const attention = recs.filter((r) => r.sync_status === "conflict" || r.sync_status === "error").length;
  emit({ pending: ops, awaiting, attention, drafts });
  return awaiting;
}

function contact(ok: boolean) {
  emit(ok ? { reachable: true, last_contact: nowIso(), offline: false } : { reachable: false, offline: true });
}

/** A genuine FieldKit acknowledgement names this record and a positive revision. Anything else — a captive
 * portal page, a proxy's "200 OK", an ack for another record — is not proof the server stored it. */
function isRecordAck(res: any, recordId: string): boolean {
  return !!res && typeof res === "object" && res.record_id === recordId && Number.isInteger(res.revision) && res.revision >= 1
    && (res.sync_status === "complete" || res.sync_status === "received");
}

function isAttachmentAck(body: any, attachmentId: string): boolean {
  return !!body && typeof body === "object" && body.attachment_id === attachmentId && body.status === "stored";
}

class NotAnAck extends Error { constructor(what: string) { super(`Unconfirmed response for ${what} (not a FieldKit acknowledgement)`); } }

async function updateRecord(id: string, patch: Partial<LocalRecord>): Promise<LocalRecord | undefined> {
  const d = await db();
  const rec = await d.get("records", id);
  if (!rec) return undefined;
  Object.assign(rec, patch);
  await d.put("records", rec);
  return rec;
}

function backoff(attempts: number): number {
  return Date.now() + Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempts, 8));
}

async function sendRecord(op: OutboxOp, dev: string): Promise<"done" | "stop" | "retry"> {
  const d = await db();
  const rec = await d.get("records", op.record_id);
  if (!rec) { await d.delete("outbox", op.seq!); return "done"; }
  const atts = await d.getAllFromIndex("attachments", "by_record", rec.id);
  const payload = {
    idempotency_key: op.idempotency_key, device_id: dev,
    record: {
      id: rec.id, workflow_id: rec.workflow_id, workflow_version: rec.workflow_version, base_revision: rec.server_revision,
      answers: rec.answers, local_results: rec.local_results, created_local_at: rec.created_local_at, completed_at: rec.completed_at,
      attachments: atts.map((a) => ({ id: a.id, field_id: a.field_id, mime: a.mime, size: a.size, sha256: a.sha256 })),
    },
  };
  await updateRecord(rec.id, { sync_status: "syncing", last_sync_attempt: nowIso() });
  try {
    const res = await api<any>("sync/records", { method: "POST", json: payload });
    if (!isRecordAck(res, rec.id)) throw new NotAnAck(`record ${rec.id}`);
    contact(true);
    emit({ last_confirmed: nowIso() });
    const tx = d.transaction(["outbox", "records"], "readwrite");
    await tx.objectStore("outbox").delete(op.seq!);
    for (const aid of res.attachments_needed ?? []) {
      await tx.objectStore("outbox").add({ kind: "attachment", record_id: rec.id, attachment_id: aid,
        idempotency_key: `att:${aid}`, created_at: nowIso(), attempts: 0, next_attempt_at: 0 });
    }
    const r = await tx.objectStore("records").get(rec.id);
    if (r) {
      r.server_revision = res.revision;
      r.server_ack = { received_at: res.received_at, revision: res.revision, sync_status: res.sync_status };
      r.sync_status = res.sync_status === "complete" ? "synced" : "received";
      r.analysis_status = res.analysis_status;
      r.analysis_job_id = res.analysis_job_id;
      r.sync_error = undefined;
      await tx.objectStore("records").put(r);
    }
    await tx.done;
    return "done";
  } catch (e) {
    return handleError(e, op, rec.id);
  }
}

async function sendAttachment(op: OutboxOp): Promise<"done" | "stop" | "retry"> {
  const d = await db();
  const att = await d.get("attachments", op.attachment_id!);
  if (!att) {  // should never happen: media is kept until acknowledged
    await updateRecord(op.record_id, { sync_status: "error", sync_error: `attachment ${op.attachment_id} missing on device` });
    await d.delete("outbox", op.seq!);
    return "done";
  }
  try {
    // Upload (and later re-store) an in-memory copy, never the IndexedDB-backed Blob itself (see media.memoryBlob).
    const { blob: body0 } = await memoryBlob(att.blob, att.mime);
    const res = await loggedFetch(apiUrl(`attachments/${encodeURIComponent(att.id)}`), {
      method: "PUT", body: body0, headers: { "Content-Type": att.mime }, credentials: "same-origin", redirect: "manual",
    });
    if (res.type === "opaqueredirect") throw new AuthRequired(false);
    if (res.status === 401) throw new AuthRequired(true);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(res.status, body);
    if (!isAttachmentAck(body, att.id)) throw new NotAnAck(`file ${att.id}`);
    contact(true);
    emit({ last_confirmed: nowIso() });
    const tx = d.transaction(["outbox", "attachments", "records"], "readwrite");
    await tx.objectStore("outbox").delete(op.seq!);
    const a = await tx.objectStore("attachments").get(att.id);
    if (a) await tx.objectStore("attachments").put({ ...a, uploaded: true, blob: body0 });
    const r = await tx.objectStore("records").get(op.record_id);
    if (r) {
      r.sync_status = body.sync_status === "complete" ? "synced" : "received";
      r.analysis_status = body.analysis_status;
      r.analysis_job_id = body.analysis_job_id;
      await tx.objectStore("records").put(r);
    }
    await tx.done;
    emit({ uploaded: state.uploaded + 1 });
    return "done";
  } catch (e) {
    return handleError(e, op, op.record_id);
  }
}

async function handleError(e: unknown, op: OutboxOp, recordId: string): Promise<"stop" | "retry" | "done"> {
  const d = await db();
  // A media upload failing never "un-receives" a record the server already acknowledged.
  const waiting: LocalRecord["sync_status"] = op.kind === "attachment" ? "received" : "pending";
  // Reachability is proven by what actually came back, not by navigator.onLine.
  // Only a reply PROVEN to come from Hermes counts; a portal redirect or a proxy error page does not.
  if (e instanceof Offline || e instanceof NotAnAck) contact(false);
  else if ((e instanceof AuthRequired || e instanceof HttpError) && e.fromHermes) contact(true);
  else if (e instanceof AuthRequired || e instanceof HttpError) contact(false);
  if (e instanceof AuthRequired) {
    await updateRecord(recordId, { sync_status: waiting });
    emit({ auth_required: true });
    await setSetting("auth_required", true);
    return "stop";
  }
  if (e instanceof Offline) {
    await updateRecord(recordId, { sync_status: waiting });
    return "stop";
  }
  if (e instanceof HttpError && e.status === 409 && e.body?.conflict) {
    const c = e.body.conflict;
    await d.delete("outbox", op.seq!);
    await updateRecord(recordId, { sync_status: "conflict",
      conflict: { conflict_id: c.conflict_id, server_revision: c.server_revision, server_answers: c.server_answers } });
    return "done";
  }
  if (e instanceof HttpError && (e.status === 422 || e.status === 404 || e.status === 413 || e.status === 415)) {
    // Will never succeed as-is: keep the record (never deleted), stop retrying, surface the reason.
    await d.delete("outbox", op.seq!);
    const detail = typeof e.body === "object" ? (e.body?.detail ?? JSON.stringify(e.body)) : String(e.body);
    await updateRecord(recordId, { sync_status: "error", sync_error: `Server rejected (${e.status}): ${detail}` });
    return "done";
  }
  op.attempts += 1;
  op.next_attempt_at = backoff(op.attempts);
  await d.put("outbox", op);
  await updateRecord(recordId, { sync_status: waiting, sync_error: e instanceof Error ? e.message : String(e) });
  emit({ last_error: e instanceof Error ? e.message : String(e) });
  return e instanceof NotAnAck ? "stop" : "retry";
}

/** Process the outbox once. Safe to call often; concurrent calls coalesce. */
/** Upload queued knowledge gaps and feedback (idempotent on the server; verified outcomes travel inside records). */
export async function sendLearning(dev: string): Promise<number> {
  const { markSent, pendingEvents } = await import("./learning");
  const evs = await pendingEvents();
  let sent = 0;
  for (let i = 0; i < evs.length; i += 50) {
    const batch = evs.slice(i, i + 50);
    await api("learning/events", { method: "POST", json: { device_id: dev, events: batch.map(({ sent: _s, ...e }) => e) } });
    await markSent(batch.map((e) => e.id));
    sent += batch.length;
  }
  return sent;
}

export async function runSync(opts: { force?: boolean } = {}): Promise<SyncState> {
  if (running) return state;
  running = true;
  emit({ running: true, last_run: nowIso(), offline: false, last_error: undefined });
  try {
    const dev = await deviceId();
    let attempted = false;
    for (let guard = 0; guard < 500; guard++) {
      const d = await db();
      const ops = await d.getAll("outbox");
      const ready = ops.filter((o) => opts.force || o.next_attempt_at <= Date.now())
        .sort((a, b) => (a.kind === b.kind ? a.seq! - b.seq! : a.kind === "record" ? -1 : 1));
      if (!ready.length) break;
      const op = ready[0];
      attempted = true;
      const outcome = op.kind === "record" ? await sendRecord(op, dev) : await sendAttachment(op);
      if (outcome === "stop") break;
      if (outcome === "retry" && !opts.force) continue;
      if (outcome === "retry" && opts.force) break;
    }
    if (!attempted) await probe();
    if (!state.auth_required && !state.offline) {
      emit({ last_ok: nowIso() });
      await setSetting("auth_required", false);
      await refreshReports().catch(() => undefined);
      await sendLearning(dev).catch(() => undefined);
      await import("./questions").then((m) => m.syncQuestions()).catch(() => undefined);
    }
  } finally {
    running = false;
    await refreshPending();
    emit({ running: false });
  }
  return state;
}

/** Nothing to upload: one cheap authenticated call proves (or disproves) that Hermes is reachable. */
async function probe(): Promise<void> {
  try {
    const me = await api<any>("me");
    contact(!!me && typeof me === "object" && typeof me.user_id === "string");
  } catch (e) {
    contact((e instanceof AuthRequired || e instanceof HttpError) && e.fromHermes);
  }
}

/** Called after the user signs in again. */
export async function clearAuthRequired(): Promise<void> {
  emit({ auth_required: false });
  await setSetting("auth_required", false);
}

export async function restoreAuthFlag(): Promise<void> {
  emit({ auth_required: await getSetting("auth_required", false) });
}

/** Pull analysis status for synced records and download any new Hermes report for offline use. */
export async function refreshReports(recordId?: string): Promise<number> {
  const d = await db();
  const recs = recordId ? [await d.get("records", recordId)].filter(Boolean) as LocalRecord[] : await d.getAll("records");
  let downloaded = 0;
  for (const rec of recs) {
    if (!["synced", "received"].includes(rec.sync_status)) continue;
    const have = await d.get("reports", rec.id);
    if (!recordId && have && have.report_id === rec.report_id && ["completed", "requires_review"].includes(rec.analysis_status)) continue;
    let server: any;
    try { server = await api<any>(`records/${encodeURIComponent(rec.id)}`); }
    catch (e) {
      // Hermes doesn't have this record (its data was reset or moved): skip it, keep refreshing the others.
      // Saved Records offers "Upload again" for such records. Sign-in and connection problems still stop here.
      if (e instanceof HttpError && e.status === 404 && !recordId) continue;
      throw e;
    }
    const patch: Partial<LocalRecord> = { analysis_status: server.analysis_status, analysis_job_id: server.analysis_job_id,
      report_id: server.report_id, report_version: server.report_version };
    if (server.report_id && (!have || have.report_id !== server.report_id)) {
      const report = await api<any>(`records/${encodeURIComponent(rec.id)}/report`);
      await d.put("reports", { record_id: rec.id, report_id: report.report_id, version: report.version, downloaded_at: nowIso(), report });
      patch.report_downloaded_at = nowIso();
      downloaded++;
    }
    await updateRecord(rec.id, patch);
  }
  return downloaded;
}

export async function requestAnalysis(recordId: string): Promise<any> {
  const res = await api<any>(`records/${encodeURIComponent(recordId)}/analyze`, { method: "POST" });
  await updateRecord(recordId, { analysis_status: res.analysis_status, analysis_job_id: res.job_id });
  return res;
}

export async function resolveConflict(recordId: string, resolution: "keep_server" | "use_client"): Promise<void> {
  const d = await db();
  const rec = await d.get("records", recordId);
  if (!rec?.conflict) return;
  const res = await api<any>(`sync/conflicts/${encodeURIComponent(rec.conflict.conflict_id)}/resolve`, { method: "POST", json: { resolution } });
  const patch: Partial<LocalRecord> = { conflict: undefined, server_revision: res.revision, sync_status: "synced" };
  if (resolution === "keep_server") patch.answers = rec.conflict.server_answers;
  await updateRecord(recordId, patch);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoSync(): void {
  if (typeof window === "undefined" || timer) return;
  const kick = () => { void runSync(); };
  window.addEventListener("online", kick);
  window.addEventListener("offline", () => contact(false));  // never keep showing a cached "reachable"
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
  // Re-prove reachability well within the 60 s display window (a cheap /me when nothing is queued).
  timer = setInterval(() => { if (navigator.onLine) kick(); }, 30_000);
  navigator.serviceWorker?.addEventListener("message", (ev) => { if (ev.data?.type === "fieldkit-sync") kick(); });
  kick();
}

/** Background Sync is only an enhancement (Chromium); it wakes an open client, never uploads from a closed app. */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (reg as any)?.sync;
    if (!sync) return false;
    await sync.register("fieldkit-sync");
    return true;
  } catch { return false; }
}

/**
 * Upload records again that Hermes confirmed earlier but no longer has (e.g. its FieldKit data was reset, or the
 * host answered from a different machine/volume). Only on the user's explicit request. Uses the normal outbox:
 * a fresh idempotency key, base revision 0 (new on that server); Hermes then asks again for any media it lacks,
 * which is still on this device. Never touches records that are not confirmed-synced.
 */
export async function resendRecords(ids: string[]): Promise<number> {
  return retryRecords(ids, { missingOnServer: true });
}

/**
 * Upload records again, on the user's request:
 *  - missingOnServer: confirmed records Hermes no longer has → sent as new (base revision 0);
 *  - otherwise: records Hermes REJECTED ("Sync problem", e.g. it lacked the workflow) → sent again as they are.
 * Puts back the exact workflow version first when this device has it. Never touches conflicts or drafts.
 */
export async function retryRecords(ids: string[], opts: { missingOnServer?: boolean } = {}): Promise<number> {
  const d = await db();
  const ok = (r: LocalRecord) => opts.missingOnServer ? (r.sync_status === "synced" || r.sync_status === "received") : r.sync_status === "error";
  const recs = (await Promise.all(ids.map((id) => d.get("records", id)))).filter((r): r is LocalRecord => !!r && ok(r));
  // A reset Hermes has lost the workflows too, and would reject these records (unknown workflow). Put back the exact
  // versions they were made with, from the copies this device downloaded (the server never overwrites a version).
  const needed = new Map(recs.map((r) => [`${r.workflow_id}@${r.workflow_version}`, r]));
  for (const r of needed.values()) {
    const stored = await d.get("workflows", r.workflow_id);
    if (stored?.definition && stored.definition.version === r.workflow_version) {
      try { await api("workflows/restore", { method: "POST", json: { definition: stored.definition } }); }
      catch (e) { if (e instanceof AuthRequired || e instanceof Offline) throw e; /* else: the upload reports it */ }
    }
  }
  let n = 0;
  for (const rec of recs) {
    const id = rec.id;
    await d.put("records", opts.missingOnServer ? { ...rec, server_revision: 0, server_ack: undefined, sync_error: undefined } : { ...rec, sync_error: undefined });
    await enqueueRecord(id);
    n++;
  }
  if (n) void runSync({ force: true });
  return n;
}
