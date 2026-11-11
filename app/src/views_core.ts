// Core screens: Home, form runner, entry view, Saved Records, entries from other devices, Pending Sync.
import { api, AuthRequired, HttpError, Offline } from "./api";
import { APP_VERSION, signIn } from "./config";
import { db, definitionFor, deleteRecord, deviceId, getSetting, setSetting, type Attachment, type Draft, type LocalRecord, type RemoteCopy, type StoredReport } from "./db";
import { describeLoadProblem, missingOnServer, unifiedRecords, type Availability, type LoadProblem, type ServerLike } from "./device";
import { computeState, ERROR_TEXT, text, type Field, type Workflow } from "./engine";
import { installedModels, ocr, ocrLanguages } from "./intel";
import { attachmentUrl, captureGps, compressPhoto, getAttachment, hermesMediaUrl, saveAttachment, signaturePad, updateAttachment, VoiceRecorder } from "./media";
import { installedPacks, installedWorkflows, installWorkflow, shellCached, storageInfo } from "./packs";
import { completeDraft, deleteDraft, hasMeaningfulInput } from "./results";
import { downloadEarlierReport, getSyncState, refreshPending, resendRecords, resolveConflict, retryRecords, runSync } from "./sync";
import { availableWorkspaces, currentWorkspace, installedWorkspaces, installWorkspace, recentActivity, summarizeLocal, workspaceForEntry, wsTitle, type Activity } from "./workspace";
import { clear, fmtBytes, fmtTime, h, isOnline, nowIso, toast, uuid } from "./util";
import { icon } from "./icons";

export type View = (main: HTMLElement, params: Record<string, string>) => Promise<void> | void;
export const go = (hash: string) => { location.hash = hash; };
export async function lang(): Promise<string> { return getSetting("lang", "en"); }

const STATUS_TEXT: Record<string, string> = {
  local: "Saved locally — pending synchronization", pending: "Saved locally — pending synchronization",
  syncing: "Uploading…", received: "Received by Hermes — files still uploading", synced: "Saved to Hermes",
  conflict: "Conflict — needs your decision", error: "Hermes didn't accept it — try again",
};

export function sevBadge(sev: string) { return h("span", { class: `badge sev-${sev}` }, sev); }

// ------------------------------------------------------------------ media previews
export type MediaKind = "photo" | "audio" | "signature";
const KIND_NOUN: Record<MediaKind, [string, string]> = { photo: ["photo", "photos"], audio: ["voice note", "voice notes"], signature: ["signature", "signatures"] };

/** "2 photos · 1 voice note · 1 signature" */
export function mediaSummary(counts: Partial<Record<MediaKind, number>>): string {
  return (["photo", "audio", "signature"] as MediaKind[]).filter((k) => counts[k]).map((k) => `${counts[k]} ${KIND_NOUN[k][counts[k] === 1 ? 0 : 1]}`).join(" · ");
}

function mediaProblem(kind: MediaKind, msg: string) {
  return h("div", { class: "banner warn media-problem", "data-media-problem": kind }, h("strong", null, kind === "audio" ? "Can't play this voice note here" : `Can't show this ${KIND_NOUN[kind][0]} here`), h("div", null, msg));
}

/** Element showing a locally stored attachment, loaded through integrity-checked attachmentUrl (never a broken icon). */
export function mediaPreview(a: Attachment, kind: MediaKind): HTMLElement {
  const box = h("div", { class: "media", "data-attachment-id": a.id, "data-kind": kind, "data-media-state": "loading" });
  void attachmentUrl(a).then((src) => {
    const el = kind === "audio" ? h("audio", { controls: true, preload: "metadata", src: src.url }) as HTMLAudioElement
      : h("img", { src: src.url, alt: KIND_NOUN[kind][0], class: kind === "signature" ? "sig-img" : "" }) as HTMLImageElement;
    el.addEventListener("error", () => {
      box.setAttribute("data-media-state", "error");
      clear(box);
      box.append(mediaProblem(kind, kind === "audio" ? `This device can't play ${a.mime} recordings. The file is kept and uploaded to Hermes unchanged.`
        : "This device couldn't decode the image. The file is kept and uploaded to Hermes unchanged."));
    });
    el.addEventListener(kind === "audio" ? "loadedmetadata" : "load", () => box.setAttribute("data-media-state", "ok"));
    box.append(el);
    if (src.source === "hermes") box.append(h("div", { class: "muted" }, src.repaired ? "The copy on this device was damaged; restored from Hermes (verified)." : "Shown from Hermes' copy (verified)."));
  }, (e) => { box.setAttribute("data-media-state", "error"); box.append(mediaProblem(kind, (e as Error).message)); });
  return box;
}

/** Element showing a file stored on Hermes (record not on this device). Loads on demand; needs internet. */
function hermesMedia(a: { id: string; mime: string; sha256?: string; status?: string }, kind: MediaKind): HTMLElement {
  const box = h("div", { class: "media", "data-attachment-id": a.id, "data-kind": kind, "data-media-state": "idle" });
  if (a.status && a.status !== "stored") { box.append(h("div", { class: "muted" }, `${KIND_NOUN[kind][0]} still uploading to Hermes`)); return box; }
  const btn = h("button", { onclick: async () => {
    btn.disabled = true; btn.textContent = "Loading…";
    try {
      const url = await hermesMediaUrl(a.id, a.mime, a.sha256);
      clear(box);
      const el = kind === "audio" ? h("audio", { controls: true, preload: "metadata", src: url }) : h("img", { src: url, alt: KIND_NOUN[kind][0], class: kind === "signature" ? "sig-img" : "" });
      el.addEventListener("error", () => { box.setAttribute("data-media-state", "error"); clear(box); box.append(mediaProblem(kind, `This device can't open ${a.mime} files.`)); });
      box.setAttribute("data-media-state", "ok");
      box.append(el);
    } catch (e) { btn.disabled = false; btn.textContent = `Show ${KIND_NOUN[kind][0]}`; box.setAttribute("data-media-state", "error"); toast((e as Error).message, "error"); }
  } }, `Show ${KIND_NOUN[kind][0]}`);
  box.append(btn);
  return box;
}

// ------------------------------------------------------------------ readiness
export interface Check { label: string; ok: boolean | null; detail?: string }

export async function readiness(): Promise<Check[]> {
  const wfs = await installedWorkflows();
  const models = await installedModels();
  const st = await storageInfo();
  const sw = !!navigator.serviceWorker?.controller;
  return [
    { label: "App installed for offline opening", ok: sw && (await shellCached()), detail: sw ? "service worker active" : "open once online to install" },
    { label: "Forms downloaded", ok: wfs.length > 0, detail: `${wfs.length} on this device` },
    { label: "Offline translation", ok: models.some((m) => m.capability === "translation") || null, detail: models.filter((m) => m.capability === "translation").map((m) => m.manifest.direction.join("→")).join(", ") || "optional — install in Offline Packs" },
    { label: "Offline OCR", ok: models.some((m) => m.capability === "ocr") || null, detail: models.filter((m) => m.capability === "ocr").map((m) => m.manifest.lang_code).join(", ") || "optional" },
    { label: "Storage protection", ok: st.persisted ? true : null,
      detail: st.persisted ? "the browser won't clear FieldKit data automatically" : "standard storage (normal on iPhone) — records are kept until they sync; see Settings" },
  ];
}

function checkRow(c: Check) {
  const icon = c.ok === true ? "✔" : c.ok === false ? "✖" : "○";
  return h("div", { class: "check" }, h("span", { class: `i ${c.ok === true ? "ok" : c.ok === false ? "no" : "wait"}` }, icon),
    h("div", null, h("div", null, c.label), c.detail ? h("div", { class: "muted" }, c.detail) : null));
}

// ------------------------------------------------------------------ home
// A compact overview: the current workspace (forms and their Start buttons live only on the Workspace page),
// offline readiness, synchronisation, saved records and recent activity on this phone.
const ACTIVITY_TEXT: Record<Activity["state"], string> = { draft: "Unfinished", waiting: "Waiting to sync", uploading: "Files uploading", synced: "Synced" };

/** A short label for an entry: the form's subject field, else its first short text answer (an asset id, a name). */
function subjectOf(def: Workflow | undefined, answers: Record<string, unknown> | undefined): string {
  if (!def || !answers) return "";
  const pick = (v: unknown) => (typeof v === "string" && v.trim().length > 0 && v.trim().length <= 40 ? v.trim() : "");
  const named = def.metadata?.subject_field ? pick(answers[def.metadata.subject_field]) : "";
  if (named) return named;
  for (const f of def.fields ?? []) { if (f.type === "text") { const v = pick(answers[f.id]); if (v) return v; } }
  return "";
}

