// Unfinished entries: opening a form saves nothing; real input saves a draft; deleting a draft removes only that draft
// and the files captured for it, never a completed record or another entry's files.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { _resetDbForTests, db, type Draft } from "../../app/src/db";
import type { Workflow } from "../../app/src/engine";
import { completeDraft, deleteDraft, hasMeaningfulInput } from "../../app/src/results";
import { getSyncState, refreshPending } from "../../app/src/sync";

const wf: Workflow = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/forms/maintenance.json"), "utf-8"));

beforeEach(() => {
  indexedDB = new IDBFactory();
  _resetDbForTests();
});

const draft = (id: string, answers: Record<string, unknown> = {}): Draft =>
  ({ id, workflow_id: wf.id, workflow_version: 1, started_at: "2026-11-11T09:00:00Z", updated_at: "", lang: "en", answers });
const file = (id: string, record_id: string) => ({ id, record_id, field_id: "photos", kind: "photo" as const, mime: "image/jpeg", size: 3,
  sha256: "c".repeat(64), blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), created_at: "", uploaded: false });

describe("when an entry becomes a draft", () => {
  it("opening a form (defaults only) is not input", () => {
    expect(hasMeaningfulInput({}, {})).toBe(false);
    expect(hasMeaningfulInput({ units: "h" }, { units: "h" })).toBe(false);
  });
  it("a typed answer, a changed default, a cleared default or a captured file is input", () => {
    expect(hasMeaningfulInput({ asset_id: "P" }, {})).toBe(true);
    expect(hasMeaningfulInput({ units: "min" }, { units: "h" })).toBe(true);
    expect(hasMeaningfulInput({}, { units: "h" })).toBe(true);
    expect(hasMeaningfulInput({ photos: [{ attachment_id: "att_x_00000001" }] }, {})).toBe(true);
  });
});

describe("deleting an unfinished entry", () => {
  it("removes the draft and only its own files, and updates the not-submitted count", async () => {
    const d = await db();
    await d.put("drafts", draft("rec_draft_00001", { asset_id: "PMP-1" }));
    await d.put("drafts", draft("rec_draft_00002", { asset_id: "PMP-2" }));
    await d.put("attachments", file("att_draft1_photo", "rec_draft_00001"));
    await d.put("attachments", file("att_draft2_photo", "rec_draft_00002"));
    await refreshPending();
    expect(getSyncState().drafts).toBe(2);
    expect(await deleteDraft("rec_draft_00001")).toEqual({ deleted: true, files: 1 });
    expect(await d.get("drafts", "rec_draft_00001")).toBeUndefined();
    expect(await d.get("attachments", "att_draft1_photo")).toBeUndefined();
    expect(await d.get("drafts", "rec_draft_00002")).toBeTruthy();                // other entries untouched
    expect(await d.get("attachments", "att_draft2_photo")).toBeTruthy();
    expect(getSyncState().drafts).toBe(1);
    expect(await deleteDraft("rec_draft_00001")).toEqual({ deleted: false, files: 0 });   // idempotent
  });

  it("never touches a completed record or its files, or its place in the upload queue", async () => {
    const d = await db();
    await d.put("workflows", { id: wf.id, version: 1, downloaded_at: "", definition: wf });
    const done = draft("rec_done_000001", { asset_id: "PMP-0043", inspection_date: "2026-11-09", condition: "fair", guard_ok: true,
      photos: [{ attachment_id: "att_done_photo1" }] });
    await d.put("drafts", done);
    await d.put("attachments", file("att_done_photo1", "rec_done_000001"));
    await completeDraft(done, wf);
    // a stale draft row with the same id (e.g. restored from an old backup) next to the completed record
    await d.put("drafts", done);
    expect(await deleteDraft("rec_done_000001")).toEqual({ deleted: true, files: 0 });
    expect(await d.get("records", "rec_done_000001")).toBeTruthy();
    expect(await d.get("attachments", "att_done_photo1")).toBeTruthy();
    expect((await d.getAll("outbox")).some((o) => o.record_id === "rec_done_000001")).toBe(true);
  });
});
