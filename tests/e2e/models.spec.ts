// Real on-device intelligence: install pinned upstream models online, then translate and OCR with the
// network disabled after a full browser restart. Large download (~115 MB) → opt-in via FIELDKIT_E2E_MODELS=1.
import { chromium, webkit, expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";

// FIELDKIT_E2E_BROWSER=webkit runs the same test on WebKit (Safari's engine).
const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const APP = `${BASE}/api/plugins/fieldkit/app/`;
const profile = process.env.FIELDKIT_E2E_PROFILE ?? mkdtempSync(join(tmpdir(), "fieldkit-models-"));

test("offline translation (en→hi) and OCR after cold restart with no network", async () => {
  test.skip(!process.env.FIELDKIT_E2E_MODELS || !process.env.FIELDKIT_E2E_PASS, "set FIELDKIT_E2E_MODELS=1 and FIELDKIT_E2E_PASS");
  test.setTimeout(900_000);
  let ctx = await engine.launchPersistentContext(profile, { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  const reload = page.getByRole("button", { name: "Reload" });
  if (await reload.isVisible().catch(() => false)) { await reload.click(); await page.waitForLoadState("load"); }
  await page.goto(`${APP}#/packs`);
  console.log("phase: install", new Date().toISOString());
  await expect(page.locator("li", { hasText: "English → Hindi translation" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("text=Not yet available")).toHaveCount(0);   // no placeholder packs
  for (const title of ["English → Hindi translation", "OCR — English"]) {
    const item = page.locator("li", { hasText: title }).filter({ has: page.getByRole("button", { name: /install/i }) });
    if (process.env.FIELDKIT_E2E_SKIP_INSTALL) break;
    await item.getByRole("button", { name: /install/i }).click();
    await expect(item.locator("text=Installed and self-tested on this device")).toBeVisible({ timeout: 600_000 });
  }
  const verify = await page.locator("li", { hasText: "English → Hindi translation" }).filter({ has: page.getByRole("button", { name: /install/i }) }).innerText();
  console.log("translation install:", verify.replace(/\s+/g, " ").slice(0, 300));
  await ctx.close();

  ctx = await engine.launchPersistentContext(profile, { offline: true, viewport: { width: 390, height: 844 } });
  // Offline proof: every off-origin request must be answered by FieldKit's service worker cache
  // (pinned runtime files) — none may reach or attempt the network.
  const leaked: string[] = [];
  ctx.on("requestfinished", async (req) => {
    const u = req.url();
    if (u.startsWith(BASE) || u.startsWith("blob:") || u.startsWith("data:")) return;
    const res = await req.response();
    if (!res?.fromServiceWorker()) leaked.push(`not from SW cache: ${u}`);
  });
  ctx.on("requestfailed", (req) => { const u = req.url(); if (!u.startsWith(BASE)) leaked.push(`failed: ${u}`); });
  ctx.on("requestfailed", (req) => console.log("FAILED", req.method(), req.url().slice(0, 160), req.failure()?.errorText));
  page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 200)); });
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
  await page.goto(`${APP}#/translate`);
  await page.getByPlaceholder("Type or paste a sentence…").fill("The pump is vibrating and the bearing is hot.");
  console.log("phase: offline translate", new Date().toISOString());
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  const out = page.locator(".card p").filter({ hasText: /[ऀ-ॿ]/ });
  await expect(out).toBeVisible({ timeout: 180_000 });
  console.log("offline translation:", await out.innerText());
  await expect(page.locator("text=no network used")).toBeVisible();

  await page.goto(`${APP}#/ocr`);
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 900; c.height = 200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000"; g.font = "bold 64px Arial"; g.fillText("FIELDKIT OFFLINE 42", 30, 120);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "sign.png", { type: "image/png" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("text=Done offline")).toBeVisible({ timeout: 120_000 });
  const ocrText = await page.locator("textarea").inputValue();
  console.log("offline OCR:", ocrText);
  expect(ocrText.toUpperCase()).toContain("FIELDKIT");
  // Requests made from tesseract's dedicated worker (importScripts) are not attributed to the service
  // worker by Playwright; accept them only if FieldKit's own upstream cache provably holds that exact URL.
  const swCached: string[] = await page.evaluate(async () =>
    (await (await caches.open("fieldkit-upstream-v1")).keys()).map((r) => r.url));
  const unexplained = leaked.filter((l) => !(l.startsWith("not from SW cache: ") && swCached.includes(l.slice(19))));
  console.log("served from FieldKit upstream cache:", swCached.join(", "));
  expect(unexplained, unexplained.join(" | ")).toEqual([]);
  await ctx.close();
});
