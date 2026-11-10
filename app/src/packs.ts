// Offline pack manager: workflows, knowledge, dictionaries (JSON from the plugin, SHA-256 verified)
// and on-device model packs (pinned upstream files, cached by the runtimes).
import { api, apiRaw } from "./api";
import { db, type InstalledPack, type StoredWorkflow } from "./db";
import type { Workflow } from "./engine";
import { nowIso, sha256Hex } from "./util";

export interface Catalog { workflows: any[]; packs: any[]; models: any }

export async function fetchCatalog(): Promise<Catalog> {
  const [w, p, m] = await Promise.all([api("workflows"), api("packs"), api("models")]);
  return { workflows: w.workflows, packs: p.packs, models: m };
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
  const wanted = [...(def.knowledge_packs ?? []), ...(def.dictionary_packs ?? [])];
  const done: string[] = [];
  const failed: string[] = [];
  for (const pid of wanted) {
    try { await installPack(pid); done.push(pid); } catch { failed.push(pid); }
  }
  return { workflow: stored, packs: done, failed };
}

export async function removeWorkflow(id: string): Promise<void> {
  const d = await db();
  const drafts = (await d.getAll("drafts")).filter((x) => x.workflow_id === id);
  if (drafts.length) throw new Error("This workflow has unfinished drafts on the device.");
  await d.delete("workflows", id);
}

export async function removePack(id: string): Promise<void> {
  await (await db()).delete("packs", id);
}

export async function installedPacks(kind?: InstalledPack["kind"]): Promise<InstalledPack[]> {
  const d = await db();
  return kind ? d.getAllFromIndex("packs", "by_kind", kind) : d.getAll("packs");
}

export async function installedWorkflows(): Promise<StoredWorkflow[]> {
  return (await db()).getAll("workflows");
}

/** Versions newer on the server than on the device. */
export function updatesAvailable(cat: Catalog, wfs: StoredWorkflow[], packs: InstalledPack[]): { workflows: string[]; packs: string[] } {
  const w = wfs.filter((x) => {
    const s = cat.workflows.find((c) => c.id === x.id);
    return s && s.published_version && s.published_version > x.version;
  }).map((x) => x.id);
  const p = packs.filter((x) => {
    const s = cat.packs.find((c) => c.id === x.id);
    return s && s.version > x.version;
  }).map((x) => x.id);
  return { workflows: w, packs: p };
}

export interface StorageInfo { usage?: number; quota?: number; persisted: boolean | null; supported: boolean }

export async function storageInfo(): Promise<StorageInfo> {
  const s = navigator.storage;
  if (!s) return { persisted: null, supported: false };
  const [est, persisted] = await Promise.all([s.estimate?.() ?? Promise.resolve({}), s.persisted?.() ?? Promise.resolve(null)]);
  return { usage: (est as StorageEstimate).usage, quota: (est as StorageEstimate).quota, persisted, supported: true };
}

export async function requestPersistence(): Promise<boolean | null> {
  try { return (await navigator.storage?.persist?.()) ?? null; } catch { return null; }
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
