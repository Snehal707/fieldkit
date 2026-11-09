// 0.2.5 learning loop, against a real Hermes: offline questions the phone can't answer and "not helpful" feedback are
// queued and reach Hermes after sync; Hermes proposes candidates (research gap, review flag); a local practice backed by
// three verified follow-up outcomes is accepted and published as workspace version 2; the phone sees the update and
// labels the new entry as learned from the team's verified outcomes. Hermes-side steps run FieldKit's own Python code.
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
from fieldkit_core import db, learning, workspace as ws
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
${code}
`]).toString();
}

test.beforeEach(() => { test.skip(!PASS || !DATA_DIR, "set FIELDKIT_E2E_PASS and FIELDKIT_E2E_DATA_DIR"); });
test.afterAll(() => {
  if (!DATA_DIR) return;
  py(`
c = s.conn
with s.lock:
    c.execute("DELETE FROM workspace_versions WHERE workspace_id='dairy-collection-mh'"); c.execute("DELETE FROM workspaces WHERE id='dairy-collection-mh'")
    c.execute("DELETE FROM packs WHERE id LIKE 'ws-dairy-collection-mh%'")
    c.execute("DELETE FROM candidates WHERE workspace_id='dairy-collection-mh'")
    c.execute("DELETE FROM learning_events WHERE workspace_id='dairy-collection-mh' OR workspace_id IS NULL")
    ids = [r[0] for r in c.execute("SELECT id FROM records WHERE workflow_id='milk-collection-check'")]
    for rid in ids:
        for t in ("sync_ops", "jobs", "reports"): c.execute(f"DELETE FROM {t} WHERE record_id=?", (rid,))
        c.execute("DELETE FROM records WHERE id=?", (rid,))
    c.execute("DELETE FROM workflow_versions WHERE workflow_id='milk-collection-check'"); c.execute("DELETE FROM workflows WHERE id='milk-collection-check'")
    c.commit()
`);
});

test("offline gaps and feedback reach Hermes; an outcome-backed practice comes back as a labelled update", async () => {
  test.setTimeout(240_000);
  py(`
from workspace_fixtures import BUNDLE
d = ws.build_draft(s, db.ALL, BUNDLE)
ws.publish(s, BUNDLE["id"], d["version"])
`);
  const profile = mkdtempSync(join(tmpdir(), "fk-learn-"));
  let ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/workspace/dairy-collection-mh`);
  await page.locator("#ws-download").click();
  await expect(page.locator("#ws-home")).toBeVisible({ timeout: 30_000 });
  await ctx.close();

  // Offline: an unanswerable question (gap) and a "not helpful" mark (feedback).
  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  page = await ctx.newPage();
  await page.goto(`${APP}#/assistant`);
  await expect(page.locator("#assistant-mode")).toBeVisible({ timeout: 20_000 });
  await page.locator("#ask").fill("How do I calibrate the milk analyser every month?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator("#chat .msg.bot").last()).toHaveAttribute("data-kind", "not_covered", { timeout: 20_000 });
  await page.locator("#ask").fill("Re-test a borderline sample");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const ans = page.locator("#chat .msg.bot").last();
  await expect(ans).toHaveAttribute("data-kind", /answer|guide_question/, { timeout: 20_000 });
  await ans.getByRole("button", { name: "Not helpful" }).click();
  await ctx.close();

  // Online again: sync uploads the events.
  ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  page = await ctx.newPage();
  await page.goto(`${APP}#/sync`);                                      // the app syncs on open; events go up with it
  // Count this test's own events (other specs on the shared test Hermes may add theirs).
  await expect.poll(() => JSON.parse(py(`
ev = learning.events(s)
print(json.dumps({"gap": sum(1 for e in ev if e["kind"] == "knowledge_gap" and "calibrate the milk analyser" in e["payload"].get("question", "")),
                  "feedback": sum(1 for e in ev if e["kind"] == "user_feedback" and e["payload"].get("helpful") is False
                                  and "borderline" in e["payload"].get("question", ""))}))
`).trim().split("\n").pop()!), { timeout: 60_000, intervals: [2_000] }).toEqual({ gap: 1, feedback: 1 });

  // Hermes: candidates; three verified outcomes → a local practice, accepted and published as version 2.
  const out = py(`
for i in range(3):
    rid = f"rec_e2e_learn_{i:03d}"
    s.sync_record("demo", "k-" + rid, "dev", {"id": rid, "workflow_id": "milk-collection-check", "workflow_version": 1, "base_revision": 0,
        "answers": {"farmer_code": "F-9"}, "local_results": {"followup_checks": [{"id": f"fc_{i}", "what": "Mix and re-test borderline samples",
        "how": "Second reading recorded", "result": "done", "report_id": "rep_e2e", "record_id": "rec_prev"}]}}, auto_analyze=False)
    learning.record_outcomes(s, "demo", rid)
new = learning.propose(s, "dairy-collection-mh")
prac = [c for c in new if c["kind"] == "local_practice"][0]
res = learning.decide(s, prac["id"], True, "approved in e2e")
pub = ws.publish(s, "dairy-collection-mh", res["draft"]["version"])
print(json.dumps({"kinds": sorted(c["kind"] for c in new), "version": pub["version"]}))
`);
  const res = JSON.parse(out.trim().split("\n").pop()!);
  expect(res.kinds).toEqual(["local_practice", "research_gap", "review_content"]);
  expect(res.version).toBe(2);

  // The phone sees the update with its changelog, downloads it, and labels the learned entry.
  await page.goto(`${APP}#/workspace/dairy-collection-mh?r=${Date.now()}`);
  const upd = page.locator("#ws-update");
  await expect(upd).toHaveAttribute("data-version", "2", { timeout: 20_000 });
  await expect(upd).toContainText("local practice from verified outcomes");
  await page.locator("#ws-download").click();
  await expect(page.locator('#ws-evidence [data-status="local_practice"]')).toContainText("Learned from your team's verified outcomes: 1", { timeout: 30_000 });
  await ctx.close();
});
