// Workspaces on the phone, against a real Hermes: a workspace created with FieldKit's own workspace code (as Hermes'
// tools do) opens from its link, downloads in one tap, works offline after a cold restart, records an entry filed
// under that workspace, and after an edit shows "Update available" while the older entry keeps its answers.
import { chromium, webkit, expect, test } from "@playwright/test";
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
const PY = resolve(ROOT, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const VIEW = { viewport: { width: 390, height: 844 } };
const RUN = Date.now().toString(36);
const WID = `e2e-visits-${RUN}`;

function tool(name: string, args: object): any {
  const out = execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from fieldkit_core import db, tools
db.set_store(db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db")))
print(tools.handler_for(${JSON.stringify(name)})(json.loads(${JSON.stringify(JSON.stringify(args))})))
`]).toString();
  return JSON.parse(out.trim().split("\n").pop()!);
}

const FORM = {
  id: `e2e-visit-${RUN}`, title: { en: "Home visit" }, languages: ["en"], metadata: { subject_field: "household_id" },
  fields: [
    { id: "household_id", type: "text", label: { en: "Household ID" }, required: true },
    { id: "concern", type: "single_choice", label: { en: "Main concern" },
      options: [{ value: "none", label: { en: "None" } }, { value: "water", label: { en: "Water" } }] },
    { id: "concern_notes", type: "multiline", label: { en: "Describe the concern" },
      visible_if: { op: "neq", field: "concern", value: "none" } },
    { id: "photos", type: "photo", label: { en: "Photos" } },
  ],
};

test.beforeEach(() => { test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR"); });

test("a workspace downloads in one tap, works offline, files entries under it and shows updates", async () => {
  test.setTimeout(180_000);
  const run = RUN;
  const d = tool("fieldkit_draft_workspace", { workspace_id: WID, title: "Home visits", purpose: "Record what I see on home visits", forms: [FORM] });
  expect(d.valid, JSON.stringify(d.errors)).toBe(true);
  expect(tool("fieldkit_publish_workspace", { workspace_id: WID, user_approved: true }).ok).toBe(true);

  const profile = mkdtempSync(join(tmpdir(), "fk-ws-"));
  let ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/workspace/${WID}`);                         // the link Hermes returns after publishing
  await page.locator("#ws-download").click();
  await expect(page.locator("#ws-home")).toContainText("Record what I see on home visits", { timeout: 30_000 });
  await expect(page.locator("#ws-evidence, #ws-guides, #ws-gaps")).toHaveCount(0);   // no research parts any more
  await ctx.close();

  // Offline cold restart: record an entry from the workspace page.
  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  page = await ctx.newPage();
  await page.goto(`${APP}#/workspace/${WID}`);
  await expect(page.locator("#ws-home")).toBeVisible({ timeout: 20_000 });
  await page.locator(`#ws-workflows a[href*="?ws=${WID}"]`).click();
  await page.getByRole("button", { name: "Start workflow" }).click();
  await page.locator("#in-household_id").fill(`HH-${run}`);
  await page.locator("#in-household_id").blur();
  await page.locator("#f-concern label", { hasText: "Water" }).click();
  await page.locator("#in-concern_notes").fill("Tank leaking");
  await page.locator("#in-concern_notes").blur();
  await page.getByRole("button", { name: "Complete workflow" }).click();
  await expect(page.locator("text=Saved locally. Pending synchronization.")).toBeVisible({ timeout: 15_000 });
  const rid = page.url().split("#/results/")[1].split("?")[0];
  await ctx.close();

  // Online: the entry syncs, filed under its workspace.
  ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  page = await ctx.newPage();
  await page.goto(`${APP}#/sync`);
  await expect.poll(async () => (await ctx.request.get(`${API}/records/${rid}`)).status(), { timeout: 60_000 }).toBe(200);
  expect((await (await ctx.request.get(`${API}/records/${rid}`)).json()).workspace_id).toBe(WID);

  // An edit published from Hermes: the phone shows the update and its change list; the old entry keeps its answers.
  const edited = { ...FORM, fields: FORM.fields.filter((f) => f.id !== "concern_notes").concat([{ id: "follow_up", type: "checkbox", label: { en: "Follow-up needed" } } as any]) };
  const e = tool("fieldkit_draft_workspace", { workspace_id: WID, forms: [edited] });
  expect(e.changes_since_published.join(" | ")).toContain('removed question "Describe the concern"');
  tool("fieldkit_publish_workspace", { workspace_id: WID, user_approved: true });
  await page.goto(`${APP}#/workspace/${WID}?r=${Date.now()}`);
  await expect(page.locator("#ws-update")).toContainText("Update available: version 2", { timeout: 20_000 });
  await expect(page.locator("#ws-update")).toContainText("Follow-up needed");
  await page.locator("#ws-download").click();
  await page.goto(`${APP}#/results/${rid}`);
  await expect(page.locator("text=Tank leaking")).toBeVisible();
  await ctx.close();
});
