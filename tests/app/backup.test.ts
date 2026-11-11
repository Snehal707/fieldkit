// Backup import is all-or-nothing: a damaged file changes nothing; a sound one restores everything, keeps what is
// already on the device, and queues unsent records for upload in the same step.
import { beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests, db } from "../../app/src/db";
import { applyBackup, BackupError, parseBackup } from "../../app/src/backup";
import { sha256Hex } from "../../app/src/util";

beforeEach(() => { indexedDB = new IDBFactory(); _resetDbForTests(); });

const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const rec = (id: string, sync_status: string, extra: object = {}) => ({ id, workflow_id: "f", workflow_version: 1, workflow_title: "F", device_id: "dev_old", answers: { a: 1 },
  local_results: {}, created_local_at: "", completed_at: "2026-11-10T10:00:00Z", lang: "hi", sync_status, server_revision: 1, workspace_id: "ws1", ...extra });
async function file(over: Record<string, unknown> = {}) {
  const sha = await sha256Hex(bytes);
  return JSON.stringify({ format: "fieldkit-backup", version: 1, exported_at: "", device_id: "dev_old",
    records: [rec("rec_synced_01", "synced"), rec("rec_pend_0001", "pending"), rec("rec_recv_0001", "received")],
    drafts: [{ id: "rec_draft_001", workflow_id: "f", workflow_version: 1, answers: {}, started_at: "", updated_at: "", lang: "hi", workspace_id: "ws1" }],
    reports: [{ record_id: "rec_synced_01", report_id: "rep1", version: 1, downloaded_at: "", report: {} }],
    attachments: [{ id: "att_one_00001", record_id: "rec_pend_0001", field_id: "p", kind: "photo", mime: "image/jpeg", size: bytes.length, sha256: sha,
      created_at: "", uploaded: false, meta: {}, data_b64: b64(bytes) }], ...over });
}
const counts = async () => { const d = await db(); return { r: await d.count("records"), d: await d.count("drafts"), a: await d.count("attachments"), o: await d.count("outbox") }; };

describe("checking a backup", () => {
  it("refuses files that are not FieldKit backups", async () => {
    await expect(parseBackup("{oops")).rejects.toThrow(BackupError);
    await expect(parseBackup(JSON.stringify({ format: "other" }))).rejects.toThrow("isn't a FieldKit backup");
    await expect(parseBackup((await file()).slice(0, 100))).rejects.toThrow("cut off");
  });
  it("refuses damaged content, naming it, before anything is written", async () => {
    await expect(parseBackup(await file({ attachments: [{ ...JSON.parse(await file()).attachments[0], data_b64: "@@bad@@" }] }))).rejects.toThrow("unreadable");
    await expect(parseBackup(await file({ attachments: [{ ...JSON.parse(await file()).attachments[0], data_b64: b64(new Uint8Array([9, 9])) }] }))).rejects.toThrow("checksum");
    await expect(parseBackup(await file({ records: [{ answers: {} }] }))).rejects.toThrow("record 1");
    await expect(parseBackup(await file({ drafts: "nope" }))).rejects.toThrow("not a list");
    expect(await counts()).toEqual({ r: 0, d: 0, a: 0, o: 0 });
  });
});

describe("restoring a backup", () => {
  it("restores everything exactly, keeps language and workspace, and queues unsent records", async () => {
    const r = await applyBackup(await parseBackup(await file()));
    expect(r).toEqual({ records: 3, drafts: 1, attachments: 1, queued: 2 });
    const d = await db();
    expect((await d.get("records", "rec_synced_01"))!.sync_status).toBe("synced");
    expect((await d.get("records", "rec_recv_0001"))!.sync_status).toBe("pending");          // re-sent: Hermes asks for missing files
    expect((await d.get("records", "rec_pend_0001"))).toMatchObject({ lang: "hi", workspace_id: "ws1", answers: { a: 1 } });
    expect((await d.get("drafts", "rec_draft_001"))!.lang).toBe("hi");
    const att = (await d.get("attachments", "att_one_00001"))!;
    expect(await sha256Hex(att.blob)).toBe(att.sha256);
    expect((await d.getAll("outbox")).map((o) => o.record_id).sort()).toEqual(["rec_pend_0001", "rec_recv_0001"]);
  });
  it("never duplicates or overwrites what is already on the device", async () => {
    const d = await db();
    await d.put("records", rec("rec_synced_01", "synced", { answers: { kept: true } }) as any);
    await applyBackup(await parseBackup(await file()));
    const again = await applyBackup(await parseBackup(await file()));
    expect(again).toEqual({ records: 0, drafts: 0, attachments: 0, queued: 0 });
    expect((await d.get("records", "rec_synced_01"))!.answers).toEqual({ kept: true });
    expect(await counts()).toEqual({ r: 3, d: 1, a: 1, o: 2 });
  });
});
