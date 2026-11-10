// Seeds the synthetic example workspaces into the test Hermes' FieldKit database (idempotent). Needs
// FIELDKIT_E2E_DATA_DIR (the plugin data dir of the test Hermes); without it the data must already be there.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default function globalSetup(): void {
  const dir = process.env.FIELDKIT_E2E_DATA_DIR;
  if (!dir) return;
  const root = resolve(import.meta.dirname, "../..");
  const py = process.env.FIELDKIT_E2E_PYTHON ?? resolve(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  console.log(execFileSync(py, [resolve(root, "tests/fixtures/seed.py"), dir], { encoding: "utf-8" }).trim());
}
