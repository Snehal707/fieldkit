// Turns a finished draft into a durable local record (validation result only) and queues it for sync.
import { db, deviceId, type Draft, type LocalRecord, type LocalResults } from "./db";
import { cleanAnswers, summarize, text, type Workflow } from "./engine";
import { refreshPending } from "./sync";
import { nowIso, uuid } from "./util";

export function buildLocalResults(wf: Workflow, answers: Record<string, unknown>, lang: string): LocalResults {
  return { generated_at: nowIso(), source: "local", ...summarize(wf, answers, lang) };
}

/** Turn a finished draft into a durable local record + queued sync op, in that order. */
export async function completeDraft(draft: Draft, wf: Workflow): Promise<LocalRecord> {
  const answers = cleanAnswers(wf, draft.answers);
  const local = buildLocalResults(wf, answers, draft.lang);
  if (!local.validation.complete) throw new Error("Workflow has unanswered required questions.");
  const rec: LocalRecord = {
    id: draft.id, workflow_id: wf.id, workspace_id: draft.workspace_id ?? null, workflow_version: wf.version ?? 1, workflow_title: text(wf.title, draft.lang),
    device_id: await deviceId(), answers, local_results: local, created_local_at: draft.started_at, completed_at: nowIso(),
    lang: draft.lang, sync_status: "pending", server_revision: 0,
  };
  // ONE transaction: the record, its sync-queue entry and the draft removal commit together or not at all,
  // so a record can never exist without being queued (e.g. if iOS kills the app mid-save).
  const d = await db();
  const tx = d.transaction(["records", "drafts", "outbox"], "readwrite");
  await tx.objectStore("records").put(rec);
  await tx.objectStore("outbox").add({ kind: "record", record_id: rec.id, idempotency_key: uuid("idk"),
    created_at: nowIso(), attempts: 0, next_attempt_at: 0 });
  await tx.objectStore("drafts").delete(draft.id);
  await tx.done;
  await refreshPending();
  return rec;
}
