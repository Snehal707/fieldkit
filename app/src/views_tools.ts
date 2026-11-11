// Translate, Scan text (OCR), Offline Packs, Settings and Connection diagnostics.
import { api, AuthRequired } from "./api";
import { APP_VERSION, PUBLIC_APP_URL, RUNNING_FROM_LEGACY_PATH, signIn } from "./config";
import { db, deleteRecord, deviceId, getSetting, setSetting, type InstalledModel } from "./db";
import { text } from "./engine";
import {
  capabilities, installedModels, installOcr, installTranslation, ocr, ocrLanguages, removeModel, translate, translationPairs,
} from "./intel";
import { fetchCatalog, installedWorkflows, removeWorkflow, storageInfo } from "./packs";
import { enqueueRecord, getSyncState, runSync } from "./sync";
import { clear, fmtBytes, fmtTime, h, isOnline, toast } from "./util";
import { icon } from "./icons";
import { go, lang, signInBanner, whoAmI, type View } from "./views_core";
import { currentDeviceLabel, describeLoadProblem, fetchAllRecords, registerDevice } from "./device";
import { languageLabel, requestOutcome, requestProtection, storageMessage, storageState } from "./storage";

// ------------------------------------------------------------------ translate
export const translateView: View = async (main) => {
  const pairs = await translationPairs();
  if (!pairs.length) {
    main.append(h("div", { class: "card" }, h("h2", null, "Translate"), h("p", null, "No offline translation model is installed."),
      h("a", { class: "btn primary", href: "#/packs" }, "Install translation in Offline Packs")));
    return;
  }
  const sel = h("select", null, ...pairs.map(([f, t]) => h("option", { value: `${f}>${t}` }, `${languageLabel(f, "en")} → ${languageLabel(t, "en")}`))) as HTMLSelectElement;
  const src = h("textarea", { placeholder: "Type or paste a sentence…" }) as HTMLTextAreaElement;
  const out = h("div");
  const btn = h("button", { class: "primary", onclick: async () => {
    const [f, t] = sel.value.split(">");
    if (!src.value.trim()) return;
    btn.disabled = true; btn.textContent = "Translating on device…";
    clear(out);
    try {
      const r = await translate(src.value, f, t);
      out.append(h("div", { class: "card", id: "translation-out" }, h("p", { style: "font-size:1.1rem;white-space:pre-wrap" }, r.text),
        r.terms.length ? h("div", { class: "muted", "data-terms": String(r.terms.length) }, `Dictionary terms used: ${r.terms.map((x) => `${x.source} → ${x.target}`).join(", ")}`) : null,
        h("div", { class: "muted" }, `Translated on this device with ${r.model} in ${r.ms} ms — no network used. A small offline model: check important wording.`)));
    } catch (e) { out.append(h("div", { class: "banner bad" }, (e as Error).message)); }
    btn.disabled = false; btn.textContent = "Translate";
  } }, "Translate");
  main.append(h("div", { class: "card" }, h("h2", null, "Translate (offline)"), sel, h("div", { style: "height:.5rem" }), src,
    h("div", { class: "row", style: "margin-top:.5rem" }, btn)), out);
};

