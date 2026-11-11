// One Saved Records list for the whole Hermes account, across isolated clients (e.g. iPhone Safari and the
// Home Screen app, which keep fully separate storage). Two browser profiles sign in to the SAME account:
//  - each lists every record of the account exactly once, with a readable source and a clear availability badge;
//  - "Download all for offline" keeps the other device's records (and reports) readable after an offline cold start;
//  - offline, records not downloaded still appear as "Needs internet" and cannot be opened;
//  - a record saved offline syncs on its own when the connection returns and then shows up on the other client;
//  - the account card shows the same Account ID on both; device IDs appear only under Settings → Advanced;
//  - offline copies and the remembered list are never shown to a different account on the same device.
import { chromium, webkit, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signIn } from "./auth";
import { downloadWorkspace, startEntry } from "./helpers";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const DATA_DIR = process.env.FIELDKIT_E2E_DATA_DIR ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const PY = resolve(import.meta.dirname, "../../.venv/Scripts/python.exe");
const VIEW = { viewport: { width: 390, height: 844 } };
const run = String(Date.now() % 1_000_000).padStart(6, "0");   // asset ids must match [A-Z]{2,4}-[0-9]{3,6}

async function open(profile: string, offline = false): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline });
  return { ctx, page: await ctx.newPage() };
}

async function setUp(name: string): Promise<{ profile: string; ctx: BrowserContext; page: Page }> {
  const profile = mkdtempSync(join(tmpdir(), "fieldkit-acct-"));
  const { ctx, page } = await open(profile);
  await signIn(ctx.request);
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await downloadWorkspace(page, APP);
  await page.goto(`${APP}#/settings`);
  await page.getByLabel("Device name").fill(name);
  await page.locator("#device-card").getByRole("button", { name: "Save" }).click();
  await expect(page.locator(`[data-device-name="${name}"]`)).toBeVisible();
  return { profile, ctx, page };
}

async function complete(page: Page, asset: string): Promise<string> {
  await startEntry(page, APP);
  await page.locator("#in-asset_id").fill(asset);
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-09");
  await page.locator("#f-condition label", { hasText: "Fair" }).click();
  await page.locator("#f-guard_ok label", { hasText: "No" }).click();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page).toHaveURL(/#\/results\//, { timeout: 30_000 });
  return page.url().split("#/results/")[1].split("?")[0];
}

const row = (page: Page, id: string) => page.locator(`#records-list li[data-record-id="${id}"]`);

async function records(page: Page) {
  await page.goto(`${APP}#/records?r=${Date.now()}`);
  await expect(page.locator("#saved-records")).toBeVisible({ timeout: 20_000 });
}

test("one Saved Records list across two isolated clients on the same Hermes account", async () => {
  test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR");
  test.setTimeout(420_000);
  const A = await setUp(`Field phone ${run}`);
  const B = await setUp(`Office laptop ${run}`);

  const idA = await complete(A.page, `ACA-${run}`);
  await expect(A.page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });
  const idB = await complete(B.page, `ACB-${run}`);
  await expect(B.page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });

  // A report for B's record as FieldKit stored them before 0.3 (still shown read-only, and copied for offline use).
  execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, "../.."))})
from fieldkit_core import db
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
rid = ${JSON.stringify(idB)}
rep = {"report_id": "rep_" + rid[-12:], "version": 1, "summary": "Report for ACB-${run}: guard missing, refit before use.",
  "issues": [{"title": "Safety guard missing", "severity": "critical", "evidence": "guard_ok = No"}],
  "missing_information": [], "references": [], "suggested_actions": [{"action": "Tag out the machine", "priority": "urgent"}],
  "requires_review": True, "review_reason": ""}
s.conn.execute("INSERT INTO reports(id, record_id, owner_user_id, version, record_revision, content, generated_by, created_at) "
               "SELECT ?, id, owner_user_id, 1, revision, ?, 'e2e', 0 FROM records WHERE id=?", (rep["report_id"], json.dumps(rep), rid))
