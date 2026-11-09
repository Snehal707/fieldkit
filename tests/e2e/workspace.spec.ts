// 0.2.5 workspaces on the phone, against a real Hermes: a workspace published by the builder (here the synthetic dairy
// test fixture, built and published through FieldKit's own Python code) opens from its link, downloads everything for
// offline in one tap, and still shows its profile, evidence summary, gaps and workflows after an offline cold restart.
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
const ROOT = resolve(import.meta.dirname, "../..");
const PY = resolve(ROOT, ".venv/Scripts/python.exe");
const VIEW = { viewport: { width: 390, height: 844 } };

function py(code: string): string {
  return execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)}); sys.path.insert(0, ${JSON.stringify(join(ROOT, "tests", "python"))})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from fieldkit_core import db, workspace as ws
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
${code}
`]).toString();
}

test.beforeEach(() => { test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR"); });
// Leave the shared test instance as we found it (other specs count published workflows).
test.afterAll(() => {
  if (!DATA_DIR) return;
  py(`
c = s.conn
with s.lock:
    for t in ("workspace_versions",): c.execute(f"DELETE FROM {t} WHERE workspace_id='dairy-collection-mh'")
    c.execute("DELETE FROM workspaces WHERE id='dairy-collection-mh'")
    c.execute("DELETE FROM packs WHERE id LIKE 'ws-dairy-collection-mh%'")
    ids = [r[0] for r in c.execute("SELECT id FROM records WHERE workflow_id='milk-collection-check'")]
    for rid in ids:
        for t in ("sync_ops", "jobs"): c.execute(f"DELETE FROM {t} WHERE record_id=?", (rid,))
        c.execute("DELETE FROM records WHERE id=?", (rid,))
    c.execute("DELETE FROM workflow_versions WHERE workflow_id='milk-collection-check'")
    c.execute("DELETE FROM workflows WHERE id='milk-collection-check'")
    c.commit()
`);
});

test("a published workspace downloads in one tap and works offline after a cold restart", async () => {
  test.setTimeout(180_000);
  const out = py(`
from workspace_fixtures import BUNDLE
d = ws.build_draft(s, db.ALL, BUNDLE)
print(json.dumps(ws.publish(s, BUNDLE["id"], d["version"])))
`);
  const pub = JSON.parse(out.trim().split("\n").pop()!);
  expect(pub.manifest_pack).toBe("ws-dairy-collection-mh");

  const profile = mkdtempSync(join(tmpdir(), "fk-ws-"));
  let ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  // The link Hermes returns after publishing.
  await page.goto(`${APP}#/workspace/dairy-collection-mh`);
  await page.locator("#ws-download").click();
  await expect(page.locator("#ws-home")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#ws-status")).toHaveCount(1);
  await expect(page.locator("#ws-home")).toContainText("Dairy collection QA (Maharashtra)");
  await expect(page.locator("#ws-home")).toContainText("Accept or reject each farmer's milk at collection");
  await ctx.close();

  // Offline cold restart: everything is on the device.
  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  page = await ctx.newPage();
  await page.goto(`${APP}#/workspace/dairy-collection-mh`);
  await expect(page.locator("#ws-home")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#ws-evidence [data-status="verified"]')).toContainText("Verified source: 2");
  await expect(page.locator('#ws-evidence [data-status="conflicting"]')).toContainText("Sources disagree: 1");
  await expect(page.locator("#ws-gaps")).toContainText("Ammonium sulphate limit");
  await expect(page.locator("#ws-guides")).toContainText("Accept or reject milk");
  await page.goto(`${APP}#/`);
  await expect(page.locator("#home-workspaces")).toContainText("Dairy collection QA (Maharashtra)");
  // The workspace's workflow runs offline.
  await page.goto(`${APP}#/workflows`);
  await expect(page.locator("li", { hasText: "Milk collection check" })).toBeVisible({ timeout: 15_000 });
  await ctx.close();
});
