// Home's compact overview against a real Hermes: recent activity tells unfinished, waiting-to-sync and synced entries
// apart; the workspace last opened stays current across app restarts (offline); entries are filed under the workspace
// they were started from.
import { chromium, webkit, expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";
import { downloadWorkspace, EXAMPLE_WS, publishFormAsWorkspace } from "./helpers";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const VIEW = { viewport: { width: 390, height: 844 } };
test.use({ actionTimeout: 20_000 });

const localRecords = (p: Page) => p.evaluate(() => new Promise<any[]>((res) => {
  const q = indexedDB.open("fieldkit");
  q.onsuccess = () => { const g = q.result.transaction("records").objectStore("records").getAll(); g.onsuccess = () => res(g.result); };
}));

test.beforeEach(() => { test.skip(!process.env.FIELDKIT_E2E_PASS || !process.env.FIELDKIT_E2E_DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR"); });

test("home: activity states, switching survives restart, entries under the right workspace", async () => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(join(tmpdir(), "fk-verify-"));
  let ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  let p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  await p.goto(APP);
  await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  // Its own second workspace (never relies on another test having made one).
  const run = Date.now().toString(36);
  const ownId = publishFormAsWorkspace({ id: `home-visit-${run}`, title: { en: "Home visit" }, languages: ["en"], metadata: { subject_field: "household_id" },
    fields: [{ id: "household_id", type: "text", label: { en: "Household ID" }, required: true }, { id: "notes", type: "multiline", label: { en: "Notes" } }] },
    `e2e-visits-home-${run}`);
  const list = (await (await ctx.request.get(`${BASE}/api/plugins/fieldkit/workspaces`)).json()).workspaces;
  const own = list.find((w: any) => w.id === ownId);
  expect(own, "an own workspace to test with").toBeTruthy();
  await downloadWorkspace(p, APP);
  await downloadWorkspace(p, APP, own.id);
  await expect(p).toHaveURL(/\?r=/, { timeout: 30_000 });     // the download finishes by reopening its page

  // A: online, from the example workspace page: Start, complete, confirmed by Hermes (synced).
  await p.goto(`${APP}#/workspace/${EXAMPLE_WS}`);
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", EXAMPLE_WS, { timeout: 20_000 });
  await p.locator("#ws-workflows a", { hasText: "Start" }).first().click();
  await p.getByRole("button", { name: "Start workflow" }).click();
  await p.locator("#in-asset_id").fill("VER-0001"); await p.locator("#in-asset_id").blur();
  await p.locator("#in-inspection_date").fill("2026-11-10");
  await p.locator("#f-condition label", { hasText: "Fair" }).click();
  await p.locator("#f-guard_ok label", { hasText: "Yes" }).click();
  await p.getByRole("button", { name: "Complete workflow" }).click();
  await expect(p.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 40_000 });
  const ridA = p.url().split("#/results/")[1].split("?")[0];

  // B: offline, from the own workspace page: complete; it waits for sync.
  await ctx.setOffline(true);
  await p.goto(`${APP}#/workspace/${own.id}`);
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", own.id, { timeout: 20_000 });
  await p.locator("#ws-workflows a", { hasText: "Start" }).first().click();
  await p.getByRole("button", { name: "Start workflow" }).click();
  await p.locator("#in-household_id").fill("VER-WAITING"); await p.locator("#in-household_id").blur();
  await p.getByRole("button", { name: "Complete workflow" }).click();
  await expect(p.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 15_000 });
  const ridB = p.url().split("#/results/")[1].split("?")[0];

  // C: an unfinished draft in the example workspace (still offline).
  await p.goto(`${APP}#/workspace/${EXAMPLE_WS}`);
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", EXAMPLE_WS, { timeout: 20_000 });
  await p.locator("#ws-workflows a", { hasText: "Start" }).first().click();
  await p.getByRole("button", { name: "Start workflow" }).click();
  await p.locator("#in-asset_id").fill("VER-0003"); await p.locator("#in-asset_id").blur();
  await p.waitForTimeout(800);

  // Entries are filed under the workspace they were started from.
  const recs = await localRecords(p);
  expect(recs.find((r) => r.id === ridA)?.workspace_id).toBe(EXAMPLE_WS);
  expect(recs.find((r) => r.id === ridB)?.workspace_id).toBe(own.id);

  // Home's recent activity distinguishes the three states (offline, from what is on the phone).
  await p.goto(`${APP}#/`);
  const recent = p.locator("#home-recent");
  await expect(recent.locator('li[data-state="draft"]', { hasText: "VER-0003" })).toContainText("Unfinished", { timeout: 15_000 });
  await expect(recent.locator('li[data-state="waiting"]', { hasText: "VER-WAITING" })).toContainText("Waiting to sync");
  await expect(recent.locator('li[data-state="synced"]', { hasText: "VER-0001" })).toContainText("Synced");
  await expect(recent.locator("li").first()).toHaveAttribute("data-state", "draft");          // unfinished first
  await expect(recent.locator('li[data-state="waiting"] a')).toHaveAttribute("href", `#/results/${ridB}`);
  await expect(p.locator('main a[href*="#/workflow/"]')).toHaveCount(0);                        // no record buttons on Home
  // Last opened workspace page was the example one (C), so it is current.
  await expect(p.locator("#home-workspaces h2")).toHaveText("Equipment inspection");

  // Switch to the own workspace from the list, then restart the app (offline): the choice persists.
  await p.goto(`${APP}#/workspaces`);
  await p.locator(`#workspaces li[data-ws="${own.id}"] a`).click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", own.id);
  await ctx.close();
  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  p = await ctx.newPage();
  await p.goto(APP);
  await expect(p.locator("#home-workspaces h2")).toHaveText(own.title, { timeout: 20_000 });
  await expect(p.locator('nav.bottom a[data-tab="ws"]')).toHaveAttribute("href", `#/workspace/${own.id}`);
  await p.locator('nav.bottom a[data-tab="ws"]').click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", own.id);
  await expect(p.locator('nav.bottom a[data-tab="ws"]')).toHaveClass(/on/);
  // Switch back to the example, restart again: persists the other way too.
  await p.goto(`${APP}#/workspaces`);
  await expect(p.locator(`#workspaces li[data-ws="${own.id}"]`)).toHaveAttribute("data-current", "true");
  await p.locator(`#workspaces li[data-ws="${EXAMPLE_WS}"] a`).click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", EXAMPLE_WS);
  await ctx.close();
  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  p = await ctx.newPage();
  await p.goto(APP);
  await expect(p.locator("#home-workspaces h2")).toHaveText("Equipment inspection", { timeout: 20_000 });

  // Back online: the waiting entry syncs and Home shows it as synced.
  await ctx.close();
  ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  p = await ctx.newPage();
  await p.goto(`${APP}#/sync`);
  await expect.poll(async () => (await ctx.request.get(`${BASE}/api/plugins/fieldkit/records/${ridB}`)).status(), { timeout: 60_000 }).toBe(200);
  const server = await (await ctx.request.get(`${BASE}/api/plugins/fieldkit/records/${ridB}`)).json();
  expect(server.workspace_id).toBe(own.id);
  await p.goto(`${APP}#/?r=${Date.now()}`);
  await expect(p.locator('#home-recent li', { hasText: "VER-WAITING" })).toHaveAttribute("data-state", "synced", { timeout: 30_000 });
  await ctx.close();
});
