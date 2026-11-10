// Shared steps for the E2E suite: the example workspaces are seeded into the test Hermes by global-setup.ts.
import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const EXAMPLE_WS = "starter-equipment-inspection";
export const EXAMPLE_FORM = "equipment-inspection";

/** Download a workspace (manifest + forms) for offline use, from its page. */
export async function downloadWorkspace(page: Page, app: string, wid = EXAMPLE_WS): Promise<void> {
  await page.goto(`${app}#/workspace/${wid}`);
  await page.locator("#ws-download").click();
  await expect(page.locator("#ws-home")).toBeVisible({ timeout: 40_000 });
}

/** Start a new entry of a downloaded form, as the workspace page's "Start" button does. */
export async function startEntry(page: Page, app: string, form = EXAMPLE_FORM, wid = EXAMPLE_WS): Promise<void> {
  await page.goto(`${app}#/workflow/${form}?ws=${wid}`);
  await page.getByRole("button", { name: "Start workflow" }).click();
}

/** Publish a workspace holding one form, through FieldKit's own tool code (as Hermes does). Needs the test Hermes'
 *  FieldKit data dir. Returns the workspace id. */
export function publishFormAsWorkspace(form: Record<string, unknown>, wid: string): string {
  const dir = process.env.FIELDKIT_E2E_DATA_DIR ?? "";
  const root = resolve(import.meta.dirname, "../..");
  const py = process.env.FIELDKIT_E2E_PYTHON ?? resolve(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const out = execFileSync(py, ["-c", `
import json, os, sys
sys.path.insert(0, sys.argv[1])
from fieldkit_core import db, tools
db.set_store(db.Store(path=os.path.join(sys.argv[2], "data.db")))
form = json.loads(sys.argv[3])
d = json.loads(tools.handler_for("fieldkit_draft_workspace")({"workspace_id": sys.argv[4], "title": form["title"], "purpose": "E2E test", "forms": [form]}))
assert d.get("valid"), d
print(tools.handler_for("fieldkit_publish_workspace")({"workspace_id": sys.argv[4], "user_approved": True}))
`, root, dir, JSON.stringify(form), wid]).toString();
  if (!JSON.parse(out.trim().split("\n").pop()!).ok) throw new Error(out);
  return wid;
}