/** "Today 2:05 PM", otherwise date and time. */
function shortWhen(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return t.toDateString() === new Date().toDateString()
    ? `Today ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : fmtTime(iso);
}

function statusRow(opts: { id?: string; href?: string; state: "ok" | "wait" | "bad"; title: string; sub: string }): HTMLElement {
  const inner = [h("span", { class: `dot ${opts.state}`, "aria-hidden": "true" }),
    h("span", { class: "grow" }, h("strong", null, opts.title), h("span", { class: "muted" }, opts.sub))];
  return opts.href ? h("a", { class: "status-row", href: opts.href, id: opts.id }, ...inner, icon("chevron", 16))
    : h("div", { class: "status-row", id: opts.id }, ...inner);
}

export const homeView: View = async (main) => {
  const d = await db();
  const [checks, records, drafts, wfs, workspaces, cur, l] = await Promise.all([readiness(), d.getAll("records"), d.getAll("drafts"),
    installedWorkflows(), installedWorkspaces(), currentWorkspace(), lang()]);
  const essential = checks.slice(0, 3);
  const ready = essential.every((c) => c.ok !== false);
  // Same rule as the header ("N awaiting confirmation"): anything Hermes hasn't fully confirmed, media included.
  const pending = records.filter((r) => r.sync_status !== "synced").length;
  const sync = getSyncState();
  const acct = await accountRecordsSummary(!sync.auth_required);
  const defs = new Map(wfs.map((w) => [w.id, w.definition]));
  if (!wfs.length) main.append(getStartedCard(sync.auth_required));

  // The current workspace, with a way to open it or switch. Its forms and Start buttons are on the Workspace page.
  const wsCard = h("section", { class: "card ws-current", id: "home-workspaces" });
  if (cur) {
    const m = cur.manifest;
    const ids = (m.workflows ?? []).map((w) => w.id);
    const sm = summarizeLocal(ids, records, drafts);
    wsCard.append(
      h("div", { class: "ws-head" }, h("h2", null, wsTitle(m, l)), m.starter ? h("span", { class: "tag" }, "Example") : null),
      h("p", { class: "ws-purpose", hidden: !m.profile?.purpose }, String(m.profile?.purpose ?? "")),
      h("div", { class: "meta" }, h("span", null, `${ids.length} ${ids.length === 1 ? "form" : "forms"}`),
        h("span", null, `${sm.today} ${sm.today === 1 ? "entry" : "entries"} today`),
        sm.unfinished ? h("span", { class: "wait" }, `${sm.unfinished} unfinished`) : null),
      h("div", { class: "row" },
        h("a", { class: "btn primary", href: `#/workspace/${encodeURIComponent(m.workspace_id)}` }, "Open workspace"),
        h("a", { class: "btn", href: "#/workspaces" }, workspaces.length > 1 ? "Switch workspace" : "All workspaces")));
  } else {
    wsCard.append(h("h2", null, "Your workspace"),
      h("p", { class: "muted" }, "Ask Hermes: “Set up FieldKit for my work.” It asks what you record and builds your forms in a few minutes."),
      h("div", { class: "row" }, h("a", { class: "btn", href: "#/workspaces" }, "Browse workspaces")));
  }
  main.append(wsCard);

  // Status: offline readiness (expands to the checks), synchronisation, saved records.
  const readinessEl = h("details", { class: "status-details", id: "home-readiness", open: !ready },
    h("summary", null, h("span", { class: `dot ${ready ? "ok" : "wait"}`, "aria-hidden": "true" }),
      h("span", { class: "grow" }, h("strong", null, ready ? "Ready to work offline" : "Not ready for offline use yet"),
        h("span", { class: "muted" }, ready ? "Your forms and the app itself are stored on this device." : "Connect once, sign in, and download your workspace."))),
    h("div", { class: "checks" }, ...checks.map(checkRow),
      h("div", { class: "row" }, h("a", { class: "btn", href: "#/packs" }, "Offline Packs"))));
  const recordsRow = statusRow({ id: "tile-records", href: "#/records", state: "ok", title: "Saved Records", sub: recordsSub(acct) });
  recordsRow.setAttribute("data-total", acct.known ? String(acct.total) : "");
  recordsRow.setAttribute("data-offline", String(acct.offline));
  main.append(h("section", { class: "card status-card", id: "home-status" }, readinessEl,
    statusRow({ href: "#/sync", state: sync.auth_required ? "bad" : pending ? "wait" : "ok", title: "Pending Sync",
      sub: sync.auth_required ? "Sign in to Hermes to sync" : pending ? `${pending} awaiting confirmation` : "All confirmed" }),
    recordsRow));

  // Recent activity on this phone (works offline).
  const recent = recentActivity(records, drafts);
  const answersById = new Map<string, Record<string, unknown>>([
    ...records.map((r) => [r.id, r.answers as Record<string, unknown>] as [string, Record<string, unknown>]),
    ...drafts.map((x) => [x.id, x.answers as Record<string, unknown>] as [string, Record<string, unknown>])]);
  const titleOf = (wid: string) => (defs.has(wid) ? text(defs.get(wid)!.title, l)
    : records.find((r) => r.workflow_id === wid)?.workflow_title ?? wid);
  main.append(h("section", { class: "card", id: "home-recent" }, h("h2", null, "Recent activity"),
    recent.length ? h("ul", { class: "activity" }, ...recent.map((a) => {
      const subject = subjectOf(defs.get(a.workflow_id), answersById.get(a.id));
      return h("li", { "data-state": a.state }, h("a", { href: a.href },
        h("span", { class: "grow" }, h("strong", null, titleOf(a.workflow_id)),
          h("span", { class: "sub-line" }, subject ? h("span", { class: "subject" }, subject) : null, h("span", { class: "muted" }, shortWhen(a.when)))),
        h("span", { class: `state ${a.state}` }, ACTIVITY_TEXT[a.state])));
    }), records.length + drafts.length > recent.length ? h("li", { class: "more" }, h("a", { href: "#/records" }, "All saved records")) : null)
      : h("p", { class: "muted" }, cur ? "No entries on this phone yet. Open your workspace to start one." : "Entries you record on this phone appear here.")));

  main.append(h("details", { class: "card", id: "home-tools" }, h("summary", null, h("strong", null, "Tools"),
    h("span", { class: "muted" }, " Translate and scan text (optional offline packs)")),
    h("div", { class: "grid" },
      tile("#/translate", "Translate", "Sentence translation"),
      tile("#/ocr", "Scan text (OCR)", "From camera or photo"))));
};

/** First run: nothing downloaded yet. Workflows are never pulled silently (they can carry large packs), so
 * Home explains the next step and offers a one-tap download of everything Hermes has published. */
function getStartedCard(authRequired: boolean): HTMLElement {
  const card = h("div", { class: "card" }, h("h2", null, "Get started"));
  if (!isOnline()) {
    card.append(h("p", { class: "muted" }, "Connect to the internet once to download workflows from your Hermes."));
    return card;
  }
  if (authRequired) {
    card.append(h("p", null, "Sign in to Hermes to see your workflows."),
      h("button", { class: "primary", onclick: () => signIn("#/") }, "Sign in"));
    return card;
  }
  const body = h("div", null, h("p", { class: "muted" }, "Checking your Hermes for published workflows…"));
  card.append(body);
  void (async () => {
    try {
      const workspaces = await availableWorkspaces();
      clear(body);
      if (!workspaces.length) {
        body.append(h("p", null, "Your Hermes has no FieldKit workspace yet."),
          h("p", { class: "muted" }, "In Hermes, say “Set up FieldKit for my work”. Then come back here."),
          h("button", { onclick: () => go(`#/?r=${Date.now()}`) }, "Check again"));
        return;
      }
      const btn = h("button", { class: "primary" }, `Download all ${workspaces.length} workspace(s) for offline use`) as HTMLButtonElement;
      btn.onclick = async () => {
        btn.disabled = true;
        const failed: string[] = [];
        for (const [i, w] of workspaces.entries()) {
          btn.textContent = `Downloading ${i + 1} of ${workspaces.length}…`;
          try { const r = await installWorkspace(w.id); failed.push(...r.failed); } catch { failed.push(w.title || w.id); }
        }
        toast(failed.length ? `Some downloads failed: ${failed.join(", ")}` : "Your forms are saved on this device.", failed.length ? "error" : "ok");
        go(`#/?r=${Date.now()}`);
      };
      body.append(h("p", null, `${workspaces.length} workspace(s) available: ${workspaces.map((w) => w.title || w.id).join(", ")}.`),
        h("div", { class: "row" }, btn, h("a", { class: "btn", href: "#/workspaces" }, "Choose individually")),
        h("p", { class: "muted" }, "Offline OCR and translation are optional downloads in Offline Packs."));
    } catch (e) {
      clear(body);
      if (e instanceof AuthRequired) {
        body.append(h("p", null, "Sign in to Hermes to see your workflows."), h("button", { class: "primary", onclick: () => signIn("#/") }, "Sign in"));
      } else {
        body.append(h("p", { class: "muted" }, (await problemFor(e)).message), h("button", { onclick: () => go(`#/?r=${Date.now()}`) }, "Try again"));
      }
    }
  })();
  return card;
}

/** Saved Records across the whole account, from the remembered Hermes list; refreshed briefly when online. */
interface AccountSummary { known: boolean; total: number; offline: number; onDevice: number; signedOut: boolean; at?: string }
async function accountRecordsSummary(tryLive: boolean): Promise<AccountSummary> {
  const d = await db();
  const local = await d.getAll("records");
  let account = await currentAccountId();
  let index = await getSetting<ServerIndex | null>("server_index", null);
  if (index && account && index.user_id !== account) index = null;
  let signedOut = false;
  const fresh = !!index && Date.now() - Date.parse(index.at) < 60_000;   // Home re-renders after every sync pass
  if (tryLive && isOnline() && !fresh) {
    // Never hold Home hostage to a slow network: give Hermes a few seconds, else use the remembered list.
    const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Offline("timeout")), 4000));
    try {
      const [{ records }, who] = await Promise.race([Promise.all([api<{ records: ServerLike[] }>("records?limit=500"), api<{ user_id: string }>("me")]), timeout]);
      account = who.user_id;
      const keep = index && index.user_id === account ? index.devices : [];
      index = { user_id: account, at: nowIso(), records, devices: keep };
      await setSetting("server_index", index);
    } catch (e) { if (e instanceof AuthRequired) signedOut = true; }
  }
  const copies = await accountCopies(account);
  const list = unifiedRecords(local, index?.records ?? [], copies, new Map(index?.devices ?? []), await deviceId());
  return { known: !!index, total: list.length, offline: list.filter((r) => r.availability !== "needs-internet").length,
    onDevice: local.length, signedOut, at: index?.at };
}

function recordsSub(a: AccountSummary): string {
  return a.known
    ? `${a.total} in your account · ${a.offline} available offline`
    : `${a.offline} available offline · ${a.signedOut ? "sign in to see your account" : "connect to see your whole account"}`;
}

function tile(href: string, title: string, sub: string) {
  return h("a", { class: "tile", href }, h("strong", null, title), h("span", { class: "muted" }, sub));
}

/** The right sign-in banner for this install: first sign-in, or an expired session. */
export async function signInBanner(): Promise<HTMLElement> {
  return authBanner(!(await getSetting<unknown>("last_account", null)));
}

