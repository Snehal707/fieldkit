// Saved Records and Offline Packs, offline-capable and without a Hermes server: the built app is served from disk and
// the few API answers these screens need are synthetic. Checks the readable record list (form + subject, one status,
// grouped by day, no per-row buttons), "Remove from device" only on a record Hermes has, and Offline Packs (forms
// read-only, each pack once, removal only after confirming).
import { chromium, webkit, expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "dashboard/app_dist");
const ORIGIN = "http://localhost:5199";
const APP = `${ORIGIN}/index.html`;
const WF = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/forms/maintenance.json"), "utf-8"));
const MODELS = readFileSync(join(ROOT, "fieldkit_core/models.json"), "utf-8");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm" };
const now = Date.now();
const at = (min: number) => new Date(now - min * 60_000).toISOString();
const SERVER = Array.from({ length: 12 }, (_, i) => ({
  id: i < 3 ? `rec_local_${i}` : `rec_srv_${String(i).padStart(3, "0")}`, workflow_id: WF.id, workflow_version: 2, workflow_title: "Equipment inspection",
  subject: `PMP-${String(40 + i).padStart(4, "0")}`, sync_status: "complete", completed_at: at(20 + i * 400), received_at: (now - (20 + i * 400) * 60_000) / 1000,
  device_id: i % 3 === 0 ? "dev_this" : "dev_other", workspace_id: "starter-equipment-inspection" }));
test.use({ actionTimeout: 15_000 });

async function serve(p: Page, online: { value: boolean }) {
  await p.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname.includes("/api/")) {
      if (!online.value) return route.abort("internetdisconnected");
      const p2 = url.pathname.split("/api/plugins/fieldkit/")[1] ?? "";
      if (p2 === "records") {
        const off = Number(url.searchParams.get("offset") ?? 0), lim = Number(url.searchParams.get("limit") ?? 50), page = SERVER.slice(off, off + lim);
        return json({ records: page, total: SERVER.length, next_offset: off + page.length < SERVER.length ? off + page.length : null });
      }
      if (p2.startsWith("records/")) { const id = p2.split("/")[1]; return SERVER.some((r) => r.id === id) ? json({ id, answers: {}, attachments: [] }) : json({ detail: "Not found" }, 404); }
      if (p2 === "devices") return json({ devices: [{ id: "dev_this", label: "iPhone · Safari" }, { id: "dev_other", label: "Android · Chrome" }] });
      if (p2 === "me") return json({ user_id: "demo", display_name: "demo", provider: "basic" });
      if (p2 === "models") return route.fulfill({ status: 200, contentType: "application/json", body: MODELS });
      return route.abort("internetdisconnected");
    }
    const file = join(DIST, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
}

async function seed(p: Page) {
  await p.evaluate(async ({ wf, srv }) => {
    const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("fieldkit"); q.onsuccess = () => res(q.result); q.onerror = rej; });
    const put = (store: string, v: any) => new Promise<void>((res, rej) => { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(v); t.oncomplete = () => res(); t.onerror = rej; });
    await put("settings", { key: "device_id", value: "dev_this" });
    await put("settings", { key: "last_account", value: { user_id: "demo", display_name: "demo", provider: "basic", at: new Date().toISOString() } });
    await put("workflows", { id: wf.id, version: wf.version, downloaded_at: new Date().toISOString(), definition: wf });
    const base = { workflow_id: wf.id, workspace_id: "starter-equipment-inspection", workflow_version: 2, workflow_title: "Equipment inspection", device_id: "dev_this", lang: "en",
      local_results: { generated_at: "", source: "local", questions_answered: 4, questions_visible: 11, validation: { complete: true, errors: {}, messages: {} } }, server_revision: 1 };
    for (let i = 0; i < 3; i++) await put("records", { ...base, id: `rec_local_${i}`, answers: { asset_id: srv[i].subject }, created_local_at: srv[i].completed_at, completed_at: srv[i].completed_at, sync_status: "synced" });
    const t = new Date().toISOString();
    await put("records", { ...base, id: "rec_local_wait01", answers: { asset_id: "PMP-0101" }, created_local_at: t, completed_at: t, sync_status: "pending", server_revision: 0 });
    await put("records", { ...base, id: "rec_local_upl001", answers: { asset_id: "PMP-0102" }, created_local_at: t, completed_at: t, sync_status: "received" });
    await put("records", { ...base, id: "rec_local_gone01", answers: { asset_id: "PMP-0103" }, created_local_at: t, completed_at: t, sync_status: "synced" });
    await put("models", { id: "ocr-eng", capability: "ocr", version: 1, title: "OCR — English", installed_at: t, verified: true, verify_detail: "self-test passed", manifest: {} });
  }, { wf: WF, srv: SERVER });
}

