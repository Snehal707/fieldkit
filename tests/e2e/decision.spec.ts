// Older structured reports (created before 0.2.6) stay readable on the phone: the report leads with a decision and
// ordered actions with how to verify them. The report is made by FieldKit's real pipeline with the LLM round-trip
// stubbed (tests/python/hermes_stub.py) and arrives with sync.
import { chromium, webkit, expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signIn } from "./auth";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";
const DATA_DIR = process.env.FIELDKIT_E2E_DATA_DIR ?? "";
const APP = `${BASE}/dashboard-plugins/fieldkit/app_dist/index.html`;
const API = `${BASE}/api/plugins/fieldkit`;
const ROOT = resolve(import.meta.dirname, "../..");
const PY = resolve(ROOT, ".venv/Scripts/python.exe");
const run = String(Date.now() % 1_000_000).padStart(6, "0");
const ASSET = `DEC-${run}`;

async function inspect(page: Page): Promise<string> {
  await page.goto(`${APP}#/workflows`);
  await page.locator("li", { hasText: "Equipment inspection" }).getByRole("button", { name: "Start" }).click();
  await page.locator("#in-asset_id").fill(ASSET);
  await page.locator("#in-asset_id").blur();
  await page.locator("#in-inspection_date").fill("2026-11-10");
  await page.locator("#f-condition label", { hasText: "Fair" }).click();
  await page.locator("#f-guard_ok label", { hasText: "No" }).click();
  return "";
}

test("the report leads with a decision and its checks are asked on the next inspection", async () => {
  test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR");
  test.setTimeout(180_000);
  const ctx = await engine.launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-dec-")), { viewport: { width: 390, height: 844 } });
  await signIn(ctx.request);
  await ctx.request.post(`${API}/examples/install`);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/packs`);
  await page.locator("li", { hasText: "Equipment inspection" }).first().getByRole("button").click();
  await expect(page.locator("text=Downloaded Equipment inspection")).toBeVisible({ timeout: 30_000 });

  await inspect(page);
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page.locator("text=Saved to Hermes — confirmed")).toBeVisible({ timeout: 30_000 });
  const id = page.url().split("#/results/")[1].split("?")[0];

  const out = execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)}); sys.path.insert(0, ${JSON.stringify(join(ROOT, "tests", "python"))})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from hermes_stub import GOOD_REPORT, Recorder, make_llm
from fieldkit_core import analysis, db
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
report, review, *_ = analysis.analyze_record(s, make_llm(Recorder({"default": GOOD_REPORT})), ${JSON.stringify(id)})
s.save_report_direct(${JSON.stringify(id)}, report, review, generated_by="e2e-decision")
print(json.dumps({"outcome": report["decision"]["outcome"], "problems": report["quality"]["problems"]}))
`]).toString();
  const res = JSON.parse(out.trim().split("\n").pop()!);
  expect(res).toEqual({ outcome: "stop", problems: [] });

  await page.goto(`${APP}#/results/${id}?r=${Date.now()}`);
  await page.goto(`${APP}#/sync`);   // 0.2.6: an existing report arrives with sync (no "Download report" button without one)
  await page.getByRole("button", { name: /Sync now/ }).click().catch(() => undefined);
  await page.waitForTimeout(4000);
  await page.goto(`${APP}#/results/${id}?r=${Date.now()}`);
  const decisionBox = page.locator("#report-decision");
  await expect(decisionBox).toBeVisible({ timeout: 20_000 });
  await expect(decisionBox).toHaveAttribute("data-outcome", "stop");
  await expect(decisionBox).toContainText("Stop and escalate");
  await expect(decisionBox).toContainText("Escalate to: maintenance supervisor");
  await expect(page.locator("#report-actions li")).toHaveCount(2);
  await expect(page.locator("#report-actions li").first()).toContainText("Check it worked: Guard refitted");
  await expect(page.locator("#report-actions li").first()).toContainText("AI suggestion");
  await expect(page.locator("#report-checks")).toContainText("Vibration after alignment");

  await ctx.close();
});
