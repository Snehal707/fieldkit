// Workspace screens: list (installed + available on Hermes) and one workspace (profile, evidence, gaps, download).
import { api, HttpError } from "./api";
import { text } from "./engine";
import { clear, fmtTime, h, isOnline, toast } from "./util";
import { go, lang, type View } from "./views_core";
import { availableWorkspaces, installedWorkspace, installedWorkspaces, installWorkspace, rememberWorkspace, STATUS_LABEL, wsTitle, type WorkspaceManifest } from "./workspace";

export const workspacesView: View = async (main) => {
  const l = await lang();
  const mine = await installedWorkspaces();
  const card = h("div", { class: "card", id: "workspaces" }, h("h2", null, "Workspaces"),
    h("p", { class: "muted" }, "A workspace is your job set up by Hermes: your workflows, decision guides and knowledge, researched for your region and kept offline on this device."));
  if (mine.length) {
    card.append(h("h3", null, "On this device"), h("ul", { class: "clean" }, ...mine.map(({ manifest: m, pack }) =>
      h("li", { class: "row", "data-ws": m.workspace_id }, h("a", { class: "grow", href: `#/workspace/${m.workspace_id}` }, h("strong", null, wsTitle(m, l)),
        h("div", { class: "muted" }, `${m.starter ? "Starter example · " : ""}version ${m.version_of_workspace ?? pack.version} · downloaded ${fmtTime(pack.installed_at)}`))))));
  }
  const avail = h("div");
  card.append(avail);
  main.append(card);
  if (!isOnline()) { avail.append(h("p", { class: "muted" }, "Offline: connect to see workspaces available on Hermes.")); return; }
  try {
    const list = (await availableWorkspaces()).filter((w) => !mine.some((x) => x.manifest.workspace_id === w.id));
    if (list.length) avail.append(h("h3", null, "Available on Hermes"), h("ul", { class: "clean" }, ...list.map((w) =>
      h("li", { class: "row" }, h("a", { class: "grow", href: `#/workspace/${w.id}` }, h("strong", null, w.title),
        h("div", { class: "muted" }, w.starter ? "Starter example (synthetic demo)" : `Built for you · version ${w.published_version}`))))));
    else if (!mine.length) avail.append(h("p", { class: "muted" }, "No workspace yet. Ask Hermes: “Set up FieldKit for my work.”"));
  } catch (e) { avail.append(h("p", { class: "muted" }, `Couldn't load workspaces from Hermes: ${(e as Error).message}`)); }
};

function evidenceBlock(m: WorkspaceManifest) {
  const s = m.summary ?? {};
  const rows: [string, number][] = [["verified", s.verified ?? 0], ["user_procedure", s.user_procedure ?? 0], ["supported", s.supported ?? 0],
    ["local_practice", s.local_practice ?? 0],
    ["conflicting", s.conflicting ?? 0], ["unverified", s.unverified ?? 0]];
  return h("div", { class: "card", id: "ws-evidence" }, h("h3", null, "How this workspace is evidenced"),
    h("ul", { class: "clean" }, ...rows.filter(([, n]) => n).map(([k, n]) => h("li", { "data-status": k }, `${STATUS_LABEL[k]}: ${n}`))),
    h("p", { class: "muted" }, "Decision guides and instructions only use verified, supported or your own procedures. Where sources disagree, the guide sends you to your escalation contact."),
    (m.sources ?? []).length ? h("details", null, h("summary", null, `Sources (${m.sources.length})`),
      h("ul", null, ...m.sources.filter((x: any) => x.tier).map((x: any) => h("li", null, `${x.title || x.url} — ${x.publisher || ""} (tier ${x.tier})`)))) : null);
}