// ------------------------------------------------------------------ OCR
export const ocrView: View = async (main) => {
  const langs = await ocrLanguages();
  if (!langs.length) {
    main.append(h("div", { class: "card" }, h("h2", null, "Scan text"), h("p", null, "No offline OCR language pack is installed."), h("a", { class: "btn primary", href: "#/packs" }, "Install OCR")));
    return;
  }
  const OCR_NAMES: Record<string, string> = { eng: "English", hin: "Hindi (Devanagari)" };
  const pref = (await lang()) === "hi" ? "hin" : "eng";
  const sel = h("select", { "aria-label": "Text language" }, ...langs.map((x) => h("option", { value: x, selected: x === pref }, OCR_NAMES[x] ?? x))) as HTMLSelectElement;
  const out = h("textarea", { placeholder: "Recognised text appears here (editable)" }) as HTMLTextAreaElement;
  const status = h("div", { class: "muted", id: "ocr-status" });
  const prog = h("progress", { max: 1, value: 0 }) as HTMLProgressElement;
  const read = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    status.textContent = "Reading text on this device…";
    status.removeAttribute("data-quality");
    try {
      const r = await ocr(f, sel.value, (p) => { if (p.progress !== undefined) prog.value = p.progress; if (p.status) status.textContent = p.status; });
      out.value = r.text;
      status.setAttribute("data-quality", r.quality);
      status.setAttribute("data-confidence", String(r.confidence));
      status.textContent = `Done offline · confidence ${r.confidence}%${r.rotation ? ` · photo was rotated ${r.rotation}°` : ""}${r.note ? ` · ${r.note}` : ""}`;
    } catch (err) { status.textContent = (err as Error).message; }
  };
  // Camera sheet (quick) or a photo from the library (e.g. a sharp close-up taken with the Camera app's macro).
  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none", "data-source": "camera", onchange: read }) as HTMLInputElement;
  const library = h("input", { type: "file", accept: "image/*", style: "display:none", "data-source": "library", onchange: read }) as HTMLInputElement;
  main.append(h("div", { class: "card" }, h("h2", null, "Scan text (OCR, offline)"),
    h("div", { class: "row" }, sel, h("button", { onclick: () => camera.click() }, icon("camera"), "Take photo"),
      h("button", { onclick: () => library.click() }, icon("photos"), "Choose from Photos"), camera, library),
    h("div", { class: "muted" }, "For small print, a close-up from the Camera app (macro) reads best."), prog, status, out,
    h("button", { onclick: async () => {
      try { await navigator.clipboard.writeText(out.value); toast("Copied", "ok"); } catch { out.select(); toast("Select the text and copy it", "info"); }
    } }, "Copy")));
};

// ------------------------------------------------------------------ packs
export const packsView: View = async (main) => {
  const [wfs, models] = await Promise.all([installedWorkflows(), installedModels()]);
  const l = await lang();
  const onDevice = h("div");
  main.append(h("div", { class: "card" }, h("h2", null, "On this device"),
    h("h3", null, "Forms"), wfs.length ? h("ul", { class: "clean" }, ...wfs.map((w) => h("li", { class: "row" },
      h("span", { class: "grow" }, `${text(w.definition.title, l)} · v${w.version}`),
      h("button", { class: "danger", onclick: async () => { try { await removeWorkflow(w.id); go(`#/packs?r=${Date.now()}`); } catch (e) { toast((e as Error).message, "error"); } } }, "Remove"))))
      : h("p", { class: "muted" }, "None. Forms come with your workspace (Workspace tab)."),
    h("h3", null, "Offline OCR and translation"), onDevice));
  const paintOnDevice = (list: typeof models) => {
    clear(onDevice);
    onDevice.append(list.length ? h("ul", { class: "clean" }, ...list.map((m) => h("li", { class: "row", "data-on-device": m.id },
      h("span", { class: "grow" }, `${m.title}`, h("div", { class: "muted" }, `${m.verified ? "✔" : "⚠"} ${m.verify_detail ?? ""} · installed ${fmtTime(m.installed_at)}`)),
      h("button", { class: "danger", onclick: async () => { await removeModel(m.id); go(`#/packs?r=${Date.now()}`); } }, "Remove"))))
      : h("p", { class: "muted" }, "None"));
  };
  paintOnDevice(models);
  const onInstalled = async () => paintOnDevice(await installedModels());
  document.addEventListener("fieldkit:model-installed", onInstalled);
  window.addEventListener("hashchange", () => document.removeEventListener("fieldkit:model-installed", onInstalled), { once: true });

  const avail = h("div", { class: "card" }, h("h2", null, "Optional offline packs"),
    h("p", { class: "muted" }, "Read text from a photo (OCR) and translate sentences without internet. Downloaded once from their pinned "
      + "upstream sources; use Wi-Fi."));
  main.append(avail);
  if (!isOnline()) { avail.append(h("p", { class: "muted" }, "Connect to the internet to download packs.")); return; }
  let cat;
  try { cat = await fetchCatalog(); } catch (e) {
    if (e instanceof AuthRequired) { avail.append(await signInBanner()); return; }
    avail.append(h("p", { class: "muted" }, describeLoadProblem(e, isOnline()).message.replace("your records", "the catalog")),
      h("button", { onclick: () => go(`#/packs?r=${Date.now()}`) }, "Try again")); return;
  }
  avail.append(h("ul", { class: "clean" }, ...cat.models.packs.map((m: any) => modelRow(m, models.find((x) => x.id === m.id)))));
};

