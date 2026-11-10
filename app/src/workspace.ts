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
  const rank: Record<string, number> = { verified: 4, user_procedure: 4, supported: 3, local_practice: 3, conflicting: 2, unverified: 1 };
  const st = (m.evidence ?? []).filter((e: any) => ids.includes(e.id)).map((e: any) => e.status as string);
  return st.sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0] ?? "unverified";
}

export const STATUS_LABEL: Record<string, string> = {
  verified: "Verified source", user_procedure: "Your procedure", supported: "Supported by a source",
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
