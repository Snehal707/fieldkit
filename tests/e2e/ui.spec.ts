// UI regressions (v0.1.6):
// 1. Offline Packs: a model installed while the screen is open flips to "Reinstall" immediately, appears in
//    "On this device", stays installed after reload (IndexedDB), and works offline after a cold restart.
// 2. Update notice from a REAL service-worker update: compact, opaque, in page flow under the header, never
//    overlapping content, the bottom nav or a focused input; one instance; fits a 320 px wide screen.
import { chromium, webkit, expect, test } from "@playwright/test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const PLUGIN_DIR = process.env.FIELDKIT_E2E_PLUGIN_DIR ?? "";  // deployed plugin dir of the test Hermes

async function signedIn(profile: string, opts: object = {}) {
  const ctx = await engine.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, ...opts });
  await signIn(ctx.request);
  const page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  return { ctx, page };
}

test("installed models flip to Reinstall immediately, persist, and work offline", async () => {
  test.skip(!PASS || !process.env.FIELDKIT_E2E_MODELS, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_MODELS=1");
  test.setTimeout(1_200_000);
  const profile = process.env.FIELDKIT_E2E_PROFILE ?? mkdtempSync(join(tmpdir(), "fieldkit-ui-"));
  let { ctx, page } = await signedIn(profile);
  await page.goto(`${APP}#/packs`);
  const titles = ["Hindi → English translation", "Speech to text", "OCR — Hindi (Devanagari)"];
  const ids = { "Hindi → English translation": "translate-hi-en", "Speech to text": "stt-whisper-tiny", "OCR — Hindi (Devanagari)": "ocr-hin" } as Record<string, string>;
  for (const t of titles) {
    const btn = page.locator(`button[data-model="${ids[t]}"]`);
    await expect(btn).toBeVisible({ timeout: 20_000 });
    await btn.click();
    const row = page.locator("li", { has: btn });
    await expect(row.locator("text=Installed and self-tested on this device")).toBeVisible({ timeout: 900_000 });
    await expect(btn).toHaveText("Reinstall");                        // no reload needed
    await expect(btn).toHaveAttribute("data-installed", "true");
    await expect(page.locator(`[data-on-device="${ids[t]}"]`)).toBeVisible();  // "On this device" updated too
  }
  await page.reload();
  for (const t of titles) await expect(page.locator(`button[data-model="${ids[t]}"]`)).toHaveText("Reinstall");
  await ctx.close();

  ctx = await engine.launchPersistentContext(profile, { offline: true, viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
  await page.goto(`${APP}#/packs`);
  for (const t of titles) await expect(page.locator(`[data-on-device="${ids[t]}"]`)).toBeVisible({ timeout: 20_000 });
  await page.goto(`${APP}#/translate`);
  await page.locator("select").selectOption("hi>en");
  await page.getByPlaceholder("Type or paste a sentence…").fill("पंप गर्म है।");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  const out = page.locator(".card p").filter({ hasText: /[A-Za-z]{3,}/ }).first();
  await expect(out).toBeVisible({ timeout: 180_000 });
  console.log("offline hi→en:", await out.innerText());
  await expect(page.locator("text=no network used")).toBeVisible();
  await ctx.close();
});

test("update notice after a real service-worker update is compact, opaque and never overlaps", async () => {
  test.skip(!PASS || !PLUGIN_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_PLUGIN_DIR");
  const swPath = join(PLUGIN_DIR, "dashboard", "app_dist", "sw.js");
  const original = readFileSync(swPath, "utf-8");
  const { ctx, page } = await signedIn(mkdtempSync(join(tmpdir(), "fieldkit-upd-")), { viewport: { width: 320, height: 568 } });  // iPhone SE size
  try {
    await page.goto(`${APP}#/assistant`);
    const input = page.getByPlaceholder(/Ask a question/);
    await input.focus();                                                // keyboard-open situation
    appendFileSync(swPath, `\n// e2e update ${Date.now()}\n`);          // a genuinely new service worker
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r?.update(); });
    const bar = page.locator(".update-bar");
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(bar).toContainText("Update ready");

    const geo = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const bar = document.querySelector(".update-bar") as HTMLElement;
      const st = getComputedStyle(bar);
      const bg = st.backgroundColor;
      const alpha = bg.startsWith("rgba") ? Number(bg.split(",")[3]) : 1;
      const inp = document.querySelector("input")!.getBoundingClientRect();
      return { bar: r(".update-bar"), main: r("main"), nav: r("nav.bottom"), header: r("header.top"), inp, alpha,
        position: st.position, parentPosition: getComputedStyle(bar.parentElement!).position, vw: innerWidth,
        bars: document.querySelectorAll(".update-bar").length };
    });
    const overlap = (a: DOMRect, b: DOMRect) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    expect(geo.position).not.toBe("fixed");
    expect(geo.parentPosition).not.toBe("fixed");
    expect(geo.alpha).toBe(1);                                          // opaque: content never shows through
    expect(geo.bar.top).toBeGreaterThanOrEqual(geo.header.bottom - 1);  // below the header
    expect(geo.bar.bottom).toBeLessThanOrEqual(geo.main.top + 1);       // above the content, not over it
    expect(overlap(geo.bar as DOMRect, geo.nav as DOMRect)).toBe(false);
    expect(overlap(geo.bar as DOMRect, geo.inp as DOMRect)).toBe(false);
    expect(geo.bar.right).toBeLessThanOrEqual(geo.vw);                  // fits 320 px
    expect(geo.bar.height).toBeLessThanOrEqual(56);                     // compact single line
    expect(geo.bars).toBe(1);

    // a second update signal never stacks a duplicate
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("fieldkit:update-ready", { detail: {} })));
    await expect(page.locator(".update-bar")).toHaveCount(1);
    // dismiss works; Reload activates the new worker
    await page.getByRole("button", { name: "Dismiss update notice" }).click();
    await expect(page.locator(".update-bar")).toHaveCount(0);
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r?.update(); });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("fieldkit:update-ready", { detail: {} })));
    const before = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    await page.getByRole("button", { name: "Reload" }).click();
    await page.waitForLoadState("load");
    await expect(page.locator("header.top")).toBeVisible();
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(before);  // same URL, new version, app intact
  } finally {
    writeFileSync(swPath, original);
    await ctx.close();
  }
});
