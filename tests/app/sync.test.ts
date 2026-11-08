// Sync queue state machine against fake-indexeddb and a scripted server.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDbForTests, db, type LocalRecord } from "../../app/src/db";
import { enqueueRecord, refreshReports, runSync, clearAuthRequired, getSyncState } from "../../app/src/sync";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const calls: { url: string; method: string; body?: any }[] = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  indexedDB = new IDBFactory();  // fresh fake DB per test
  _resetDbForTests();
  calls.length = 0;
  await clearAuthRequired();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url: String(url), method: init.method || "GET", body });
    return handler(String(url), init);
  });
});

async function addRecord(over: Partial<LocalRecord> = {}): Promise<LocalRecord> {
  const rec: LocalRecord = {
    id: "rec_test_000001", workflow_id: "equipment-inspection", workflow_version: 1, workflow_title: "Equipment inspection",
    device_id: "dev", answers: { condition: "poor" }, created_local_at: "2026-11-08T10:00:00Z", completed_at: "2026-11-08T10:05:00Z",
    lang: "en", sync_status: "local", server_revision: 0, analysis_status: "not_requested",
    local_results: { generated_at: "", source: "local", validation: { complete: true, errors: {}, messages: {} },
      questions_answered: 1, questions_visible: 1, findings: [], references: [], explanations: [] },
    ...over,
  };
  await (await db()).put("records", rec);
  return rec;
}

const ack = (extra: object = {}) => ({ record_id: "rec_test_000001", revision: 1, received_at: 1, sync_status: "complete",
  analysis_status: "pending", analysis_job_id: "job_1", attachments_needed: [], ...extra });

describe("sync queue", () => {
  it("acknowledged record is marked synced and dequeued", async () => {
    handler = () => json(200, ack());
    await addRecord();
    await enqueueRecord("rec_test_000001");
    await runSync();
    const r = await (await db()).get("records", "rec_test_000001");
    expect(r!.sync_status).toBe("synced");
    expect(r!.server_revision).toBe(1);
    expect(r!.analysis_status).toBe("pending");  // synced ≠ analysed
    expect(await (await db()).count("outbox")).toBe(0);
  });

  it("network failure keeps the op with the same idempotency key", async () => {
    handler = () => { throw new TypeError("Failed to fetch"); };
    await addRecord();
    await enqueueRecord("rec_test_000001");
    await runSync();
    const ops1 = await (await db()).getAll("outbox");
    expect(ops1).toHaveLength(1);
    expect((await (await db()).get("records", "rec_test_000001"))!.sync_status).toBe("pending");
    handler = () => json(200, ack());
    await runSync({ force: true });
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.body.idempotency_key);
    expect(new Set(keys).size).toBe(1);  // retries reuse the key → server dedupes
    expect(await (await db()).count("outbox")).toBe(0);
  });

  it("401 pauses the queue without losing anything, resumes after sign-in", async () => {
    handler = () => new Response("", { status: 401 });
    await addRecord();
    await enqueueRecord("rec_test_000001");
    await runSync();
    expect(getSyncState().auth_required).toBe(true);
    expect(await (await db()).count("outbox")).toBe(1);
    await clearAuthRequired();
    handler = () => json(200, ack());
    await runSync({ force: true });
    expect((await (await db()).get("records", "rec_test_000001"))!.sync_status).toBe("synced");
  });

  it("409 marks a conflict and keeps local answers", async () => {
    handler = () => json(409, { conflict: { conflict_id: "cfl_1", server_revision: 3, server_answers: { condition: "good" } } });
    await addRecord({ server_revision: 1 });
    await enqueueRecord("rec_test_000001");
    await runSync();
    const r = await (await db()).get("records", "rec_test_000001");
    expect(r!.sync_status).toBe("conflict");
    expect(r!.answers.condition).toBe("poor");
    expect(r!.conflict!.server_answers.condition).toBe("good");
  });

  it("422 stops retrying but never deletes the record", async () => {
    handler = () => json(422, { detail: "unknown workflow_id/workflow_version" });
    await addRecord();
    await enqueueRecord("rec_test_000001");
    await runSync();
    const r = await (await db()).get("records", "rec_test_000001");
    expect(r!.sync_status).toBe("error");
    expect(r!.sync_error).toContain("unknown workflow");
  });

  it("attachments upload after the record ack; media kept until confirmed", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    await addRecord();
    await (await db()).put("attachments", { id: "att_test_0001", record_id: "rec_test_000001", field_id: "photos", kind: "photo",
      mime: "image/jpeg", size: 3, sha256: "a".repeat(64), blob, created_at: "", uploaded: false });
    let putCount = 0;
    handler = (url, init) => {
      if (init.method === "PUT") {
        putCount++;
        if (putCount === 1) throw new TypeError("connection dropped");
        return json(200, { attachment_id: "att_test_0001", status: "stored", sync_status: "complete", analysis_status: "pending" });
      }
      return json(200, ack({ sync_status: "received", attachments_needed: ["att_test_0001"], analysis_status: "not_requested" }));
    };
    await enqueueRecord("rec_test_000001");
    await runSync();
    let r = await (await db()).get("records", "rec_test_000001");
    expect(r!.sync_status).toBe("pending");  // interrupted upload
    expect((await (await db()).get("attachments", "att_test_0001"))!.uploaded).toBe(false);
    await runSync({ force: true });
    r = await (await db()).get("records", "rec_test_000001");
    expect(r!.sync_status).toBe("synced");
    expect((await (await db()).get("attachments", "att_test_0001"))!.uploaded).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);  // record not re-sent
  });

  it("downloads a Hermes report for offline use", async () => {
    await addRecord({ sync_status: "synced", server_revision: 1, analysis_status: "pending" });
    handler = (url) => url.endsWith("/report")
      ? json(200, { report_id: "rep_1", version: 1, summary: "All good", source: "hermes" })
      : json(200, { analysis_status: "completed", analysis_job_id: "job_1", report_id: "rep_1", report_version: 1 });
    expect(await refreshReports()).toBe(1);
    const stored = await (await db()).get("reports", "rec_test_000001");
    expect(stored!.report.summary).toBe("All good");
    const r = await (await db()).get("records", "rec_test_000001");
    expect(r!.analysis_status).toBe("completed");
    expect(r!.report_downloaded_at).toBeTruthy();
    // second refresh does not re-download
    expect(await refreshReports()).toBe(0);
  });
});
