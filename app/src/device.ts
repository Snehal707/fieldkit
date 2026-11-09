// Readable device names. Each browser and each Home Screen app keeps its own on-device storage (on iOS a
// Home Screen web app is fully separate from Safari), so each is its own FieldKit "device" with its own id.
import { api, AuthRequired, HttpError, Offline } from "./api";
import { deviceId, getSetting, setSetting } from "./db";
import { isStandalone } from "./storage";

export function platformOf(ua: string, maxTouchPoints = 0): string {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "iPad";  // iPadOS reports as a Mac
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Windows/.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux";
  return "Device";
}

export function browserOf(ua: string): string {
  if (/EdgiOS|EdgA|Edg\//.test(ua)) return "Edge";
  if (/FxiOS|Firefox\//.test(ua)) return "Firefox";
  if (/CriOS/.test(ua)) return "Chrome";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) || /AppleWebKit/.test(ua)) return "Safari";
  return "Browser";
}

/** e.g. "iPhone · Home Screen app", "iPhone · Safari", "Windows · Chrome". */
export function deviceLabel(ua: string, standalone: boolean, maxTouchPoints = 0): string {
  return `${platformOf(ua, maxTouchPoints)} · ${standalone ? "Home Screen app" : browserOf(ua)}`;
}

export async function currentDeviceLabel(): Promise<string> {
  const custom = await getSetting<string>("device_name", "");
  return custom || deviceLabel(navigator.userAgent, isStandalone(), navigator.maxTouchPoints ?? 0);
}

/** Tell Hermes this device's name (separate from the sync queue; harmless to repeat; never throws). */
export async function registerDevice(force = false): Promise<void> {
  try {
    const [id, label] = await Promise.all([deviceId(), currentDeviceLabel()]);
    const sent = await getSetting<string>("device_name_registered", "");
    if (!force && sent === `${id}|${label}`) return;
    await api("devices", { method: "POST", json: { device_id: id, label } });
    await setSetting("device_name_registered", `${id}|${label}`);
  } catch { /* offline or signed out: try again next time */ }
}

/** Server record summaries that are NOT already on this device, newest first (no duplicates). */
export function otherDeviceRecords<T extends { id: string; received_at?: number }>(server: T[], localIds: Iterable<string>): T[] {
  const mine = new Set(localIds);
  const seen = new Set<string>();
  return server.filter((r) => !mine.has(r.id) && !seen.has(r.id) && seen.add(r.id))
    .sort((a, b) => (b.received_at ?? 0) - (a.received_at ?? 0));
}

// ------------------------------------------------------------------ one list for the whole account
export type Availability = "on-device" | "waiting" | "kept-offline" | "needs-internet";

export interface UnifiedRecord {
  id: string; title: string; when: string; availability: Availability; analysis: string;
  source: string;        // readable: "This device" or another device's name — never an id
  href: string; syncNote?: string; hasReport?: boolean;
}

export interface LocalLike { id: string; workflow_title: string; completed_at: string; sync_status: string; analysis_status: string }
export interface ServerLike { id: string; workflow_title?: string; workflow_id: string; completed_at?: string; received_at?: number; device_id?: string; analysis_status: string; report_id?: string | null }
export interface CopyLike { id: string; workflow_title: string; completed_at?: string; received_at?: number; device_label: string; analysis_status: string; report: unknown }

/**
 * Merge this device's records, the account's records on Hermes and offline copies into ONE list, one entry per
 * record id (this device's own copy wins, so nothing is duplicated), newest first.
 */
export function unifiedRecords(local: LocalLike[], server: ServerLike[], copies: CopyLike[], deviceNames: Map<string, string>,
                               thisDeviceId: string): UnifiedRecord[] {
  const out = new Map<string, UnifiedRecord & { sortKey: number }>();
  const ts = (s?: string, n?: number) => (s ? Date.parse(s) : 0) || (n ? n * 1000 : 0);
  for (const r of local) {
    const confirmed = r.sync_status === "synced" || r.sync_status === "received";
    out.set(r.id, { id: r.id, title: r.workflow_title, when: r.completed_at, sortKey: ts(r.completed_at),
      availability: confirmed ? "on-device" : "waiting", analysis: r.analysis_status, source: "This device", href: `#/results/${r.id}`,
      syncNote: confirmed ? undefined : r.sync_status });
  }
  const copyById = new Map(copies.map((c) => [c.id, c]));
  for (const r of server) {
    if (out.has(r.id)) continue;
    const kept = copyById.get(r.id);
    out.set(r.id, { id: r.id, title: r.workflow_title ?? r.workflow_id, when: r.completed_at ?? "", sortKey: ts(r.completed_at, r.received_at),
      availability: kept ? "kept-offline" : "needs-internet", analysis: r.analysis_status,
      source: r.device_id === thisDeviceId ? "This device" : (deviceNames.get(r.device_id ?? "") || "Another device"),
      href: `#/remote/${r.id}`, hasReport: !!r.report_id });
  }
  for (const c of copies) {   // copies whose record is no longer in the (possibly stale/offline) server list
    if (out.has(c.id)) continue;
    out.set(c.id, { id: c.id, title: c.workflow_title, when: c.completed_at ?? "", sortKey: ts(c.completed_at, c.received_at),
      availability: "kept-offline", analysis: c.analysis_status, source: c.device_label || "Another device", href: `#/remote/${c.id}`, hasReport: !!c.report });
  }
  return [...out.values()].sort((a, b) => b.sortKey - a.sortKey).map(({ sortKey: _s, ...rest }) => rest);
}

// ------------------------------------------------------------------ honest load errors
export type ProblemKind = "offline" | "unreachable" | "signed-out" | "server-outdated" | "server-error";
export interface LoadProblem { kind: ProblemKind; message: string }

/**
 * Say what actually went wrong when Hermes data couldn't be loaded. "Offline" only when the device really is
 * offline; a network failure while online is "can't reach Hermes"; HTTP errors are server errors, never "offline".
 */
export function describeLoadProblem(e: unknown, browserOnline: boolean, serverVersion = "", appVersion = ""): LoadProblem {
  if (e instanceof AuthRequired) return { kind: "signed-out", message: "Signed out of Hermes. Sign in to see every record in your account." };
  if (e instanceof Offline) {
    return browserOnline
      ? { kind: "unreachable", message: "Can't reach Hermes right now (the request didn't get through). Records on this device still work." }
      : { kind: "offline", message: "You're offline. Records marked “Needs internet” open once you're connected." };
  }
  if (e instanceof HttpError && e.status === 404) {
    return { kind: "server-outdated", message: serverVersion && appVersion && serverVersion !== appVersion
      ? `Hermes is running the FieldKit ${serverVersion} server, but this app is ${appVersion}. Restart the Hermes dashboard so the update takes effect.`
      : "This Hermes server doesn't support this FieldKit feature yet (HTTP 404). Restart the Hermes dashboard after updating the plugin." };
  }
  if (e instanceof HttpError) return { kind: "server-error", message: `Hermes couldn't load your records (HTTP ${e.status}). Try again in a moment.` };
  return { kind: "server-error", message: `Couldn't load your records from Hermes: ${(e as Error)?.message ?? String(e)}` };
}
