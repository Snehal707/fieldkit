// Regression for the real-iPhone findings (0.2.4), against a real Hermes:
//  - Results showed a broken photo thumbnail and an audio playback error;
//  - signatures must reach Hermes linked to the right inspection, intact, and be viewable in the report;
//  - voice notes must be considered by the analysis, and attachment counts must be right (a signature is not a photo).
// The photo is an iPhone-style JPEG stored in sensor orientation with EXIF orientation 6.
// Voice notes need a fake microphone, which only Chromium has; WebKit runs the photo + signature parts.
import { chromium, webkit, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { signIn } from "./auth";

const isWebkit = process.env.FIELDKIT_E2E_BROWSER === "webkit";
const engine = isWebkit ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const DATA_DIR = process.env.FIELDKIT_E2E_DATA_DIR ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const API = `${BASE}/api/plugins/fieldkit`;
const ROOT = resolve(import.meta.dirname, "../..");
const PY = resolve(ROOT, ".venv/Scripts/python.exe");
const run = String(Date.now() % 1_000_000).padStart(6, "0");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function client(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-media-")), {
    viewport: { width: 390, height: 844 },
    ...(isWebkit ? {} : { permissions: ["microphone"], args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }),
  });
  await signIn(ctx.request);
  await ctx.request.post(`${API}/examples/install`);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  return { ctx, page };
}

