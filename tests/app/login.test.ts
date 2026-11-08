import { expect, it } from "vitest";
import { loginUrlFor } from "../../app/src/config";

// Port of Hermes v0.23.0 hermes_cli/dashboard_auth/request_utils.py:is_safe_next_path
const DENY = ["/login", "/auth/", "/api/auth/"];
function isSafeNextPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (DENY.some((p) => path === p || path.startsWith(p))) return false;
  return !(path === "/api" || path.startsWith("/api/"));
}

for (const root of ["https://hermes.example.org/", "https://example.org/hermes/"]) {
  it(`sign-in next= is accepted by Hermes (root ${root})`, () => {
    const u = new URL(loginUrlFor(new URL(root)));
    expect(u.pathname).toBe(new URL("login", root).pathname);
    const next = u.searchParams.get("next")!;
    expect(isSafeNextPath(next)).toBe(true);
    expect(next).toBe(new URL("dashboard-plugins/fieldkit/return.html", root).pathname);
  });
}

it("the old target (the app under /api) is exactly what Hermes rejects", () => {
  expect(isSafeNextPath("/api/plugins/fieldkit/app/#/sync")).toBe(false);
});
