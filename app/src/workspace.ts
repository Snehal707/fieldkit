// Workspaces on the phone: the user's forms, set up with Hermes, downloaded as one manifest pack (`ws-<id>`) plus the
// form versions it lists, all SHA-256 checked. Works offline once installed.
import { api } from "./api";
import { type InstalledPack } from "./db";
import { text } from "./engine";
import { installedPacks, installPack, installWorkflow } from "./packs";
import { db, getSetting, setSetting } from "./db";

export interface WorkspaceManifest {
  kind: "workspace"; id: string; workspace_id: string; title: any; languages: string[];
  profile: { purpose?: string; [k: string]: unknown };
  workflows: { id: string; version: number }[]; packs?: string[]; starter?: boolean;
  version?: number; version_of_workspace?: number;
}

export const manifestPackId = (wid: string) => `ws-${wid}`;

export async function installedWorkspaces(): Promise<{ pack: InstalledPack; manifest: WorkspaceManifest }[]> {
  return (await installedPacks()).filter((p) => p.kind === "workspace").map((p) => ({ pack: p, manifest: p.content as WorkspaceManifest }));
}

export async function installedWorkspace(wid: string): Promise<WorkspaceManifest | null> {
  const p = await (await db()).get("packs", manifestPackId(wid));
  return p ? (p.content as WorkspaceManifest) : null;
}

/** Download a workspace and its forms for offline use. Partial failures are reported, never hidden. */
export async function installWorkspace(wid: string, onStep?: (s: string) => void): Promise<{ manifest: WorkspaceManifest; workflows: string[]; failed: string[] }> {
  onStep?.("Downloading the workspace…");
  const m = (await installPack(manifestPackId(wid))).content as WorkspaceManifest;
  const failed: string[] = [], workflows: string[] = [];
  for (const w of m.workflows ?? []) {
    onStep?.(`Downloading form ${w.id}…`);
    try { await installWorkflow(w.id); workflows.push(w.id); } catch { failed.push(w.id); }
  }
  return { manifest: m, workflows, failed };
}

export async function availableWorkspaces(): Promise<any[]> {
  return (await api<{ workspaces: any[] }>("workspaces")).workspaces;
}

export function wsTitle(m: { title: any }, lang: string): string { return text(m.title, lang) || "Workspace"; }

/** The workspace a new entry belongs to: the one the user started it from (when that workspace contains the form),
 *  else the only installed workspace containing the form, else null. Never a guess between several. */
export async function workspaceForEntry(workflowId: string, startedFrom?: string | null): Promise<string | null> {
  try {
    const ids = (await installedWorkspaces()).filter((w) => (w.manifest.workflows ?? []).some((x) => x.id === workflowId))
      .map((w) => w.manifest.workspace_id);
    if (startedFrom && ids.includes(startedFrom)) return startedFrom;
    return ids.length === 1 ? ids[0] : null;
  } catch { return null; }
}

/** Counts for one workspace, calculated on the phone from what is stored here (offline). */
export interface LocalSummary { total: number; today: number; unfinished: number; waiting: number; latest?: string }

export function summarizeLocal(workflowIds: string[], records: { workflow_id: string; completed_at: string; sync_status: string }[],
  drafts: { workflow_id: string }[], now: Date = new Date()): LocalSummary {
  const ids = new Set(workflowIds);
  const mine = records.filter((r) => ids.has(r.workflow_id));
  const day = now.toISOString().slice(0, 10);
  return {
    total: mine.length, today: mine.filter((r) => String(r.completed_at).slice(0, 10) === day).length,
    unfinished: drafts.filter((d) => ids.has(d.workflow_id)).length,
    waiting: mine.filter((r) => !["synced", "received"].includes(r.sync_status)).length,
    latest: mine.map((r) => r.completed_at).sort().pop(),
  };
}

// ------------------------------------------------------------------ the current workspace (Home, the Workspace tab)
/** The workspace Home shows and the Workspace tab opens: the one the user last opened, if it is still on this
 *  phone; otherwise the newest own (non-example) workspace; otherwise the example. Null when none is installed. */
export function pickCurrent<T extends { manifest: { workspace_id: string; starter?: boolean } }>(installed: T[], lastOpened: string): T | null {
  return installed.find((w) => w.manifest.workspace_id === lastOpened) ?? installed.find((w) => !w.manifest.starter) ?? installed[0] ?? null;
}

export async function currentWorkspace(): Promise<{ pack: InstalledPack; manifest: WorkspaceManifest } | null> {
  const all = (await installedWorkspaces()).sort((a, b) => String(b.pack.installed_at).localeCompare(String(a.pack.installed_at)));
  return pickCurrent(all, await getSetting<string>("current_workspace", ""));
}

export async function setCurrentWorkspace(wid: string): Promise<void> { await setSetting("current_workspace", wid); }

/** Recent activity on this phone: every unfinished entry first (they need finishing), then the newest saved
 *  entries, up to `limit` items in all (never fewer than the unfinished ones). */
export interface Activity { id: string; workflow_id: string; href: string; when: string; state: "draft" | "waiting" | "synced" }
export function recentActivity(records: { id: string; workflow_id: string; completed_at: string; sync_status: string }[],
  drafts: { id: string; workflow_id: string; updated_at?: string; started_at: string }[], limit = 5): Activity[] {
  const items: Activity[] = [
    ...drafts.map((d) => ({ id: d.id, workflow_id: d.workflow_id, href: `#/run/${d.id}`, when: d.updated_at || d.started_at, state: "draft" as const })),
    ...records.map((r) => ({ id: r.id, workflow_id: r.workflow_id, href: `#/results/${r.id}`, when: r.completed_at,
      state: (r.sync_status === "synced" || r.sync_status === "received" ? "synced" : "waiting") as Activity["state"] })),
  ];
  const newest = (x: Activity, y: Activity) => (Date.parse(y.when) || 0) - (Date.parse(x.when) || 0);
  const open = items.filter((i) => i.state === "draft").sort(newest);
  const done = items.filter((i) => i.state !== "draft").sort(newest);
  return [...open, ...done].slice(0, Math.max(limit, open.length));
}