export function authBanner(firstTime = false) {
  if (firstTime) {
    return h("div", { class: "banner warn", "data-auth": "first" }, h("strong", null, "Sign in to Hermes"),
      h("div", { class: "muted" }, "Sign in once in this app to see your account's records and sync. Each browser and Home Screen app signs in separately."),
      h("div", { class: "row", style: "margin-top:.5rem" }, h("button", { class: "primary", onclick: () => signIn(location.hash || "#/") }, "Sign in")));
  }
  return h("div", { class: "banner warn", "data-auth": "expired" }, h("strong", null, "Sign in to Hermes to continue syncing"),
    h("div", { class: "muted" }, "Your session expired. Nothing has been lost: records stay queued on this device and upload after you sign in."),
    h("div", { class: "row", style: "margin-top:.5rem" }, h("button", { class: "primary", onclick: () => signIn(location.hash || "#/sync") }, "Sign in")));
}

// ------------------------------------------------------------------ workflows
export const workflowLinkView: View = async (main, p) => {
  // Deep link from Hermes (…/app/#/workflow/<id>): download if needed, then offer to start. "?ws=" names the workspace
  // the user started from (workspace page, home), so the entry is filed under it.
  const id = p.id;
  const startedFrom = new URLSearchParams(location.hash.split("?")[1] ?? "").get("ws");
  let stored = await (await db()).get("workflows", id);
  if (!stored && isOnline()) {
    try {
      main.append(h("p", { class: "muted" }, "Downloading workflow and its packs for offline use…"));
      const r = await installWorkflow(id);
      stored = r.workflow;
      clear(main);
      if (r.failed.length) toast(`Some packs failed: ${r.failed.join(", ")}`, "error");
    } catch (e) {
      clear(main);
      if (e instanceof AuthRequired) { main.append(await signInBanner()); return; }
      main.append(h("div", { class: "banner bad" }, `Could not download workflow "${id}": ${(e as Error).message}`));
      return;
    }
  }
  if (!stored) { main.append(h("div", { class: "banner warn" }, `Workflow "${id}" is not on this device. Connect to the internet to download it.`)); return; }
  const l = await lang();
  const wf = stored.definition;
  main.append(h("div", { class: "card" }, h("h2", null, text(wf.title, l)), h("p", null, text(wf.description, l)),
    h("p", { class: "muted" }, `Version ${stored.version} · ${wf.fields.length} questions · stored on this device`),
    h("button", { class: "primary", onclick: () => startWorkflow(id, startedFrom) }, "Start workflow")));
};

/** Entries opened but not yet holding any input: kept in memory only, so opening a form creates no draft. */
const unsavedDrafts = new Map<string, Draft>();

async function startWorkflow(id: string, startedFrom?: string | null) {
  const draft: Draft = { id: uuid("rec"), workflow_id: id, workflow_version: (await (await db()).get("workflows", id))!.version,
    answers: {}, started_at: nowIso(), updated_at: nowIso(), lang: await lang(),
    workspace_id: await workspaceForEntry(id, startedFrom) };
  const wf = (await (await db()).get("workflows", id))!.definition;
  for (const f of wf.fields) if (f.default !== undefined) draft.answers[f.id] = f.default;
  unsavedDrafts.set(draft.id, draft);   // saved as a draft on the first real input (see runView's save)
  go(`#/run/${draft.id}?wf=${encodeURIComponent(id)}${startedFrom ? `&ws=${encodeURIComponent(startedFrom)}` : ""}`);
}

