// End-to-end: real Hermes dashboard + real Chromium. Proves the PWA reopens with the network fully
// disabled after the browser process is closed (not just an open tab), persists records/results,
// recovers from an expired session without losing data, and synchronises without duplicates.
import { chromium, webkit, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";
import { downloadWorkspace, startEntry } from "./helpers";

// FIELDKIT_E2E_BROWSER=webkit runs the same test on WebKit (Safari's engine).
const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const USER = process.env.FIELDKIT_E2E_USER ?? "demo";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const API = `${BASE}/api/plugins/fieldkit`;
const profile = mkdtempSync(join(tmpdir(), "fieldkit-e2e-"));

async function launch(offline: boolean): Promise<BrowserContext> {
  return engine.launchPersistentContext(profile, { offline, viewport: { width: 390, height: 844 }, permissions: ["geolocation"],
    geolocation: { latitude: 18.5204, longitude: 73.8567, accuracy: 15 } });
}

async function login(ctx: BrowserContext) {
  await signIn(ctx.request, USER, PASS);
}

test.describe.configure({ mode: "serial" });

test("install online, then work fully offline after a cold restart, then sync", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  // ---------- 1. online setup
  let ctx = await launch(false);
  await login(ctx);
  const baseline = (await (await ctx.request.get(`${API}/records?limit=500`)).json()).records.length;
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await downloadWorkspace(page, APP);
  await page.goto(`${APP}#/`);
  await expect(page.locator("text=Ready to work offline")).toBeVisible({ timeout: 15_000 });
  await ctx.close();  // full browser shutdown

  // ---------- 2. cold start with the network disabled
  ctx = await launch(true);
  page = await ctx.newPage();
  await page.goto(APP);
  await expect(page.locator("text=Ready to work offline")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("header .pill", { hasText: "offline" })).toBeVisible();

  // complete the workflow offline
  await startEntry(page, APP);
  await page.locator("#in-asset_id").fill("PMP-0042");
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-08");
  await page.locator("#f-condition label", { hasText: "Fair" }).click();
  await page.locator("#f-symptoms label", { hasText: "Abnormal vibration" }).click();
  await expect(page.locator("#in-vibration_level")).toBeVisible();  // conditional question appears
  await page.locator("#in-vibration_level").fill("9.2");
  await page.locator("#in-vibration_level").blur();
  await page.locator("#f-guard_ok label", { hasText: "No" }).click();
  await page.locator("#f-location button", { hasText: "Capture location" }).click();
  await expect(page.locator("#f-location", { hasText: "18.5204" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Complete workflow" }).click();

  // offline Results page
  await expect(page.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("header .pill", { hasText: "1 awaiting confirmation" })).toBeVisible();  // never "0 queued" offline
  await expect(page.locator("header .pill", { hasText: "device offline" })).toBeVisible();
  await expect(page.locator("#result-media, dl.kv").first()).toBeVisible();
  await expect(page.locator("text=PMP-0042")).toBeVisible();                     // the saved answers, offline
  await expect(page.locator("text=Safety guard problem")).toHaveCount(0);        // 0.3: forms no longer classify
  const recordUrl = page.url();
  const recordId = recordUrl.split("#/results/")[1];
  await ctx.close();

  // ---------- 3. cold start offline again: record + results persist
  ctx = await launch(true);
  page = await ctx.newPage();
  await page.goto(recordUrl);
  await expect(page.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("text=PMP-0042")).toBeVisible();
  await ctx.close();

  // ---------- 4. back online but the Hermes session is gone → nothing lost, sign-in requested
  ctx = await launch(false);
  await ctx.clearCookies();
  page = await ctx.newPage();
  await page.goto(`${APP}#/sync`);  // navigation 401 → service worker serves the cached shell
  await expect(page.locator("text=Sign in to Hermes to continue syncing").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("text=Waiting (1)")).toBeVisible();

  // ---------- 5. sign in again → sync resumes, server acknowledges exactly one record
  await login(ctx);
  await page.reload();
  await expect.poll(async () => (await ctx.request.get(`${API}/records/${recordId}`)).status(), { timeout: 30_000 }).toBe(200);
  await page.goto(recordUrl);
  await expect(page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("header .pill", { hasText: "all confirmed" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("header .pill", { hasText: "Hermes reachable" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("text=Ask your Hermes agent about this entry")).toBeVisible();
  // re-run sync: still exactly one server record (idempotent)
  await page.goto(`${APP}#/sync`);
  await page.getByRole("button", { name: /Sync now/ }).click();
  const recs = (await (await ctx.request.get(`${API}/records?limit=500`)).json()).records;
  expect(recs).toHaveLength(baseline + 1);  // exactly one new server record, even after a forced re-sync
  const full = await (await ctx.request.get(`${API}/records/${recordId}`)).json();
  expect(full.sync_status).toBe("complete");
  expect(full.revision).toBe(1);
  expect(full.answers.vibration_level).toBe(9.2);
  expect(full.workspace_id).toBe("starter-equipment-inspection");                   // the entry knows its workspace
  expect(full.answers.location.lat).toBeCloseTo(18.5204, 3);
  // Evidence trail: the server receipt time is after the offline completion time.
  expect(full.received_at * 1000).toBeGreaterThan(Date.parse(full.completed_at));
  await ctx.close();
});
