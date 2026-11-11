// Navigation on a phone (iPhone 13 profile): bottom tabs respond at once; nested screens have a Back button that
// returns to the previous screen (skipping a form's Start page), keeps form progress and scroll position, never changes
// the selected workspace by itself, and falls back to the screen's parent when opened directly from a link.
import { chromium, webkit, devices, expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";
import { downloadWorkspace, EXAMPLE_FORM, EXAMPLE_WS } from "./helpers";

const isWebkit = process.env.FIELDKIT_E2E_BROWSER === "webkit";
const engine = isWebkit ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const { defaultBrowserType: _ignored, ...IPHONE } = devices["iPhone 13"] as any;
test.use({ actionTimeout: 20_000 });
test.beforeEach(() => { test.skip(!process.env.FIELDKIT_E2E_PASS, "set FIELDKIT_E2E_PASS"); });

const tab = (p: Page, label: string) => p.locator("nav.bottom a", { hasText: label });
const back = (p: Page) => p.locator("#back");
const path = (p: Page) => decodeURIComponent(p.url().split("#")[1] ?? "/").replace(/[?&]r=\d+/, "");

/** ms from tapping a tab (inside the page, no automation overhead) until the screen visibly changes. */
const firstResponse = (p: Page, label: string) => p.evaluate((lab) => new Promise<number>((res) => {
  const main = document.querySelector("main")!;
  const t0 = performance.now();
  const mo = new MutationObserver(() => { mo.disconnect(); res(performance.now() - t0); });
  mo.observe(main, { childList: true });
  ([...document.querySelectorAll("nav.bottom a")].find((x) => x.textContent?.includes(lab)) as HTMLAnchorElement).click();
}), label);

test("tabs respond at once; Back returns to the previous screen and keeps progress and the workspace", async () => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(join(tmpdir(), "fk-nav-"));
  const ctx = await engine.launchPersistentContext(profile, IPHONE);
  await signIn(ctx.request);
  const p = await ctx.newPage();
  await p.goto(APP);
  await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  const own = (await (await ctx.request.get(`${BASE}/api/plugins/fieldkit/workspaces`)).json()).workspaces.find((w: any) => !w.starter);
  await downloadWorkspace(p, APP, own.id);
  await downloadWorkspace(p, APP);                       // the example workspace, opened last: it is the current one
  await expect(p).toHaveURL(/\?r=/, { timeout: 30_000 });
  // Downloading refreshed the page in place: Back from here is not "the same page again".
  await p.goto(`${APP}#/`);
  await expect(p.locator("#home-workspaces h2")).toHaveText("Equipment inspection", { timeout: 20_000 });

  // Bottom tabs are roots (no Back) and respond within a fraction of a second.
  for (const t of ["Records", "Sync", "Settings", "Workspace", "Home"]) {
    const ms = await firstResponse(p, t);
    expect(ms, `${t} responded in ${Math.round(ms)} ms`).toBeLessThan(400);
    await expect(back(p)).toBeHidden();
  }

  // Home → Open workspace → Back → Home.
  await p.locator("#home-workspaces a", { hasText: "Open workspace" }).click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", EXAMPLE_WS);
  await expect(back(p)).toBeVisible();
  await back(p).click();
  await expect(p.locator("#home-workspaces")).toBeVisible();
  expect(path(p)).toBe("/");

  // Workspace tab → Start a form → type → Back: returns to the workspace (skipping the Start page), the draft is kept.
  await tab(p, "Workspace").click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", EXAMPLE_WS);
  await expect(back(p)).toBeHidden();
  await p.locator(`#ws-workflows a[href*="${EXAMPLE_FORM}"]`).click();
  await expect(back(p)).toBeVisible();
  await p.getByRole("button", { name: "Start workflow" }).click();
  await p.locator("#in-asset_id").fill("PMP-0777");
  await p.locator("#in-asset_id").blur();
  await expect(p.locator("#draft-state")).toContainText("Draft saved");
  await back(p).click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", EXAMPLE_WS);
  await expect(back(p)).toBeHidden();                    // the tab's own screen again
  await tab(p, "Home").click();
  const draftRow = p.locator("#home-recent li[data-state='draft']", { hasText: "PMP-0777" });
  await expect(draftRow).toHaveCount(1);
  await draftRow.locator("a").click();                   // resume from Home
  await expect(p.locator("#in-asset_id")).toHaveValue("PMP-0777");
  await back(p).click();
  expect(path(p)).toBe("/");

  // Opening another workspace from the list is an explicit choice; Back never changes it by itself.
  await p.locator("#home-workspaces a", { hasText: /Switch workspace|All workspaces/ }).click();
  await expect(back(p)).toBeVisible();
  await p.locator(`#workspaces li[data-ws="${own.id}"] a`).click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", own.id);
  await back(p).click();                                 // → the list
  await expect(p.locator("#workspaces")).toBeVisible();
  await back(p).click();                                 // → Home
  await expect(p.locator("#home-workspaces h2")).toHaveText(own.title);
  await tab(p, "Workspace").click();
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", own.id);

  // Records → scroll → open a record → Back: the list, at the same place.
  await tab(p, "Records").click();
  await expect(p.locator("#records-list li").nth(25)).toBeVisible({ timeout: 30_000 });
  const target = p.locator("#records-list li").nth(25);
  await target.scrollIntoViewIfNeeded();
  const before = await p.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(300);
  await target.locator("a").click();
  await expect(back(p)).toBeVisible();
  await back(p).click();
  await expect(p.locator("#records-list")).toBeVisible();
  await expect.poll(() => p.evaluate(() => window.scrollY), { timeout: 5_000 }).toBeGreaterThan(before - 120);
  await expect(back(p)).toBeHidden();

  // Opened straight from a link (new app launch): Back goes to the parent screen.
  const rid = (await p.locator("#records-list li").first().getAttribute("data-record-id"))!;
  const fresh = await ctx.newPage();
  const href = (await p.locator(`#records-list li[data-record-id="${rid}"] a`).getAttribute("href"))!;
  await fresh.goto(`${APP}${href}`);
  await expect(back(fresh)).toBeVisible({ timeout: 20_000 });
  await back(fresh).click();
  await expect(fresh.locator("#records-list")).toBeVisible({ timeout: 20_000 });
  await fresh.close();

  // Offline: Back still works and the tabs still respond at once.
  await ctx.setOffline(true);
  await tab(p, "Home").click();
  await p.locator("#home-workspaces a", { hasText: "Open workspace" }).click();
  await back(p).click();
  await expect(p.locator("#home-workspaces")).toBeVisible();
  for (const t of ["Records", "Sync", "Home"]) expect(await firstResponse(p, t)).toBeLessThan(400);
  await ctx.close();
});
