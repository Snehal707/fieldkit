// Workspaces on the phone (0.2.5): a workspace built by Hermes for the user's job, downloaded as one manifest pack
// (`ws-<id>`) plus the workflows and packs it lists, all SHA-256 checked like every pack. Works offline once installed.
import { api } from "./api";
import { db, type InstalledPack } from "./db";
import { text } from "./engine";
import { installedPacks, installPack, installWorkflow } from "./packs";

export interface WorkspaceManifest {
  kind: "workspace"; id: string; workspace_id: string; title: any; languages: string[]; profile: any;
  workflows: { id: string; version: number }[]; packs: string[]; guides: any[]; report_policy: any; intents?: any[];
  sources: any[]; evidence: any[]; gaps: any[]; traceability: any[]; summary: Record<string, number>; starter?: boolean;
  version?: number; version_of_workspace?: number;
}

export const manifestPackId = (wid: string) => `ws-${wid}`;

export async function installedWorkspaces(): Promise<{ pack: InstalledPack; manifest: WorkspaceManifest }[]> {
  return (await installedPacks()).filter((p) => p.kind === ("workspace" as any)).map((p) => ({ pack: p, manifest: p.content as WorkspaceManifest }));
}

export async function installedWorkspace(wid: string): Promise<WorkspaceManifest | null> {
  const p = await (await db()).get("packs", manifestPackId(wid));
  return p ? (p.content as WorkspaceManifest) : null;
}

/** Download a workspace and everything it needs for offline use. Partial failures are reported, never hidden. */
export async function installWorkspace(wid: string, onStep?: (s: string) => void): Promise<{ manifest: WorkspaceManifest; workflows: string[]; packs: string[]; failed: string[] }> {
  onStep?.("Downloading the workspace…");
  const m = (await installPack(manifestPackId(wid))).content as WorkspaceManifest;
  const failed: string[] = [], workflows: string[] = [], packs: string[] = [];
  for (const w of m.workflows ?? []) {
    onStep?.(`Downloading workflow ${w.id}…`);
    try { const r = await installWorkflow(w.id); workflows.push(w.id); packs.push(...r.packs); failed.push(...r.failed); }
    catch { failed.push(w.id); }
  }
  for (const p of m.packs ?? []) {
    if (packs.includes(p)) continue;
    onStep?.(`Downloading ${p}…`);
    try { await installPack(p); packs.push(p); } catch { failed.push(p); }
  }
  return { manifest: m, workflows, packs, failed };
}

export async function availableWorkspaces(): Promise<any[]> {
  return (await api<{ workspaces: any[] }>("workspaces")).workspaces;
}

/** Evidence status of the strongest evidence behind a set of ids (for labels). */
export function bestStatus(m: WorkspaceManifest, ids: string[] = []): string {
  const rank: Record<string, number> = { verified: 4, user_procedure: 4, supported: 3, reference: 3, local_practice: 3, conflicting: 2, unverified: 1 };
  const st = (m.evidence ?? []).filter((e: any) => ids.includes(e.id)).map((e: any) => e.status as string);
  return st.sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0] ?? "unverified";
}

export const STATUS_LABEL: Record<string, string> = {
  verified: "Verified source", user_procedure: "Your procedure", supported: "Supported by a source",
  reference: "Reference only (a standard for another stage)",
  local_practice: "Learned from your team's verified outcomes",
  conflicting: "Sources disagree", unverified: "Not verified",
};

export function wsTitle(m: { title: any }, lang: string): string { return text(m.title, lang) || "Workspace"; }


// The workspace the user is working in (per device convenience; the assistant answers from it).
const CURRENT_WS = "fieldkit.current-workspace";
export function rememberWorkspace(id: string | null): void {
  try { if (id) localStorage.setItem(CURRENT_WS, id); else localStorage.removeItem(CURRENT_WS); } catch { /* storage blocked */ }
}
export function currentWorkspace(): string | null {
  try { return localStorage.getItem(CURRENT_WS); } catch { return null; }
}

/** The workspace a workflow belongs to becomes the one in use (opening a workflow is the strongest signal of what the
 *  user is working on; a trial showed that "last workspace page viewed" was wrong). */
export async function rememberWorkspaceForWorkflow(workflowId: string): Promise<void> {
  try {
    const hit = (await installedWorkspaces()).find((w) => (w.manifest.workflows ?? []).some((x) => x.id === workflowId));
    if (hit) rememberWorkspace(hit.manifest.workspace_id);
  } catch { /* no workspaces on this device */ }
}

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

/** Offline summary for a workspace, calculated on the phone from what is stored here (no AI, no network). */
export interface LocalSummary {
  total: number; today: number; flagged: number; bySeverity: Record<string, number>; unfinished: number;
  waiting: number; reports: number; latest?: string;
}

export function summarizeLocal(workflowIds: string[], records: { workflow_id: string; completed_at: string; sync_status: string;
  report_id?: string | null; local_results?: { findings?: { severity: string }[] } }[], drafts: { workflow_id: string }[],
  now: Date = new Date()): LocalSummary {
  const ids = new Set(workflowIds);
  const mine = records.filter((r) => ids.has(r.workflow_id));
  const day = now.toISOString().slice(0, 10);
  const bySeverity: Record<string, number> = {};
  let flagged = 0;
  for (const r of mine) {
    const sev = (r.local_results?.findings ?? []).map((f) => f.severity).filter((x) => x !== "info");
    if (sev.length) {
      flagged++;
      const order = ["critical", "high", "medium", "low"];
      const worst = order.find((o) => sev.includes(o)) ?? sev[0];
      bySeverity[worst] = (bySeverity[worst] ?? 0) + 1;
    }
  }
  return {
    total: mine.length, today: mine.filter((r) => String(r.completed_at).slice(0, 10) === day).length, flagged, bySeverity,
    unfinished: drafts.filter((d) => ids.has(d.workflow_id)).length,
    waiting: mine.filter((r) => !["synced", "received"].includes(r.sync_status)).length,
    reports: mine.filter((r) => r.report_id).length,
    latest: mine.map((r) => r.completed_at).sort().pop(),
  };
}
