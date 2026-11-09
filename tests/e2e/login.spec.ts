// Real sign-in round trip through Hermes' own login page: FieldKit → Hermes login → back to FieldKit
// (not the dashboard), signed in, then first-run download of all published workflows → offline ready.
import { chromium, webkit, expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";

// FIELDKIT_E2E_BROWSER=webkit runs the same test on WebKit (Safari's engine).
const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const USER = process.env.FIELDKIT_E2E_USER ?? "demo";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;

test("Sign in returns to FieldKit and first-run download makes it offline-ready", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fieldkit-login-")), { viewport: { width: 390, height: 844 } });
  // One-time: install the app shell while signed in, make sure examples are published, then lose the session.
  await signIn(ctx.request, USER, PASS);
  await ctx.request.post(`${BASE}/api/plugins/fieldkit/examples/install`);
  const page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await ctx.clearCookies();
  await page.goto(`${APP}#/`);
  await page.reload();

  // Signed out: Home offers sign-in.
  const signInBtn = page.getByRole("button", { name: "Sign in", exact: true }).first();
  await expect(signInBtn).toBeVisible({ timeout: 20_000 });
  await signInBtn.click();

  // Hermes' own login page, with next= pointing at FieldKit's return page (not an /api path).
  await page.waitForURL(/\/login\?next=/, { timeout: 20_000 });
  expect(decodeURIComponent(page.url())).toContain("next=/dashboard-plugins/fieldkit/app_dist/index.html");
  await page.locator("input[name=username]").first().fill(USER);
  await page.locator("input[name=password]").first().fill(PASS);
  await page.locator("input[name=password]").first().press("Enter");

  // Lands back in FieldKit — not on the dashboard — signed in.
  await page.waitForURL((u) => u.pathname.endsWith("/dashboard-plugins/fieldkit/app_dist/index.html"), { timeout: 30_000 });
  await expect(page.locator("text=Signed in as")).toBeVisible({ timeout: 15_000 });

  // First run: one tap downloads everything published → offline ready.
  const dl = page.getByRole("button", { name: /Download all \d+ workflow/ });
  await expect(dl).toBeVisible({ timeout: 20_000 });
  await dl.click();
  await expect(page.locator("text=Ready to work offline")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".tile", { hasText: "My Workflows" })).toContainText("3 downloaded");
  await ctx.close();
});
