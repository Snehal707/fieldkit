// Authenticated calls to the FieldKit plugin API. Cookies (the Hermes dashboard session) are sent
// automatically because the app is same-origin; no credentials ever live in this code.
// Every request is recorded in the on-device connection log (netlog.ts) with what actually came back.
import { apiUrl } from "./config";
import { describe, looksLikeHermes, markLast, netlog, pathOf } from "./netlog";

export class AuthRequired extends Error {
  /** true only when the 401 demonstrably came from Hermes (FastAPI JSON), not from a portal/proxy. */
  constructor(public fromHermes = false) { super("Hermes sign-in required"); }
}
export class Offline extends Error { constructor(msg = "Server unreachable") { super(msg); } }
export class HttpError extends Error {
  /** fromHermes: the error body has the FastAPI/Hermes JSON shape (so Hermes itself answered). */
  constructor(public status: number, public body: any, public fromHermes = false) { super(`HTTP ${status}`); }
}

/** fetch + on-device log entry. Throws Offline on network failure. */
export async function loggedFetch(url: string, init: RequestInit): Promise<Response> {
  const t0 = performance.now();
  const base = { t: new Date().toISOString(), method: (init.method || "GET").toUpperCase(), path: pathOf(url), ms: 0, online: navigator.onLine };
  try {
    const res = await fetch(url, init);
    const e = describe(res, { ...base, ms: Math.round(performance.now() - t0) });
    netlog(e);
    return res;
  } catch (err) {
    netlog({ ...base, outcome: "network-error", note: (err as Error)?.message?.slice(0, 120), ms: Math.round(performance.now() - t0) });
    throw new Offline();
  }
}

function verifyLast(path: string, hermes: boolean, note?: string): void {
  markLast(pathOf(apiUrl(path)), hermes, note);
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const res = await loggedFetch(apiUrl(path), {
    ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin", cache: "no-store", redirect: "manual",
  });
  const ct = res.headers.get("content-type") || "";
  // A redirect (opaqueredirect) is NOT proof Hermes answered: captive portals redirect too.
  if (res.type === "opaqueredirect") { verifyLast(path, false, "redirect (not proof of Hermes)"); throw new AuthRequired(false); }
  const body = ct.includes("json") ? await res.json().catch(() => null) : await res.text();
  const hermes = looksLikeHermes(ct, body);
  verifyLast(path, hermes);
  if (res.status === 401) throw new AuthRequired(hermes);
  if (!res.ok) throw new HttpError(res.status, body, hermes);
  return body as T;
}

export async function apiRaw(path: string): Promise<Response> {
  const res = await loggedFetch(apiUrl(path), { credentials: "same-origin", cache: "no-store", redirect: "manual" });
  if (res.status === 401 || res.type === "opaqueredirect") throw new AuthRequired(res.status === 401);
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
  return res;
}
