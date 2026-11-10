// Regression for the real-iPhone findings (0.2.4), against a real Hermes:
//  - Results showed a broken photo thumbnail and an audio playback error;
//  - signatures must reach Hermes linked to the right entry, intact, and be viewable from another device;
//  - Hermes' tools must hand over every file (right kind, intact), and counts must be right (a signature is not a photo).
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
import { downloadWorkspace, startEntry } from "./helpers";

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

test("photo, voice note and signature: playable on the entry, intact on Hermes, readable by Hermes' tools", async () => {
  test.setTimeout(240_000);
  const A = await client();
  const { page } = A;
  await downloadWorkspace(page, APP);
  await startEntry(page, APP);
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
  {
    // An upload never triggers processing: no transcription on Hermes.
    await new Promise((done) => setTimeout(done, 5_000));
    const r2 = await (await A.ctx.request.get(`${API}/records/${id}`)).json();
    const v2 = r2.attachments.find((x: any) => x.kind === "audio");
    if (v2) {                        // WebKit records no voice note in this test
      expect(v2.transcript_source ?? null, "no Hermes speech-to-text on upload").not.toBe("hermes");
      expect(v2.transcript_error ?? null).toBeNull();
    }
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

  // Hermes' own tools get every file as a readable copy (for its vision / speech-to-text), right kind, intact.
  const out = execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from fieldkit_core import db, tools
db.set_store(db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db")))
rec = json.loads(tools.handler_for("fieldkit_get_record")({"record_id": ${JSON.stringify(id)}}))
files = [json.loads(tools.handler_for("fieldkit_get_attachment")({"attachment_id": a["id"]})) for a in rec["record"]["attachments"]]
print(json.dumps({"summary": rec["record"]["attachment_summary"], "files": [[f["kind"], f["integrity"], f["path"].rsplit(".", 1)[-1], os.path.getsize(f["path"])] for f in files]}))
`]).toString();
  const res = JSON.parse(out.trim().split(/\r?\n/).pop()!);
  console.log("hermes tools:", JSON.stringify(res));
  expect(res.summary).toBe(summary);
  for (const [kind, integrity, ext, size] of res.files) {
    expect(integrity).toBe("intact");
    expect(size).toBeGreaterThan(0);
    expect(kind === "audio" ? ["webm", "m4a", "ogg"] : ["jpg", "png", "webp"]).toContain(ext);
  }
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
