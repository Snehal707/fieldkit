// Strict offline proof (v0.1.3 investigation). Network is cut for the page AND the service worker:
//   A) browser offline emulation (navigator.onLine=false, like Airplane mode with Wi-Fi off);
//   B) navigator.onLine=TRUE but every request is blocked at the network layer — the iOS case where the
//      phone believes it has a network that cannot reach anything.
// Every request (page + service worker) is recorded. The server is checked by a SEPARATE client that stays
// online, so "the server has no record" is proven, not inferred. Reconnection must sync with no user action.
import { chromium, expect, request, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/api/plugins/fieldkit/app/`;
const API = `${BASE}/api/plugins/fieldkit`;

async function serverClient() {
  const r = await request.newContext();
  await r.post(`${BASE}/auth/password-login`, { data: { provider: "basic", username: "demo", password: PASS, next: "/" } });
  return r;
}

function recordTraffic(ctx: BrowserContext) {
  const reachedNetwork: string[] = [];
  ctx.on("requestfinished", async (req) => {
    const res = await req.response();
    if (res && !res.fromServiceWorker() && req.url().startsWith(BASE)) reachedNetwork.push(`${req.method()} ${new URL(req.url()).pathname} → ${res.status()}`);
  });
  return reachedNetwork;
}

async function setup(profile: string) {
  const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 } });
  await ctx.request.post(`${BASE}/auth/password-login`, { data: { provider: "basic", username: "demo", password: PASS, next: "/" } });
  await ctx.request.post(`${API}/examples/install`);
  const page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/packs`);
  await page.locator("li", { hasText: "Equipment inspection" }).first().getByRole("button").click();
  await expect(page.locator("text=Downloaded Equipment inspection")).toBeVisible({ timeout: 30_000 });
  await ctx.close();
}

async function completeInspection(page: Page, asset: string): Promise<string> {
  await page.goto(`${APP}#/workflows`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.locator("#in-asset_id").fill(asset);
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-09");
  await page.locator("#f-condition label", { hasText: "Good" }).click();
  await page.locator("#f-guard_ok label", { hasText: "Yes" }).click();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 15_000 });
  return page.url().split("#/results/")[1];
}

async function pillTextsFor(page: Page, ms: number): Promise<Set<string>> {
  const seen = new Set<string>();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    seen.add((await page.locator("header").innerText()).replace(/\s+/g, " "));
    await page.waitForTimeout(250);
  }
  return seen;
}

test.describe.configure({ mode: "serial" });

