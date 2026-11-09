// Voice: record a note (fake microphone), install Whisper tiny online, then transcribe it with the network
// disabled after a cold restart. Proves the pipeline runs on-device; transcription ACCURACY is not asserted
// (the fake device produces a tone, not speech). Chromium only (WebKit has no fake media device).
import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./auth";

const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const profile = process.env.FIELDKIT_E2E_VOICE_PROFILE ?? mkdtempSync(join(tmpdir(), "fieldkit-voice-"));
const opts = { viewport: { width: 390, height: 844 }, permissions: ["microphone"],
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] };

test("voice note recorded, Whisper installed, transcribed offline after restart", async () => {
  test.skip(!PASS || !process.env.FIELDKIT_E2E_MODELS, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_MODELS=1");
  test.setTimeout(900_000);
  let ctx = await chromium.launchPersistentContext(profile, opts);
  await signIn(ctx.request);
  await ctx.request.post(`${BASE}/api/plugins/fieldkit/examples/install`);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/packs`);
  await page.locator("li", { hasText: "Equipment inspection" }).getByRole("button", { name: /Download for offline|Re-download|Update/ }).first().click();
  await expect(page.locator("text=Downloaded Equipment inspection")).toBeVisible({ timeout: 30_000 });
  const stt = page.locator("li", { hasText: "Speech to text" }).filter({ has: page.getByRole("button", { name: /install/i }) });
  await stt.getByRole("button", { name: /install/i }).click();
  await expect(stt.locator("text=Installed and self-tested on this device")).toBeVisible({ timeout: 600_000 });
  console.log("stt install:", (await stt.innerText()).replace(/\s+/g, " ").slice(0, 200));
  await ctx.close();

  ctx = await chromium.launchPersistentContext(profile, { ...opts, offline: true });
  page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP}#/workflows`);
  await page.getByRole("button", { name: "Start" }).click();
  const voice = page.locator("#f-voice_note");
  await voice.getByRole("button", { name: /Record voice note/ }).click();
  await page.waitForTimeout(3000);
  await voice.getByRole("button", { name: /Stop recording/ }).click();
  await expect(voice.locator("audio")).toHaveCount(1, { timeout: 10_000 });     // saved locally + playable
  await expect(voice.locator("text=/\\d+(\\.\\d)? s ·/")).toBeVisible();
  await voice.getByRole("button", { name: /Transcribe \(offline\)/ }).click();
  // Pipeline finished on-device: either a transcript appears or the button is offered again (no speech in a tone).
  await expect(voice.getByRole("button", { name: /Transcribing on device/ })).toHaveCount(0, { timeout: 180_000 });
  const toast = await page.locator(".toast-error").allInnerTexts();
  console.log("voice section after offline transcription:", (await voice.innerText()).replace(/\s+/g, " ").slice(0, 200));
  expect(toast, `error toast: ${toast.join(" | ")}`).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});
