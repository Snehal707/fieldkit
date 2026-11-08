// Connection diagnostics: every request FieldKit makes to Hermes is recorded with what actually came back,
// so "Hermes reachable" is backed by inspectable evidence instead of inference. Kept on the device only
// (last 150 entries, localStorage) — never uploaded. Nothing sensitive is stored: paths, status, headers.
export interface NetEntry {
  t: string;               // device time (ISO)
  method: string;
  path: string;            // path only (no host, no query secrets)
  outcome: "response" | "network-error";
  status?: number;
  type?: string;           // Response.type: basic | cors | opaqueredirect | ...
  ctype?: string;
  server_date?: string;    // HTTP Date header: proves a live reply from a server, with its clock
  served_by?: string;      // HTTP Server/Via header if exposed
  redirected?: boolean;
  final_url?: string;      // where the response really came from (detects redirects to other hosts)
  hermes?: boolean;        // body/shape proved it was the FieldKit/Hermes API answering
  note?: string;
  ms: number;
  online: boolean;         // navigator.onLine at the time
}

const KEY = "fieldkit-netlog";
const MAX = 150;
let entries: NetEntry[] = load();
const listeners = new Set<() => void>();

function load(): NetEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX))); } catch { /* storage blocked */ }
}

export function netlog(e: NetEntry): void {
  entries.push(e);
  if (entries.length > MAX) entries = entries.slice(-MAX);
  save();
  listeners.forEach((l) => l());
}

export function netEntries(): NetEntry[] { return entries.slice(); }

/** Record whether the latest response for `path` was proven to come from Hermes (after its body was read). */
export function markLast(path: string, hermes: boolean, note?: string): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].path === path && entries[i].outcome === "response") {
      entries[i].hermes = hermes;
      if (note) entries[i].note = note;
      save();
      listeners.forEach((l) => l());
      return;
    }
  }
}
export function clearNetlog(): void { entries = []; save(); listeners.forEach((l) => l()); }
export function onNetlog(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

export function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

/** Fill response-derived fields of an entry. */
export function describe(res: Response, base: Omit<NetEntry, "outcome">): NetEntry {
  return {
    ...base, outcome: "response", status: res.status, type: res.type,
    ctype: res.headers.get("content-type") ?? undefined,
    server_date: res.headers.get("date") ?? undefined,
    served_by: res.headers.get("server") ?? res.headers.get("via") ?? undefined,
    redirected: res.redirected, final_url: res.url ? pathOrForeign(res.url) : undefined,
  };
}

function pathOrForeign(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === location.origin ? u.pathname : `${u.origin}${u.pathname}`;  // a foreign origin is a red flag
  } catch { return url; }
}

/** True when a body has the shape only Hermes/FieldKit produce (FastAPI JSON). */
export function looksLikeHermes(ctype: string | null | undefined, body: unknown): boolean {
  return !!ctype && ctype.includes("application/json") && !!body && typeof body === "object";
}

export function report(extra: Record<string, unknown> = {}): string {
  const lines = [
    `FieldKit connection report — ${new Date().toISOString()}`,
    `navigator.onLine: ${navigator.onLine}`,
    `connection: ${JSON.stringify((navigator as any).connection ? { type: (navigator as any).connection.type, effectiveType: (navigator as any).connection.effectiveType } : "n/a")}`,
    `user agent: ${navigator.userAgent}`,
    `standalone: ${(navigator as any).standalone ?? matchMedia("(display-mode: standalone)").matches}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`),
    "--- last requests (newest first) ---",
    ...entries.slice().reverse().slice(0, 40).map((e) =>
      `${e.t} ${e.method} ${e.path} → ${e.outcome === "network-error" ? `NETWORK ERROR (${e.note ?? ""})` : `${e.status} ${e.type} ${e.ctype ?? ""}`}`
      + `${e.hermes ? " [verified Hermes]" : e.outcome === "response" ? " [NOT verified]" : ""}`
      + `${e.server_date ? ` server-date="${e.server_date}"` : ""}${e.final_url && e.final_url !== e.path ? ` final=${e.final_url}` : ""}`
      + ` ${e.ms}ms online=${e.online}`),
  ];
  return lines.join("\n");
}
