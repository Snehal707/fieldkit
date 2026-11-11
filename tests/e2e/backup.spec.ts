// Backup round trip with Hermes unreachable (the built app is served from disk): export from one phone, import on a
// fresh one, export again and compare; re-import adds nothing and overwrites nothing; damaged backups change nothing.
import { chromium, webkit, expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "dashboard/app_dist");
const ORIGIN = "http://localhost:5199";
const APP = `${ORIGIN}/index.html`;
const WF = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/forms/maintenance.json"), "utf-8"));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm" };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 300 }, (_, i) => i % 256), 0xff, 0xd9]);
const PHOTO2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 200 }, (_, i) => (i * 7) % 256), 0xff, 0xd9]);
const log = (...a: unknown[]) => console.log("AUDIT", ...a);

async function device() {
  // A persistent profile, like the installed app (WebKit cannot keep files in IndexedDB in a throwaway context).
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-bk-")), { viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN || url.pathname.includes("/api/")) return route.abort("internetdisconnected");
    const file = join(DIST, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  const p = ctx.pages()[0] ?? await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => log("PAGEERROR", String(e)));
  await p.goto(APP);
  await expect(p.locator("header.top")).toBeVisible({ timeout: 15_000 });
  return { ctx, p };
}

const dump = (p: Page) => p.evaluate(async () => {
  const db: IDBDatabase = await new Promise((res) => { const q = indexedDB.open("fieldkit"); q.onsuccess = () => res(q.result); });
  const all = (s: string) => new Promise<any[]>((res) => { const g = db.transaction(s).objectStore(s).getAll(); g.onsuccess = () => res(g.result); });
  const atts = await all("attachments");
  const hex = async (b: Blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await b.arrayBuffer()))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { records: await all("records"), drafts: await all("drafts"), reports: await all("reports"), outbox: await all("outbox"),
    attachments: await Promise.all(atts.map(async (a) => ({ ...a, blob: undefined, blob_sha: await hex(a.blob), blob_size: a.blob.size, blob_type: a.blob.type }))) };
});