function modelRow(m: any, have: InstalledModel | undefined) {
  const installed = !!have;
  const outdated = !!have && (have.version ?? 1) < (m.version ?? 1);
  const prog = h("progress", { max: 100, value: 0, style: "display:none" }) as HTMLProgressElement;
  const status = h("div", { class: "muted" }, `${m.license} · ${fmtBytes(m.download_size)}${m.quality_note ? ` · ${m.quality_note}` : ""}`,
    outdated ? h("div", { class: "banner warn", "data-model-update": m.id }, `Update available: ${m.update_note || "improved version"}. The installed version keeps working until you update.`) : null);
  const b = h("button", { class: installed ? "" : "primary", onclick: async () => {
    b.disabled = true; prog.style.display = "block";
    const totals = new Map<string, [number, number]>();
    const onProgress = (p: any) => {
      if (p.file && p.total) totals.set(p.file, [p.loaded ?? 0, p.total]);
      const [ld, tt] = [...totals.values()].reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      if (tt) prog.value = Math.round((ld / tt) * 100);
      else if (p.progress !== undefined) prog.value = Math.round(p.progress * 100);
      status.textContent = p.status ? `${p.status}${p.file ? ` ${p.file}` : ""}` : status.textContent;
    };
    try {
      const fn = m.capability === "translation" ? installTranslation : installOcr;
      const r = await fn(m, onProgress);
      status.textContent = `Installed and self-tested on this device · ${r.verify_detail}`;
      // The label used to be computed only when the screen was drawn, so a model installed while the
      // screen stayed open kept saying "Install". Reflect the new (already persisted) state right away.
      b.textContent = "Reinstall";
      b.className = "";
      b.setAttribute("data-installed", "true");
      document.dispatchEvent(new CustomEvent("fieldkit:model-installed", { detail: { id: m.id } }));
      toast(`${m.title} ready offline`, "ok");
    } catch (e) { status.textContent = `Install failed: ${(e as Error).message}`; }
    b.disabled = false;
  } }, outdated ? "Update" : installed ? "Reinstall" : "Install");
  if (outdated) b.className = "primary";
  b.setAttribute("data-model", m.id);
  if (installed) b.setAttribute("data-installed", "true");
  return h("li", null, h("div", { class: "row" }, h("strong", { class: "grow" }, m.title), b), status, prog);
}