// ------------------------------------------------------------------ runner
export const runView: View = async (main, p) => {
  const d = await db();
  const savedDraft = await d.get("drafts", p.id);
  const draft = savedDraft ?? unsavedDrafts.get(p.id);
  if (!draft) {
    const rec = await d.get("records", p.id);
    if (rec) return go(`#/results/${rec.id}`);
    // An entry that was opened but never given any input was not saved (e.g. the app was reloaded): start again.
    const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
    if (q.get("wf")) return go(`#/workflow/${encodeURIComponent(q.get("wf")!)}${q.get("ws") ? `?ws=${encodeURIComponent(q.get("ws")!)}` : ""}`);
    main.append(h("div", { class: "banner bad" }, "Draft not found."));
    return;
  }
  let persisted = !!savedDraft;
  const defaults = JSON.parse(JSON.stringify(draft.answers)) as Record<string, unknown>;
  const stored = await d.get("workflows", draft.workflow_id);
  if (!stored) { main.append(h("div", { class: "banner bad" }, "This workflow is no longer on the device.")); return; }
  const wf = stored.definition;
  const l = draft.lang;
  let showErrors = false;
  const touched = new Set<string>();
  const form = h("div");
  const save = async () => {
    const first = !persisted;
    if (first) {
      if (!hasMeaningfulInput(draft.answers, defaults)) return;   // nothing entered yet: no draft
      persisted = true;
      unsavedDrafts.delete(draft.id);
    }
    draft.updated_at = nowIso();
    await d.put("drafts", draft);
    if (first) await refreshPending();   // the header now shows "1 not submitted"
  };
  const removeDraft = async () => {
    if (!confirm("Delete this unfinished entry? Its answers and any photos, voice notes or signatures captured for it "
      + "are removed from this phone. Completed records are not affected.")) return;
    const r = await deleteDraft(draft.id);
    toast(r.deleted ? "Unfinished entry deleted." : "This entry was already gone.", "ok");
    go(draft.workspace_id ? `#/workspace/${encodeURIComponent(draft.workspace_id)}` : "#/");
  };
  const set = async (fid: string, v: unknown, rerender = true) => {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete draft.answers[fid]; else draft.answers[fid] = v;
    touched.add(fid);
    await save();
    if (rerender) render();
  };

  const notice = h("div");
  const render = (keepFocus = true) => {
    // A re-render (e.g. after a choice is saved) must not take the cursor out of the field being typed in: on a slow
    // device the save can finish mid-typing, and keystrokes after the rebuild would otherwise go nowhere.
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const keep = keepFocus && active && form.contains(active) && active.id?.startsWith("in-")
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    const st = computeState(wf, draft.answers, l);
    clear(form);
    form.append(notice);
    const vis = new Set(st.visible);
    for (const f of wf.fields) {
      if (!vis.has(f.id)) continue;
      form.append(fieldView(f, st, vis));
    }
    form.append(
      h("div", { class: "row" },
      h("button", { class: "primary", onclick: finish }, "Complete workflow"),
      h("span", { class: "muted", id: "draft-state" }, `${persisted ? "Draft saved on this device" : "Nothing saved until you answer something"} · ${Object.keys(st.errors).length} item(s) to fix`)),
      ...(persisted ? [h("div", { class: "row" }, h("button", { class: "danger small", id: "delete-draft", onclick: removeDraft }, "Delete draft"))] : []));
    if (keep) {
      const again = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(keep.id)}`);
      if (again) {
        again.focus({ preventScroll: true });
        try { if (keep.start !== null && keep.end !== null) again.setSelectionRange(keep.start, keep.end); } catch { /* date/number inputs */ }
      }
    }
  };

  const fieldView = (f: Field, st: ReturnType<typeof computeState>, _vis: Set<string>) => {
    const req = st.required.includes(f.id);
    const errs = (showErrors || touched.has(f.id)) ? (st.errors[f.id] ?? []) : [];
    const msgs = st.messages[f.id] ?? [];
    const box = h("div", { class: "field card", id: `f-${f.id}` });
    if (f.type === "instruction") {
      box.append(h("div", { class: "banner hermes" }, text(f.label, l)));
      return box;
    }
    box.append(h("label", { class: "q", for: `in-${f.id}` }, text(f.label, l), f.unit ? ` (${f.unit})` : "", req ? h("span", { class: "req" }, " *") : null));
    box.append(input(f));
    if (f.help) box.append(h("div", { class: "help" }, text(f.help, l)));
    for (const e of errs) if (ERROR_TEXT[e]) box.append(h("div", { class: "err" }, ERROR_TEXT[e]));
    if (errs.includes("rule")) for (const m of msgs) box.append(h("div", { class: "err" }, m));
    return box;
  };

  const input = (f: Field): HTMLElement => {
    const v = draft.answers[f.id];
    const id = `in-${f.id}`;
    const ph = text(f.placeholder, l);
    switch (f.type) {
      case "text": return h("input", { id, value: (v as string) ?? "", placeholder: ph, oninput: (e: Event) => set(f.id, (e.target as HTMLInputElement).value, false), onchange: () => render(false) });
      case "multiline": {
        return h("textarea", { id, placeholder: ph, oninput: (e: Event) => set(f.id, (e.target as HTMLTextAreaElement).value, false), onchange: () => render(false) }, (v as string) ?? "");
      }
      case "number": return h("input", { id, type: "number", inputmode: "decimal", step: "any", value: v ?? "",
        oninput: (e: Event) => { const s = (e.target as HTMLInputElement).value; set(f.id, s === "" ? undefined : Number(s), false); }, onchange: () => render(false) });
      case "date": return h("input", { id, type: "date", value: (v as string) ?? "", onchange: (e: Event) => set(f.id, (e.target as HTMLInputElement).value) });
      case "time": return h("input", { id, type: "time", value: (v as string) ?? "", onchange: (e: Event) => set(f.id, (e.target as HTMLInputElement).value) });
      case "checkbox": return h("div", { class: "choices row" },
        ...[["Yes", true], ["No", false]].map(([lab, val]) => h("label", null,
          h("input", { type: "radio", name: id, checked: v === val, onchange: () => set(f.id, val) }), String(lab))),
        v !== undefined ? h("button", { onclick: () => set(f.id, undefined) }, "Clear") : null);
      case "single_choice": return h("div", { class: "choices" }, ...(f.options ?? []).map((o) => h("label", null,
        h("input", { type: "radio", name: id, checked: v === o.value, onchange: () => set(f.id, o.value) }), text(o.label, l))));
      case "multi_choice": {
        const cur = Array.isArray(v) ? (v as unknown[]) : [];
        return h("div", { class: "choices" }, ...(f.options ?? []).map((o) => h("label", null,
          h("input", { type: "checkbox", checked: cur.includes(o.value),
            onchange: (e: Event) => set(f.id, (e.target as HTMLInputElement).checked ? [...cur, o.value] : cur.filter((x) => x !== o.value)) }),
          text(o.label, l))));
      }
      case "photo": return photoInput(f);
      case "audio": return audioInput(f);
      case "gps": return gpsInput(f);
      case "signature": return signatureInput(f);
    }
    return h("div", { class: "err" }, `Unsupported field type ${f.type}`);
  };

  const mediaItems = (f: Field) => (Array.isArray(draft.answers[f.id]) ? draft.answers[f.id] : draft.answers[f.id] ? [draft.answers[f.id]] : []) as any[];

  const photoInput = (f: Field) => {
    const items = mediaItems(f);
    const thumbs = h("div", { class: "thumbs" });
    for (const it of items) {
      void getAttachment(it.attachment_id).then((a) => {
        if (!a) return;
        const ocrBtn = h("button", { onclick: async () => {
          const langs = await ocrLanguages();
          if (!langs.length) return toast("Install an OCR pack in Offline Packs first.", "error");
          ocrBtn.disabled = true;
          ocrBtn.textContent = "Reading text…";
          try {
            const want = l === "hi" ? "hin" : "eng";
            const r = await ocr(a.blob, langs.includes(want) ? want : langs[0], (p) => { if (p.status) ocrBtn.textContent = p.status; });
            it.ocr_text = r.text;
            it.ocr_confidence = r.confidence;
            await updateAttachment(a.id, { meta: { ocr_text: r.text, ocr_confidence: r.confidence } });
            if (r.note) toast(r.note, r.quality === "poor" ? "error" : "info");
            await set(f.id, items);
          } catch (e) { toast((e as Error).message, "error"); ocrBtn.disabled = false; ocrBtn.textContent = "Extract text (OCR)"; }
        } }, "Extract text (OCR)");
        thumbs.append(h("div", null, mediaPreview(a, "photo"),
          h("div", { class: "row" }, ocrBtn, h("button", { class: "danger", onclick: async () => {
            await d.delete("attachments", a.id); await set(f.id, items.filter((x) => x.attachment_id !== a.id));
          } }, "Remove")),
          it.ocr_text !== undefined ? h("textarea", { oninput: async (e: Event) => { it.ocr_text = (e.target as HTMLTextAreaElement).value; await set(f.id, items, false); } }, it.ocr_text) : null));
      });
    }
    const max = f.validation?.max_items ?? 10;
    // Two native ways in. "Take photo" opens iOS's camera sheet directly (capture), which does not switch to the
    // macro lens, so very close subjects can be blurry on Pro iPhones. "Choose from Photos" lets the user shoot with
    // the Camera app (automatic macro) and attach that photo. Both go through the same compression and storage.
    const add = async (file: File | undefined, fromLibrary: boolean) => {
      if (!file) return;
      try {
        const c = await compressPhoto(file);
        const att = await saveAttachment(draft.id, f.id, "photo", c.blob, { width: c.width, height: c.height });
        const shot = fromLibrary && file.lastModified && file.lastModified <= Date.now() ? new Date(file.lastModified).toISOString() : nowIso();
        await set(f.id, [...items, fromLibrary ? { attachment_id: att.id, taken_at: shot, source: "photo_library" } : { attachment_id: att.id, taken_at: nowIso() }]);
      } catch (err) { toast(`Could not read photo: ${(err as Error).message}`, "error"); }
    };
    const cameraIn = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none", "data-source": "camera",
      onchange: (e: Event) => add((e.target as HTMLInputElement).files?.[0], false) }) as HTMLInputElement;
    const libraryIn = h("input", { type: "file", accept: "image/*", style: "display:none", "data-source": "library",
      onchange: (e: Event) => add((e.target as HTMLInputElement).files?.[0], true) }) as HTMLInputElement;
    return h("div", null, thumbs, items.length < max ? h("div", null, h("div", { class: "row" },
      h("button", { onclick: () => cameraIn.click() }, icon("camera"), "Take photo"), h("button", { onclick: () => libraryIn.click() }, icon("photos"), "Choose from Photos"),
      cameraIn, libraryIn),
      h("div", { class: "muted" }, "For close-ups, take the photo with the Camera app (it switches to macro), then choose it here."))
      : h("div", { class: "muted" }, `Maximum ${max} photos.`));
  };

  const audioInput = (f: Field) => {
    const items = mediaItems(f);
    const list = h("div");
    for (const it of items) {
      void getAttachment(it.attachment_id).then((a) => {
        if (!a) return;
        list.append(h("div", { class: "card" }, mediaPreview(a, "audio"),
          h("div", { class: "muted" }, `${a.meta?.duration_s ?? "?"} s · ${fmtBytes(a.size)}`),
          it.transcript !== undefined ? h("div", null, h("label", { class: "q" }, "Transcript (you can correct it)"),
            h("textarea", { "data-transcript": a.id, oninput: async (e: Event) => { it.transcript = (e.target as HTMLTextAreaElement).value; await set(f.id, items, false); } }, it.transcript)) : null,
          h("button", { class: "danger", onclick: async () => { await d.delete("attachments", a.id); await set(f.id, items.filter((x) => x.attachment_id !== a.id)); } }, "Remove")));
      });
    }
    const rec = new VoiceRecorder();
    let on = false;
    const btn = h("button", { onclick: async () => {
      if (!on) {
        try { await rec.start(); on = true; btn.replaceChildren(icon("stop"), "Stop recording"); } catch (e) { toast(`Microphone unavailable: ${(e as Error).message}`, "error"); }
        return;
      }
      on = false;
      const { blob, duration_s } = await rec.stop();
      const att = await saveAttachment(draft.id, f.id, "audio", blob, { duration_s });
      await set(f.id, [...items, { attachment_id: att.id, recorded_at: nowIso() }]);
    } }, icon("mic"), "Record voice note");
    return h("div", null, list, btn);
  };

  const gpsInput = (f: Field) => {
    const v = draft.answers[f.id] as any;
    const status = h("div", { class: "muted" }, v ? `${v.lat}, ${v.lon} · ±${v.accuracy ?? "?"} m · ${v.source}` : "No location captured");
    const lat = h("input", { placeholder: "Latitude", inputmode: "decimal", value: v?.lat ?? "" }) as HTMLInputElement;
    const lon = h("input", { placeholder: "Longitude", inputmode: "decimal", value: v?.lon ?? "" }) as HTMLInputElement;
    return h("div", null, status, h("div", { class: "row" },
      h("button", { onclick: async () => {
        status.textContent = "Locating…";
        try { await set(f.id, await captureGps()); } catch (e) { status.textContent = (e as Error).message; }
      } }, icon("pin"), "Capture location")),
      h("details", null, h("summary", { class: "muted" }, "Enter manually"), h("div", { class: "row" }, lat, lon,
        h("button", { onclick: () => set(f.id, { lat: Number(lat.value), lon: Number(lon.value), accuracy: null, timestamp: nowIso(), source: "manual" }) }, "Save"))));
  };

  const signatureInput = (f: Field) => {
    const v = draft.answers[f.id] as any;
    if (v?.attachment_id) {
      const img = h("div");
      void getAttachment(v.attachment_id).then((a) => { if (a) img.append(mediaPreview(a, "signature")); else img.append(mediaProblem("signature", "The signature file is missing on this device. Sign again.")); });
      return h("div", null, img, v.signed_at ? h("div", { class: "muted" }, `Signed ${fmtTime(v.signed_at)}`) : null, h("button", { onclick: async () => { await d.delete("attachments", v.attachment_id); await set(f.id, undefined); } }, "Sign again"));
    }
    const c = h("canvas", { class: "sig", width: 600, height: 200 }) as HTMLCanvasElement;
    const pad = signaturePad(c);
    return h("div", null, c, h("div", { class: "row" }, h("button", { onclick: () => pad.clear() }, "Clear"),
      h("button", { onclick: async () => {
        if (pad.isEmpty()) return toast("Please sign first.", "error");
        const att = await saveAttachment(draft.id, f.id, "signature", await pad.toBlob());
        await set(f.id, { attachment_id: att.id, signed_at: nowIso() });
      } }, "Save signature")));
  };

  const finish = async () => {
    showErrors = true;
    const st = computeState(wf, draft.answers, l);
    if (!st.complete) {
      // Stays on screen (not a 4-second toast): the inspection is NOT saved as a record and will NOT sync.
      clear(notice);
      const bad = wf.fields.filter((f) => st.errors[f.id]).map((f) => text(f.label, l));
      notice.append(h("div", { class: "banner bad", role: "alert" }, h("strong", null, "Not submitted yet"),
        h("div", null, `This entry is still a draft and has not been saved for upload. Fix ${bad.length} answer(s): ${bad.join(", ")}.`)));
      render();
      const first = Object.keys(st.errors)[0];
      document.getElementById(`f-${first}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    clear(notice);
    let rec;
    try {
      rec = await completeDraft(draft, wf);
    } catch (e) {
      notice.append(h("div", { class: "banner bad", role: "alert" }, h("strong", null, "Could not save this entry"),
        h("div", null, `${(e as Error).message}. Your answers are still in the draft — nothing was lost.`)));
      render();
      return;
    }
    toast("Saved on this device.", "ok");   // the Results banner says the sync state; don't repeat it
    void runSync();
    go(`#/results/${rec.id}`);
  };

  main.append(h("div", { class: "card" }, h("h2", null, text(wf.title, l)), h("div", { class: "muted" }, text(wf.description, l)),
    h("div", { class: "muted" }, "Everything you enter is saved on this device as you go — no connection needed.")), form);
  render();
};

