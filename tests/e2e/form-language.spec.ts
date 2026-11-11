// Form language, fully offline (no Hermes needed): the built app is served from disk and every Hermes request fails.
// With Hindi selected the Equipment inspection form, its yes/no answers and saved responses are in Hindi and marked
// lang="hi"; a form without Hindi falls back to English; switching the setting re-labels open drafts and saved entries
// while the stored answers and the entry's recorded language stay exactly as they were.
import { chromium, webkit, expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "dashboard/app_dist");
const ORIGIN = "http://localhost:5199";
const APP = `${ORIGIN}/index.html`;
const WF = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/forms/maintenance.json"), "utf-8"));
const EN_ONLY = { id: "en-only-check", version: 1, title: { en: "English-only check" }, languages: ["en"],
  fields: [{ id: "site", type: "text", label: { en: "Site name" } }, { id: "ok", type: "checkbox", label: { en: "All clear" } }] };
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
test.use({ actionTimeout: 15_000 });

async function seed(p: Page) {
  await p.evaluate(async ({ forms }) => {
    const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("fieldkit"); q.onsuccess = () => res(q.result); q.onerror = rej; });
    const put = (store: string, v: any) => new Promise<void>((res, rej) => { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(v); t.oncomplete = () => res(); t.onerror = rej; });
    for (const wf of forms) await put("workflows", { id: wf.id, version: wf.version, downloaded_at: new Date().toISOString(), definition: wf });
    await put("settings", { key: "lang", value: "hi" });
  }, { forms: [WF, EN_ONLY] });
}

async function setLang(p: Page, value: "en" | "hi") {
  await p.goto(`${APP}#/settings`);
  await p.locator("main select").first().selectOption(value);
  await p.waitForTimeout(300);
}

const stored = (p: Page, id: string) => p.evaluate((rid) => new Promise<any>((res) => {
  const q = indexedDB.open("fieldkit");
  q.onsuccess = () => { const g = q.result.transaction("records").objectStore("records").get(rid); g.onsuccess = () => res(g.result); };
}), id);

/** Date inputs: set like a date picker does (WebKit on Windows has no native date input for Playwright's fill). */
const setDate = (p: Page, sel: string, v: string) => p.locator(sel).evaluate((el: HTMLInputElement, val) => {
  el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
}, v);

test("form language: Hindi offline, English fallback, switching re-labels without changing stored answers", async () => {
  test.setTimeout(120_000);
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN || url.pathname.includes("/api/")) return route.abort("internetdisconnected");
    const file = join(DIST, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("dialog", (d) => d.accept());
  await p.goto(APP);
  await expect(p.locator("header.top")).toBeVisible({ timeout: 15_000 });
  await seed(p);
  await p.reload();                                      // the app reads settings at start (seeded behind its back)
  await expect(p.locator("header.top")).toBeVisible({ timeout: 15_000 });

  // Hindi: start page, questions, options, yes/no answers, all marked lang="hi".
  await p.goto(`${APP}#/workflow/${WF.id}`);
  await expect(p.locator("main .card h2").first()).toHaveText("उपकरण निरीक्षण", { timeout: 15_000 });
  await expect(p.locator("main .card").first()).toHaveAttribute("lang", "hi");
  await p.getByRole("button", { name: "Start workflow" }).click();
  await expect(p.locator("#f-asset_id label.q")).toContainText("एसेट टैग");
  await expect(p.locator("#f-asset_id")).toHaveAttribute("lang", "hi");
  await expect(p.locator("#f-condition .choices label")).toHaveText(["अच्छी", "ठीक", "खराब"]);
  await expect(p.locator("#f-guard_ok .choices label")).toHaveText(["हाँ", "नहीं"]);
  await expect(p.locator("#f-guard_ok .choices")).toHaveAttribute("lang", "hi");

  // Answer in Hindi, then switch to English: the open draft is shown in English, answers kept.
  await p.locator("#in-asset_id").fill("PMP-0042"); await p.locator("#in-asset_id").blur();
  await setDate(p, "#in-inspection_date", "2026-11-10");
  await p.locator("#f-condition .choices label", { hasText: "ठीक" }).click();
  await p.locator("#f-guard_ok .choices label", { hasText: "हाँ" }).click();
  const draftUrl = p.url();
  await setLang(p, "en");
  await p.goto(draftUrl);
  await expect(p.locator("#f-asset_id label.q")).toContainText("Asset tag");
  await expect(p.locator("#f-asset_id")).toHaveAttribute("lang", "en");
  await expect(p.locator("#in-asset_id")).toHaveValue("PMP-0042");
  await expect(p.locator("#f-condition label", { hasText: "Fair" }).locator("input")).toBeChecked();
  await expect(p.locator("#f-guard_ok label", { hasText: "Yes" }).locator("input")).toBeChecked();
  await p.getByRole("button", { name: "Complete workflow" }).click();
  await expect(p).toHaveURL(/#\/results\//, { timeout: 15_000 });
  const rid = p.url().split("#/results/")[1].split("?")[0];
  const resp = p.locator("main .card", { hasText: "Saved responses" });
  await expect(resp).toContainText("Asset tag");
  await expect(resp).toContainText("Fair");
  await expect(resp.locator("dd", { hasText: /^Yes$/ })).toHaveCount(1);

  // Back to Hindi: the saved entry follows the setting.
  await setLang(p, "hi");
  await p.goto(`${APP}#/results/${rid}`);
  await expect(resp).toContainText("एसेट टैग");
  await expect(resp).toContainText("ठीक");
  await expect(resp.locator("dd", { hasText: /^हाँ$/ })).toHaveAttribute("lang", "hi");
  await expect(resp.locator("dt", { hasText: "एसेट टैग" })).toHaveAttribute("lang", "hi");

  // Stored data unchanged: option values, booleans, and the language the entry was started in.
  const rec = await stored(p, rid);
  expect(rec.answers).toMatchObject({ asset_id: "PMP-0042", inspection_date: "2026-11-10", condition: "fair", guard_ok: true });
  expect(rec.lang).toBe("hi");

  // A form without Hindi: English text, marked lang="en"; yes/no in Hindi (the words exist) but the label stays English.
  await p.goto(`${APP}#/workflow/${EN_ONLY.id}`);
  await expect(p.locator("main .card h2").first()).toHaveText("English-only check");
  await expect(p.locator("main .card").first()).toHaveAttribute("lang", "en");
  await p.getByRole("button", { name: "Start workflow" }).click();
  await expect(p.locator("#f-site label.q")).toHaveText("Site name");
  await expect(p.locator("#f-site")).toHaveAttribute("lang", "en");
  expect(errors).toEqual([]);
  await browser.close();
});
