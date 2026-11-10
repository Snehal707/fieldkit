import { defineConfig } from "@playwright/test";

// Runs against a real Hermes dashboard with FieldKit installed (see docs/TESTING.md):
//   FIELDKIT_E2E_BASE=http://127.0.0.2:9300 FIELDKIT_E2E_USER=demo FIELDKIT_E2E_PASS=... npm run test:e2e
export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
