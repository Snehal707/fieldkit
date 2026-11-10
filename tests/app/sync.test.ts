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

  it("sends the entry's workspace and keeps the one Hermes filed it under", async () => {
    handler = () => json(200, ack({ workspace_id: "plant-rounds" }));
    await addRecord({ workspace_id: "plant-rounds" });
    await enqueueRecord("rec_test_000001");
    await runSync();
    const sent = calls.find((c) => c.url.includes("sync/records"))!;
    expect(sent.body.record.workspace_id).toBe("plant-rounds");
    expect((await (await db()).get("records", "rec_test_000001"))!.workspace_id).toBe("plant-rounds");
  });

  it("an old entry without a workspace is sent with null (Hermes fills it in only if unambiguous)", async () => {
    handler = () => json(200, ack({ workspace_id: null }));
    await addRecord();
    await enqueueRecord("rec_test_000001");
    await runSync();
    expect(calls.find((c) => c.url.includes("sync/records"))!.body.record.workspace_id).toBeNull();
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
    expect(r!.sync_status).toBe("received");  // server has the record; media upload interrupted
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

describe("upload again records Hermes no longer has", () => {
  it("re-sends a confirmed record as new (base revision 0, fresh key) and re-uploads its media when asked", async () => {
    const { resendRecords } = await import("../../app/src/sync");
    const { missingOnServer } = await import("../../app/src/device");
    const d = await db();
    await addRecord({ sync_status: "synced", server_revision: 3, server_ack: { received_at: 1, revision: 3, sync_status: "complete" } });
    await addRecord({ id: "rec_test_pending", sync_status: "pending" });
    await d.put("attachments", { id: "att_photo_0001", record_id: "rec_test_000001", field_id: "photo", kind: "photo", mime: "image/jpeg",
      size: 3, sha256: "abc", blob: new Blob(["abc"], { type: "image/jpeg" }), created_at: "", uploaded: true });

    // Detection: only CONFIRMED records missing from a complete server list; never pending ones; never on a truncated list.
    const local = await d.getAll("records");
    expect(missingOnServer(local, [], true).map((r) => r.id)).toEqual(["rec_test_000001"]);
    expect(missingOnServer(local, ["rec_test_000001"], true)).toEqual([]);
    expect(missingOnServer(local, [], false)).toEqual([]);

    await d.put("workflows", { id: "equipment-inspection", version: 1, downloaded_at: "",
      definition: { id: "equipment-inspection", version: 1, title: { en: "Equipment inspection" }, fields: [] } as any });
    handler = (url) => url.endsWith("/workflows/restore") ? json(200, { restored: true, version: 1 }) : url.includes("/attachments/")
      ? json(200, { attachment_id: "att_photo_0001", status: "stored", record_id: "rec_test_000001", sync_status: "complete", analysis_status: "pending" })
      : json(200, ack({ attachments_needed: ["att_photo_0001"] }));
    expect(await resendRecords(["rec_test_000001", "rec_test_pending", "rec_unknown"])).toBe(1);   // only the confirmed one
    // resendRecords starts the upload itself; wait until the queue is empty and the record is confirmed again.
    await vi.waitFor(async () => {
      if (getSyncState().running) await new Promise((r) => setTimeout(r, 10));
      else await runSync({ force: true });
      expect(await d.count("outbox")).toBe(0);
      expect((await d.get("records", "rec_test_000001"))!.sync_status).toBe("synced");
    }, { timeout: 4000, interval: 20 });
    const sent = calls.filter((c) => c.url.endsWith("/sync/records"));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.record.id).toBe("rec_test_000001");
    expect(sent[0].body.record.base_revision).toBe(0);
    // The exact workflow version is put back BEFORE the record is uploaded (a reset Hermes lost it too).
    const restoreAt = calls.findIndex((c) => c.url.endsWith("/workflows/restore"));
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(calls[restoreAt].body.definition).toMatchObject({ id: "equipment-inspection", version: 1 });
    expect(restoreAt).toBeLessThan(calls.findIndex((c) => c.url.endsWith("/sync/records")));              // new on that server, not a stale revision → no conflict
    expect(calls.some((c) => c.url.includes("/attachments/att_photo_0001") && c.method === "PUT")).toBe(true);
    expect((await d.get("records", "rec_test_000001"))!.sync_status).toBe("synced");
    expect((await d.get("records", "rec_test_pending"))!.sync_status).toBe("pending");   // untouched
  });
});

describe("audit fixes", () => {
  it("a record Hermes rejected can be retried (it was stuck forever before)", async () => {
    const { retryRecords } = await import("../../app/src/sync");
    const d = await db();
    await addRecord();
    await d.put("workflows", { id: "equipment-inspection", version: 1, downloaded_at: "",
      definition: { id: "equipment-inspection", version: 1, title: { en: "Equipment inspection" }, fields: [] } as any });
    // First upload: Hermes lacks the workflow → 422 → "error", removed from the queue.
    handler = () => json(422, { detail: "unknown workflow_id/workflow_version" });
    await enqueueRecord("rec_test_000001");
    await runSync({ force: true });
    expect((await d.get("records", "rec_test_000001"))!.sync_status).toBe("error");
    expect(await d.count("outbox")).toBe(0);
    await runSync({ force: true });
    expect((await d.get("records", "rec_test_000001"))!.sync_status).toBe("error");   // nothing retries it by itself
    // Try again: the workflow version goes back first, then the record is accepted.
    calls.length = 0;
    handler = (url) => url.endsWith("/workflows/restore") ? json(200, { restored: true, version: 1 }) : json(200, ack());
    expect(await retryRecords(["rec_test_000001"])).toBe(1);
    await vi.waitFor(async () => {
      if (getSyncState().running) await new Promise((r) => setTimeout(r, 10)); else await runSync({ force: true });
      expect((await d.get("records", "rec_test_000001"))!.sync_status).toBe("synced");
    }, { timeout: 4000, interval: 20 });
    expect(calls.findIndex((c) => c.url.endsWith("/workflows/restore"))).toBeLessThan(calls.findIndex((c) => c.url.endsWith("/sync/records")));
    expect(await retryRecords(["rec_test_000001"])).toBe(0);    // only rejected records are retried this way
  });

  it("one record Hermes doesn't have no longer stops report downloads for the others", async () => {
    await addRecord({ id: "rec_gone_000001", sync_status: "synced", server_revision: 1, analysis_status: "pending" });
    await addRecord({ id: "rec_here_000001", sync_status: "synced", server_revision: 1, analysis_status: "pending" });
    handler = (url) => {
      if (url.includes("rec_gone_000001")) return json(404, { detail: "Not found" });
      if (url.endsWith("/records/rec_here_000001/report")) return json(200, { report_id: "rep_1", version: 1, summary: "ok" });
      return json(200, { id: "rec_here_000001", analysis_status: "completed", report_id: "rep_1", report_version: 1 });
    };
    expect(await refreshReports()).toBe(1);
    expect((await (await db()).get("reports", "rec_here_000001"))?.report_id).toBe("rep_1");
  });
});


// 0.2.6: questions about one visit wait on the phone until that visit has synced, then go to Hermes; the answer comes
// back to the same visit and stays readable offline.
describe("questions about a visit", () => {
  it("queue offline, send after the record syncs, and store the answer with the visit", async () => {
    const { askAboutRecord, questionsFor, syncQuestions } = await import("../../app/src/questions");
    await addRecord({ sync_status: "local" });
    const q = await askAboutRecord("rec_test_000001", "What do the photos show?", "en");
    expect(q).toMatchObject({ status: "queued", record_id: "rec_test_000001", question: "What do the photos show?" });
    handler = () => json(500, {});
    expect(await syncQuestions()).toBe(0);                                  // record not synced yet: nothing sent
    expect(calls.filter((c) => c.url.includes("/questions"))).toHaveLength(0);
    await (await db()).put("records", { ...(await (await db()).get("records", "rec_test_000001"))!, sync_status: "synced" });
    handler = (url, init) => (init.method === "POST" ? json(200, { id: q.id, status: "queued" })
      : json(200, { questions: [{ id: q.id, status: "answered", answer: { answer: "Belt guard missing.", confidence: "medium", next_steps: ["Refit"] } }] }));
    expect(await syncQuestions()).toBe(2);                                  // sent, then answered
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/records/rec_test_000001/questions"))!;
    expect(post.body).toMatchObject({ id: q.id, question: "What do the photos show?" });
    const [got] = await questionsFor("rec_test_000001");
    expect(got.status).toBe("answered");
    expect(got.answer?.answer).toBe("Belt guard missing.");
    await expect(askAboutRecord("rec_test_000001", "   ", "en")).rejects.toThrow();
  });

  it("a failed question shows the reason, and 'Ask again' resends the same id with retry", async () => {
    const { askAboutRecord, askAgain, questionsFor, syncQuestions } = await import("../../app/src/questions");
    await addRecord({ sync_status: "synced", workspace_id: "plant-rounds" });
    const q = await askAboutRecord("rec_test_000001", "What do the photos show?", "en");
    expect(q.workspace_id).toBe("plant-rounds");                           // the entry's workspace, not a guess
    const why = "vision_slot: NotFoundError 404: Not Found; text_only: NotFoundError 404: Not Found";
    handler = (url, init) => (init.method === "POST" ? json(200, { id: q.id, status: "queued" })
      : json(200, { questions: [{ id: q.id, status: "failed", error: why }] }));
    await syncQuestions();
    let [got] = await questionsFor("rec_test_000001");
    expect(got.status).toBe("failed");
    expect(got.error).toBe(why);
    await askAgain(q.id);                                                   // works offline
    [got] = await questionsFor("rec_test_000001");
    expect(got).toMatchObject({ status: "queued", retry: true });
    calls.length = 0;
    handler = (url, init) => (init.method === "POST" ? json(200, { id: q.id, status: "queued" })
      : json(200, { questions: [{ id: q.id, status: "answered", answer: { answer: "Guard missing." } }] }));
    await syncQuestions();
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ id: q.id, retry: true });
    [got] = await questionsFor("rec_test_000001");
    expect(got.status).toBe("answered");
    expect(got.retry).toBeUndefined();
  });
});
