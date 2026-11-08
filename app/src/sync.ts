// Durable synchronisation queue.
//
// * Every completed record gets one outbox op with a stable idempotency key (kept across retries).
// * A record is only marked synced after the server acknowledges it; media stays on the device until
//   the server confirms each attachment's SHA-256.
// * 401 pauses the queue (nothing is dropped) until the user signs in again.
// * 409 marks a conflict for the user to resolve; the server never overwrites silently.
// * A browser "online" event only triggers an attempt — reachability is proven by the request itself.
import { AuthRequired, HttpError, Offline, api } from "./api";
import { apiUrl } from "./config";
import { db, deviceId, getSetting, setSetting, type LocalRecord, type OutboxOp } from "./db";
import { nowIso, uuid } from "./util";

export interface SyncState {
  running: boolean; last_run?: string; last_ok?: string; auth_required: boolean; offline: boolean;
  pending: number; last_error?: string; uploaded: number;
}

let running = false;
const listeners = new Set<(s: SyncState) => void>();
let state: SyncState = { running: false, auth_required: false, offline: false, pending: 0, uploaded: 0 };

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

export async function refreshPending(): Promise<number> {
  const n = await (await db()).count("outbox");
  emit({ pending: n });
  return n;
}

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
    let res: Response;
    try {
      res = await fetch(apiUrl(`attachments/${encodeURIComponent(att.id)}`), {
        method: "PUT", body: att.blob, headers: { "Content-Type": att.mime }, credentials: "same-origin", redirect: "manual",
      });
    } catch { throw new Offline(); }
    if (res.status === 401 || res.type === "opaqueredirect") throw new AuthRequired();
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(res.status, body);
    const tx = d.transaction(["outbox", "attachments", "records"], "readwrite");
    await tx.objectStore("outbox").delete(op.seq!);
    const a = await tx.objectStore("attachments").get(att.id);
    if (a) { a.uploaded = true; await tx.objectStore("attachments").put(a); }
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
  if (e instanceof AuthRequired) {
    await updateRecord(recordId, { sync_status: "pending" });
    emit({ auth_required: true });
    await setSetting("auth_required", true);
    return "stop";
  }
  if (e instanceof Offline) {
    await updateRecord(recordId, { sync_status: "pending" });
    emit({ offline: true });
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
  await updateRecord(recordId, { sync_status: "pending", sync_error: e instanceof Error ? e.message : String(e) });
  emit({ last_error: e instanceof Error ? e.message : String(e) });
  return "retry";
}

/** Process the outbox once. Safe to call often; concurrent calls coalesce. */
export async function runSync(opts: { force?: boolean } = {}): Promise<SyncState> {
  if (running) return state;
  running = true;
  emit({ running: true, last_run: nowIso(), offline: false, last_error: undefined });
  try {
    const dev = await deviceId();
    for (let guard = 0; guard < 500; guard++) {
      const d = await db();
      const ops = await d.getAll("outbox");
      const ready = ops.filter((o) => opts.force || o.next_attempt_at <= Date.now())
        .sort((a, b) => (a.kind === b.kind ? a.seq! - b.seq! : a.kind === "record" ? -1 : 1));
      if (!ready.length) break;
      const op = ready[0];
      const outcome = op.kind === "record" ? await sendRecord(op, dev) : await sendAttachment(op);
      if (outcome === "stop") break;
      if (outcome === "retry" && !opts.force) continue;
      if (outcome === "retry" && opts.force) break;
    }
    if (!state.auth_required && !state.offline) {
      emit({ last_ok: nowIso() });
      await setSetting("auth_required", false);
      await refreshReports().catch(() => undefined);
    }
  } finally {
    running = false;
    await refreshPending();
    emit({ running: false });
  }
  return state;
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
    const server = await api<any>(`records/${encodeURIComponent(rec.id)}`);
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
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
  timer = setInterval(() => { if (navigator.onLine) kick(); }, 60_000);
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
