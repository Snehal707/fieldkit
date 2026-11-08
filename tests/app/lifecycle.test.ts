// Record lifecycle regression tests: true offline submission, reconnect, failed uploads, counter accuracy,
// and never treating a non-FieldKit 200 (captive portal / proxy page) as a server acknowledgement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { _resetDbForTests, db, type Draft } from "../../app/src/db";
import type { Workflow } from "../../app/src/engine";
import { completeDraft } from "../../app/src/results";
import { clearAuthRequired, getSyncState, refreshPending, runSync } from "../../app/src/sync";

const wf: Workflow = JSON.parse(readFileSync(resolve(__dirname, "../../examples/maintenance/workflow.json"), "utf-8"));
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const offline: Handler = () => { throw new TypeError("Load failed"); };  // what iOS Safari throws with no network

beforeEach(async () => {
  indexedDB = new IDBFactory();
  _resetDbForTests();
  await clearAuthRequired();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => handler(String(url), init));
  handler = offline;
});

async function submit(id = "rec_life_000001", attachments = false): Promise<string> {
  const draft: Draft = { id, workflow_id: wf.id, workflow_version: 1, started_at: "2026-11-09T09:00:00Z", updated_at: "", lang: "en",
    answers: { asset_id: "PMP-0043", inspection_date: "2026-11-09", condition: "fair", guard_ok: true,
      ...(attachments ? { photos: [{ attachment_id: "att_life_photo1" }] } : {}) } };
  const d = await db();
  await d.put("workflows", { id: wf.id, version: 1, downloaded_at: "", definition: wf });
  await d.put("drafts", draft);
  if (attachments) {
    await d.put("attachments", { id: "att_life_photo1", record_id: id, field_id: "photos", kind: "photo", mime: "image/jpeg",
      size: 3, sha256: "b".repeat(64), blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), created_at: "", uploaded: false });
  }
  await completeDraft(draft, wf);
  return id;
}

const ack = (id: string, extra: object = {}) => ({ record_id: id, revision: 1, received_at: 1_794_000_000, sync_status: "complete",
  analysis_status: "pending", analysis_job_id: "job_1", attachments_needed: [], ...extra });

describe("record lifecycle", () => {
  it("true offline submission: record and its queue entry are durable; counter shows it", async () => {
    const id = await submit();
    const d = await db();
    expect((await d.get("records", id))!.sync_status).toBe("pending");
    expect(await d.count("outbox")).toBe(1);
    expect(await d.get("drafts", id)).toBeUndefined();
    expect(getSyncState().awaiting).toBe(1);
    await runSync();
    expect((await d.get("records", id))!.sync_status).toBe("pending");
    expect(getSyncState().awaiting).toBe(1);
    expect(getSyncState().reachable).toBe(false);  // Hermes not reachable, regardless of navigator.onLine
  });

  it("reconnect: server ack → synced, counter 0, Hermes reachable", async () => {
    const id = await submit();
    await runSync();
    handler = () => json(200, ack(id));
    await runSync({ force: true });
    expect((await (await db()).get("records", id))!.sync_status).toBe("synced");
    expect(getSyncState().awaiting).toBe(0);
    expect(getSyncState().reachable).toBe(true);
    expect(getSyncState().last_confirmed).toBeTruthy();
  });

  it("captive portal / proxy 200 HTML is NOT an acknowledgement", async () => {
    const id = await submit();
    handler = () => new Response("<html>Sign in to Wi-Fi</html>", { status: 200, headers: { "content-type": "text/html" } });
    await runSync();
    const r = await (await db()).get("records", id);
    expect(r!.sync_status).toBe("pending");
    expect(r!.server_ack).toBeUndefined();
    expect(await (await db()).count("outbox")).toBe(1);
    expect(getSyncState().awaiting).toBe(1);
  });

  it("an ack for a different record is rejected", async () => {
    const id = await submit();
    handler = () => json(200, ack("rec_someone_else"));
    await runSync();
    expect((await (await db()).get("records", id))!.sync_status).toBe("pending");
  });

  it("failed media upload: record received but still counted until every file is confirmed", async () => {
    const id = await submit("rec_life_000002", true);
    handler = (url, init) => (init.method === "PUT"
      ? json(500, { detail: "disk full" })
      : json(200, ack(id, { sync_status: "received", attachments_needed: ["att_life_photo1"], analysis_status: "not_requested" })));
    await runSync();
    const d = await db();
    expect((await d.get("records", id))!.sync_status).toBe("received");
    expect(getSyncState().awaiting).toBe(1);   // not "0 queued" while the photo is unconfirmed
    expect((await d.get("attachments", "att_life_photo1"))!.uploaded).toBe(false);
    handler = (url, init) => (init.method === "PUT"
      ? json(200, { attachment_id: "att_life_photo1", status: "stored", sync_status: "complete", analysis_status: "pending", record_id: id })
      : json(200, ack(id)));
    await runSync({ force: true });
    expect((await d.get("records", id))!.sync_status).toBe("synced");
    expect(getSyncState().awaiting).toBe(0);
  });

  it("attachment ack must name the uploaded file", async () => {
    const id = await submit("rec_life_000003", true);
    handler = (url, init) => (init.method === "PUT"
      ? new Response("OK", { status: 200, headers: { "content-type": "text/plain" } })
      : json(200, ack(id, { sync_status: "received", attachments_needed: ["att_life_photo1"] })));
    await runSync();
    expect((await (await db()).get("attachments", "att_life_photo1"))!.uploaded).toBe(false);
    expect(getSyncState().awaiting).toBe(1);
  });

  it("rejected record (422) still counts as needing attention, never as done", async () => {
    await submit();
    handler = () => json(422, { detail: "unknown workflow_id/workflow_version" });
    await runSync();
    expect(getSyncState().awaiting).toBe(1);
    expect(getSyncState().attention).toBe(1);
  });

  it("counter reflects records, not internal queue entries", async () => {
    await submit("rec_life_000004");
    await submit("rec_life_000005");
    expect(await refreshPending()).toBe(2);
  });
});
