// Offline downloads: forms and workspace manifests (JSON from the plugin, SHA-256 verified) and the optional
// on-device OCR and translation packs (pinned upstream files, cached by their runtimes).
import { api, apiRaw } from "./api";
import { db, type InstalledPack, type StoredWorkflow } from "./db";
import type { Workflow } from "./engine";
import { nowIso, sha256Hex } from "./util";

export interface Catalog { models: any }

/** The optional on-device packs (OCR, translation) Hermes offers. */
export async function fetchCatalog(): Promise<Catalog> {
  return { models: await api("models") };
}

export async function installPack(id: string): Promise<InstalledPack> {
  const res = await apiRaw(`packs/${encodeURIComponent(id)}`);
  const body = await res.text();
  const expected = res.headers.get("x-fieldkit-sha256");
  const actual = await sha256Hex(body);
  if (expected && expected !== actual) throw new Error(`Integrity check failed for pack ${id}`);
  const content = JSON.parse(body);
  const pack: InstalledPack = {
    id, kind: content.kind, version: content.version, sha256: actual, size: body.length,
    title: typeof content.title === "object" ? content.title.en ?? Object.values(content.title)[0] : content.title,
    languages: content.languages ?? [], domain: content.domain ?? "", installed_at: nowIso(), content,
  };
  await (await db()).put("packs", pack);  // single put: a partial write is never visible
  return pack;
}

export async function installWorkflow(id: string): Promise<{ workflow: StoredWorkflow; packs: string[]; failed: string[] }> {
  const def = await api<Workflow>(`workflows/${encodeURIComponent(id)}`);
  if (!def || !Array.isArray(def.fields)) throw new Error("Invalid workflow from server");
  const d = await db();
  const before = await d.get("workflows", def.id);
  const previous = { ...(before?.previous ?? {}) };
  if (before && before.version !== (def.version ?? 1)) previous[String(before.version)] = before.definition;
  const stored: StoredWorkflow = { id: def.id, version: def.version ?? 1, downloaded_at: nowIso(), definition: def,
    ...(Object.keys(previous).length ? { previous } : {}) };
  await d.put("workflows", stored);
  return { workflow: stored, packs: [], failed: [] };
}

export async function removeWorkflow(id: string): Promise<void> {
  const d = await db();
  const drafts = (await d.getAll("drafts")).filter((x) => x.workflow_id === id);
  if (drafts.length) throw new Error("This workflow has unfinished drafts on the device.");
  await d.delete("workflows", id);
}

export async function installedPacks(kind?: InstalledPack["kind"]): Promise<InstalledPack[]> {
  const d = await db();
  return kind ? d.getAllFromIndex("packs", "by_kind", kind) : d.getAll("packs");
}

export async function installedWorkflows(): Promise<StoredWorkflow[]> {
  return (await db()).getAll("workflows");
}

export interface StorageInfo { usage?: number; quota?: number; persisted: boolean | null; supported: boolean }

export async function storageInfo(): Promise<StorageInfo> {
  const s = navigator.storage;
  if (!s) return { persisted: null, supported: false };
  const [est, persisted] = await Promise.all([s.estimate?.() ?? Promise.resolve({}), s.persisted?.() ?? Promise.resolve(null)]);
  return { usage: (est as StorageEstimate).usage, quota: (est as StorageEstimate).quota, persisted, supported: true };
}

/** Is the app shell present in the service worker cache (i.e. will it reopen offline)? */
export async function shellCached(): Promise<boolean> {
  try {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith("fieldkit-shell-"));
    if (!shell) return false;
    const c = await caches.open(shell);
    return !!(await c.match(new URL("./", location.href).toString())) || !!(await c.match(new URL("./index.html", location.href).toString()));
  } catch { return false; }
}
