// App-wide audit fixes (0.2.3), each checked against a real Hermes:
//  1. Home's Saved Records tile shows the ACCOUNT's total and how many are available offline (not only local),
//     and keeps showing them offline from the remembered list.
//  2. A brand-new install opening a Hermes link while signed out is asked to sign in, not told its session expired.
//  3. A record Hermes rejected (it lacked the workflow) can be retried from Results; before, it was stuck forever.
//  4. "Remove from device" / "Free up space" never remove a record Hermes doesn't have.
//  5. Importing a backup queues its unsent records for upload (before, they never uploaded).
import { chromium, webkit, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signIn } from "./auth";
import { allServerIds, downloadWorkspace, EXAMPLE_FORM, EXAMPLE_WS, publishFormAsWorkspace, startEntry } from "./helpers";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const DATA_DIR = process.env.FIELDKIT_E2E_DATA_DIR ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const API = `${BASE}/api/plugins/fieldkit`;
const PY = resolve(import.meta.dirname, "../../.venv/Scripts/python.exe");
const run = String(Date.now() % 1_000_000).padStart(6, "0");
const VIEW = { viewport: { width: 390, height: 844 } };

function sql(script: string, ...args: string[]) {
  execFileSync(PY, ["-c", `import sqlite3, sys\nc = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA foreign_keys=ON")\n${script}\nc.commit()`,
    join(DATA_DIR, "data.db"), ...args]);
}
const dropRecord = (id: string) => sql(`for t in ("sync_ops",): c.execute(f"DELETE FROM {t} WHERE record_id=?", (sys.argv[2],))
c.execute("DELETE FROM records WHERE id=?", (sys.argv[2],))`, id);

async function client(profile = mkdtempSync(join(tmpdir(), "fk-audit-")), offline = false): Promise<{ ctx: BrowserContext; page: Page; profile: string }> {
  const ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  return { ctx, page, profile };
}

