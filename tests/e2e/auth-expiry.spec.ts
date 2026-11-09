// Expired Hermes session (the iPhone report: raw {"error":"session_expired",...} JSON on a Home Screen launch).
// A launch is a top-level navigation to the app's start URL. The session cookie is replaced by an invalid one,
// which Hermes answers with 401 "invalid_or_expired_session" on /api paths.
import { chromium, webkit, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const LEGACY = `${BASE}/api/plugins/fieldkit/app/`;
const API = `${BASE}/api/plugins/fieldkit`;

async function expireSession(ctx: BrowserContext) {
  const cookies = (await ctx.cookies()).filter((c) => c.name.startsWith("hermes_session"));
  expect(cookies.length).toBeGreaterThan(0);
  await ctx.clearCookies();
  await ctx.addCookies(cookies.map((c) => ({ ...c, value: "expired.invalid.session" })));
}

async function loginThroughHermesPage(page: Page) {
  await page.waitForURL(/\/login\?next=/, { timeout: 20_000 });
  expect(decodeURIComponent(page.url())).toContain("next=/dashboard-plugins/fieldkit/app_dist/index.html");
  await page.locator("input[name=username]").first().fill(process.env.FIELDKIT_E2E_USER ?? "demo");
  await page.locator("input[name=password]").first().fill(PASS);
  await page.locator("input[name=password]").first().press("Enter");
  // Wait for the URL (back in FieldKit), not the load event; the assertions that follow prove the app works.
  await page.waitForURL((u) => u.pathname.endsWith("/dashboard-plugins/fieldkit/app_dist/index.html"), { timeout: 30_000, waitUntil: "commit" });
  await expect(page.locator("header.top")).toBeVisible({ timeout: 20_000 });
}

test("cold launch with an expired session and NO service worker opens the app and signs back in", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-exp-cold-")), { viewport: { width: 390, height: 844 },
    serviceWorkers: "block" });   // the iPhone case where the web app's service worker is gone
  await signIn(ctx.request);
  await expireSession(ctx);
  const page = await ctx.newPage();
  const res = await page.goto(APP);
  expect(res!.status()).toBe(200);                                         // the launch page is never gated
  await expect(page.locator("body")).not.toContainText("session_expired");
  await expect(page.locator("body")).not.toContainText("invalid_or_expired_session");
  await expect(page.locator("header.top")).toBeVisible({ timeout: 20_000 });
  const signInBtn = page.getByRole("button", { name: "Sign in", exact: true }).first();
  await expect(signInBtn).toBeVisible({ timeout: 20_000 });
  await signInBtn.click();
  await loginThroughHermesPage(page);
  await expect(page.locator("text=Signed in as")).toBeVisible({ timeout: 15_000 });
  expect((await ctx.request.get(`${API}/me`)).status()).toBe(200);
  await ctx.close();
});

test("expired session: offline data stays accessible without login; online sync asks to sign in and resumes", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  test.setTimeout(240_000);
  const profile = mkdtempSync(join(tmpdir(), "fk-exp-off-"));
  let ctx = await engine.launchPersistentContext(profile, { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  await ctx.request.post(`${API}/examples/install`);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/packs`);
  await page.locator("li", { hasText: "Equipment inspection" }).getByRole("button", { name: /Download for offline|Re-download|Update/ }).first().click();
  await expect(page.locator("text=Downloaded Equipment inspection")).toBeVisible({ timeout: 30_000 });
  await ctx.close();

  // Offline + expired session: the app and its data open without any login.
  ctx = await engine.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, offline: true });
  await expireSession(ctx);
  page = await ctx.newPage();
  await page.goto(APP);
  await expect(page.locator("body")).not.toContainText("session_expired");
  await page.goto(`${APP}#/workflows`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.locator("#in-asset_id").fill("PMP-8001");
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-09");
  await page.locator("#f-condition label", { hasText: "Good" }).click();
  await page.locator("#f-guard_ok label", { hasText: "Yes" }).click();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 15_000 });
  const id = page.url().split("#/results/")[1];
  await ctx.close();

  // Back online, still expired: launch shows the app (not JSON), asks to sign in, keeps the record.
  ctx = await engine.launchPersistentContext(profile, { viewport: { width: 390, height: 844 } });
  await expireSession(ctx);
  page = await ctx.newPage();
  await page.goto(`${APP}#/sync`);
  await expect(page.locator("body")).not.toContainText("session_expired");
  await expect(page.locator("text=Sign in to Hermes to continue syncing").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("header", { hasText: "sign-in needed" })).toBeVisible();
  await expect(page.locator("text=1 record(s)")).toBeVisible();          // still queued, nothing lost
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  await loginThroughHermesPage(page);
  // Returned to FieldKit, signed in → the queued record syncs by itself.
  await expect.poll(async () => (await ctx.request.get(`${API}/records/${id}`)).status(), { timeout: 60_000 }).toBe(200);
  await expect(page.locator("header", { hasText: "all confirmed" })).toBeVisible({ timeout: 30_000 });
  await ctx.close();
});

test("legacy address still works and moves a browser tab to the public address", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-legacy-")), { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  const page = await ctx.newPage();
  await page.goto(`${LEGACY}#/settings`);
  await page.waitForURL((u) => u.pathname.endsWith("/dashboard-plugins/fieldkit/app_dist/index.html") && u.hash === "#/settings", { timeout: 20_000 });
  await expect(page.locator("#storage-card")).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});