// ------------------------------------------------------------------ settings
export const settingsView: View = async (main) => {
  const [l, dev, st, me, caps] = await Promise.all([lang(), deviceId(), storageInfo(), isOnline() ? whoAmI() : Promise.resolve(null), capabilities()]);
  const d = await db();
  main.append(h("div", { class: "card" }, h("h2", null, "App"),
    h("label", { class: "q" }, "Form language"),
    h("select", { onchange: async (e: Event) => { await setSetting("lang", (e.target as HTMLSelectElement).value); toast("Saved"); } },
      ...[["en", "English"], ["hi", "हिंदी"]].map(([v, n]) => h("option", { value: v, selected: v === l }, n))),
    h("dl", { class: "kv", style: "margin-top:.8rem" },
      h("dt", null, "App version"), h("dd", null, APP_VERSION)),
    h("div", { class: "row", style: "margin-top:.8rem" },
      h("a", { class: "btn", href: "#/diagnostics" }, "Connection diagnostics"))));

  // ---- Hermes account + this device
  const last = await getSetting<{ user_id: string; display_name: string; provider: string; at: string } | null>("last_account", null);
  const acct = me ?? null;
  const hstatus = acct ? await api<any>("status").catch(() => null) : null;   // which Hermes data store answered
  const shownAccount = acct ?? last;
  const devName = await currentDeviceLabel();
  const nameInput = h("input", { value: devName, maxlength: 80, "aria-label": "Device name" }) as HTMLInputElement;
  main.append(h("div", { class: "card", id: "account-card" }, h("h2", null, "Hermes account"),
    h("dl", { class: "kv" },
      h("dt", null, "Status"), h("dd", { "data-account-status": acct ? "signed-in" : getSyncState().auth_required ? "expired" : isOnline() ? "signed-out" : "offline" },
        acct ? "Signed in" : getSyncState().auth_required ? "Session expired — sign in again" : isOnline() ? "Not signed in" : "Offline (not checked)"),
      h("dt", null, acct ? "Signed in as" : "Last signed in as"), h("dd", null, shownAccount ? (shownAccount.display_name || shownAccount.user_id) : "—"),
      h("dt", null, "Account ID"), h("dd", { "data-account-id": shownAccount?.user_id ?? "" }, shownAccount ? shownAccount.user_id : "—"),
      h("dt", null, "Sign-in method"), h("dd", null, shownAccount?.provider || "—")),
    h("p", { class: "muted" }, "Every browser and Home Screen app signs in separately, but the same Account ID means the same Hermes account: records from all of them are on Hermes together."),
    acct ? null : h("button", { class: "primary", onclick: () => signIn("#/settings") }, "Sign in to Hermes")));
  main.append(h("div", { class: "card", id: "device-card" }, h("h2", null, "This device"),
    h("dl", { class: "kv" }, h("dt", null, "Name"), h("dd", { "data-device-name": devName }, devName)),
    h("label", { class: "q" }, "Rename this device"),
    h("div", { class: "row" }, h("div", { class: "grow" }, nameInput), h("button", { onclick: async () => {
      await setSetting("device_name", nameInput.value.trim().slice(0, 80));
      await registerDevice(true);
      toast("Device name saved", "ok");
      go(`#/settings?r=${Date.now()}`);
    } }, "Save")),
    h("details", { id: "advanced", style: "margin-top:.8rem" }, h("summary", null, "Advanced"),
      h("dl", { class: "kv" }, h("dt", null, "Device ID"), h("dd", { "data-device-id": dev }, dev),
        h("dt", null, "Hermes data store"), h("dd", { "data-store-id": hstatus?.store?.store_id ?? "" }, hstatus?.store?.store_id || (acct ? "unknown (older server)" : "—")),
        h("dt", null, "Hermes machine"), h("dd", null, hstatus?.instance?.machine ? `${hstatus.instance.machine}${hstatus.instance.region ? ` (${hstatus.instance.region})` : ""}` : "—"),
        h("dt", null, "Your records on it"), h("dd", { "data-store-records": String(hstatus?.store?.records_for_you ?? "") }, hstatus?.store ? String(hstatus.store.records_for_you) : "—"),
        h("dt", null, "FieldKit server"), h("dd", null, hstatus?.version ?? "—")),
      h("p", { class: "muted" }, "Technical details for troubleshooting. Two installs signed in to the same account should show the same Hermes data store and record count."))));

  // ---- Storage: three clearly different states, calm wording, no false promises (see storage.ts)
  const ss = await storageState();
  const sm = storageMessage(ss);
  main.append(h("div", { class: "card", id: "storage-card" }, h("h2", null, "Storage on this device"),
    h("div", { class: `banner ${sm.tone === "ok" ? "hermes" : "local"}`, "data-storage-kind": ss.kind },
      h("strong", null, sm.label), h("div", null, sm.detail)),
    ss.usage !== undefined ? h("p", { class: "muted" }, `Using ${fmtBytes(ss.usage)}${ss.quota ? ` of up to ${fmtBytes(ss.quota)} available to FieldKit` : ""}.`) : null,
    sm.canRequest ? h("button", { onclick: async () => {
      const r = requestOutcome(await requestProtection());
      toast(r.text, r.tone);
      go(`#/settings?r=${Date.now()}`);
    } }, "Ask the browser to protect storage") : null));

  // ---- Home Screen app: real benefits, no permanent-storage promise
  if (RUNNING_FROM_LEGACY_PATH && ss.standalone) {
    const link = PUBLIC_APP_URL.toString();
    main.append(h("div", { class: "card", id: "readd-card" }, h("h2", null, "Re-add FieldKit to your Home Screen"),
      h("p", null, "This icon opens FieldKit's old address, which shows an error page instead of the app when your Hermes session has expired. Your records are safe and will appear in the new icon too."),
      h("ol", null, h("li", null, "Copy the link below and open it in Safari."), h("li", null, "Tap Share → Add to Home Screen."),
        h("li", null, "Open the new icon and sign in once, then remove the old icon.")),
      h("pre", { class: "wrap" }, link),
      h("button", { class: "primary", onclick: async () => { try { await navigator.clipboard.writeText(link); toast("Link copied", "ok"); } catch { toast("Select the link above and copy it", "info"); } } }, "Copy link")));
  }
  main.append(h("div", { class: "card", id: "install-card" }, h("h2", null, "Use FieldKit as an app"),
    ss.standalone
      ? h("p", null, "✔ You're using FieldKit from the Home Screen.")
      : h("p", null, "Add FieldKit to your Home Screen (iPhone: Share → Add to Home Screen; Android: menu → Install app)."),
    h("ul", null,
      h("li", null, "Opens full-screen from its own icon, and starts offline from the Home Screen."),
      h("li", null, "On iPhone, the browser is more likely to protect its storage when it's used as a Home Screen app — but this isn't guaranteed."),
      h("li", null, "On iPhone the installed app keeps its own data, separate from Safari: sign in once inside it, and download your workspace there.")),
    h("p", { class: "muted" }, "Installing doesn't make storage permanent. Records stay on the device until they sync, so sync regularly and use Export for an extra backup.")));

  main.append(h("div", { class: "card" }, h("h2", null, "Backup & recovery"),
    h("p", { class: "muted" }, "Export everything on this device (records, media, reports, drafts) to a file you can keep or move to another device."),
    h("div", { class: "row" },
      h("button", { onclick: async () => exportData() }, "Export data"),
      h("label", { class: "btn" }, "Import backup", h("input", { type: "file", accept: "application/json", style: "display:none", onchange: async (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        try {
          const n = await importData(f);
          toast(`Restored ${n.records} record(s), ${n.attachments} file(s)${n.queued ? `; ${n.queued} queued for upload` : ""}. Existing items were kept.`, "ok");
          go(`#/settings?r=${Date.now()}`);
        } catch (err) { toast(`Couldn't import: ${(err as Error).message}`, "error"); }
      } })))));

  const synced = (await d.getAll("records")).filter((r) => r.sync_status === "synced");
  main.append(h("div", { class: "card", id: "free-space-card" }, h("h2", null, "Free up space"),
    h("p", { class: "muted" }, `${synced.length} record(s) on this device are confirmed by Hermes. Before removing any, FieldKit checks that Hermes still has them; records Hermes doesn't have are kept. Records not yet confirmed are never removed.`),
    h("button", { class: "danger", disabled: !synced.length, onclick: async (ev: Event) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      if (!confirm(`Remove up to ${synced.length} record(s) from this device? They stay in your Hermes account.`)) return;
      btn.disabled = true;
      let onServer: Set<string>;
      try { onServer = new Set((await fetchAllRecords((p) => api(p))).records.map((r) => r.id)); }
      catch (e) {
        toast(e instanceof AuthRequired ? "Sign in to Hermes first, so FieldKit can check what Hermes has." : `Nothing removed: ${describeLoadProblem(e, isOnline()).message}`, "error");
        btn.disabled = false; return;
      }
      const safe = synced.filter((r) => onServer.has(r.id));
      for (const r of safe) await deleteRecord(r.id);
      const kept = synced.length - safe.length;
      toast(`Removed ${safe.length} record(s).${kept ? ` Kept ${kept} that Hermes doesn't have. See Saved Records.` : ""}`, kept ? "info" : "ok");
      go(`#/settings?r=${Date.now()}`);
    } }, "Remove confirmed records")));
};