test("records list is readable and action-free; packs list each pack once and confirm removal", async () => {
  test.setTimeout(120_000);
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const online = { value: true };
  await serve(p, online);
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  let answer = true;
  p.on("dialog", (d) => (answer ? d.accept() : d.dismiss()));
  await p.goto(APP);
  await expect(p.locator("header.top")).toBeVisible({ timeout: 15_000 });
  await seed(p);

  // Records: form + subject, one status each, grouped by day, no buttons on rows.
  await p.goto(`${APP}#/records`);
  const row = (id: string) => p.locator(`#records-list li[data-record-id="${id}"]`);
  await expect(row("rec_local_wait01")).toContainText("Equipment inspection");
  await expect(row("rec_local_wait01")).toContainText("PMP-0101");
  await expect(row("rec_local_wait01").locator(".rec-status")).toHaveText("Waiting to sync");
  await expect(row("rec_local_upl001").locator(".rec-status")).toHaveText("Files uploading");
  await expect(row("rec_local_0").locator(".rec-status")).toHaveText("Synced");
  await expect(row("rec_srv_003")).toContainText("Made on this phone");
  await expect(row("rec_srv_003")).toContainText("Needs internet");
  await expect(row("rec_srv_004")).toContainText("From Android · Chrome");
  for (const id of ["rec_local_wait01", "rec_local_0", "rec_srv_004"]) await expect(row(id).locator(".rec-status")).toHaveCount(1);
  await expect(p.locator("#records-list button")).toHaveCount(0);
  await expect(p.locator("#records-list .rec-day h3").first()).toHaveText("Today");
  await expect(p.locator("header.top .status")).toBeVisible();
  expect(await p.locator("header.top .status").evaluate((el) => getComputedStyle(el, "::before").content)).toMatch(/none|normal/);

  // The record's page offers "Remove from device" only when Hermes still has the record.
  await p.goto(`${APP}#/results/rec_local_0`);
  await expect(p.locator("#remove-from-device")).toBeVisible();
  await p.goto(`${APP}#/results/rec_local_gone01`);
  await expect(p.locator("#remove-slot")).toBeAttached();
  await p.waitForTimeout(800);
  await expect(p.locator("#remove-from-device")).toHaveCount(0);
  await p.goto(`${APP}#/results/rec_local_wait01`);
  await expect(p.locator("#remove-slot")).toHaveCount(0);                      // not confirmed yet: never offered
  await p.goto(`${APP}#/results/rec_local_0`);
  await p.locator("#remove-from-device").click();
  await expect(p).toHaveURL(/#\/records/);
  await expect(row("rec_local_0")).toHaveAttribute("data-availability", "needs-internet");   // still listed, from Hermes

  // Offline Packs: forms read-only; each pack once; Install vs installed + Remove; removal only after confirming.
  await p.goto(`${APP}#/packs`);
  await expect(p.locator("#packs-forms")).toContainText("Managed by your workspace");
  await expect(p.locator("#packs-forms button")).toHaveCount(0);
  await expect(p.locator("ul.packs li")).toHaveCount(4);
  await expect(p.locator('li[data-pack="ocr-eng"]')).toContainText("Installed, self-test passed");
  await expect(p.locator('button[data-model="ocr-eng"]')).toBeHidden();
  await expect(p.locator('button[data-remove="ocr-eng"]')).toBeVisible();
  await expect(p.locator('button[data-model="ocr-hin"]')).toHaveText("Install");
  await expect(p.locator('button[data-remove="ocr-hin"]')).toBeHidden();
  answer = false;
  await p.locator('button[data-remove="ocr-eng"]').click();
  await expect(p.locator('li[data-pack="ocr-eng"]')).toHaveAttribute("data-on-device", "ocr-eng");     // kept
  answer = true;
  await p.locator('button[data-remove="ocr-eng"]').click();
  await expect(p.locator('li[data-pack="ocr-eng"]')).not.toHaveAttribute("data-on-device", "ocr-eng");
  await expect(p.locator('button[data-model="ocr-eng"]')).toHaveText("Install");

  // Offline: the screen still lists packs on this phone and says how to get more.
  await seed(p);
  online.value = false;
  await ctx.setOffline(true);
  await p.goto(`${APP}#/packs?r=1`);
  await expect(p.locator('li[data-pack="ocr-eng"]')).toContainText("Installed, self-test passed");
  await expect(p.locator('button[data-model="ocr-eng"]')).toBeHidden();
  await expect(p.locator("#packs-models")).toContainText("connect to the internet to download more packs");
  expect(errors).toEqual([]);
  await browser.close();
});
