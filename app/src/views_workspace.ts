// Workspace screens: the list (on this phone and available on Hermes) and one workspace (purpose, forms, counts).
import { api, AuthRequired, HttpError } from "./api";
import { signIn } from "./config";
import { db } from "./db";
import { text } from "./engine";
import { installedWorkflows } from "./packs";
import { clear, h, isOnline, toast } from "./util";
import { go, lang, type View } from "./views_core";
import { availableWorkspaces, currentWorkspace, installedWorkspace, installedWorkspaces, installWorkspace, setCurrentWorkspace, summarizeLocal, wsTitle } from "./workspace";

export const workspacesView: View = async (main) => {
  const l = await lang();
  const cur = (await currentWorkspace())?.manifest.workspace_id ?? "";
  const mine = (await installedWorkspaces()).sort((a, b) => Number(b.manifest.workspace_id === cur) - Number(a.manifest.workspace_id === cur));
  const card = h("div", { class: "card", id: "workspaces" },
    h("p", { class: "muted" }, mine.length > 1
      ? "Choose the workspace to work in. Home and the Workspace tab open the one you choose."
      : "A workspace holds the forms you fill in, set up with Hermes for your work and kept offline on this phone."));
  if (mine.length) {
    card.append(h("h3", null, "On this device"), h("ul", { class: "ws-list" }, ...mine.map(({ manifest: m, pack }) => {
      const isCur = m.workspace_id === cur;
      return h("li", { "data-ws": m.workspace_id, "data-current": isCur ? "true" : null },
        h("a", { href: `#/workspace/${m.workspace_id}`, "aria-current": isCur ? "true" : null },
          h("span", { class: "grow" }, h("strong", null, wsTitle(m, l)),
            h("span", { class: "muted" }, `${m.starter ? "Example, " : ""}${(m.workflows ?? []).length} form(s), version ${m.version_of_workspace ?? pack.version}`)),
          isCur ? h("span", { class: "tag on" }, "Current") : h("span", { class: "open-link" }, "Open")));
    })));
  }
  const avail = h("div");
  card.append(avail);
  main.append(card);
  if (!isOnline()) { avail.append(h("p", { class: "muted" }, "Offline: connect to see workspaces available on Hermes.")); return; }
  try {
    const list = (await availableWorkspaces()).filter((w) => !mine.some((x) => x.manifest.workspace_id === w.id));
    if (list.length) {
      // Long lists stay scannable: the first few, then everything on request.
      const SHOW = 8;
      const items = list.map((w) => h("li", null, h("a", { href: `#/workspace/${w.id}` },
        h("span", { class: "grow" }, h("strong", null, w.title), h("span", { class: "muted" }, w.starter ? "Example (synthetic)" : `Version ${w.published_version}`)),
        h("span", { class: "open-link" }, "Download"))));
      items.slice(SHOW).forEach((li) => { li.hidden = true; });
      const ul = h("ul", { class: "ws-list", id: "ws-available" }, ...items);
      const more = list.length > SHOW ? h("button", { class: "small", onclick: () => { items.forEach((li) => { li.hidden = false; }); more!.remove(); } },
        `Show all ${list.length}`) : null;
      avail.append(h("h3", null, "Available on Hermes"), ul, more ?? "");
    }
    else if (!mine.length) avail.append(h("p", { class: "muted" }, "No workspace yet. Ask Hermes: “Set up FieldKit for my work.”"));
  } catch (e) { avail.append(h("p", { class: "muted" }, `Couldn't load workspaces from Hermes: ${(e as Error).message}`)); }
};

