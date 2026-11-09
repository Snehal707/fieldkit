// v0.2.0 bug (seen on a real iPhone): Saved Records said "Offline" and "No records yet" while Hermes was
// reachable, because ANY failed request, including a 404 on the optional `devices` endpoint (a Hermes dashboard
// still running the 0.1.9 FieldKit router), hid the account's records. Each failure must now be reported for
// what it is, and records that did load must always be shown.
import { chromium, webkit, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const API = `${BASE}/api/plugins/fieldkit`;

let ctx: BrowserContext;
let page: Page;
let serverCount = 0;

test.beforeAll(async () => {
  if (!PASS) return;
  // A brand-new client with no records of its own: exactly the Home Screen app in the bug report.
  ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-errors-")), { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  // Make sure the account has at least one record on Hermes (synthetic, from another "device").
  await ctx.request.post(`${BASE}/api/plugins/fieldkit/examples/install`);
  const synced = await ctx.request.post(`${API}/sync/records`, { data: { idempotency_key: `idk_err_${Date.now()}`, device_id: "dev_errtest0001",
    record: { id: `rec_err${Date.now()}`, workflow_id: "equipment-inspection", workflow_version: 1, base_revision: 0,
      answers: { asset_id: "ERR-0001" }, created_local_at: new Date().toISOString(), completed_at: new Date().toISOString() } } });
  expect(synced.ok(), await synced.text()).toBe(true);
  serverCount = (await (await ctx.request.get(`${API}/records?limit=500`)).json()).records.length;
  page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
});
test.afterAll(async () => { await ctx?.close(); });
test.beforeEach(async () => { test.skip(!PASS, "set FIELDKIT_E2E_PASS"); await ctx.unrouteAll({ behavior: "ignoreErrors" }); });

async function openRecords() {
  await page.goto(`${APP}#/records?r=${Date.now()}`);
  await expect(page.locator("#saved-records")).toBeVisible({ timeout: 20_000 });
}

test("baseline: the account's records load and nothing claims to be offline", async () => {
  expect(serverCount).toBeGreaterThan(0);
  await openRecords();
  await expect(page.locator("#records-fresh")).toBeVisible();
  await expect(page.locator("#records-list li")).toHaveCount(serverCount);
  await expect(page.locator("#records-note")).toHaveCount(0);
});

test.describe("simulated server failures (route() cannot intercept service-worker traffic in WebKit)", () => {
  test.beforeEach(() => { test.skip(process.env.FIELDKIT_E2E_BROWSER === "webkit", "route() cannot block SW-controlled traffic in WebKit"); });

  test("old server without `devices` (404): records still listed, clear restart message, not 'Offline'", async () => {
    await ctx.route(/\/api\/plugins\/fieldkit\/devices$/, (r) => r.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Not Found"}' }));
    await openRecords();
    await expect(page.locator("#records-list li")).toHaveCount(serverCount);
    await expect(page.locator("#records-partial")).toHaveAttribute("data-problem", "server-outdated");
    await expect(page.locator("#records-partial")).toContainText("Restart the Hermes dashboard");
    await expect(page.locator("#records-note")).toHaveCount(0);
    await expect(page.locator("#saved-records")).not.toContainText("Offline");
    await expect(page.locator("#saved-records")).not.toContainText("No records yet");
  });

  test("server error on records (500): says so, offers Try again, never 'No records yet' or 'Offline'", async () => {
    await ctx.route(/\/api\/plugins\/fieldkit\/records\?/, (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"Internal Server Error"}' }));
    await openRecords();
    await expect(page.locator("#records-note")).toHaveAttribute("data-problem", "server-error");
    await expect(page.locator("#records-note")).toContainText("HTTP 500");
    await expect(page.locator("#saved-records")).not.toContainText("No records yet");
    await expect(page.locator("#saved-records")).not.toContainText("Offline");
    // The list remembered from the last successful load is still shown, labelled as such.
    await expect(page.locator("#records-note")).toContainText("as of");
    await expect(page.locator("#records-list li")).toHaveCount(serverCount);
    await ctx.unrouteAll({ behavior: "ignoreErrors" });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("#records-fresh")).toBeVisible({ timeout: 20_000 });
  });

  test("network up but request fails: 'Can't reach Hermes', not 'Offline'", async () => {
    await ctx.route(/\/api\/plugins\/fieldkit\/records\?/, (r) => r.abort("connectionrefused"));
    await openRecords();
    await expect(page.locator("#records-note")).toHaveAttribute("data-problem", "unreachable");
    await expect(page.locator("#records-note")).toContainText("Can't reach Hermes");
  });

  test("signed out (401): sign-in prompt, not 'Offline'", async () => {
    await ctx.route(/\/api\/plugins\/fieldkit\/records\?/, (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Unauthorized"}' }));
    await openRecords();
    await expect(page.locator("#records-note")).toHaveAttribute("data-problem", "signed-out");
    await expect(page.locator("#records-note").getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});

test("really offline: says Offline and still shows the remembered list", async () => {
  await openRecords();                                         // remember the list while online
  await ctx.setOffline(true);
  try {
    await openRecords();
    await expect(page.locator("#records-note")).toHaveAttribute("data-problem", "offline");
    await expect(page.locator("#records-list li")).toHaveCount(serverCount);
    await expect(page.locator("#records-list li").first()).toHaveAttribute("data-availability", "needs-internet");
  } finally { await ctx.setOffline(false); }
});