// ------------------------------------------------------------------ results
export const resultsView: View = async (main, p) => {
  const d = await db();
  const rec = await d.get("records", p.id);
  if (!rec) {
    // Removed from this device (or made elsewhere): it may still be in the account on Hermes.
    main.append(h("div", { class: "banner warn" }, h("strong", null, "This record isn't stored on this device"),
      h("div", null, "If it's in your Hermes account, you can open it from there."),
      h("div", { class: "row" }, h("a", { class: "btn primary", href: `#/remote/${p.id}` }, "Open from Hermes"),
        h("a", { class: "btn", href: "#/records" }, "Saved Records"))));
    return;
  }
  const wf = definitionFor(await d.get("workflows", rec.workflow_id), rec.workflow_version);
  const stored = await d.get("reports", rec.id);
  const atts = await d.getAllFromIndex("attachments", "by_record", rec.id);
  const l = rec.lang;
  const lr = rec.local_results;
  const synced = rec.sync_status === "synced" || rec.sync_status === "received";

  main.append(h("div", { class: "card" }, h("h2", null, rec.workflow_title),
    h("dl", { class: "kv" }, h("dt", null, "Completed"), h("dd", null, fmtTime(rec.completed_at)),
      h("dt", null, "Questions answered"), h("dd", null, `${lr.questions_answered} of ${lr.questions_visible}`),
      h("dt", null, "Validation"), h("dd", null, lr.validation.complete ? "All required answers valid" : "Incomplete")),
    h("details", null, h("summary", { class: "muted" }, "Technical details"),
      h("dl", { class: "kv" }, h("dt", null, "Record ID"), h("dd", null, rec.id), h("dt", null, "Workflow version"), h("dd", null, String(rec.workflow_version)),
        h("dt", null, "Hermes revision"), h("dd", null, String(rec.server_ack?.revision ?? rec.server_revision ?? 0))))));

  // Sync + analysis status: never conflate the two.
  if (!synced) {
    main.append(h("div", { class: `banner ${rec.sync_status === "conflict" || rec.sync_status === "error" ? "bad" : "local"}` },
      h("strong", null, rec.sync_status === "conflict" ? "Conflict — needs your decision" : rec.sync_status === "error" ? "Hermes didn't accept this record" : "Saved locally. Pending synchronization."),
      h("div", { class: "muted" }, rec.sync_status === "error" ? `${rec.sync_error ?? ""} It's safe on this device.` : "Hermes has not confirmed this entry yet. It is safe on this device."),
      rec.sync_status === "error" ? retryButton(rec.id, `#/results/${rec.id}`) : null,
      rec.sync_status === "pending" || rec.sync_status === "syncing" ? h("div", { class: "muted" }, (() => {
        const st = getSyncState();
        return !isOnline() ? "Device is offline — it will upload automatically when FieldKit is open and connected."
          : st.reachable === false ? "Network is up but Hermes is not reachable yet — will retry automatically."
            : "Uploading when Hermes confirms…";
      })()) : null,
      rec.sync_status === "conflict" ? h("a", { class: "btn", href: "#/sync" }, "Resolve") : null));
  } else {
    main.append(h("div", { class: "banner hermes" },
      h("strong", null, rec.sync_status === "synced" ? "Saved to Hermes — confirmed" : "Received by Hermes — files still uploading"),
      h("div", { class: "muted" }, `Confirmed by Hermes ${fmtTime(rec.server_ack?.received_at)}`),
      h("div", { class: "muted" }, "Ask your Hermes agent about this entry in chat: it can read the answers, photos and voice notes.")));
  }

  // Saved responses + media
  const resp = h("div", { class: "card" }, h("h2", null, "Saved responses"));
  const dl = h("dl", { class: "kv" });
  for (const f of wf?.fields ?? []) {
    if (f.type === "instruction" || !(f.id in rec.answers)) continue;
    const v = rec.answers[f.id] as any;
    let shown: string;
    if (["single_choice"].includes(f.type)) shown = text(f.options?.find((o) => o.value === v)?.label, l) || String(v);
    else if (f.type === "multi_choice") shown = (v as any[]).map((x) => text(f.options?.find((o) => o.value === x)?.label, l) || String(x)).join(", ");
    else if (f.type === "checkbox") shown = v ? "Yes" : "No";
    else if (f.type === "gps") shown = `${v.lat}, ${v.lon} (±${v.accuracy ?? "?"} m, ${v.source})`;
    else if (["photo", "audio"].includes(f.type)) {
      const list = (Array.isArray(v) ? v : [v]).filter(Boolean);
      shown = mediaSummary({ [f.type]: list.length }) + list.map((x: any) => x.ocr_text ? `\nText in photo: ${x.ocr_text}` : x.transcript ? `\nTranscript: ${x.transcript}` : "").join("");
    }
    else if (f.type === "signature") shown = v?.signed_at ? `Signed ${fmtTime(v.signed_at)}` : "Signed";
    else shown = `${v}${f.unit ? ` ${f.unit}` : ""}`;
    dl.append(h("dt", null, text(f.label, l)), h("dd", { style: "white-space:pre-wrap" }, shown));
  }
  resp.append(dl);
  // Only files the record's answers actually reference (a removed photo's leftovers are not "attachments").
  const referenced = new Set<string>();
  const fieldOf = new Map<string, Field>();
  for (const f of wf?.fields ?? []) {
    if (!["photo", "audio", "signature"].includes(f.type)) continue;
    for (const x of [rec.answers[f.id]].flat() as any[]) if (x?.attachment_id) { referenced.add(x.attachment_id); fieldOf.set(x.attachment_id, f); }
  }
  const shownAtts = atts.filter((a) => referenced.has(a.id) || !wf);
  if (shownAtts.length) {
    const kindOf = (a: Attachment): MediaKind => (fieldOf.get(a.id)?.type as MediaKind) ?? (a.kind as MediaKind);
    const counts: Partial<Record<MediaKind, number>> = {};
    for (const a of shownAtts) counts[kindOf(a)] = (counts[kindOf(a)] ?? 0) + 1;
    const media = h("div", { class: "thumbs", style: "margin-top:.6rem", id: "result-media" });
    for (const a of shownAtts) {
      const f = fieldOf.get(a.id);
      media.append(h("figure", { class: "media-item" }, mediaPreview(a, kindOf(a)),
        h("figcaption", { class: "muted" }, `${f ? text(f.label, l) : KIND_NOUN[kindOf(a)][0]}${a.uploaded ? " · on Hermes" : " · not uploaded yet"}`)));
    }
    const up = shownAtts.filter((a) => a.uploaded).length;
    resp.append(h("h3", null, mediaSummary(counts)), media,
      h("div", { class: "muted", id: "media-upload-status", "data-uploaded": String(up), "data-total": String(shownAtts.length) },
        up === shownAtts.length ? `All ${shownAtts.length} file(s) uploaded to Hermes and kept on this device.` : `${up} of ${shownAtts.length} file(s) uploaded to Hermes so far. All are kept on this device.`));
  }
  const known = new Set((wf?.fields ?? []).map((f) => f.id));
  const extra = Object.entries(rec.answers).filter(([k, v]) => !known.has(k) && v !== undefined && v !== null && v !== "" && typeof v !== "object");
  if (extra.length) {
    resp.append(h("h3", null, "Answers to questions no longer in the form"),
      h("dl", { class: "kv", id: "removed-answers" }, ...extra.flatMap(([k, v]) => [h("dt", null, k.replace(/_/g, " ")), h("dd", null, String(v))])));
  }
  main.append(resp);

  // Made by FieldKit before 0.3 — shown only if this entry has one.
  const earlier = await earlierSection(rec, stored);
  if (earlier) main.append(earlier);
};

/** What FieldKit produced for this entry before 0.3 (rule findings, questions answered by Hermes, a report). Read-only;
 *  new entries never get these: ask your Hermes agent instead. */
async function earlierSection(rec: LocalRecord, stored: StoredReport | undefined): Promise<HTMLElement | null> {
  const d = await db();
  const findings = rec.local_results?.findings ?? [];
  const questions = (await d.getAllFromIndex("questions", "by_record", rec.id)).filter((q) => q.answer);
  if (!findings.length && !questions.length && !stored && !rec.report_id) return null;
  const box = h("div", { class: "card", id: "earlier-results" }, h("h2", null, "From an earlier FieldKit version"),
    h("p", { class: "muted" }, "Kept for reference. FieldKit no longer analyses entries; ask your Hermes agent instead."));
  if (findings.length) box.append(h("h3", null, "Rule findings on the phone"), h("ul", { class: "clean" }, ...findings.map((f) =>
    h("li", null, sevBadge(f.severity), " ", h("strong", null, f.label), f.detail ? h("div", { class: "muted" }, f.detail) : null))));
  for (const q of questions) box.append(h("div", { class: "banner local", "data-question": q.id }, h("strong", null, q.question),
    h("p", { style: "white-space:pre-wrap" }, q.answer!.answer)));
  if (stored) {
    box.append(h("h3", null, "Hermes report"), h("p", { class: "muted" }, `Version ${stored.report.version} · downloaded ${fmtTime(stored.downloaded_at)}`));
    reportBody(box, stored.report, rec.lang);
  } else if (rec.report_id) {
    box.append(h("button", { onclick: async () => {
      try { await downloadEarlierReport(rec.id); go(`#/results/${rec.id}?r=${Date.now()}`); }
      catch (e) { toast(e instanceof AuthRequired ? "Sign in to Hermes first." : `Offline or unavailable: ${(e as Error).message}`, "error"); }
    } }, "Download the earlier report"));
  }
  return box;
}

const INTEGRITY_TEXT: Record<string, string> = {
  intact: "intact (SHA-256 verified on Hermes)", mismatch: "DOES NOT MATCH the captured file", missing: "missing on Hermes",
  not_uploaded: "not uploaded yet",
};

/** Report section listing the record's files as evidence: voice-note transcripts and signatures with integrity. */
function evidenceSection(att: any): HTMLElement {
  const sec = h("div", { class: "evidence", id: "report-evidence" }, h("h3", null, "Evidence"), h("p", { class: "muted", "data-summary": att.summary }, att.summary));
  const vn = att.voice_notes;
  if (vn?.attached) {
    sec.append(h("div", { class: `banner ${vn.transcribed === vn.attached ? "hermes" : "warn"}`, "data-voice-transcribed": `${vn.transcribed}/${vn.attached}` },
      h("strong", null, vn.transcribed === vn.attached ? `Voice notes considered (${vn.transcribed} of ${vn.attached} transcribed)` : `${vn.attached - vn.transcribed} voice note(s) not transcribed`),
      ...att.evidence.filter((e: any) => e.kind === "audio").map((e: any) => h("div", null,
        e.transcript ? `“${e.transcript}” — ${e.transcript_source === "device" ? "transcribed on the phone" : "transcribed by Hermes"}`
          : `Not transcribed: ${e.transcript_error ?? "unknown reason"}`))));
  }
  for (const e of att.evidence.filter((x: any) => x.kind === "signature")) {
    sec.append(h("div", { class: `banner ${e.integrity === "intact" ? "hermes" : "warn"}`, "data-signature": e.attachment_id, "data-integrity": e.integrity },
      h("strong", null, `${e.field_label || "Signature"}${e.signed_at ? ` — signed ${fmtTime(e.signed_at)}` : ""}`),
      h("div", null, `File ${INTEGRITY_TEXT[e.integrity] ?? e.integrity}`),
      e.stored ? hermesMedia({ id: e.attachment_id, mime: e.mime, sha256: e.sha256 }, "signature") : null));
  }
  const bad = att.evidence.filter((e: any) => e.kind !== "signature" && e.integrity !== "intact" && e.integrity !== "not_uploaded");
  if (bad.length) sec.append(h("div", { class: "banner bad" }, `${bad.length} file(s) on Hermes failed the integrity check.`));
  return sec;
}