async function seedA(p: Page) {
  await p.evaluate(async ({ wf, photo, photo2, s1, s2 }) => {
    const db: IDBDatabase = await new Promise((res) => { const q = indexedDB.open("fieldkit"); q.onsuccess = () => res(q.result); });
    const put = (s: string, v: any) => new Promise<void>((res, rej) => { const t = db.transaction(s, "readwrite"); t.objectStore(s).put(v); t.oncomplete = () => res(); t.onerror = () => rej(new Error(`${s} ${v.id ?? v.key ?? v.record_id}: ${t.error?.name} ${t.error?.message}`)); });
    const blob = (a: number[]) => new Blob([new Uint8Array(a)], { type: "image/jpeg" });
    await put("workflows", { id: wf.id, version: wf.version, downloaded_at: "", definition: wf });
    await put("settings", { key: "lang", value: "en" });
    // three empty drafts from the old behaviour (opened in Hindi, nothing entered)
    for (let i = 1; i <= 3; i++) await put("drafts", { id: `rec_emptydraft${i}x`, workflow_id: wf.id, workflow_version: 2, answers: {}, started_at: `2026-11-1${i}T08:00:00Z`, updated_at: `2026-11-1${i}T08:00:00Z`, lang: "hi", workspace_id: "starter-equipment-inspection" });
    // a draft with an answer and a photo
    await put("drafts", { id: "rec_realdraft01", workflow_id: wf.id, workflow_version: 2, answers: { asset_id: "PMP-0500", photos: [{ attachment_id: "att_draftphoto01" }] }, started_at: "2026-11-11T09:00:00Z", updated_at: "2026-11-11T09:05:00Z", lang: "en", workspace_id: "starter-equipment-inspection" });
    await put("attachments", { id: "att_draftphoto01", record_id: "rec_realdraft01", field_id: "photos", kind: "photo", mime: "image/jpeg", size: photo2.length, sha256: s2, blob: blob(photo2), created_at: "2026-11-11T09:01:00Z", uploaded: false, meta: {} });
    const base = { workflow_id: wf.id, workflow_version: 2, workflow_title: "Equipment inspection", device_id: "dev_phoneA0001", lang: "hi",
      local_results: { generated_at: "", source: "local", questions_answered: 4, questions_visible: 11, validation: { complete: true, errors: {}, messages: {} } } };
    await put("records", { ...base, id: "rec_synced00001", workspace_id: "starter-equipment-inspection", answers: { asset_id: "PMP-0501", condition: "fair", guard_ok: true, photos: [{ attachment_id: "att_syncphoto01" }] },
      created_local_at: "2026-11-10T10:00:00Z", completed_at: "2026-11-10T10:05:00Z", sync_status: "synced", server_revision: 1, server_ack: { revision: 1, received_at: 1794300000 } });
    await put("attachments", { id: "att_syncphoto01", record_id: "rec_synced00001", field_id: "photos", kind: "photo", mime: "image/jpeg", size: photo.length, sha256: s1, blob: blob(photo), created_at: "2026-11-10T10:01:00Z", uploaded: true, meta: {} });
    await put("records", { ...base, id: "rec_pending0001", workspace_id: null, answers: { asset_id: "PMP-0502", photos: [{ attachment_id: "att_pendphoto01" }] }, created_local_at: "2026-11-11T07:00:00Z", completed_at: "2026-11-11T07:05:00Z", sync_status: "pending", server_revision: 0 });
    await put("attachments", { id: "att_pendphoto01", record_id: "rec_pending0001", field_id: "photos", kind: "photo", mime: "image/jpeg", size: photo.length, sha256: s1, blob: blob(photo), created_at: "2026-11-11T07:01:00Z", uploaded: false, meta: {} });
    await put("records", { ...base, id: "rec_received001", workspace_id: "starter-equipment-inspection", answers: { asset_id: "PMP-0503" }, created_local_at: "2026-11-11T06:00:00Z", completed_at: "2026-11-11T06:05:00Z", sync_status: "received", server_revision: 1 });
    await put("reports", { record_id: "rec_synced00001", report_id: "rep_old0001", version: 1, downloaded_at: "", report: { summary: "Earlier report" } });
  }, { wf: WF, photo: [...PHOTO], photo2: [...PHOTO2], s1: sha(PHOTO), s2: sha(PHOTO2) });
  await p.reload();
  await expect(p.locator("header.top")).toBeVisible();
}

async function exportFrom(p: Page, name: string): Promise<any> {
  await p.goto(`${APP}#/settings`);
  const dl = p.waitForEvent("download");
  await p.getByRole("button", { name: "Export data" }).click();
  const file = join(tmpdir(), name);
  await (await dl).saveAs(file);
  return JSON.parse(readFileSync(file, "utf-8"));
}

async function importInto(p: Page, file: string): Promise<string> {
  await p.goto(`${APP}#/settings?r=${Date.now()}`);
  await expect(p.locator('input[type=file][accept="application/json"]')).toBeAttached();
  await p.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));   // only this import's message
  await p.locator('input[type=file][accept="application/json"]').setInputFiles(file);
  const t = p.locator(".toast").last();
  await expect(t).toBeVisible({ timeout: 15_000 });
  return t.innerText();
}

