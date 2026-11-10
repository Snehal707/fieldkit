// v1 → v2 IndexedDB migration must keep every existing record, queued upload, draft and report.
import { beforeEach, expect, it } from "vitest";
import { _resetDbForTests, db, DB_VERSION } from "../../app/src/db";

beforeEach(() => { indexedDB = new IDBFactory(); _resetDbForTests(); });

function openV1(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("fieldkit", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("settings", { keyPath: "key" });
      d.createObjectStore("workflows", { keyPath: "id" });
      d.createObjectStore("packs", { keyPath: "id" }).createIndex("by_kind", "kind");
      d.createObjectStore("models", { keyPath: "id" });
      d.createObjectStore("drafts", { keyPath: "id" });
      const rec = d.createObjectStore("records", { keyPath: "id" });
      rec.createIndex("by_sync", "sync_status"); rec.createIndex("by_workflow", "workflow_id");
      d.createObjectStore("attachments", { keyPath: "id" }).createIndex("by_record", "record_id");
      d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("by_record", "record_id");
      d.createObjectStore("reports", { keyPath: "record_id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function put(d: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((res, rej) => { const t = d.transaction(store, "readwrite"); t.objectStore(store).put(value); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}

it("upgrades a v1 database without losing data and adds the separate remote store", async () => {
  const v1 = await openV1();
  await put(v1, "records", { id: "rec_old_00001", sync_status: "pending", workflow_id: "w", answers: { a: 1 } });
  await put(v1, "outbox", { kind: "record", record_id: "rec_old_00001", idempotency_key: "idk_1", attempts: 0, next_attempt_at: 0 });
  await put(v1, "drafts", { id: "rec_draft_0001", workflow_id: "w", answers: {} });
  await put(v1, "settings", { key: "device_id", value: "dev_kept_123" });
  v1.close();

  expect(DB_VERSION).toBe(4);
  const d = await db();
  expect([...d.objectStoreNames]).toContain("remote");
  expect([...d.objectStoreNames]).toEqual(expect.arrayContaining(["learning", "vectors", "questions"]));   // v3 (0.2.5), v4 (0.2.6)
  expect((await d.get("records", "rec_old_00001"))?.sync_status).toBe("pending");
  expect(await d.count("outbox")).toBe(1);
  expect(await d.get("drafts", "rec_draft_0001")).toBeTruthy();
  expect((await d.get("settings", "device_id"))?.value).toBe("dev_kept_123");   // same device id after upgrade
  expect(await d.count("remote")).toBe(0);
});