/** Body of a Hermes report — shared by this device's records and records from other devices. Report v2 (0.2.5) leads
 *  with the decision, then ordered actions (who, by when, how to verify, how to do it offline), interpreted issues with
 *  their evidence, what is uncertain, and the checks for next time. v1 reports keep their original layout. */
export function reportBody(box: HTMLElement, r: any, uiLang = "en"): void {
  const langs = Object.keys(r.translations ?? {});
  const body = h("div", { class: "report-body" });
  const draw = (lg: string) => {
    clear(body);
    const tr = lg !== "en" ? r.translations?.[lg] : null;
    if (r.schema_version >= 2 && r.decision?.outcome) reportV2(body, r, tr, lg);
    else reportV1(body, r);
  };
  if (langs.length) {
    const opts = ["en", ...langs.filter((x) => x !== "en")];
    box.append(h("div", { class: "row lang-switch", role: "group", "aria-label": "Report language" },
      ...opts.map((lg) => h("button", { "data-lang": lg, onclick: () => draw(lg) }, languageName(lg)))));
  }
  box.append(body);
  draw(langs.includes(uiLang) ? uiLang : "en");
}

function languageName(code: string): string {
  return ({ en: "English", hi: "हिंदी" } as Record<string, string>)[code] ?? code;
}

const ORIGIN_TEXT: Record<string, string> = { guide: "From your workspace guide", knowledge: "From your workspace knowledge", ai_suggestion: "AI suggestion" };

function reportV2(box: HTMLElement, r: any, tr: any, lg: string): void {
  const scale = new Map<string, any>((r.decision_scale ?? []).map((d: any) => [d.id, d]));
  const dec = r.decision;
  const step = scale.get(dec.outcome);
  const sev = step?.severity ?? "info";
  const label = typeof step?.label === "object" ? text(step.label, lg) : step?.label || dec.outcome;
  const when = typeof dec.deadline_days === "number" ? (dec.deadline_days <= 0 ? "Now" : `Within ${dec.deadline_days} day(s)`) : "";
  box.append(h("div", { class: `banner decision sev-${sev}`, id: "report-decision", "data-outcome": dec.outcome, "data-confidence": dec.confidence },
    h("div", { class: "muted" }, "Decision"), h("strong", { class: "decision-label" }, label),
    h("div", null, tr?.rationale || dec.rationale),
    h("div", { class: "muted" }, [`Confidence: ${dec.confidence}`, when, dec.escalate_to ? `Escalate to: ${dec.escalate_to}` : ""].filter(Boolean).join(" · "))));
  if (r.requires_review) box.append(h("div", { class: "banner warn" }, h("strong", null, "Needs human review"),
    h("div", null, (r.review_triggers ?? []).join("; ") || r.review_reason || "")));
  box.append(h("p", null, tr?.summary || r.summary));
  const acts = r.next_actions ?? [];
  if (acts.length) {
    box.append(h("h3", null, "What to do next"), h("ol", { class: "actions", id: "report-actions" }, ...acts.map((a: any, i: number) =>
      h("li", { "data-origin": a.origin }, h("strong", null, tr?.next_actions?.[i] || a.action),
        h("div", { class: "muted" }, [a.who, typeof a.by_when_days === "number" ? (a.by_when_days <= 0 ? "now" : `within ${a.by_when_days} day(s)`) : ""].filter(Boolean).join(" · ")),
        a.verify_by ? h("div", null, `Check it worked: ${a.verify_by}`) : null,
        h("div", { class: "row" }, h("span", { class: `badge origin-${a.origin}` }, ORIGIN_TEXT[a.origin] ?? a.origin))))));
  }
  if (r.issues?.length) box.append(h("h3", null, "Why"), h("ul", { class: "clean", id: "report-issues" }, ...r.issues.map((i: any, k: number) =>
    h("li", null, sevBadge(i.severity), " ", h("strong", null, tr?.issues?.[k] || i.title),
      i.interpretation ? h("div", null, i.interpretation) : null,
      (i.evidence_refs ?? []).length ? h("div", { class: "muted evidence-refs" }, "Evidence: ", (i.evidence_refs as any[]).map((e) => `${e.kind.replace(/_/g, " ")} ${e.ref}${e.quote ? ` (“${e.quote}”)` : ""}`).join("; ")) : h("div", { class: "muted" }, i.evidence)))));
  if (r.uncertainty?.length) box.append(h("h3", null, "Not certain"), h("ul", { id: "report-uncertainty" }, ...r.uncertainty.map((u: any) =>
    h("li", null, h("strong", null, u.unknown), u.impact ? ` — ${u.impact}` : "", h("div", { class: "muted" }, `To find out: ${u.how_to_resolve}`)))));
  if (r.differences_from_local_findings?.length) box.append(h("h3", null, "Compared with the phone's own findings"),
    h("ul", null, ...r.differences_from_local_findings.map((x: any) => h("li", null, `Phone: ${x.local} → Hermes: ${x.hermes}`, h("div", { class: "muted" }, x.why)))));
  if (r.follow_up_verification?.length) box.append(h("h3", null, "Checks for next time"),
    h("ul", { id: "report-checks" }, ...r.follow_up_verification.map((c: any) => h("li", null, c.what, h("div", { class: "muted" }, `${c.how}${typeof c.due_in_days === "number" ? ` · within ${c.due_in_days} day(s)` : ""}`)))),
);
  if (r.images?.note) box.append(h("div", { class: `banner ${r.images.analyzed === false ? "warn" : "hermes"}` },
    h("strong", null, r.images.analyzed === false ? "Photos not analysed" : "Photos analysed"), h("div", null, r.images.note)));
  if (r.attachments?.evidence?.length) box.append(evidenceSection(r.attachments));
  if (r.missing_information?.length) box.append(h("h3", null, "Missing information"), h("ul", null, ...r.missing_information.map((m: string) => h("li", null, m))));
  if (r.quality?.problems?.length) box.append(h("div", { class: "banner warn" }, h("strong", null, "This report did not pass every quality check"),
    h("ul", null, ...r.quality.problems.map((q: string) => h("li", null, q)))));
  if (r.references?.length) box.append(h("h3", null, "Supporting references"), h("ul", null, ...r.references.map((x: any) => h("li", null, `${x.title}${x.source ? ` — ${x.source}` : ""}`))));
}

function reportV1(box: HTMLElement, r: any): void {
  if (r.requires_review) box.append(h("div", { class: "banner warn" }, h("strong", null, "Requires human review"), r.review_reason ? h("div", null, r.review_reason) : null));
  box.append(h("p", null, r.summary));
  if (r.images?.note) {
    box.append(h("div", { class: `banner ${r.images.analyzed === false ? "warn" : "hermes"}` },
      h("strong", null, r.images.analyzed === false ? "Photos not analysed" : "Photos analysed"), h("div", null, r.images.note)));
  }
  if (r.attachments?.evidence?.length) box.append(evidenceSection(r.attachments));
  if (r.issues?.length) box.append(h("h3", null, "Issues identified"), h("ul", { class: "clean" }, ...r.issues.map((i: any) => h("li", null, sevBadge(i.severity), " ", h("strong", null, i.title), h("div", { class: "muted" }, i.evidence)))));
  if (r.missing_information?.length) box.append(h("h3", null, "Missing information"), h("ul", null, ...r.missing_information.map((m: string) => h("li", null, m))));
  if (r.suggested_actions?.length) box.append(h("h3", null, "Suggested actions"), h("ul", { class: "clean" }, ...r.suggested_actions.map((a: any) => h("li", null, h("span", { class: "badge" }, a.priority), " ", a.action))));
  if (r.references?.length) box.append(h("h3", null, "Supporting references"), h("ul", null, ...r.references.map((x: any) => h("li", null, `${x.title}${x.source ? ` — ${x.source}` : ""}`))));
}

// ------------------------------------------------------------------ records / sync / reports
const AVAIL_TEXT: Record<Availability, string> = {
  "on-device": "Available offline", waiting: "Available offline", "kept-offline": "Available offline", "needs-internet": "Needs internet",
};

/** Last list of the account's records seen on Hermes, so offline the list still shows what exists (tied to the account). */
interface ServerIndex { user_id: string; at: string; records: ServerLike[]; devices: [string, string][] }

async function currentAccountId(): Promise<string> {
  return (await getSetting<{ user_id?: string } | null>("last_account", null))?.user_id ?? "";
}

/** Turn a failed request into an honest message; on a 404, ask Hermes which FieldKit server version it runs. */
async function problemFor(e: unknown): Promise<LoadProblem> {
  let serverVersion = "";
  if (e instanceof HttpError && e.status === 404) {
    try { serverVersion = String((await api<{ version?: string }>("status")).version ?? ""); } catch { /* keep generic message */ }
  }
  return describeLoadProblem(e, isOnline(), serverVersion, APP_VERSION);
}

/** Offline copies that belong to the signed-in (or last signed-in) Hermes account only. */
async function accountCopies(account?: string): Promise<RemoteCopy[]> {
  const who = account ?? await currentAccountId();
  return (await (await db()).getAll("remote")).filter((c) => !!who && c.owner === who);
}