s.conn.execute("UPDATE records SET report_id=?, report_version=1 WHERE id=?", (rep["report_id"], rid))
s.conn.commit()
`]);

  // Both clients: every record once, readable sources, explicit availability, no device ids.
  for (const [me, other, mine, theirs, otherName] of [[A, B, idA, idB, `Office laptop ${run}`], [B, A, idB, idA, `Field phone ${run}`]] as const) {
    await records(me.page);
    await expect(row(me.page, mine)).toHaveCount(1);
    await expect(row(me.page, theirs)).toHaveCount(1);
    await expect(row(me.page, mine)).toHaveAttribute("data-availability", "on-device");
    await expect(row(me.page, mine)).toContainText("Available offline");
    await expect(row(me.page, mine)).toContainText("This phone");
    await expect(row(me.page, theirs)).toHaveAttribute("data-availability", "needs-internet");
    await expect(row(me.page, theirs)).toContainText("Needs internet");
    await expect(row(me.page, theirs)).toContainText(`From ${otherName}`);
    expect(await me.page.locator("#saved-records").innerText()).not.toMatch(/dev_\d/);
    const ids = await me.page.locator("#records-list li").evaluateAll((els) => els.map((e) => e.getAttribute("data-record-id")));
    expect(new Set(ids).size).toBe(ids.length);                                   // no duplicates anywhere
    void other;
  }

  // Same account on both; the device id is only under Advanced.
  const accountIds: string[] = [];
  for (const c of [A, B]) {
    await c.page.goto(`${APP}#/settings?r=${Date.now()}`);
    const acct = c.page.locator("#account-card [data-account-id]");
    await expect(acct).not.toHaveAttribute("data-account-id", "");
    accountIds.push((await acct.getAttribute("data-account-id"))!);
    await expect(c.page.locator("#account-card [data-account-status]")).toHaveAttribute("data-account-status", "signed-in");
    await expect(c.page.locator("[data-device-id]")).toBeHidden();                // collapsed under Advanced
    await c.page.locator("#advanced summary").click();
    await expect(c.page.locator("[data-device-id]")).toBeVisible();
    await expect(c.page.locator("[data-device-id]")).toHaveText(/^dev_\d+$/);
  }
  expect(accountIds[0]).toBe(accountIds[1]);

  // A downloads everything for offline (B's record + its report).
  await records(A.page);
  A.page.once("dialog", (d) => d.accept());               // large accounts ask before downloading everything
  await A.page.locator("#download-all").click();
  // Downloads every entry of the account one by one (hundreds on a long-used test Hermes): wait until it is done.
  await expect(A.page.locator(".toast", { hasText: /now available offline|downloaded/ })).toBeVisible({ timeout: 300_000 });
  await expect(row(A.page, idB)).toHaveAttribute("data-availability", "kept-offline", { timeout: 20_000 });
  await expect(row(A.page, idB)).toContainText("Available offline");

  // B saves another record that A has NOT downloaded; A sees it online (remembered for offline).
  const idC = await complete(B.page, `ACC-${run}`);
  await expect(B.page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });
  await records(A.page);
  await expect(row(A.page, idC)).toHaveAttribute("data-availability", "needs-internet");
  await A.ctx.close();

  // A: offline cold start.
  let a = await open(A.profile, true);
  await records(a.page);
  await expect(a.page.locator("#records-note")).toContainText("Offline");
  await expect(row(a.page, idA)).toHaveAttribute("data-availability", "on-device");
  await expect(row(a.page, idB)).toHaveAttribute("data-availability", "kept-offline");
  await expect(row(a.page, idC)).toHaveAttribute("data-availability", "needs-internet");
  await expect(row(a.page, idC).locator("a")).toHaveCount(0);                     // can't be opened offline
  await row(a.page, idB).locator("a").click();
  await expect(a.page.locator(`text=Report for ACB-${run}`)).toBeVisible({ timeout: 20_000 });
  await expect(a.page.locator("text=Tag out the machine")).toBeVisible();
  await expect(a.page.locator(`#remote-record >> text=From Office laptop ${run}`)).toBeVisible();

  // A saves a record while offline → waiting; connection returns → it syncs by itself.
  const idD = await complete(a.page, `ACD-${run}`);
  await records(a.page);
  await expect(row(a.page, idD)).toHaveAttribute("data-availability", "waiting");
  await expect(row(a.page, idD)).toContainText("Waiting to sync");
  await a.ctx.setOffline(false);
  await a.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => {
    await records(a.page);
    return row(a.page, idD).getAttribute("data-availability");
  }, { timeout: 60_000, intervals: [2_000] }).toBe("on-device");
  await records(B.page);
  await expect(row(B.page, idD)).toHaveCount(1);
  await expect(row(B.page, idD)).toContainText(`From Field phone ${run}`);

  // Account isolation on a shared device: another account never sees this account's offline copies or list.
  await a.ctx.setOffline(true);
  await a.page.evaluate(() => new Promise<void>((done, fail) => {
    const r = indexedDB.open("fieldkit");
    r.onsuccess = () => {
      const t = r.result.transaction("settings", "readwrite");
      t.objectStore("settings").put({ key: "last_account", value: { user_id: "someone_else", display_name: "Someone else", provider: "basic", at: "" } });
      t.oncomplete = () => done(); t.onerror = () => fail(t.error);
    };
    r.onerror = () => fail(r.error);
  }));
  await a.page.reload();                                  // the app reads settings at start (written here behind its back)
  await records(a.page);
  await expect(row(a.page, idB)).toHaveCount(0);
  await expect(row(a.page, idC)).toHaveCount(0);
  await a.ctx.close();
  await B.ctx.close();
});
