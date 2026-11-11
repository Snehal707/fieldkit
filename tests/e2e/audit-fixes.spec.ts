// Fixes from the final audit, checked offline-capable without a Hermes server (the built app is served from disk and
// the few API answers these screens need are synthetic):
//  - Back still appears after tapping the tab that is already open;
//  - a record from another device whose form this phone never downloaded reads with the form's own labels (fetched
//    from Hermes), shows Yes/No instead of true/false, and long labels never overlap the answers;
//  - a workspace link opened before downloading names the workspace, or asks to sign in when signed out;
//  - the header says "not signed in" on a phone that has never signed in (instead of "all confirmed").
import { chromium, webkit, devices, expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "dashboard/app_dist");
const ORIGIN = "http://localhost:5199";
const APP = `${ORIGIN}/index.html`;
const { defaultBrowserType: _x, ...IPHONE } = devices["iPhone 13"] as any;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm" };
const PUMP = { id: "pump-audit", version: 3, title: { en: "Pump audit" }, languages: ["en"], metadata: { subject_field: "pump_number" },
  fields: [{ id: "pump_number", type: "text", label: { en: "Pump number" } },
           { id: "corrective_action_assigned_to_supervisor_on_duty", type: "text", label: { en: "Corrective action assigned to (supervisor on duty)" } },
           { id: "guard_fitted", type: "checkbox", label: { en: "Guard fitted" } }] };
const REMOTE = { id: "rec_remote_pump01", workflow_id: "pump-audit", workflow_version: 3, revision: 1, device_id: "dev_other", sync_status: "complete",
  completed_at: "2026-11-11T08:00:00Z", received_at: 1794300000, answers: { pump_number: "P-17", corrective_action_assigned_to_supervisor_on_duty: "Hubli depot",
    guard_fitted: true, unknown_extra_field_from_an_old_version: false }, attachments: [], local_results: {} };
test.use({ actionTimeout: 15_000 });

async function serve(p: Page, opts: { signedIn: boolean }) {
  await p.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname.includes("/api/")) {
      const q = url.pathname.split("/api/plugins/fieldkit/")[1] ?? "";
      if (!opts.signedIn) return json({ detail: "Unauthorized" }, 401);
      if (q === "records") return json({ records: [{ ...REMOTE, workflow_title: "Pump audit", subject: "P-17" }], total: 1, next_offset: null });
      if (q === `records/${REMOTE.id}`) return json(REMOTE);
      if (q === `records/${REMOTE.id}/report`) return json({ detail: "Not found" }, 404);
      if (q === "workflows/pump-audit" && url.searchParams.get("version") === "3") return json(PUMP);
      if (q === "workspaces/water-survey") return json({ workspace_id: "water-survey", title: { en: "Village water survey" }, profile: { purpose: "Record each household's drinking water source." } });
      if (q === "devices") return json({ devices: [{ id: "dev_other", label: "Field tablet" }] });
      if (q === "me") return json({ user_id: "demo", display_name: "demo", provider: "basic" });
      return route.abort("internetdisconnected");
    }
    const file = join(DIST, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
}

test("audit fixes: Back after re-tapping a tab, readable records from other devices, workspace links, sign-in state", async () => {
  test.setTimeout(120_000);
  const browser = await engine.launch();

  // A phone that has never signed in.
  const fresh = await browser.newContext(IPHONE);
  const f = await fresh.newPage();
  await serve(f, { signedIn: false });
  await f.goto(`${APP}#/workspace/water-survey`);
  await expect(f.locator("header .pill").first()).toHaveText(/not signed in|sign-in needed/, { timeout: 15_000 });
  await expect(f.locator("header .pill", { hasText: "all confirmed" })).toHaveCount(0);
  await expect(f.locator("#ws-preview")).toContainText("Sign in to Hermes to download this workspace.");
  await expect(f.locator("#ws-preview").getByRole("button", { name: "Sign in" })).toBeVisible();
  await fresh.close();

  // A signed-in phone.
  const ctx = await browser.newContext(IPHONE);
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await serve(p, { signedIn: true });
  await p.goto(`${APP}#/workspace/water-survey`);
  await expect(p.locator("#ws-preview h2")).toHaveText("Village water survey", { timeout: 15_000 });
  await expect(p.locator("#ws-preview")).toContainText("drinking water source");

  // Records tab, tap it again, open a record: Back is there.
  await p.locator("nav.bottom a", { hasText: "Records" }).click();
  await expect(p.locator("#records-list li").first()).toBeVisible({ timeout: 15_000 });
  await p.locator("nav.bottom a", { hasText: "Records" }).click();
  await p.waitForTimeout(400);
  await p.locator("#records-list li a").first().click();
  await expect(p.locator("#remote-record")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#back")).toBeVisible();

  // The record reads with its form's labels, though this phone never downloaded that form.
  await expect(p.locator("#remote-record h2")).toHaveText("Pump audit");
  const answers = p.locator("main .card", { hasText: "Answers" });
  await expect(answers).toContainText("Pump number");
  await expect(answers).toContainText("Corrective action assigned to (supervisor on duty)");
  await expect(answers.locator("dt", { hasText: "Guard fitted" }).locator("xpath=following-sibling::dd[1]")).toHaveText("Yes");
  await expect(answers).toContainText("Unknown extra field from an old version");      // no raw snake_case
  await expect(answers).not.toContainText("pump_number");
  await expect(answers).not.toContainText("true");
  // Long labels wrap inside their column instead of running into the answer.
  const overlap = await answers.locator("dl.kv dt").evaluateAll((dts) => dts.some((dt) => {
    const a = dt.getBoundingClientRect(), b = (dt.nextElementSibling as HTMLElement).getBoundingClientRect();
    return a.right > b.left + 1 && a.top < b.bottom && b.top < a.bottom;
  }));
  expect(overlap).toBe(false);

  // Back returns to Records.
  await p.locator("#back").click();
  await expect(p.locator("#records-list")).toBeVisible();
  expect(errors).toEqual([]);
  await browser.close();
});
