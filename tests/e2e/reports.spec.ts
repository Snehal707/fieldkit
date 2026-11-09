// Offline access to a completed Hermes report: record synced → report stored on the server (same code path the
// worker/Hermes use) → phone downloads it → browser closed → reopened with NO network → report fully readable.
import { chromium, webkit, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signIn } from "./auth";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const DATA_DIR = process.env.FIELDKIT_E2E_DATA_DIR ?? "";  // <HERMES_HOME>/plugin-data/fieldkit of the test instance
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const PY = resolve(import.meta.dirname, "../../.venv/Scripts/python.exe");

test("a downloaded Hermes report stays readable offline after a cold restart", async () => {
  test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR");
  const profile = mkdtempSync(join(tmpdir(), "fieldkit-report-"));
  let ctx = await engine.launchPersistentContext(profile, { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  await ctx.request.post(`${BASE}/api/plugins/fieldkit/examples/install`);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/packs`);
  await page.locator("li", { hasText: "Equipment inspection" }).first().getByRole("button").click();
  await expect(page.locator("text=Downloaded Equipment inspection")).toBeVisible({ timeout: 30_000 });
  await page.goto(`${APP}#/workflows`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.locator("#in-asset_id").fill("PMP-7001");
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-09");
  await page.locator("#f-condition label", { hasText: "Fair" }).click();
  await page.locator("#f-guard_ok label", { hasText: "No" }).click();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page.locator("text=Synchronised — durably received by Hermes")).toBeVisible({ timeout: 30_000 });
  const id = page.url().split("#/results/")[1];

  // Store a report exactly as the analysis worker / fieldkit_save_report does.
  execFileSync(PY, ["-c", `
import os, sys
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, "../.."))})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from fieldkit_core import db
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
s.save_report_direct(${JSON.stringify(id)}, {"summary": "Guard missing on PMP-7001; stop and refit before use.",
  "issues": [{"title": "Safety guard missing", "severity": "critical", "evidence": "guard_ok = No"}],
  "missing_information": [], "references": [], "suggested_actions": [{"action": "Tag out the machine", "priority": "urgent"}],
  "followups": [{"title": "Re-inspect after refit", "detail": "", "due_date": None}], "requires_review": True,
  "review_reason": "Safety-critical", "images": {"attached": 0, "analyzed": None, "note": ""}}, True, generated_by="e2e")
`]);

  // The phone downloads it (Results → Download report).
  await page.goto(`${APP}#/results/${id}?r=1`);
  await page.getByRole("button", { name: /Download report|Check for newer report/ }).click();
  await expect(page.locator("text=Guard missing on PMP-7001")).toBeVisible({ timeout: 20_000 });
  await ctx.close();

  // Cold restart with no network: the report is still there, on the Results page and in Reports.
  ctx = await engine.launchPersistentContext(profile, { offline: true, viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
  await page.goto(`${APP}#/results/${id}`);
  await expect(page.locator("text=Guard missing on PMP-7001")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("text=available offline")).toBeVisible();
  await expect(page.locator("text=Requires human review").first()).toBeVisible();
  await expect(page.locator("text=Tag out the machine")).toBeVisible();
  await page.goto(`${APP}#/reports`);
  await expect(page.locator("text=Guard missing on PMP-7001")).toBeVisible();
  await expect(page.locator("header", { hasText: "device offline" })).toBeVisible();
  await ctx.close();
});