/** Fetch a record (plus its report, if any) from Hermes in the shape kept in the separate `remote` store. */
async function fetchRemoteCopy(id: string, names?: Map<string, string>, owner?: string): Promise<RemoteCopy> {
  const d = await db();
  const rec = await api<any>(`records/${encodeURIComponent(id)}`);
  let report: any = null;
  try { report = await api<any>(`records/${encodeURIComponent(id)}/report`); }
  catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; }
  if (!names) names = await api<{ devices: any[] }>("devices").then((r) => new Map(r.devices.map((x: any) => [x.id, x.label] as [string, string])), () => new Map<string, string>());   // names are optional
  const wfDef = (await d.get("workflows", rec.workflow_id))?.definition;
  return { id: rec.id, workflow_id: rec.workflow_id, workflow_title: wfDef ? text(wfDef.title, await lang()) : (rec.workflow_title ?? rec.workflow_id),
    workflow_version: rec.workflow_version, device_id: rec.device_id ?? "",
    device_label: names.get(rec.device_id) || (rec.device_id === await deviceId() ? "This device" : "Another device"),
    completed_at: rec.completed_at, received_at: rec.received_at, revision: rec.revision, analysis_status: rec.analysis_status,
    answers: rec.answers, local_results: rec.local_results, report, report_id: rec.report_id ?? null, downloaded_at: nowIso(),
    attachments: (rec.attachments ?? []).map((a: any) => ({ id: a.id, field_id: a.field_id, kind: a.kind, mime: a.mime, size: a.size, sha256: a.sha256, status: a.status })),
    owner: owner || await currentAccountId() };
}

export const recordsView: View = async (main) => {
  const d = await db();
  const local = await d.getAll("records");
  const me = await deviceId();
  let account = await currentAccountId();
  let index = await getSetting<ServerIndex | null>("server_index", null);
  if (index && account && index.user_id !== account) index = null;     // never show another account's list
  let live = false;
  let problem: LoadProblem | null = null;      // the account's list could not be loaded
  let partial: LoadProblem | null = null;      // the list loaded, but device names didn't
  // Only the record list is required. Device names and the identity check are optional extras: their failure
  // must never hide records that did load (v0.2.0 bug: a 404 on `devices` emptied the list and said "Offline").
  const [recRes, devRes, whoRes] = await Promise.allSettled([api<{ records: ServerLike[] }>("records?limit=500"),
    api<{ devices: any[] }>("devices"), api<{ user_id: string }>("me")]);
  if (recRes.status === "fulfilled") {
    live = true;
    const who = whoRes.status === "fulfilled" ? whoRes.value.user_id : "";
    if (who) account = who;
    const sameAccount = !!index && index.user_id === account;
    const devices: [string, string][] = devRes.status === "fulfilled"
      ? devRes.value.devices.map((x: any) => [x.id, x.label]) : sameAccount ? index!.devices : [];
    if (devRes.status === "rejected") partial = await problemFor(devRes.reason);
    const titles = new Map((await d.getAll("workflows")).map((w) => [w.id, w.definition.title]));
    const l = await lang();
    const records = recRes.value.records.map((r) => ({ ...r,
      workflow_title: r.workflow_title ?? (titles.has(r.workflow_id) ? text(titles.get(r.workflow_id), l) : r.workflow_id) }));
    index = { user_id: account, at: nowIso(), records, devices };
    // Remember the list for offline use only when we know whose list it is.
    if (who) await setSetting("server_index", index);
  } else {
    problem = await problemFor(recRes.reason);
  }
  const copies = await accountCopies(account);
  const names = new Map(index?.devices ?? []);
  const list = unifiedRecords(local, index?.records ?? [], copies, names, me);
  const localById = new Map(local.map((r) => [r.id, r]));
  const serverIds = new Set(recRes.status === "fulfilled" ? recRes.value.records.map((r) => r.id) : []);
  const onlineOnly = list.filter((r) => r.availability === "needs-internet");

  const card = h("div", { class: "card", id: "saved-records" },
    h("p", { class: "muted" }, "Every record in your Hermes account, from all your devices. Records marked “Available offline” open without internet."));
  if (problem) {
    card.append(h("div", { class: `banner ${problem.kind === "offline" ? "local" : "warn"}`, id: "records-note", "data-problem": problem.kind },
      h("strong", null, problem.kind === "offline" ? "Offline" : "Couldn't load your account's records"),
      h("div", null, problem.message),
      h("div", { class: "muted" }, index ? `Showing records on this device and the list from Hermes as of ${fmtTime(index.at)}.`
        : "Showing only records stored on this device."),
      h("div", { class: "row" },
        problem.kind === "signed-out" ? h("button", { class: "primary", onclick: () => signIn("#/records") }, "Sign in") : null,
        problem.kind !== "offline" ? h("button", { onclick: () => go(`#/records?r=${Date.now()}`) }, "Try again") : null)));
  } else {
    card.append(h("p", { class: "muted", id: "records-fresh" }, `Up to date with Hermes · ${fmtTime(index!.at)}`));
    if (partial) card.append(h("div", { class: "banner warn", id: "records-partial", "data-problem": partial.kind },
      h("strong", null, "Device names unavailable"), h("div", null, partial.message)));
    // Records Hermes confirmed earlier but no longer has for this account: its FieldKit data was reset, or the
    // host answered from another machine with its own data. They are still on this device; offer to upload again.
    const serverRecs = recRes.status === "fulfilled" ? recRes.value.records : [];
    const missing = missingOnServer(local, serverRecs.map((r) => r.id), serverRecs.length < 500);
    if (missing.length) {
      const st = await api<{ store?: { store_id?: string; records_for_you?: number }; instance?: { machine?: string } }>("status").catch(() => null);
      const where = st?.store?.store_id ? ` (Hermes data store ${st.store.store_id}${st.instance?.machine ? ` on ${st.instance.machine}` : ""})` : "";
      card.append(h("div", { class: "banner warn", id: "records-missing", "data-missing": String(missing.length) },
        h("strong", null, `Hermes doesn't have ${missing.length} record(s) from this device`),
        h("div", null, `Hermes confirmed receiving them earlier, but your account's records on Hermes${where} don't include them now. ` +
          "This happens when Hermes' FieldKit data was reset or moved, or when the server answers from a different machine. " +
          "They are safe on this device."),
        h("div", { class: "row" }, h("button", { class: "primary", id: "resend-missing", onclick: async (ev: Event) => {
          const btn = ev.currentTarget as HTMLButtonElement;   // currentTarget is null after the first await
          const who = (await getSetting<{ display_name?: string; user_id?: string } | null>("last_account", null));
          const name = who?.display_name || who?.user_id || account;
          if (!confirm(`Upload ${missing.length} record(s) from this device to Hermes account “${name}”?`)) return;
          btn.disabled = true;
          try {
            const n = await resendRecords(missing.map((r) => r.id));
            toast(`${n} record(s) queued for upload. They'll appear on your other devices once Hermes confirms them.`, "ok");
          } catch (e) {
            toast(e instanceof AuthRequired ? "Sign in to Hermes first." : `Couldn't upload now: ${(await problemFor(e)).message}`, "error");
          }
          go(`#/records?r=${Date.now()}`);
        } }, `Upload ${missing.length} again`))));
    }
  }
  if (live && onlineOnly.length) {
    card.append(h("div", { class: "row" }, h("button", { id: "download-all", onclick: async (ev: Event) => {
      const btn = ev.currentTarget as HTMLButtonElement; btn.disabled = true;
      let ok = 0; let failed = 0;
      for (const r of onlineOnly) {
        btn.textContent = `Downloading ${ok + failed + 1} of ${onlineOnly.length}…`;
        try { await d.put("remote", await fetchRemoteCopy(r.id, names, account)); ok++; } catch { failed++; }
      }
      toast(failed ? `${ok} downloaded, ${failed} failed. Try again.` : `${ok} record(s) now available offline.`, failed ? "error" : "ok");
      go(`#/records?r=${Date.now()}`);
    } }, `Download all for offline (${onlineOnly.length})`)));
  }
  card.append(list.length ? h("ul", { class: "clean", id: "records-list" }, ...list.map((r) => {
    const offline = r.availability !== "needs-internet";
    const openable = offline || live;
    const rec = localById.get(r.id);
    return h("li", { "data-record-id": r.id, "data-availability": r.availability },
      openable ? h("a", { href: r.href }, h("strong", null, r.title)) : h("strong", null, r.title), " ",
      h("span", { class: `badge ${offline ? "avail-offline" : "avail-online"}` }, AVAIL_TEXT[r.availability]),
      r.availability === "waiting" ? h("span", null, " ", h("span", { class: "badge avail-waiting" },
        r.syncNote === "error" ? "Not accepted — open to retry" : r.syncNote === "conflict" ? "Conflict — needs your decision" : "Waiting to sync")) : null,
      h("div", { class: "muted" }, [r.source === "This device" ? "This device" : `From ${r.source}`, fmtTime(r.when),
        r.syncNote ? STATUS_TEXT[r.syncNote] : null, r.hasReport ? "earlier report available" : null]
        .filter(Boolean).join(" · ")),
      h("div", { class: "row" },
        r.availability === "needs-internet" && live ? h("button", { onclick: async (ev: Event) => {
          (ev.currentTarget as HTMLButtonElement).disabled = true;
          try { await d.put("remote", await fetchRemoteCopy(r.id, names, account)); toast("Available offline.", "ok"); }
          catch (e) { toast(e instanceof AuthRequired ? "Sign in to Hermes first." : `Couldn't download: ${(e as Error).message}`, "error"); }
          go(`#/records?r=${Date.now()}`);
        } }, "Make available offline") : null,
        r.availability === "kept-offline" ? h("button", { onclick: async () => {
          await d.delete("remote", r.id); toast("Removed from this device. It's still in your Hermes account.", "ok"); go(`#/records?r=${Date.now()}`);
        } }, "Remove offline copy") : null,
        // Only when the list just loaded from Hermes includes it: a record Hermes no longer has must never be removed.
        rec?.sync_status === "synced" && live && serverIds.has(r.id) ? h("button", { class: "danger", onclick: async () => {
          if (!confirm("Remove this record from this device? It stays in your Hermes account.")) return;
          await deleteRecord(r.id); toast("Removed from this device. It's still in your Hermes account.", "ok"); go(`#/records?r=${Date.now()}`);
        } }, "Remove from device") : null));
  })) : h("p", { class: "muted", id: "records-empty" }, live ? `Hermes has no records for this account yet${account ? ` (Account ID ${account})` : ""}.` : "No records stored on this device. Your account's records will appear here once they can be loaded from Hermes."));
  main.append(card);
  // Quietly refresh offline copies whose record changed on Hermes (e.g. a report arrived after it was downloaded).
  if (live) {
    const byId = new Map((index?.records ?? []).map((r: any) => [r.id, r]));
    for (const c of copies) {
      const s: any = byId.get(c.id);
      if (s && (s.revision !== c.revision || (s.report_id && s.report_id !== c.report_id) || s.analysis_status !== c.analysis_status)) {
        void fetchRemoteCopy(c.id, names, account).then((n) => d.put("remote", n)).catch(() => {});
      }
    }
  }
};

