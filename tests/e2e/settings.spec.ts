// Settings: compact voice summary with an expandable list, and three clearly different storage states with calm,
// accurate wording (no false promise of permanent storage). Browser behaviour is fixed by init scripts so the
// test is deterministic on Chromium and WebKit.
import { chromium, webkit, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;

// An iPhone-like voice list: many voices, heavily repeated language codes, plus one network voice.
const VOICES = [
  ...Array.from({ length: 18 }, (_, i) => ({ name: `English ${i}`, lang: ["en-US", "en-GB", "en-AU", "en-IN"][i % 4], localService: true })),
  ...Array.from({ length: 22 }, (_, i) => ({ name: `Voice ${i}`, lang: ["fr-FR", "de-DE", "es-ES", "it-IT", "ja-JP", "zh-CN", "ar-SA"][i % 7], localService: true })),
  { name: "Lekha", lang: "hi-IN", localService: true },
  { name: "Network voice", lang: "en-US", localService: false },
];

function initScript(mode: "protected" | "declined" | "unsupported") {
  return `(() => {
    const voices = ${JSON.stringify(VOICES)};
    try { Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
      getVoices: () => voices, speak() {}, cancel() {}, addEventListener() {}, removeEventListener() {} } }); } catch (e) {}
    const mode = ${JSON.stringify(mode)};
    if (mode === "unsupported") {
      try { Object.defineProperty(navigator, "storage", { configurable: true, value: undefined }); } catch (e) {}
    } else if (navigator.storage) {
      // Patch the prototype, not the instance: WebKit doesn't keep the navigator.storage wrapper alive, so after a
      // garbage collection navigator.storage is a fresh object and instance-level overrides silently disappear.
      const granted = mode === "protected";
      const proto = Object.getPrototypeOf(navigator.storage);
      proto.persisted = async function () { return granted; };
      proto.persist = async function () { return granted; };
    }
  })();`;
}

async function open(mode: "protected" | "declined" | "unsupported") {
  const ctx: BrowserContext = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), `fieldkit-set-${mode}-`)),
    { viewport: { width: 375, height: 667 } });
  await ctx.addInitScript(initScript(mode));
  await signIn(ctx.request);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP}#/settings`);
  await expect(page.locator("#storage-card")).toBeVisible({ timeout: 20_000 });
  return { ctx, page, errors };
}

const expectations = {
  protected: { kind: "protected", label: "Protected", button: false },
  declined: { kind: "best-effort", label: "Standard storage (not protected)", button: true },
  unsupported: { kind: "unsupported", label: "Standard storage", button: false },
} as const;

for (const mode of ["protected", "declined", "unsupported"] as const) {
  test(`storage state: ${mode}`, async () => {
    test.skip(!PASS, "set FIELDKIT_E2E_PASS");
    const { ctx, page, errors } = await open(mode);
    const exp = expectations[mode];
    const banner = page.locator("#storage-card [data-storage-kind]");
    await expect(banner).toHaveAttribute("data-storage-kind", exp.kind);
    await expect(banner.locator("strong")).toHaveText(exp.label);
    await expect(banner).not.toHaveClass(/\bbad\b|\bwarn\b/);                      // calm, never alarming
    const text = await page.locator("#storage-card").innerText();
    expect(text).not.toMatch(/evict|will be lost|danger/i);
    await expect(page.getByRole("button", { name: "Ask the browser to protect storage" })).toHaveCount(exp.button ? 1 : 0);
    if (mode === "declined") {
      await page.getByRole("button", { name: "Ask the browser to protect storage" }).click();
      await expect(page.locator(".toast")).toContainText("common on iPhone");
      await expect(page.locator(".toast-error")).toHaveCount(0);
    }
    // Home readiness never shows a failure for normal storage behaviour
    await page.goto(`${APP}#/`);
    const row = page.locator(".check", { hasText: "Storage protection" });
    await expect(row.locator(".i")).toHaveText(mode === "protected" ? "✔" : "○");
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test("the install card is honest; no read-aloud or speech settings remain", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  const { ctx, page } = await open("declined");
  await expect(page.locator("#voices-card")).toHaveCount(0);
  const install = await page.locator("#install-card").innerText();
  expect(install).toContain("isn't guaranteed");
  expect(install).toContain("doesn't make storage permanent");
  await ctx.close();
});
