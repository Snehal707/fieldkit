// The FieldKit tab rendered inside the REAL Hermes dashboard SPA (real plugin SDK, real auth), every section.
import { chromium, webkit, expect, test } from "@playwright/test";
import { signIn } from "./auth";

// FIELDKIT_E2E_BROWSER=webkit runs the same test on WebKit (Safari's engine).
const engine = process.env.FIELDKIT_E2E_BROWSER === "webkit" ? webkit : chromium;
const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";
const PASS = process.env.FIELDKIT_E2E_PASS ?? "";

test("FieldKit dashboard tab renders every section in the real Hermes dashboard", async () => {
  test.skip(!PASS, "set FIELDKIT_E2E_PASS");
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(ctx.request);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && /fieldkit/i.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/fieldkit`);
  await expect(page.getByText("FieldKit status")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/version 0\.3/)).toBeVisible();
  await expect(page.getByText(/analysis/i)).toHaveCount(0);                     // 0.3: FieldKit runs no analysis

  // Four tabs: Overview, Records, Synchronization, Mobile Access.
  const sections: [string, RegExp][] = [
    ["Records", /Synchronised records/],
    ["Synchronization", /Open conflicts|No open conflicts/],
    ["Mobile Access", /Open FieldKit on a phone/],
  ];
  for (const [tab, expectText] of sections) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByText(expectText).first()).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByAltText("QR code for the FieldKit app")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
  await browser.close();
});