/** Read-only view of a record from another device, with an optional offline copy (separate store). */
export const remoteView: View = async (main, p) => {
  const d = await db();
  const id = p.id;
  const copy = (await accountCopies()).find((c) => c.id === id);
  let live: RemoteCopy | null = null;
  try {
    live = await fetchRemoteCopy(id);
  } catch (e) {
    if (!copy) {
      const pr = await problemFor(e);
      main.append(h("div", { class: "banner warn", id: "remote-problem", "data-problem": pr.kind },
        h("strong", null, "This record isn't available offline on this device"), h("div", null, pr.message),
        h("div", { class: "row" }, pr.kind === "signed-out" ? h("button", { class: "primary", onclick: () => signIn(`#/remote/${id}`) }, "Sign in") : null,
          pr.kind !== "offline" ? h("button", { onclick: () => go(`#/remote/${id}?r=${Date.now()}`) }, "Try again") : null)));
      return;
    }
  }
  const r = live ?? copy!;
  const wf = (await d.get("workflows", r.workflow_id))?.definition;
  const l = await lang();
  main.append(h("div", { class: "card", id: "remote-record" }, h("h2", null, r.workflow_title),
    h("div", { class: "banner local" }, h("strong", null, r.device_label === "This device" ? "Saved earlier on this device" : `From ${r.device_label || "another device"}`),
      h("div", null, "In your Hermes account. Read-only here.")),
    h("dl", { class: "kv" }, h("dt", null, "Completed"), h("dd", null, fmtTime(r.completed_at)),
      h("dt", null, "Received by Hermes"), h("dd", null, fmtTime(r.received_at)),
      h("dt", null, "Availability"), h("dd", { "data-availability": copy ? "kept-offline" : "needs-internet" }, copy ? `Available offline (downloaded ${fmtTime(copy.downloaded_at)})` : "Needs internet"))));
  const dl = h("dl", { class: "kv" });
  const serverAtts = new Map<string, any>((live?.attachments ?? copy?.attachments ?? []).map((a) => [a.id, a]));
  for (const [k, v] of Object.entries(r.answers ?? {})) {
    const f = wf?.fields.find((x) => x.id === k);
    let shown: string | HTMLElement = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (f?.type === "single_choice") shown = text(f.options?.find((o) => o.value === v)?.label, l) || String(shown);
    else if (f?.type === "multi_choice" && Array.isArray(v)) shown = v.map((x) => text(f.options?.find((o) => o.value === x)?.label, l) || String(x)).join(", ");
    else if (f?.type === "checkbox") shown = v ? "Yes" : "No";
    else if (f?.type === "gps" && v && typeof v === "object") shown = `${(v as any).lat}, ${(v as any).lon} (±${(v as any).accuracy ?? "?"} m)`;
    else if ((f && ["photo", "audio", "signature"].includes(f.type)) || ([v].flat() as any[]).some((x) => x?.attachment_id && serverAtts.has(x.attachment_id))) {
      // Media answers; when this phone doesn't have the form, the kind comes from Hermes' attachment details.
      const items = ([v].flat() as any[]).filter((x) => x?.attachment_id);
      const kind = (f?.type ?? serverAtts.get(items[0]?.attachment_id)?.kind ?? "photo") as MediaKind;
      const box = h("div", null, kind === "signature" ? `Signed ${fmtTime((v as any)?.signed_at)}` : mediaSummary({ [kind]: items.length }));
      for (const it of items) {
        const sa = serverAtts.get(it.attachment_id);
        box.append(hermesMedia({ id: it.attachment_id, mime: sa?.mime ?? "", sha256: sa?.sha256, status: sa?.status }, kind));
        if (it.transcript) box.append(h("div", { class: "muted" }, `Transcript: ${it.transcript}`));
        if (it.ocr_text) box.append(h("div", { class: "muted" }, `Text in photo: ${it.ocr_text}`));
      }
      shown = box;
    }
    dl.append(h("dt", null, f ? text(f.label, l) : k), h("dd", null, shown));
  }
  main.append(h("div", { class: "card" }, h("h2", null, "Answers"), dl));
  if (r.report) {
    const rep = h("div", { class: "card", id: "remote-report" }, h("h2", null, "Report from an earlier FieldKit version"));
    reportBody(rep, r.report, l);
    main.append(rep);
  }
  main.append(h("div", { class: "row" },
    live ? h("button", { class: "primary", onclick: async () => {
      await d.put("remote", live!);
      toast(live!.report ? "Available offline, with its report." : "Available offline.", "ok");
      go(`#/remote/${id}?r=${Date.now()}`);
    } }, copy ? "Update offline copy" : "Make available offline") : null,
    copy ? h("button", { onclick: async () => { await d.delete("remote", id); toast("Offline copy removed. The record is still on Hermes.", "ok"); go("#/records"); } }, "Remove offline copy") : null));
};

export const syncView: View = async (main) => {
  const d = await db();
  const recs = await d.getAll("records");
  const wfs = new Map((await d.getAll("workflows")).map((w) => [w.id, w.definition]));
  const ops = await d.getAll("outbox");
  const st = getSyncState();
  const waiting = recs.filter((r) => !["synced", "received"].includes(r.sync_status));
  main.append(h("div", { class: "card" }, h("h2", null, "Status"),
    h("dl", { class: "kv" },
      h("dt", null, "Device network"), h("dd", null, isOnline() ? "Connected (as reported by the browser)" : "Offline"),
      h("dt", null, "Hermes"), h("dd", null, st.reachable === true ? `Reachable — last contact ${fmtTime(st.last_contact)}`
        : st.reachable === false ? "Not reachable (no internet, captive Wi-Fi, or server down)" : "Not checked yet"),
      h("dt", null, "Awaiting confirmation"), h("dd", null, `${st.awaiting} record(s)${st.attention ? ` · ${st.attention} need attention` : ""}`),
      h("dt", null, "Uploads queued (records and files)"), h("dd", null, String(ops.length)),
      h("dt", null, "Last server confirmation"), h("dd", null, fmtTime(st.last_confirmed)),
      h("dt", null, "Last attempt"), h("dd", null, fmtTime(st.last_run)), h("dt", null, "Last success"), h("dd", null, fmtTime(st.last_ok)),
      st.last_error ? h("dt", null, "Last error") : null, st.last_error ? h("dd", null, st.last_error) : null),
    h("div", { class: "row", style: "margin-top:.6rem" },
      h("button", { class: "primary", disabled: st.running, onclick: async () => { await runSync({ force: true }); go(`#/sync?r=${Date.now()}`); } }, st.running ? "Syncing…" : "Sync now"),
      st.auth_required ? h("button", { onclick: () => signIn("#/sync") }, "Sign in again") : null)));
  main.append(h("div", { class: "card" }, h("h2", null, `Waiting (${waiting.length})`),
    waiting.length ? h("ul", { class: "clean" }, ...waiting.map((r) => h("li", null, h("a", { href: `#/results/${r.id}` }, r.workflow_title),
      h("div", { class: "muted" }, `${r.sync_status === "error" ? "Hermes didn't accept it" : STATUS_TEXT[r.sync_status]}${r.sync_error ? ` — ${r.sync_error}` : ""}`),
      r.sync_status === "error" ? retryButton(r.id, "#/sync") : null,
      r.conflict ? conflictBox(r, wfs.get(r.workflow_id)) : null))) : h("p", { class: "muted" }, "Everything on this device has been received by Hermes.")));
};

/** "Try again" for a record Hermes rejected: puts back its workflow version if Hermes lacks it, then re-queues it. */
function retryButton(id: string, back: string): HTMLElement {
  return h("button", { class: "primary", "data-retry": id, onclick: async (ev: Event) => {
    const btn = ev.currentTarget as HTMLButtonElement;   // captured before any await
    btn.disabled = true;
    try {
      const n = await retryRecords([id]);
      toast(n ? "Sending again…" : "Nothing to retry.", n ? "ok" : "info");
    } catch (e) {
      toast(e instanceof AuthRequired ? "Sign in to Hermes first." : `Couldn't send now: ${(await problemFor(e)).message}`, "error");
    }
    go(`${back}${back.includes("?") ? "&" : "?"}r=${Date.now()}`);
  } }, "Try again");
}

function conflictBox(r: LocalRecord, wf?: Workflow) {
  const keys = [...new Set([...Object.keys(r.answers), ...Object.keys(r.conflict!.server_answers)])]
    .filter((k) => JSON.stringify(r.answers[k]) !== JSON.stringify(r.conflict!.server_answers[k]));
  const label = (k: string) => { const f = wf?.fields.find((x) => x.id === k); return f ? text(f.label, r.lang) : k; };
  const show = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return "(empty)";
    const f = wf?.fields.find((x) => x.id === k);
    if (f?.type === "single_choice") return text(f.options?.find((o) => o.value === v)?.label, r.lang) || String(v);
    if (f?.type === "checkbox") return v ? "Yes" : "No";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  return h("div", { class: "banner bad" }, h("strong", null, "This record was changed on another device."),
    h("dl", { class: "kv" }, ...keys.flatMap((k) => [h("dt", null, label(k)),
      h("dd", null, `This device: ${show(k, r.answers[k])} · Hermes: ${show(k, r.conflict!.server_answers[k])}`)])),
    h("div", { class: "row" },
      h("button", { onclick: async () => { await resolveConflict(r.id, "use_client"); go(`#/sync?r=${Date.now()}`); } }, "Keep this device's version"),
      h("button", { onclick: async () => { await resolveConflict(r.id, "keep_server"); go(`#/sync?r=${Date.now()}`); } }, "Use the Hermes version")));
}

export async function whoAmI(): Promise<{ user_id: string; display_name: string; provider?: string } | null> {
  try { return await api("me"); } catch { return null; }
}

export type { Attachment };
