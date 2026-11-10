// Sync queue state machine against fake-indexeddb and a scripted server.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDbForTests, db, type LocalRecord } from "../../app/src/db";
import { downloadEarlierReport, enqueueRecord, runSync, clearAuthRequired, getSyncState } from "../../app/src/sync";

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
    lang: "en", sync_status: "local", server_revision: 0,
    local_results: { generated_at: "", source: "local", validation: { complete: true, errors: {}, messages: {} },
      questions_answered: 1, questions_visible: 1 },
    ...over,
  };
  await (await db()).put("records", rec);
  return rec;
}

const ack = (extra: object = {}) => ({ record_id: "rec_test_000001", revision: 1, received_at: 1, sync_status: "complete",
  attachments_needed: [], ...extra });

describe("sync queue", () => {
  it("acknowledged record is marked synced and dequeued", async () => {
    handler = () => json(200, ack());
    await addRecord();
    await enqueueRecord("rec_test_000001");
    await runSync();
    const r = await (await db()).get("records", "rec_test_000001");
    expect(r!.sync_status).toBe("synced");
    expect(r!.server_revision).toBe(1);
    expect(calls.some((c) => /analyze|questions|learning/.test(c.url))).toBe(false);   // syncing only uploads
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
        return json(200, { attachment_id: "att_test_0001", status: "stored", sync_status: "complete" });
      }
      return json(200, ack({ sync_status: "received", attachments_needed: ["att_test_0001"] }));
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

  it("downloads a report made before 0.3 for offline reading, once", async () => {
    await addRecord({ sync_status: "synced", server_revision: 1 });
    handler = (url) => url.endsWith("/report")
      ? json(200, { report_id: "rep_1", version: 1, summary: "All good", source: "hermes" })
      : json(200, { report_id: "rep_1", report_version: 1 });
    expect(await downloadEarlierReport("rec_test_000001")).toBe(true);
    expect((await (await db()).get("reports", "rec_test_000001"))!.report.summary).toBe("All good");
    expect(await downloadEarlierReport("rec_test_000001")).toBe(false);          // not downloaded twice
    handler = () => json(200, { report_id: null });
    await addRecord({ id: "rec_noreport_01", sync_status: "synced", server_revision: 1 });
    expect(await downloadEarlierReport("rec_noreport_01")).toBe(false);
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
      ? json(200, { attachment_id: "att_photo_0001", status: "stored", record_id: "rec_test_000001", sync_status: "complete" })
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

});


