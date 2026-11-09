// 0.2.5 offline assistant with the real on-device understanding model (paraphrase-multilingual-MiniLM, 118 MB, pinned
// and SHA-256 checked), against a real Hermes, then fully offline after a cold restart: a paraphrased question starts the
// right decision guide, the guide asks only what it needs and ends in an evidenced outcome, a Hindi question is
// understood, and an off-topic question is refused and queued as a knowledge gap. Needs FIELDKIT_E2E_MODELS=1.
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
const ROOT = resolve(import.meta.dirname, "../..");
const PY = resolve(ROOT, ".venv/Scripts/python.exe");
const VIEW = { viewport: { width: 390, height: 844 } };

function py(code: string) {
  return execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)}); sys.path.insert(0, ${JSON.stringify(join(ROOT, "tests", "python"))})
os.environ["FIELDKIT_DATA_DIR"] = ${JSON.stringify(DATA_DIR)}
from fieldkit_core import db, workspace as ws
s = db.Store(path=os.path.join(${JSON.stringify(DATA_DIR)}, "data.db"))
${code}
`]).toString();
}

async function ask(page: Page, q: string) {
  const before = await page.locator("#chat .msg.bot").count();
  await page.locator("#ask").fill(q);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator("#chat .msg.bot")).toHaveCount(before + 1, { timeout: 60_000 });
  return page.locator("#chat .msg.bot").last();
}

test.beforeEach(() => { test.skip(!PASS || !DATA_DIR || !process.env.FIELDKIT_E2E_MODELS, "set FIELDKIT_E2E_PASS, FIELDKIT_E2E_DATA_DIR and FIELDKIT_E2E_MODELS=1"); });
test.afterAll(() => {
  if (!DATA_DIR || !process.env.FIELDKIT_E2E_MODELS) return;
  py(`
c = s.conn
with s.lock:
    c.execute("DELETE FROM workspace_versions WHERE workspace_id='dairy-collection-mh'"); c.execute("DELETE FROM workspaces WHERE id='dairy-collection-mh'")
    c.execute("DELETE FROM packs WHERE id LIKE 'ws-dairy-collection-mh%'")
    c.execute("DELETE FROM workflow_versions WHERE workflow_id='milk-collection-check'"); c.execute("DELETE FROM workflows WHERE id='milk-collection-check'")
    c.commit()
`);
});

test("the offline assistant understands paraphrases and Hindi, runs a guide, and refuses to guess", async () => {
  test.setTimeout(900_000);
  py(`
from workspace_fixtures import BUNDLE
d = ws.build_draft(s, db.ALL, BUNDLE)
ws.publish(s, BUNDLE["id"], d["version"])
`);
  const profile = mkdtempSync(join(tmpdir(), "fk-assist-"));
  let ctx = await engine.launchPersistentContext(profile, VIEW);
  await signIn(ctx.request);
  let page = await ctx.newPage();
  await page.goto(APP);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await page.goto(`${APP}#/workspace/dairy-collection-mh`);
  await page.locator("#ws-download").click();
  await expect(page.locator("#ws-home")).toBeVisible({ timeout: 30_000 });
  await page.goto(`${APP}#/packs`);
  const btn = page.locator('button[data-model="understand-multilingual"]');
  await btn.click();
  await expect(page.locator("li", { has: btn }).locator("text=Installed and self-tested on this device")).toBeVisible({ timeout: 600_000 });
  await ctx.close();

  ctx = await engine.launchPersistentContext(profile, { ...VIEW, offline: true });
  page = await ctx.newPage();
  const requests: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("blob:") && !r.url().startsWith("data:")) requests.push(r.url()); });
  await page.goto(`${APP}#/assistant`);
  await expect(page.locator("#assistant-mode")).toContainText("Understands questions by meaning", { timeout: 120_000 });

  // A paraphrase that names no guide: "take this farmer's milk or send it back" → the accept/reject guide.
  let m = await ask(page, "Should I take this farmer's milk or send it back?");
  await expect(m).toHaveAttribute("data-kind", "guide_question");
  await expect(m).toContainText("Accept or reject milk");
  m = await ask(page, "8.2");                                           // the guide asked for the SNF reading
  await expect(m).toContainText("Was it re-tested?");
  await m.getByRole("button", { name: "No", exact: true }).click();
  m = page.locator("#chat .msg.bot").last();
  await expect(m).toHaveAttribute("data-kind", "guide_outcome", { timeout: 30_000 });
  await expect(m).toContainText("Re-test once");
  await expect(m).toContainText("Verified source");

  // Hindi, understood by meaning (no keyword shared with the English content).
  m = await ask(page, "दूध स्वीकार करूँ या लौटा दूँ?");
  await expect(m).toHaveAttribute("data-kind", "guide_question");

  // Off-topic: refused, not guessed, and queued for Hermes as a knowledge gap.
  m = await ask(page, "Who won the cricket match yesterday?");
  await expect(m).toHaveAttribute("data-kind", "not_covered");
  const gaps = await page.evaluate(() => new Promise<number>((res) => {
    const q = indexedDB.open("fieldkit");
    q.onsuccess = () => { const g = q.result.transaction("learning").objectStore("learning").getAll(); g.onsuccess = () => res(g.result.filter((e: any) => e.kind === "knowledge_gap").length); };
  }));
  expect(gaps).toBe(1);
  expect(requests.filter((u) => /^https?:\/\/(?!127\.0\.0\.2)/.test(u))).toEqual([]);   // nothing left the device
  await ctx.close();
});