async function ready(c: { ctx: BrowserContext; page: Page }, wid = EXAMPLE_WS) {
  await signIn(c.ctx.request);
  await c.page.goto(APP);
  await expect.poll(() => c.page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await downloadWorkspace(c.page, APP, wid);
}

async function complete(page: Page, asset: string, form = EXAMPLE_FORM, wid = EXAMPLE_WS): Promise<string> {
  await startEntry(page, APP, form, wid);
  await page.locator("#in-asset_id").fill(asset);
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-09");
  await page.locator("#f-condition label", { hasText: "Fair" }).click();
  await page.locator("#f-guard_ok label", { hasText: "No" }).click();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page).toHaveURL(/#\/results\//, { timeout: 30_000 });
  return page.url().split("#/results/")[1].split("?")[0];
}

const serverIds = (ctx: BrowserContext) => allServerIds(ctx.request, API);

test.beforeEach(() => { test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR"); });
test.afterAll(() => {
  if (!DATA_DIR) return;
  sql(`ids = [r[0] for r in c.execute("SELECT id FROM records WHERE workflow_id LIKE 'audit-test-%'")]
for rid in ids:
    for t in ("sync_ops", "jobs"): c.execute(f"DELETE FROM {t} WHERE record_id=?", (rid,))
    c.execute("DELETE FROM records WHERE id=?", (rid,))
c.execute("DELETE FROM workflow_versions WHERE workflow_id LIKE 'audit-test-%'")
c.execute("DELETE FROM workflows WHERE id LIKE 'audit-test-%'")`);
});

test("Home: Saved Records shows the account total and how many are available offline, also offline", async () => {
  const A = await client();
  await ready(A);
  await complete(A.page, `AUD-${run}`);
  await expect(A.page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });
  const total = (await serverIds(A.ctx)).length;
  expect(total).toBeGreaterThan(1);                                     // the account has records from other devices
  await A.page.goto(`${APP}#/?r=${Date.now()}`);
  const t = A.page.locator("#tile-records");
  await expect(t).toHaveAttribute("data-total", String(total), { timeout: 15_000 });
  await expect(t).toHaveAttribute("data-offline", "1");                 // only this device's own record is offline here
  await expect(t).toContainText(`${total} in your account · 1 available offline`);
  await A.ctx.close();
  // Offline cold start: the remembered list still gives the account total.
  const off = await client(A.profile, true);
  await off.page.goto(APP);
  await expect(off.page.locator("#tile-records")).toHaveAttribute("data-total", String(total), { timeout: 20_000 });
  await expect(off.page.locator("#tile-records")).toHaveAttribute("data-offline", "1");
  await off.ctx.close();
});

test("a brand-new install opening a Hermes link signed out is asked to sign in, not told its session expired", async () => {
  const fresh = await client();                                          // never signed in, nothing stored
  await fresh.page.goto(`${APP}#/workflow/equipment-inspection`);
  await expect(fresh.page.locator('[data-auth="first"]')).toBeVisible({ timeout: 20_000 });
  await expect(fresh.page.locator("text=Your session expired")).toHaveCount(0);
  await fresh.ctx.close();
});

test("a record Hermes rejected can be retried; removal never deletes what Hermes doesn't have; imports upload", async () => {
  const A = await client();
  await signIn(A.ctx.request);
  // A uniquely named workflow that Hermes will "lose" before the record is uploaded.
  const wfId = `audit-test-${run}`;
  const wfTitle = `Audit test ${run}`;
  const wf = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/forms/maintenance.json"), "utf-8"));
  const wsId = publishFormAsWorkspace({ ...wf, id: wfId, title: { en: wfTitle } }, `audit-ws-${run}`);
  await ready(A, wsId);
  sql(`c.execute("DELETE FROM workflow_versions WHERE workflow_id=?", (sys.argv[2],)); c.execute("DELETE FROM workflows WHERE id=?", (sys.argv[2],))`, wfId);

  // 3. Rejected → visible problem with a way out → accepted after Try again.
  const rejected = await complete(A.page, `AUR-${run}`, wfId, wsId);
  await A.page.goto(`${APP}#/results/${rejected}?r=${Date.now()}`);
  await expect(A.page.locator("text=Hermes didn't accept this record")).toBeVisible({ timeout: 30_000 });
  await A.page.locator(`[data-retry="${rejected}"]`).click();
  await expect.poll(async () => (await serverIds(A.ctx)).includes(rejected), { timeout: 60_000, intervals: [1_000] }).toBe(true);
  await A.page.goto(`${APP}#/results/${rejected}?r=${Date.now()}`);
  await expect(A.page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });

  // 4. Hermes loses a confirmed record: no "Remove from device" for it, and Free up space keeps it.
  dropRecord(rejected);
  await A.page.goto(`${APP}#/records?r=${Date.now()}`);
  const row = A.page.locator(`#records-list li[data-record-id="${rejected}"]`);
  await expect(row).toHaveAttribute("data-availability", "on-device", { timeout: 20_000 });
  await expect(row.getByRole("button", { name: "Remove from device" })).toHaveCount(0);
  await A.page.goto(`${APP}#/settings?r=${Date.now()}`);
  await A.page.locator("#free-space-card").getByRole("button", { name: "Remove confirmed records" }).click();
  await expect(A.page.locator(".toast", { hasText: "Kept" })).toBeVisible();
  expect(await A.page.evaluate((id) => new Promise((res) => {
    const q = indexedDB.open("fieldkit"); q.onsuccess = () => { const g = q.result.transaction("records").objectStore("records").get(id); g.onsuccess = () => res(!!g.result); };
  }), rejected)).toBe(true);

  // 5. A backup with a record that never uploaded: importing it queues it, and Hermes receives it.
  const imported = `rec_imp${run}abcdef`;
  const backup = { format: "fieldkit-backup", version: 1, exported_at: new Date().toISOString(), device_id: "dev_old",
    records: [{ id: imported, workflow_id: wfId, workflow_version: 1, workflow_title: wfTitle, device_id: "dev_old",
      answers: { asset_id: `AUI-${run}`, inspection_date: "2026-11-09", condition: "fair", guard_ok: false },
      local_results: { generated_at: "", source: "local", validation: { complete: true, errors: {}, messages: {} }, questions_answered: 4,
        questions_visible: 4 },
      created_local_at: new Date().toISOString(), completed_at: new Date().toISOString(), lang: "en",
      sync_status: "pending", server_revision: 0 }],
    drafts: [], reports: [], attachments: [] };
  const file = join(mkdtempSync(join(tmpdir(), "fk-backup-")), "backup.json");
  writeFileSync(file, JSON.stringify(backup));
  await A.page.goto(`${APP}#/settings?r=${Date.now()}`);
  await A.page.locator('input[type="file"][accept="application/json"]').setInputFiles(file);
  await expect(A.page.locator(".toast", { hasText: "queued for upload" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await serverIds(A.ctx)).includes(imported), { timeout: 60_000, intervals: [1_000] }).toBe(true);
  await A.ctx.close();
});
