// Shared Hermes sign-in for the E2E suite.
// Hermes throttles password logins to 10 attempts per client IP per 60 s, and successful logins count too
// (hermes_cli/dashboard_auth/routes.py: _PW_RATE_MAX_ATTEMPTS / _PW_RATE_WINDOW_SEC). The whole suite runs
// from one IP, so an unchecked login that gets 429 leaves the browser signed out: the app shell is never
// served (401) and the service worker never registers. Always check the result, wait out a 429, and only
// log in again when the session has actually expired.
import { expect, type APIRequestContext } from "@playwright/test";

const BASE = process.env.FIELDKIT_E2E_BASE ?? "http://127.0.0.2:9300";

export async function signIn(r: APIRequestContext, username = process.env.FIELDKIT_E2E_USER ?? "demo",
  password = process.env.FIELDKIT_E2E_PASS ?? "") {
  const deadline = Date.now() + 75_000;  // longer than one rate-limit window
  for (;;) {
    const res = await r.post(`${BASE}/auth/password-login`, { data: { provider: "basic", username, password, next: "/" } });
    if (res.status() !== 429 || Date.now() > deadline) {
      expect(res.ok(), `Hermes sign-in failed: ${res.status()} ${await res.text()}`).toBe(true);
      return;
    }
    await new Promise((done) => setTimeout(done, 2_000));  // throttled attempts are not counted; just wait
  }
}