test("A: browser offline (page + service worker) → stays pending, survives restart, auto-syncs on reconnect", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  test.setTimeout(240_000);
  const profile = mkdtempSync(join(tmpdir(), "fieldkit-strictA-"));
  await setup(profile);
  const server = await serverClient();

  let ctx = await chromium.launchPersistentContext(profile, { offline: true, viewport: { width: 390, height: 844 } });
  let net = recordTraffic(ctx);
  let page = await ctx.newPage();
  await page.goto(APP);
  // An inspection blocked by validation is a DRAFT: it must say so, never "all confirmed".
  await page.goto(`${APP}#/workflows`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.locator("#in-asset_id").fill("bad tag");
  await page.locator("#in-asset_id").blur();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page.locator("text=Not submitted yet")).toBeVisible();
  await page.waitForTimeout(5000);  // the old toast vanished after 4 s — this banner must not
  await expect(page.locator("text=Not submitted yet")).toBeVisible();
  await expect(page.locator("header", { hasText: "1 not submitted" })).toBeVisible();
  await expect(page.locator("header", { hasText: "all confirmed" })).toHaveCount(0);
  const id = await completeInspection(page, "PMP-9001");
  // 1. saved + queued before any network request, inspected directly in IndexedDB
  const local = await page.evaluate(async (rid) => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("fieldkit"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const get = (store: string, key: any) => new Promise<any>((res) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); });
    const all = (store: string) => new Promise<any[]>((res) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
    const rec = await get("records", rid);
    return { status: rec?.sync_status, ack: rec?.server_ack ?? null, ops: (await all("outbox")).filter((o) => o.record_id === rid).length };
  }, id);
  expect(local).toEqual({ status: "pending", ack: null, ops: 1 });
  // 5. counter never reaches zero while offline (sampled for 6 s, including a manual "Sync now")
  await page.goto(`${APP}#/sync`);
  await page.getByRole("button", { name: /Sync now/ }).click();
  const seen = await pillTextsFor(page, 6000);
  expect([...seen].every((t) => (t.includes("1 awaiting confirmation") && t.includes("1 not submitted")) || t.includes("syncing")), [...seen].join(" | ")).toBe(true);
  expect([...seen].some((t) => t.includes("all confirmed"))).toBe(false);
  expect([...seen].every((t) => t.includes("device offline")), [...seen].join(" | ")).toBe(true);
  // 2. the server never acknowledged it — checked by an independent online client
  expect((await server.get(`${API}/records/${id}`)).status()).toBe(404);
  expect(net, `requests reached the network while offline: ${net.join(", ")}`).toEqual([]);
  await ctx.close();

  // 6. close + reopen offline: still there, still pending
  ctx = await chromium.launchPersistentContext(profile, { offline: true, viewport: { width: 390, height: 844 } });
  net = recordTraffic(ctx);
  page = await ctx.newPage();
  await page.goto(`${APP}#/results/${id}`);
  await expect(page.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("header", { hasText: "1 awaiting confirmation" })).toBeVisible();
  expect(net).toEqual([]);
  // discard the deliberately invalid draft so the final state can be "all confirmed"
  await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res) => { const r = indexedDB.open("fieldkit"); r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const t = db.transaction("drafts", "readwrite"); t.objectStore("drafts").clear(); t.oncomplete = res; });
  });
  expect((await server.get(`${API}/records/${id}`)).status()).toBe(404);

  // Connectivity returns — NO user action: the app must sync by itself.
  await ctx.setOffline(false);
  await expect.poll(async () => (await server.get(`${API}/records/${id}`)).status(), { timeout: 60_000 }).toBe(200);
  await expect(page.locator("header", { hasText: "all confirmed" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("text=Synchronised — durably received by Hermes")).toBeVisible({ timeout: 30_000 });
  const rec = await (await server.get(`${API}/records/${id}`)).json();
  expect(rec.revision).toBe(1);
  expect(rec.received_at * 1000).toBeGreaterThan(Date.parse(rec.completed_at));
  await ctx.close();
  await server.dispose();
});

test("B: navigator.onLine=true but every request blocked (page + service worker) → never confirmed", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  test.setTimeout(240_000);
  const profile = mkdtempSync(join(tmpdir(), "fieldkit-strictB-"));
  await setup(profile);
  const server = await serverClient();

  const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 } });
  // Warm the page first so cached "Hermes reachable" exists — then cut everything.
  const page = await ctx.newPage();
  await page.goto(APP);
  await expect(page.locator("header", { hasText: "Hermes reachable" })).toBeVisible({ timeout: 30_000 });
  const blocked: string[] = [];
  const blockAll = (r: any) => { blocked.push(r.request().url()); return r.abort("internetdisconnected"); };
  await ctx.route("**/*", blockAll);  // applies to page and service worker fetches
  const id = await completeInspection(page, "PMP-9002");
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await page.goto(`${APP}#/sync`);
  await page.getByRole("button", { name: /Sync now/ }).click();
  const seen = await pillTextsFor(page, 6000);
  expect([...seen].some((t) => t.includes("all confirmed")), [...seen].join(" | ")).toBe(false);
  expect([...seen].some((t) => t.includes("Hermes reachable")), `stale reachability shown: ${[...seen].join(" | ")}`).toBe(false);
  expect((await server.get(`${API}/records/${id}`)).status()).toBe(404);
  expect(blocked.some((u) => u.includes("/sync/records"))).toBe(true);  // it did try, and was blocked

  await ctx.unroute("**/*", blockAll);
  await expect.poll(async () => (await server.get(`${API}/records/${id}`)).status(), { timeout: 90_000 }).toBe(200);
  await expect(page.locator("header", { hasText: "all confirmed" })).toBeVisible({ timeout: 30_000 });
  await ctx.close();
  await server.dispose();
});
