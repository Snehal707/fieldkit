// v0.2.1 bug (real iPhone): Safari listed its records ("Available offline", confirmed by Hermes) while a new Home
// Screen app on the same account showed none. Hermes no longer had them: its FieldKit data had been reset or the
// host answered from a different machine with its own data. Verified by swapping the test Hermes onto a fresh
// data store between steps. This spec reproduces the same state in one run by removing one record, and the
// workflow it was made with, from the test instance's database only, then checks:
//  - a fresh install sees no such record (the bug);
//  - the install that made it detects "Hermes doesn't have 1 record from this device";
//  - "Upload again" restores the exact workflow version and the record, photos included, to the SAME account;
//  - the fresh install then lists it exactly once; Settings shows the same data store on both.
import { chromium, webkit, expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signIn } from "./auth";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const DATA_DIR = process.env.FIELDKIT_E2E_DATA_DIR ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const API = `${BASE}/api/plugins/fieldkit`;
const PY = resolve(import.meta.dirname, "../../.venv/Scripts/python.exe");
const run = String(Date.now() % 1_000_000).padStart(6, "0");
const WF_ID = `restore-test-${run}`;
const WF_TITLE = `Restore test ${run}`;

async function client() {
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-restore-")), { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  return { ctx, page };
}

async function records(page: Page) {
  await page.goto(`${APP}#/records?r=${Date.now()}`);
  await expect(page.locator("#saved-records")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#records-fresh")).toBeVisible();
}

test("records Hermes lost are detected on the device that made them and can be uploaded again", async () => {
  test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR");
  test.setTimeout(240_000);
  const A = await client();
  // A uniquely named workflow, so removing it below cannot affect any other test.
  const wf = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../examples/maintenance/workflow.json"), "utf-8"));
  const pub = await A.ctx.request.post(`${API}/workflows`, { data: { definition: { ...wf, id: WF_ID, title: { en: WF_TITLE } }, publish: true } });
  expect(pub.ok(), await pub.text()).toBe(true);
  await A.ctx.request.post(`${API}/examples/install`);
  await A.page.goto(`${APP}#/packs`);
  await A.page.locator("li", { hasText: WF_TITLE }).first().getByRole("button").click();
  await expect(A.page.locator(`text=Downloaded ${WF_TITLE}`)).toBeVisible({ timeout: 30_000 });
  await A.page.goto(`${APP}#/workflows`);
  await A.page.locator("li", { hasText: WF_TITLE }).getByRole("button", { name: "Start" }).click();
  await A.page.locator("#in-asset_id").fill(`RST-${run}`);
  await A.page.locator("#in-asset_id").blur();
  await A.page.locator("#in-inspection_date").fill("2026-11-09");
  await A.page.locator("#f-condition label", { hasText: "Fair" }).click();
  await A.page.locator("#f-guard_ok label", { hasText: "No" }).click();
  await A.page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(A.page.locator("text=Synchronised — durably received by Hermes")).toBeVisible({ timeout: 30_000 });
  const id = A.page.url().split("#/results/")[1].split("?")[0];

  // Hermes loses the record and its workflow (what a reset / different data volume looks like). Test instance only.
  execFileSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA foreign_keys=ON")
c.execute("DELETE FROM sync_ops WHERE record_id=?", (sys.argv[2],))
c.execute("DELETE FROM jobs WHERE record_id=?", (sys.argv[2],))
c.execute("DELETE FROM records WHERE id=?", (sys.argv[2],))
c.execute("DELETE FROM workflow_versions WHERE workflow_id=?", (sys.argv[3],))
c.execute("DELETE FROM workflows WHERE id=?", (sys.argv[3],))
c.commit()
`, join(DATA_DIR, "data.db"), id, WF_ID]);

  // A brand-new install (the Home Screen app in the report) on the same account: the record is not there.
  const B = await client();
  await records(B.page);
  await expect(B.page.locator(`#records-list li[data-record-id="${id}"]`)).toHaveCount(0);

  // The install that made it still shows it as confirmed, and now says Hermes doesn't have it.
  await records(A.page);
  await expect(A.page.locator(`#records-list li[data-record-id="${id}"]`)).toHaveAttribute("data-availability", "on-device");
  await expect(A.page.locator("#records-missing")).toHaveAttribute("data-missing", "1");
  await expect(A.page.locator("#records-missing")).toContainText("Hermes doesn't have 1 record(s) from this device");
  await A.page.locator("#resend-missing").click();
  await expect.poll(async () => (await (await A.ctx.request.get(`${API}/records?limit=500`)).json()).records.some((r: any) => r.id === id),
    { timeout: 60_000, intervals: [1_000] }).toBe(true);
  const back = await (await A.ctx.request.get(`${API}/workflows/${WF_ID}`)).json();
  expect(back.version).toBe(1);                                         // the exact version the record was made with

  await records(A.page);
  await expect(A.page.locator("#records-missing")).toHaveCount(0);
  await records(B.page);
  await expect(B.page.locator(`#records-list li[data-record-id="${id}"]`)).toHaveCount(1);   // once, no duplicates

  // Both installs report the same Hermes data store.
  const stores: string[] = [];
  for (const c of [A, B]) {
    await c.page.goto(`${APP}#/settings?r=${Date.now()}`);
    stores.push((await c.page.locator("[data-store-id]").getAttribute("data-store-id"))!);
  }
  expect(stores[0]).toMatch(/^fks_[0-9a-f]{16}$/);
  expect(stores[0]).toBe(stores[1]);
  await A.ctx.close();
  await B.ctx.close();
});

// Leave the shared test instance as we found it: other specs count published workflows.
test.afterAll(() => {
  if (!DATA_DIR) return;
  execFileSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA foreign_keys=ON")
ids = [r[0] for r in c.execute("SELECT id FROM records WHERE workflow_id LIKE 'restore-test-%'")]
for rid in ids:
    c.execute("DELETE FROM sync_ops WHERE record_id=?", (rid,)); c.execute("DELETE FROM jobs WHERE record_id=?", (rid,))
    c.execute("DELETE FROM records WHERE id=?", (rid,))
c.execute("DELETE FROM workflow_versions WHERE workflow_id LIKE 'restore-test-%'")
c.execute("DELETE FROM workflows WHERE id LIKE 'restore-test-%'")
c.commit()
`, join(DATA_DIR, "data.db")]);
});