export const workspaceView: View = async (main, p) => {
  const l = await lang();
  const wid = p.id;
  const m = await installedWorkspace(wid);
  const status = h("div", { class: "muted", id: "ws-status" });
  const btn = h("button", { class: "primary", id: "ws-download", onclick: async () => {
    btn.disabled = true;
    try {
      const r = await installWorkspace(wid, (st) => { status.textContent = st; });
      status.textContent = r.failed.length ? `Downloaded, but ${r.failed.length} form(s) failed: ${r.failed.join(", ")}. Try again with a better connection.`
        : `Everything is on this device: ${r.workflows.length} form(s).`;
      toast(r.failed.length ? "Some forms didn't download" : "Workspace ready offline", r.failed.length ? "error" : "ok");
      go(`#/workspace/${wid}?r=${Date.now()}`);
    } catch (e) {
      status.textContent = e instanceof HttpError && e.status === 404 ? "This workspace isn't published on Hermes." : `Download failed: ${(e as Error).message}`;
      btn.disabled = false;
    }
  } }, m ? "Update from Hermes" : "Download everything for offline");
  if (!m) {
    // Not downloaded yet: say which workspace this is (from Hermes), or ask to sign in first.
    const heading = h("h2", null, "Workspace");
    const about = h("div");
    const card = h("div", { class: "card", id: "ws-preview" }, heading, about,
      h("p", null, isOnline() ? "Not on this device yet." : "Not on this device yet. Connect to the internet to download it."),
      isOnline() ? btn : null, status);
    main.append(card);
    if (isOnline()) {
      try {
        const info = await api<any>(`workspaces/${encodeURIComponent(wid)}`);
        heading.textContent = text(info.title, l) || "Workspace";
        if (info.profile?.purpose) about.append(h("p", { class: "muted" }, String(info.profile.purpose)));
      } catch (e) {
        if (e instanceof AuthRequired) { clear(card); card.append(heading, h("p", null, "Sign in to Hermes to download this workspace."), h("div", { class: "row" }, h("button", { class: "primary", onclick: () => signIn(`#/workspace/${wid}`) }, "Sign in"))); }
        else if (e instanceof HttpError && e.status === 404) { about.append(h("p", { class: "muted" }, "This workspace isn't published on Hermes.")); btn.disabled = true; }
      }
    }
    return;
  }
  await setCurrentWorkspace(wid);
  const count = (await installedWorkspaces()).length;
  const home = h("div", { class: "card", id: "ws-home", "data-ws": wid },
    h("div", { class: "ws-head" }, h("h2", null, wsTitle(m, l)),
      h("a", { class: "btn small", href: "#/workspaces" }, count > 1 ? "Switch workspace" : "All workspaces")),
    m.starter ? h("div", { class: "banner warn" }, "Example with synthetic content. Ask Hermes to set up a workspace for your own work.") : null,
    m.profile?.purpose ? h("p", null, String(m.profile.purpose)) : null,
    h("dl", { class: "kv" },
      h("dt", null, "Version"), h("dd", null, String(m.version_of_workspace ?? m.version ?? 1)),
      h("dt", null, "Hermes"), h("dd", { id: "ws-after-sync" }, "Syncing saves your entries in your Hermes account. Ask your Hermes agent anything about them.")),
    h("div", { class: "row" }, isOnline() ? btn : null), status);
  main.append(home);
  if (isOnline()) {
    void (async () => {
      try {
        const live = await api<any>(`workspaces/${encodeURIComponent(wid)}`);
        if ((live.published_version ?? 0) > (m.version_of_workspace ?? 1)) {
          home.prepend(h("div", { class: "banner warn", id: "ws-update", "data-version": String(live.published_version) },
            h("strong", null, `Update available: version ${live.published_version}`),
            ...(live.changelog ?? []).map((c: string) => h("div", null, c))));
        }
      } catch { /* offline or older server: nothing to show */ }
    })();
  }
  const wfNames = new Map((await installedWorkflows()).map((w) => [w.id, text(w.definition.title, l)]));
  main.append(h("div", { class: "card", id: "ws-workflows" }, h("h3", null, "New entry"),
    h("ul", { class: "clean" }, ...(m.workflows ?? []).map((w) => h("li", { class: "row" }, h("span", { class: "grow" }, wfNames.get(w.id) ?? w.id),
      h("a", { class: "btn primary", href: `#/workflow/${encodeURIComponent(w.id)}?ws=${encodeURIComponent(wid)}` }, "Start"))))));
  const d = await db();
  const sm = summarizeLocal((m.workflows ?? []).map((w) => w.id), await d.getAll("records"), await d.getAll("drafts"));
  main.append(h("div", { class: "card", id: "ws-summary" }, h("h3", null, "On this phone"),
    sm.total || sm.unfinished ? h("dl", { class: "kv" },
      h("dt", null, "Entries"), h("dd", null, `${sm.total} saved (${sm.today} today)`),
      h("dt", null, "Unfinished"), h("dd", null, String(sm.unfinished)),
      h("dt", null, "Waiting to sync"), h("dd", null, String(sm.waiting)))
      : h("p", { class: "muted" }, "No entries yet. Start one under “New entry”.")));
};
