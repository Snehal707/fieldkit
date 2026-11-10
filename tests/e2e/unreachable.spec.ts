// "Connected but no internet" (Wi-Fi without internet / captive portal): navigator.onLine is TRUE, yet Hermes
// is unreachable. FieldKit must say so, keep the record awaiting confirmation, and never claim it synced.
import { chromium, webkit, expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";
import { downloadWorkspace, startEntry } from "./helpers";

// FIELDKIT_E2E_BROWSER=webkit runs the same test on WebKit (Safari's engine).
const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const API = `${BASE}/api/plugins/fieldkit`;
const isApi = (u: URL) => u.pathname.startsWith("/api/plugins/fieldkit/") && !u.pathname.startsWith("/api/plugins/fieldkit/app/");

test("network up but Hermes unreachable or captive portal: honest status, nothing lost, then confirmed", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  // Playwright's route() cannot intercept requests from a service-worker-controlled page in WebKit, so the
  // outage cannot be simulated there (requests really reach the server). Covered on Chromium and a real iPhone.
  test.skip(process.env.FIELDKIT_E2E_BROWSER === "webkit", "route() cannot block SW-controlled traffic in WebKit");
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fieldkit-unreach-")), { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  const page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await downloadWorkspace(page, APP);

  // Captive portal: every API call returns a 200 HTML login page (navigator.onLine stays true).
  const portal = (r: any) => r.fulfill({ status: 200, contentType: "text/html", body: "<html>Hotel Wi-Fi login</html>" });
  const refused = (r: any) => r.abort("connectionrefused");
  await ctx.route(isApi, portal);
  await startEntry(page, APP);
  await page.locator("#in-asset_id").fill("PMP-0043");
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-09");
  await page.locator("#f-condition label", { hasText: "Good" }).click();
  await page.locator("#f-guard_ok label", { hasText: "Yes" }).click();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("header .pill", { hasText: "1 awaiting confirmation" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("header .pill", { hasText: "no Hermes connection" })).toBeVisible({ timeout: 15_000 });
  const recordId = page.url().split("#/results/")[1];

  // Network reachable at the IP level but API connections fail.
  await ctx.unroute(isApi, portal);
  await ctx.route(isApi, refused);
  await page.goto(`${APP}#/sync`);
  await page.getByRole("button", { name: /Sync now/ }).click();
  await expect(page.locator("text=Not reachable")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("text=1 record(s)")).toBeVisible();
  expect((await ctx.request.get(`${API}/records/${recordId}`)).status()).toBe(404);  // server truly has nothing

  // Real connectivity returns → confirmed exactly once.
  await ctx.unroute(isApi, refused);
  await page.getByRole("button", { name: /Sync now/ }).click();
  await expect(page.locator("header .pill", { hasText: "all confirmed" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("header .pill", { hasText: "Hermes reachable" })).toBeVisible();
  const rec = await (await ctx.request.get(`${API}/records/${recordId}`)).json();
  expect(rec.revision).toBe(1);
  expect(rec.answers.asset_id).toBe("PMP-0043");
  await ctx.close();
});