export const workspaceView: View = async (main, p) => {
  const l = await lang();
  const wid = p.id;
  rememberWorkspace(wid);
  let m = await installedWorkspace(wid);
  const status = h("div", { class: "muted", id: "ws-status" });
  const btn = h("button", { class: "primary", id: "ws-download", onclick: async () => {
    btn.disabled = true;
    try {
      const r = await installWorkspace(wid, (st) => { status.textContent = st; });
      status.textContent = r.failed.length ? `Downloaded, but ${r.failed.length} item(s) failed: ${r.failed.join(", ")}. Try again with a better connection.`
        : `Everything is on this device: ${r.workflows.length} workflow(s), ${r.packs.length} pack(s).`;
      toast(r.failed.length ? "Some items didn't download" : "Workspace ready offline", r.failed.length ? "error" : "ok");
      go(`#/workspace/${wid}?r=${Date.now()}`);
    } catch (e) {
      status.textContent = e instanceof HttpError && e.status === 404 ? "This workspace isn't published on Hermes." : `Download failed: ${(e as Error).message}`;
      btn.disabled = false;
    }
  } }, m ? "Update from Hermes" : "Download everything for offline");
  if (!m) {
    main.append(h("div", { class: "card" }, h("h2", null, "Workspace"),
      h("p", null, isOnline() ? "Not on this device yet." : "Not on this device yet. Connect to the internet to download it."),
      isOnline() ? btn : null, status));
    return;
  }
  const prof = m.profile ?? {};
  main.append(h("div", { class: "card", id: "ws-home", "data-ws": wid }, h("h2", null, wsTitle(m, l)),
    m.starter ? h("div", { class: "banner warn" }, "Starter example with synthetic content. Ask Hermes to build a workspace for your actual job.") : null,
    h("dl", { class: "kv" },
      h("dt", null, "Role"), h("dd", null, prof.role || "—"),
      h("dt", null, "Where"), h("dd", null, [prof.region, prof.country].filter(Boolean).join(", ") || "—"),
      h("dt", null, "Version"), h("dd", null, String(m.version_of_workspace ?? m.version ?? 1))),
    (prof.responsibilities ?? []).length ? h("div", null, h("h3", null, "Your responsibilities"),
      h("ul", null, ...prof.responsibilities.map((r: any) => h("li", null, r.description, (r.decisions ?? []).length ? h("div", { class: "muted" }, `Decides: ${r.decisions.join(", ")}`) : null)))) : null,
    h("div", { class: "row" }, isOnline() ? btn : null), status));
  if (isOnline()) {
    void (async () => {
      try {
        const live = await api<any>(`workspaces/${encodeURIComponent(wid)}`);
        const have = m!.version_of_workspace ?? 1;
        if ((live.published_version ?? 0) > have) {
          const note = h("div", { class: "banner warn", id: "ws-update", "data-version": String(live.published_version) },
            h("strong", null, `Update available: version ${live.published_version}`),
            ...(live.changelog ?? []).map((c: string) => h("div", null, c)));
          document.getElementById("ws-home")?.prepend(note);
        }
      } catch { /* offline or older server: nothing to show */ }
    })();
  }
  main.append(h("div", { class: "card" }, h("h3", null, "Workflows"),
    h("ul", { class: "clean" }, ...(m.workflows ?? []).map((w) => h("li", { class: "row" }, h("span", { class: "grow" }, w.id),
      h("a", { class: "btn", href: `#/workflow/${encodeURIComponent(w.id)}` }, "Open"))))));
  if ((m.guides ?? []).length) {
    main.append(h("div", { class: "card", id: "ws-guides" }, h("h3", null, "Decision guides"),
      h("ul", { class: "clean" }, ...m.guides.map((g: any) => h("li", { class: "row" }, h("span", { class: "grow" }, text(g.title, l)),
        h("a", { class: "btn", href: `#/guide/${encodeURIComponent(wid)}/${encodeURIComponent(g.id)}` }, "Start"))))));
  }
  main.append(evidenceBlock(m));
  if ((m.gaps ?? []).length) {
    main.append(h("div", { class: "card", id: "ws-gaps" }, h("h3", null, "Not covered by reliable sources"),
      h("ul", null, ...m.gaps.map((g: any) => h("li", null, h("strong", null, g.topic), g.note ? h("div", { class: "muted" }, g.note) : null))),
      h("p", { class: "muted" }, "For these, follow your own procedure or ask your escalation contact. Hermes keeps researching them.")));
  }
  void clear;
};
