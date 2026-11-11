// Unfinished entries against a real Hermes, offline: opening a form saves nothing; the first answer or a captured photo
// saves a draft that survives a restart; deleting a draft (after confirming) removes it and its photo only.
import { chromium, webkit, expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { signIn } from "./auth";
import { downloadWorkspace, EXAMPLE_FORM, EXAMPLE_WS } from "./helpers";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const VIEW = { viewport: { width: 390, height: 844 } };
test.use({ actionTimeout: 20_000 });

const count = (p: Page, store: string) => p.evaluate((s) => new Promise<number>((res) => {
  const q = indexedDB.open("fieldkit");
  q.onsuccess = () => { const c = q.result.transaction(s).objectStore(s).count(); c.onsuccess = () => res(c.result); };
}), store);

async function openForm(p: Page) {
  await p.goto(`${APP}#/workspace/${EXAMPLE_WS}`);
  await expect(p.locator("#ws-home")).toHaveAttribute("data-ws", EXAMPLE_WS, { timeout: 20_000 });
  await p.locator(`#ws-workflows a[href*="${EXAMPLE_FORM}"]`).click();
  await p.getByRole("button", { name: "Start workflow" }).click();
  await expect(p.locator("#in-asset_id")).toBeVisible();
}

test.beforeEach(() => { test.skip(!process.env.FIELDKIT_E2E_PASS, "set FIELDKIT_E2E_PASS"); });

test("drafts: none on open, saved on input or a photo, survive restart, delete safely", async () => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(join(tmpdir(), "fk-drafts-"));
  let ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  let p = await ctx.newPage();
  await p.goto(APP);
  await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await downloadWorkspace(p, APP);
  await expect(p).toHaveURL(/\?r=/, { timeout: 30_000 });
  await ctx.close();

  // Offline from here on.
  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  await p.goto(APP);
  await expect(p.locator("#home-workspaces")).toBeVisible({ timeout: 20_000 });
  const recordsBefore = await count(p, "records");

  // 1. Opening a form and leaving: nothing saved.
  await openForm(p);
  await expect(p.locator("#draft-state")).toContainText("Nothing saved until you answer something");
  await expect(p.locator("#delete-draft")).toHaveCount(0);
  expect(await count(p, "drafts")).toBe(0);
  await p.goto(`${APP}#/`);
  await expect(p.locator("#home-recent li[data-state='draft']")).toHaveCount(0);
  await expect(p.locator("header .pill", { hasText: "not submitted" })).toHaveCount(0);

  // 2. Reloading an opened-but-empty form starts again instead of showing a broken draft.
  await openForm(p);
  await p.reload();
  await expect(p.getByRole("button", { name: "Start workflow" })).toBeVisible({ timeout: 15_000 });
  expect(await count(p, "drafts")).toBe(0);

  // 3. A typed answer saves a draft, which survives a full restart.
  await p.getByRole("button", { name: "Start workflow" }).click();
  await p.locator("#in-asset_id").fill("PMP-7001");
  await p.locator("#in-asset_id").blur();
  await expect(p.locator("#draft-state")).toContainText("Draft saved on this device");
  expect(await count(p, "drafts")).toBe(1);
  await expect(p.locator("header .pill", { hasText: "1 not submitted" })).toBeVisible();
  const typedUrl = p.url();
  await ctx.close();
  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  await p.goto(typedUrl);
  await expect(p.locator("#in-asset_id")).toHaveValue("PMP-7001", { timeout: 20_000 });

  // 4. A captured photo alone (no typing) saves a draft too.
  await openForm(p);
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#456" } }).jpeg().toBuffer();
  await p.locator('#f-photos input[data-source="library"]').setInputFiles({ name: "IMG_1.JPG", mimeType: "image/jpeg", buffer: jpeg });
  await expect(p.locator("#f-photos .media img, #f-photos .thumbs img")).not.toHaveCount(0, { timeout: 15_000 });
  await expect(p.locator("#draft-state")).toContainText("Draft saved on this device");
  expect(await count(p, "drafts")).toBe(2);
  const attsBefore = await count(p, "attachments");

  // 5. Delete that draft (confirmed): the draft and its photo go; the other draft and every record stay.
  await p.locator("#delete-draft").click();
  await expect(p.locator("text=Unfinished entry deleted.")).toBeVisible();
  expect(await count(p, "drafts")).toBe(1);
  expect(await count(p, "attachments")).toBe(attsBefore - 1);
  expect(await count(p, "records")).toBe(recordsBefore);
  await p.goto(`${APP}#/`);
  await expect(p.locator("#home-recent li[data-state='draft']", { hasText: "PMP-7001" })).toHaveCount(1);

  // 6. Declining the confirmation deletes nothing.
  p.removeAllListeners("dialog");
  p.on("dialog", (d) => d.dismiss());
  await p.goto(typedUrl);
  await p.locator("#delete-draft").click();
  expect(await count(p, "drafts")).toBe(1);
  await ctx.close();
});