/** iPhone-style photo: pixels stored landscape (sensor orientation) + EXIF orientation 6 → portrait when shown. */
async function iphonePhoto(): Promise<string> {
  const upright = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#d8d2c4" } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect x="0" y="0" width="300" height="120" fill="#c00"/>
      <text x="80" y="400" font-size="90" font-family="Arial">PMP-${run}</text></svg>`), left: 0, top: 0 }]).png().toBuffer();
  const file = join(mkdtempSync(join(tmpdir(), "fk-photo-")), "IMG_0001.jpg");
  writeFileSync(file, await sharp(upright).rotate(-90).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer());
  return file;
}

test.beforeEach(() => { test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR"); });

test("photo, voice note and signature: playable on Results, intact on Hermes, evidence in the report", async () => {
  test.setTimeout(240_000);
  const A = await client();
  const { page } = A;
  await page.goto(`${APP}#/packs`);
  await page.locator("li", { hasText: "Equipment inspection" }).first().getByRole("button").click();
  await expect(page.locator("text=Downloaded Equipment inspection")).toBeVisible({ timeout: 30_000 });
  await page.goto(`${APP}#/workflows`);
  await page.locator("li", { hasText: "Equipment inspection" }).getByRole("button", { name: "Start" }).click();
  await page.locator("#in-asset_id").fill(`MED-${run}`);
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-09");
  await page.locator("#f-condition label", { hasText: "Fair" }).click();
  await page.locator("#f-guard_ok label", { hasText: "No" }).click();

  // Photo (EXIF-rotated): stored upright, i.e. portrait.
  await page.locator('#f-photos input[type="file"]').setInputFiles(await iphonePhoto());
  await expect(page.locator('#f-photos .media[data-media-state="ok"] img')).toHaveCount(1, { timeout: 20_000 });
  const dims = await page.locator("#f-photos .media img").evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  expect(dims[1]).toBeGreaterThan(dims[0]);                                        // EXIF orientation applied

  // Voice note (Chromium's fake microphone).
  if (!isWebkit) {
    const voice = page.locator("#f-voice_note");
    await voice.getByRole("button", { name: /Record voice note/ }).click();
    await page.waitForTimeout(2500);
    await voice.getByRole("button", { name: /Stop recording/ }).click();
    await expect(voice.locator('.media[data-media-state="ok"] audio')).toHaveCount(1, { timeout: 15_000 });
  }

  // Signature.
  const pad = page.locator("#f-inspector_sign canvas");
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 20, box.y + box.height / 2 + (i % 2 ? -25 : 25));
  await page.mouse.up();
  await page.locator("#f-inspector_sign").getByRole("button", { name: "Save signature" }).click();
  await expect(page.locator('#f-inspector_sign .media[data-media-state="ok"] img')).toHaveCount(1, { timeout: 15_000 });

  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page).toHaveURL(/#\/results\//, { timeout: 30_000 });
  const id = page.url().split("#/results/")[1].split("?")[0];
  const n = isWebkit ? 2 : 3;
  const summary = isWebkit ? "1 photo · 1 signature" : "1 photo · 1 voice note · 1 signature";

  // Results after upload: every file loads (no broken thumbnail, no audio error); counts are per kind.
  await expect.poll(async () => {
    const r = await (await A.ctx.request.get(`${API}/records/${id}`)).json();
    return r.sync_status;
  }, { timeout: 60_000, intervals: [1_000] }).toBe("complete");
  await page.goto(`${APP}#/results/${id}?r=${Date.now()}`);
  await expect(page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#result-media .media[data-media-state="ok"]')).toHaveCount(n, { timeout: 20_000 });
  await expect(page.locator(".media-problem")).toHaveCount(0);
  await expect(page.locator("#result-media").locator("..")).toContainText(summary);
  await expect(page.locator("#media-upload-status")).toHaveAttribute("data-uploaded", String(n));
  if (!isWebkit) {
    const playable = await page.locator("#result-media audio").evaluate((a: HTMLAudioElement) => ({ err: a.error?.code ?? 0, dur: a.duration }));
    expect(playable.err).toBe(0);
    expect(playable.dur).toBeGreaterThan(0);
  }

  // Hermes has every file, linked to THIS inspection, byte-for-byte what the phone captured.
  const rec = await (await A.ctx.request.get(`${API}/records/${id}`)).json();
  expect(rec.attachment_summary).toBe(summary);
  const local = await page.evaluate((rid) => new Promise<{ id: string; sha256: string; field_id: string }[]>((res) => {
    const q = indexedDB.open("fieldkit");
    q.onsuccess = () => { const g = q.result.transaction("attachments").objectStore("attachments").index("by_record").getAll(rid);
      g.onsuccess = () => res(g.result.map((a: any) => ({ id: a.id, sha256: a.sha256, field_id: a.field_id }))); };
  }), id);
  expect(local).toHaveLength(n);
  for (const a of local) {
    const server = rec.attachments.find((x: any) => x.id === a.id);
    expect(server, `attachment ${a.field_id} on Hermes`).toBeTruthy();
    expect(server.status).toBe("stored");
    expect(server.sha256).toBe(a.sha256);
    expect(server.field_id).toBe(a.field_id);
    const body = await (await A.ctx.request.get(`${API}/attachments/${a.id}`)).body();
    expect(sha(body)).toBe(a.sha256);
  }
  if (!isWebkit) {
    // Hermes transcribes the voice note right after upload, in the dashboard process, with its own speech-to-text.
    // Whatever this Hermes can do, the outcome is recorded: a transcript, or the reason there isn't one.
    const vn = await expect.poll(async () => {
      const r = await (await A.ctx.request.get(`${API}/records/${id}`)).json();
      const v = r.attachments.find((x: any) => x.kind === "audio");
      return v.transcript || v.transcript_error ? v : null;
    }, { timeout: 120_000, intervals: [2_000] }).not.toBeNull();
    const r2 = await (await A.ctx.request.get(`${API}/records/${id}`)).json();
    const v2 = r2.attachments.find((x: any) => x.kind === "audio");
    console.log("Hermes speech-to-text on upload:", JSON.stringify({ transcript: v2.transcript, source: v2.transcript_source, error: v2.transcript_error }));
    void vn;
  }
  const sig = rec.attachments.find((x: any) => x.kind === "signature");
  expect(sig.field_id).toBe("inspector_sign");
  expect(sig.signed_at).toBeTruthy();

  // A damaged copy on the device is restored from Hermes' verified copy instead of showing a broken image.
  const photoId = local.find((a) => a.field_id === "photos")!.id;
  await page.evaluate((aid) => new Promise<void>((res) => {
    const q = indexedDB.open("fieldkit");
    q.onsuccess = () => { const st = q.result.transaction("attachments", "readwrite").objectStore("attachments");
      const g = st.get(aid); g.onsuccess = () => { st.put({ ...g.result, blob: new Blob([]) }).onsuccess = () => res(); }; };
  }), photoId);
  await page.goto(`${APP}#/results/${id}?r=${Date.now()}`);
  const restored = page.locator(`#result-media .media[data-attachment-id="${photoId}"]`);
  await expect(restored).toHaveAttribute("data-media-state", "ok", { timeout: 20_000 });
  await expect(restored).toContainText("restored from Hermes (verified)");

  // Real analysis pipeline on the uploaded files (LLM round-trip stubbed; Hermes' own speech-to-text as configured here).
  const out = execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)}); sys.path.insert(0, ${JSON.stringify(join(ROOT, "tests", "python"))})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from hermes_stub import GOOD_REPORT, Recorder, make_llm
from fieldkit_core import analysis, db
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
report, review, provider, model = analysis.analyze_record(s, make_llm(Recorder({"default": GOOD_REPORT})), ${JSON.stringify(id)})
s.save_report_direct(${JSON.stringify(id)}, report, review, generated_by="e2e-real-analysis")
print(json.dumps({"images": report["images"]["attached"], "att": report["attachments"]["summary"], "voice": report["attachments"]["voice_notes"],
  "missing": [m for m in report["missing_information"] if "voice" in m]}))
