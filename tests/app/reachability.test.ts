// "Hermes reachable" must be backed by a reply PROVEN to come from Hermes. Portal pages, proxy errors and
// network failures must never produce it. Every request lands in the on-device connection log.
import { beforeEach, expect, it, vi } from "vitest";
import { _resetDbForTests } from "../../app/src/db";
import { clearNetlog, netEntries } from "../../app/src/netlog";
import { clearAuthRequired, getSyncState, runSync } from "../../app/src/sync";

type Handler = () => Response;
let handler: Handler;
const store: Record<string, string> = {};

beforeEach(async () => {
  indexedDB = new IDBFactory();
  _resetDbForTests();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", async () => handler());
  clearNetlog();
  await clearAuthRequired();
});

const cases: [string, Handler, boolean | null][] = [
  ["Hermes /me JSON", () => new Response(JSON.stringify({ user_id: "demo" }), { status: 200, headers: { "content-type": "application/json" } }), true],
  ["Hermes 401 JSON (signed out, still reachable)", () => new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }), true],
  ["captive portal 200 HTML", () => new Response("<html>Wi-Fi login</html>", { status: 200, headers: { "content-type": "text/html" } }), false],
  ["proxy 401 HTML", () => new Response("<html>Proxy auth</html>", { status: 401, headers: { "content-type": "text/html" } }), false],
  ["proxy 403 text", () => new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } }), false],
  ["gateway 502 HTML", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }), false],
  ["no network", () => { throw new TypeError("Load failed"); }, false],
];

for (const [name, h, expected] of cases) {
  it(`reachability from: ${name}`, async () => {
    handler = h;
    await runSync();
    expect(getSyncState().reachable).toBe(expected);
    const last = netEntries().at(-1)!;
    expect(last.path.endsWith("/me")).toBe(true);
    if (name === "no network") expect(last.outcome).toBe("network-error");
    else expect(!!last.hermes).toBe(expected);
  });
}