async function blobToB64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function exportData() {
  const d = await db();
  const atts = await d.getAll("attachments");
  const data = {
    format: "fieldkit-backup", version: 1, exported_at: new Date().toISOString(), device_id: await deviceId(),
    records: await d.getAll("records"), drafts: await d.getAll("drafts"), reports: await d.getAll("reports"),
    attachments: await Promise.all(atts.map(async (a) => ({ ...a, blob: undefined, data_b64: await blobToB64(a.blob) }))),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = h("a", { href: url, download: `fieldkit-backup-${Date.now()}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function importData(file: File): Promise<{ records: number; attachments: number; queued: number }> {
  let data: any;
  try { data = JSON.parse(await file.text()); } catch { throw new Error("this file isn't a FieldKit backup (not valid JSON)"); }
  if (data?.format !== "fieldkit-backup") throw new Error("this file isn't a FieldKit backup");
  const d = await db();
  let records = 0, attachments = 0;
  const toQueue: string[] = [];
  for (const r of data.records ?? []) {
    if (await d.get("records", r.id)) continue;
    // A record that was still waiting (or mid-upload) on the old device must upload from this one.
    // ("received" = Hermes has the record but not all its photos/audio: re-sending makes Hermes ask for the rest.)
    const unsent = !["synced", "conflict", "error"].includes(r.sync_status);
    await d.put("records", unsent ? { ...r, sync_status: "pending" } : r);
    if (unsent) toQueue.push(r.id);
    records++;
  }
  for (const r of data.drafts ?? []) if (!(await d.get("drafts", r.id))) await d.put("drafts", r);
  for (const r of data.reports ?? []) if (!(await d.get("reports", r.record_id))) await d.put("reports", r);
  for (const a of data.attachments ?? []) {
    if (await d.get("attachments", a.id)) continue;
    const bin = Uint8Array.from(atob(a.data_b64), (c) => c.charCodeAt(0));
    const { data_b64: _drop, ...rest } = a;
    await d.put("attachments", { ...rest, blob: new Blob([bin], { type: a.mime }) });
    attachments++;
  }
  for (const id of toQueue) await enqueueRecord(id);   // after the media is in place
  if (toQueue.length) void runSync();
  return { records, attachments, queued: toQueue.length };
}


// ------------------------------------------------------------------ connection diagnostics
export const diagnosticsView: View = async (main) => {
  const { netEntries, report, onNetlog, clearNetlog } = await import("./netlog");
  const { loggedFetch } = await import("./api");
  const { apiUrl } = await import("./config");
  const { getSyncState } = await import("./sync");
  const verdict = h("div");
  const list = h("div");
  const pre = h("pre", { class: "wrap", style: "font-size:.72rem;max-height:40vh;overflow:auto" });

  const paintList = () => {
    clear(list);
    const s = getSyncState();
    list.append(h("dl", { class: "kv" },
      h("dt", null, "Device says online"), h("dd", null, String(navigator.onLine)),
      h("dt", null, "App status"), h("dd", null, s.reachable === true ? `Hermes reachable (last proof ${fmtTime(s.last_contact)})` : s.reachable === false ? "Hermes NOT reachable" : "not checked"),
      h("dt", null, "App version"), h("dd", null, APP_VERSION),
      h("dt", null, "Service worker"), h("dd", null, navigator.serviceWorker?.controller ? "active (offline cache in use)" : "not controlling this page")));
    const rows = netEntries().slice().reverse().slice(0, 25);
    list.append(h("h3", null, "Recent requests (newest first)"),
      rows.length ? h("ul", { class: "clean" }, ...rows.map((e) => h("li", null,
        h("strong", { class: e.outcome === "network-error" ? "no" : e.hermes ? "ok" : "wait" },
          e.outcome === "network-error" ? "NO NETWORK" : `${e.status}${e.hermes ? " ✔ Hermes" : " ? not Hermes"}`),
        ` ${e.method} ${e.path}`,
        h("div", { class: "muted" }, `${fmtTime(e.t)} · ${e.ms} ms · device online=${e.online}`
          + (e.server_date ? ` · server clock ${e.server_date}` : "") + (e.final_url && e.final_url !== e.path ? ` · answered by ${e.final_url}` : "")
          + (e.note ? ` · ${e.note}` : ""))))) : h("p", { class: "muted" }, "No requests recorded yet."));
    pre.textContent = report({ app_version: APP_VERSION, reachable: s.reachable, last_contact: s.last_contact ?? null, awaiting: s.awaiting, drafts: s.drafts });
  };

  const liveTest = async () => {
    clear(verdict);
    verdict.append(h("p", { class: "muted" }, "Testing…"));
    let msg: HTMLElement;
    try {
      const res = await loggedFetch(`${apiUrl("me")}?diag=${Date.now()}`, { credentials: "same-origin", cache: "no-store", redirect: "manual" });
      const ct = res.headers.get("content-type") || "";
      const body = ct.includes("json") ? await res.json().catch(() => null) : (await res.text().catch(() => "")).slice(0, 160);
      const date = res.headers.get("date");
      if (res.type === "opaqueredirect") {
        msg = h("div", { class: "banner warn" }, h("strong", null, "Something redirected the request — not Hermes."),
          h("div", null, "Typical of a Wi-Fi login page (hotel, office, café). The phone has a network but cannot reach Hermes."));
      } else if (ct.includes("json") && body && typeof body === "object" && "user_id" in body) {
        msg = h("div", { class: "banner hermes" }, h("strong", null, "Connected: Hermes answered just now."),
          h("div", null, `Signed in as ${(body as any).display_name || (body as any).user_id}. Server clock: ${date ?? "n/a"}.`));
      } else if (res.status === 401 && ct.includes("json")) {
        msg = h("div", { class: "banner warn" }, h("strong", null, "Connected, but signed out."),
          h("div", null, "Hermes answered (HTTP 401): this app's Hermes session has expired or it hasn't signed in yet."),
          h("button", { class: "primary", onclick: () => signIn("#/diagnostics") }, "Sign in"));
      } else if (ct.includes("json") && body && typeof body === "object" && "detail" in body) {
        msg = h("div", { class: "banner warn" }, h("strong", null, `Hermes answered with an error (HTTP ${res.status}).`),
          h("div", null, String((body as any).detail)));
      } else {
        msg = h("div", { class: "banner warn" }, h("strong", null, `Something answered (HTTP ${res.status}, ${ct || "no type"}) but it is NOT Hermes.`),
          h("div", null, `Answered by: ${res.url || "unknown"}. Body starts: ${typeof body === "string" ? body : JSON.stringify(body)?.slice(0, 160)}`));
      }
    } catch {
      msg = h("div", { class: "banner local" }, h("strong", null, navigator.onLine ? "Can't reach Hermes." : "No connection."),
        h("div", null, navigator.onLine ? "The device reports a network, but the request didn't get through. Records stay on this device and upload later."
          : "This device is offline. FieldKit keeps working offline; records upload when you're connected."));
    }
    clear(verdict);
    verdict.append(msg);
    paintList();
  };

  main.append(h("div", { class: "card" }, h("h2", null, "Connection diagnostics"),
    h("p", { class: "muted" }, "Shows exactly what FieldKit sent and what came back. Stored only on this device."),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: liveTest }, "Run live connection test"),
      h("button", { onclick: async () => { try { await navigator.clipboard.writeText(pre.textContent || ""); toast("Report copied", "ok"); } catch { toast("Select the report text below and copy it", "error"); } } }, "Copy report"),
      h("button", { onclick: () => { clearNetlog(); paintList(); } }, "Clear log")),
    verdict),
    h("div", { class: "card" }, list),
    h("div", { class: "card" }, h("h3", null, "Report (paste this to support)"), pre));
  paintList();
  const off = onNetlog(paintList);
  window.addEventListener("hashchange", () => off(), { once: true });
};
