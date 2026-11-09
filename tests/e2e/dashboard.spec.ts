// The FieldKit tab rendered inside the REAL Hermes dashboard SPA (real plugin SDK, real auth), every section.
import { chromium, webkit, expect, test } from "@playwright/test";

// FIELDKIT_E2E_BROWSER=webkit runs the same test on WebKit (Safari's engine).
const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";

test("FieldKit dashboard tab renders every section in the real Hermes dashboard", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.request.post(`${BASE}/auth/password-login`, { data: { provider: "basic", username: "demo", password: PASS, next: "/" } });
  await ctx.request.post(`${BASE}/api/plugins/fieldkit/examples/install`);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && /fieldkit/i.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/fieldkit`);
  await expect(page.getByText("FieldKit status")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/analysis: (automatic|on-demand|deferred)/)).toBeVisible();

  const sections: [string, RegExp][] = [
    ["Workflows", /Equipment inspection/],
    ["Knowledge", /Import a document as a knowledge pack/],
    ["Records", /Synchronised records/],
    ["Reports", /Follow-up actions/],
    ["Synchronization", /Analysis jobs/],
    ["Offline Packs", /On-device model packs/],
    ["Mobile Access", /Open FieldKit on a phone/],
  ];
  for (const [tab, expectText] of sections) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByText(expectText).first()).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByAltText("QR code for the FieldKit app")).toBeVisible();
  // a workflow definition opens from the Workflows section
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  // the View button inside the "Equipment inspection" row (not any other "View" button in the Hermes UI)
  const viewBtns = page.getByRole("button", { name: "View", exact: true });
  console.log("View buttons on page:", await viewBtns.count());
  await page.locator("xpath=//b[normalize-space()='Equipment inspection']/ancestor::div[2]//button[normalize-space()='View']").click();
  await expect(page.getByText(/Definition: /)).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
  await browser.close();
});
