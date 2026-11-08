// Authenticated calls to the FieldKit plugin API. Cookies (the Hermes dashboard session) are sent
// automatically because the app is same-origin; no credentials ever live in this code.
import { apiUrl } from "./config";

export class AuthRequired extends Error { constructor() { super("Hermes sign-in required"); } }
export class Offline extends Error { constructor(msg = "Server unreachable") { super(msg); } }
export class HttpError extends Error {
  constructor(public status: number, public body: any) { super(`HTTP ${status}`); }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body,
      credentials: "same-origin", cache: "no-store", redirect: "manual",
    });
  } catch {
    throw new Offline();
  }
  // A redirect to /login (opaqueredirect) or 401 both mean the session is gone.
  if (res.status === 401 || res.type === "opaqueredirect") throw new AuthRequired();
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new HttpError(res.status, body);
  return body as T;
}

export async function apiRaw(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { credentials: "same-origin", cache: "no-store", redirect: "manual" });
  } catch {
    throw new Offline();
  }
  if (res.status === 401 || res.type === "opaqueredirect") throw new AuthRequired();
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
  return res;
}