test("backup: exact round trip, no duplicates or overwrites, damaged files change nothing", async () => {
  test.setTimeout(240_000);
  const A = await device();
  await seedA(A.p);
  const before = await dump(A.p);
  const exp1 = await exportFrom(A.p, "fk-exp1.json");
  expect([exp1.records.length, exp1.drafts.length, exp1.reports.length, exp1.attachments.length]).toEqual([3, 4, 1, 3]);
  expect(exp1.drafts.filter((d: any) => d.lang === "hi" && !Object.keys(d.answers).length)).toHaveLength(3);   // kept as they are
  for (const a of exp1.attachments) expect(sha(Buffer.from(a.data_b64, "base64"))).toBe(a.sha256);

  // A fresh phone: everything back, byte for byte, with workspace and language.
  const B = await device();
  const f1 = join(tmpdir(), "fk-exp1.json");
  expect(await importInto(B.p, f1)).toContain("Restored 3 record(s), 4 draft(s), 3 file(s); 2 queued for upload");
  const b = await dump(B.p);
  for (const r of before.records) {
    const x = b.records.find((y) => y.id === r.id)!;
    expect(x, r.id).toBeTruthy();
    for (const k of ["answers", "workspace_id", "lang", "workflow_id", "workflow_version", "completed_at", "device_id"]) expect(x[k], `${r.id}.${k}`).toEqual(r[k]);
    expect(x.sync_status).toBe(r.sync_status === "synced" ? "synced" : "pending");
  }
  for (const a of before.attachments) {
    const x = b.attachments.find((y) => y.id === a.id)!;
    expect([x.blob_sha, x.blob_type, x.uploaded, x.record_id]).toEqual([a.blob_sha, a.blob_type, a.uploaded, a.record_id]);
  }
  for (const d of before.drafts) expect(b.drafts.find((y) => y.id === d.id)).toEqual(d);
  expect(b.outbox.map((o) => o.record_id).sort()).toEqual(["rec_pending0001", "rec_received001"]);
  expect(b.reports).toHaveLength(1);

  // Export again: the same content (only the upload state of the two re-queued records may differ).
  const exp2 = await exportFrom(B.p, "fk-exp2.json");
  const norm = (e: any) => JSON.stringify({
    records: e.records.map((r: any) => ({ ...r, sync_status: undefined, last_sync_attempt: undefined })).sort((x: any, y: any) => x.id.localeCompare(y.id)),
    drafts: [...e.drafts].sort((x: any, y: any) => x.id.localeCompare(y.id)), reports: e.reports,
    attachments: [...e.attachments].sort((x: any, y: any) => x.id.localeCompare(y.id)) });
  expect(norm(exp2)).toBe(norm(exp1));

  // Importing the same backup again adds nothing.
  expect(await importInto(B.p, f1)).toContain("Restored 0 record(s), 0 draft(s), 0 file(s)");
  const b2 = await dump(B.p);
  expect([b2.records.length, b2.drafts.length, b2.attachments.length, b2.outbox.length]).toEqual([3, 4, 3, 2]);

  // A record already on a phone is never overwritten by a backup.
  const C = await device();
  await C.p.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res) => { const q = indexedDB.open("fieldkit"); q.onsuccess = () => res(q.result); });
    await new Promise<void>((res) => { const t = db.transaction("records", "readwrite"); t.objectStore("records").put({ id: "rec_synced00001", workflow_id: "x", workflow_version: 1, workflow_title: "Newer", device_id: "dev_c", answers: { asset_id: "KEEP-ME" }, local_results: {}, lang: "en", created_local_at: "", completed_at: "", sync_status: "synced", server_revision: 2 }); t.oncomplete = () => res(); });
  });
  await importInto(C.p, f1);
  expect((await dump(C.p)).records.find((r) => r.id === "rec_synced00001")!.answers.asset_id).toBe("KEEP-ME");

  // Damaged backups: a clear message, and nothing written at all.
  const bad: [string, string, RegExp][] = [
    ["not json", "{oops", /isn't a FieldKit backup/],
    ["wrong format", JSON.stringify({ format: "something-else" }), /isn't a FieldKit backup/],
    ["truncated", readFileSync(f1, "utf-8").slice(0, 400), /cut off/],
    ["unreadable file", JSON.stringify({ ...exp1, attachments: [{ ...exp1.attachments[0], data_b64: "@@@not-base64@@@" }] }), /damaged.*unreadable.*Nothing was imported/],
    ["tampered file", JSON.stringify({ ...exp1, attachments: [{ ...exp1.attachments[0], data_b64: Buffer.from("tampered").toString("base64") }] }), /damaged.*checksum.*Nothing was imported/],
    ["record without id", JSON.stringify({ ...exp1, records: [...exp1.records, { answers: {} }] }), /damaged.*record 4.*Nothing was imported/],
  ];
  for (const [name, content, msg] of bad) {
    const f = join(tmpdir(), `fk-bad-${name.replace(/\W+/g, "-")}.json`);
    writeFileSync(f, content);
    expect(await importInto(C.p, f), name).toMatch(msg);
  }
  const c = await dump(C.p);
  expect([c.records.length, c.drafts.length, c.attachments.length, c.outbox.length]).toEqual([3, 4, 3, 2]);   // only the good import
  for (const ctx of [A.ctx, B.ctx, C.ctx]) await ctx.close();
});