`]).toString();
  const res = JSON.parse(out.trim().split("\n").pop()!);
  console.log("analysis:", JSON.stringify(res));
  expect(res.images).toBe(1);                                                // the signature is not counted as a photo
  expect(res.att).toBe(summary);
  if (!isWebkit) {
    expect(res.voice.attached).toBe(1);
    // Either Hermes transcribed it, or the report says why not — never silently ignored.
    expect(res.voice.transcribed === 1 || res.missing.some((m: string) => m.includes("could not be transcribed"))).toBe(true);
  }

  // The phone downloads the report: evidence with the signature (intact, viewable) and the voice-note status.
  await page.goto(`${APP}#/results/${id}?r=${Date.now()}`);
  await page.getByRole("button", { name: /Download report|Check for newer report/ }).click();
  const ev = page.locator("#report-evidence");
  await expect(ev).toBeVisible({ timeout: 20_000 });
  await expect(ev.locator("[data-summary]")).toHaveText(summary);
  await expect(ev.locator(`[data-signature="${sig.id}"]`)).toHaveAttribute("data-integrity", "intact");
  await ev.getByRole("button", { name: "Show signature" }).click();
  await expect(ev.locator(`.media[data-attachment-id="${sig.id}"][data-media-state="ok"] img`)).toHaveCount(1, { timeout: 15_000 });
  if (!isWebkit) await expect(ev.locator("[data-voice-transcribed]")).toBeVisible();
  await A.ctx.close();

  // Another install on the same account can open the record and validate the signature from Hermes.
  const B = await client();
  await B.page.goto(`${APP}#/remote/${id}`);
  await expect(B.page.locator("#remote-record")).toBeVisible({ timeout: 20_000 });
  const remoteSig = B.page.locator(`.media[data-attachment-id="${sig.id}"]`).first();
  await remoteSig.getByRole("button", { name: "Show signature" }).click();
  await expect(remoteSig.locator("img")).toHaveCount(1, { timeout: 15_000 });
  await expect(remoteSig).toHaveAttribute("data-media-state", "ok");
  await B.ctx.close();
});

// Real speech through Hermes' own speech-to-text (whatever provider this Hermes is configured with). Set
// FIELDKIT_E2E_SPEECH_WAV to a 16 kHz WAV of an English sentence (tests/eval/tts.ps1 makes synthetic ones) and
// FIELDKIT_E2E_SPEECH_TEXT to the sentence.
test("a spoken voice note is transcribed by Hermes on upload and reaches the analysis", async () => {
  const wavPath = process.env.FIELDKIT_E2E_SPEECH_WAV ?? "";
  const expected = (process.env.FIELDKIT_E2E_SPEECH_TEXT ?? "").toLowerCase().replace(/[^a-z ]/g, "");
  test.skip(!wavPath || !expected, "set FIELDKIT_E2E_SPEECH_WAV and FIELDKIT_E2E_SPEECH_TEXT");
  const { readFileSync } = await import("node:fs");
  const r = await (await import("@playwright/test")).request.newContext();
  await signIn(r);
  const wav = readFileSync(wavPath);
  const rid = `rec_speech${run}abc`, aid = `att_speech${run}abc`;
  const sync = await r.post(`${API}/sync/records`, { data: { idempotency_key: `idk_speech_${run}`, device_id: "dev_speech0001", record: {
    id: rid, workflow_id: "equipment-inspection", workflow_version: 1, base_revision: 0,
    answers: { asset_id: `SPK-${run}`, voice_note: [{ attachment_id: aid, recorded_at: new Date().toISOString() }] },
    created_local_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    attachments: [{ id: aid, field_id: "voice_note", mime: "audio/wav", size: wav.length, sha256: sha(wav) }] } } });
  expect(sync.ok(), await sync.text()).toBe(true);
  expect((await r.put(`${API}/attachments/${aid}`, { data: wav, headers: { "content-type": "audio/wav" } })).ok()).toBe(true);
  let got: any = null;
  await expect.poll(async () => {
    got = (await (await r.get(`${API}/records/${rid}`)).json()).attachments.find((x: any) => x.id === aid);
    return got.transcript || got.transcript_error || null;
  }, { timeout: 180_000, intervals: [2_000] }).not.toBeNull();
  console.log("Hermes transcript:", got.transcript ?? `(none: ${got.transcript_error})`);
  expect(got.transcript_error ?? null).toBeNull();
  expect(got.transcript_source).toBe("hermes");
  const words = expected.split(" ").filter((w) => w.length > 3);
  const heard = got.transcript.toLowerCase();
  expect(words.filter((w) => heard.includes(w)).length / words.length).toBeGreaterThan(0.7);
  const out = execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)}); sys.path.insert(0, ${JSON.stringify(join(ROOT, "tests", "python"))})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from hermes_stub import GOOD_REPORT, Recorder, make_llm
from fieldkit_core import analysis, db
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
rec = Recorder({"default": GOOD_REPORT})
report, *_ = analysis.analyze_record(s, make_llm(rec), ${JSON.stringify(rid)})
print(json.dumps({"voice": report["attachments"]["voice_notes"], "in_prompt": ${JSON.stringify(got.transcript)} in json.dumps(rec.calls[0]["messages"], ensure_ascii=False, default=str)}))
`]).toString();
  const res = JSON.parse(out.trim().split("\n").pop()!);
  expect(res.voice).toEqual({ attached: 1, transcribed: 1, from_device: 0, from_hermes: 1 });
  expect(res.in_prompt).toBe(true);
  await r.dispose();
});
