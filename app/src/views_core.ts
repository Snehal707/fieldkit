// Core screens: Home, My Workflows, workflow runner, Results, Saved Records, Pending Sync, Reports.
import { api, AuthRequired, HttpError } from "./api";
import { signIn } from "./config";
import { db, deleteRecord, deviceId, getSetting, setSetting, type Attachment, type Draft, type LocalRecord, type RemoteCopy, type StoredReport } from "./db";
import { unifiedRecords, type Availability, type ServerLike } from "./device";
import { computeState, ERROR_TEXT, text, type Field, type Workflow } from "./engine";
import { installedModels, ocr, ocrLanguages, speak, transcribe, voicesReady } from "./intel";
import { KnowledgeIndex } from "./knowledge";
import { captureGps, compressPhoto, getAttachment, saveAttachment, signaturePad, VoiceRecorder } from "./media";
import { installedPacks, installedWorkflows, installWorkflow, shellCached, storageInfo } from "./packs";
import { completeDraft } from "./results";
import { getSyncState, refreshPending, refreshReports, requestAnalysis, resolveConflict, runSync } from "./sync";
import { clear, fmtBytes, fmtTime, h, isOnline, nowIso, toast, uuid } from "./util";

export type View = (main: HTMLElement, params: Record<string, string>) => Promise<void> | void;
export const go = (hash: string) => { location.hash = hash; };
export async function lang(): Promise<string> { return getSetting("lang", "en"); }

const STATUS_TEXT: Record<string, string> = {
  local: "Saved locally — pending synchronisation", pending: "Saved locally — pending synchronisation",
  syncing: "Uploading…", received: "Received by Hermes — media still uploading", synced: "Synchronised with Hermes",
  conflict: "Conflict — needs your decision", error: "Sync problem — needs attention",
};
const ANALYSIS_TEXT: Record<string, string> = {
  not_requested: "Not requested", pending: "Pending", processing: "Processing", completed: "Completed",
  failed: "Failed", requires_review: "Completed — requires human review",
};

export function sevBadge(sev: string) { return h("span", { class: `badge sev-${sev}` }, sev); }

// ------------------------------------------------------------------ readiness
export interface Check { label: string; ok: boolean | null; detail?: string }

export async function readiness(): Promise<Check[]> {
  const wfs = await installedWorkflows();
  const packs = await installedPacks();
  const models = await installedModels();
  const st = await storageInfo();
  const needed = new Set(wfs.flatMap((w) => [...(w.definition.knowledge_packs ?? []), ...(w.definition.dictionary_packs ?? [])]));
  const missing = [...needed].filter((p) => !packs.some((x) => x.id === p));
  const sw = !!navigator.serviceWorker?.controller;
  return [
    { label: "App installed for offline opening", ok: sw && (await shellCached()), detail: sw ? "service worker active" : "open once online to install" },
    { label: "Workflows downloaded", ok: wfs.length > 0, detail: `${wfs.length} on this device` },
    { label: "Knowledge & dictionary packs for those workflows", ok: wfs.length ? missing.length === 0 : null, detail: missing.length ? `missing: ${missing.join(", ")}` : `${packs.length} installed` },
    { label: "Offline translation", ok: models.some((m) => m.capability === "translation") || null, detail: models.filter((m) => m.capability === "translation").map((m) => m.manifest.direction.join("→")).join(", ") || "optional — install in Offline Packs" },
    { label: "Offline OCR", ok: models.some((m) => m.capability === "ocr") || null, detail: models.filter((m) => m.capability === "ocr").map((m) => m.manifest.lang_code).join(", ") || "optional" },
    { label: "Offline speech-to-text", ok: models.some((m) => m.capability === "stt") || null, detail: models.some((m) => m.capability === "stt") ? "Whisper tiny on device" : "optional" },
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
export const homeView: View = async (main) => {
  const d = await db();
  const [checks, records, drafts] = await Promise.all([readiness(), d.getAll("records"), d.getAll("drafts")]);
  const essential = checks.slice(0, 3);
  const ready = essential.every((c) => c.ok !== false);
  const pending = records.filter((r) => !["synced", "received"].includes(r.sync_status)).length;
  const sync = getSyncState();
  if (!(await installedWorkflows()).length) main.append(getStartedCard(sync.auth_required));
  main.append(
    h("div", { class: `banner ${ready ? "hermes" : "warn"}` },
      h("strong", null, ready ? "Ready to work offline" : "Not ready for offline use yet"),
      h("div", { class: "muted" }, ready ? "Workflows, packs and the app itself are stored on this phone." : "Connect once, sign in, and download workflows in Offline Packs.")),
    h("div", { class: "card" }, h("h2", null, "Offline readiness"), ...checks.map(checkRow),
      h("div", { class: "row", style: "margin-top:.5rem" }, h("a", { class: "btn", href: "#/packs" }, "Offline Packs"))),
    h("div", { class: "grid" },
      tile("#/workflows", "My Workflows", `${(await installedWorkflows()).length} downloaded`),
      tile("#/records", "Saved Records", `${records.length} on device`),
      tile("#/sync", "Pending Sync", `${pending} waiting`),
      tile("#/reports", "Reports", `${(await d.getAll("reports")).length} downloaded`),
      tile("#/assistant", "Offline Assistant", "Ask your knowledge packs"),
      tile("#/translate", "Translate", "Sentence translation"),
      tile("#/dictionary", "Dictionary", "Terms & definitions"),
      tile("#/knowledge", "Knowledge", "Browse topics"),
      tile("#/ocr", "Scan text (OCR)", "From camera or photo"),
      tile("#/settings", "Settings", "Storage, export, account")));
  if (drafts.length) {
    main.append(h("div", { class: "card" }, h("h2", null, "Unfinished drafts"),
      h("ul", { class: "clean" }, ...drafts.map((dr) => h("li", null, h("a", { href: `#/run/${dr.id}` }, `${dr.workflow_id} — started ${fmtTime(dr.started_at)}`))))));
  }
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
      const { workflows } = await api<{ workflows: any[] }>("workflows");
      clear(body);
      if (!workflows.length) {
        body.append(h("p", null, "Your Hermes has no published FieldKit workflows yet."),
          h("p", { class: "muted" }, "In Hermes Mobile, say “Install the FieldKit examples”, or ask Hermes to create and publish a workflow. Then come back here."),
          h("button", { onclick: () => go(`#/?r=${Date.now()}`) }, "Check again"));
        return;
      }
      const btn = h("button", { class: "primary" }, `Download all ${workflows.length} workflow(s) for offline use`) as HTMLButtonElement;
      btn.onclick = async () => {
        btn.disabled = true;
        const failed: string[] = [];
        for (const [i, w] of workflows.entries()) {
          btn.textContent = `Downloading ${i + 1} of ${workflows.length}…`;
          try { await installWorkflow(w.id); } catch { failed.push(w.title || w.id); }
        }
        toast(failed.length ? `Some downloads failed: ${failed.join(", ")}` : "Workflows and packs saved on this device.", failed.length ? "error" : "ok");
        go(`#/?r=${Date.now()}`);
      };
      body.append(h("p", null, `${workflows.length} published workflow(s) available: ${workflows.map((w) => w.title || w.id).join(", ")}.`),
        h("div", { class: "row" }, btn, h("a", { class: "btn", href: "#/packs" }, "Choose individually")),
        h("p", { class: "muted" }, "Translation, OCR and speech models are optional larger downloads in Offline Packs."));
    } catch (e) {
      clear(body);
      if (e instanceof AuthRequired) {
        body.append(h("p", null, "Sign in to Hermes to see your workflows."), h("button", { class: "primary", onclick: () => signIn("#/") }, "Sign in"));
      } else {
        body.append(h("p", { class: "muted" }, `Could not reach Hermes: ${(e as Error).message}`));
      }
    }
  })();
  return card;
}

function tile(href: string, title: string, sub: string) {
  return h("a", { class: "tile", href }, h("strong", null, title), h("span", { class: "muted" }, sub));
}

export function authBanner() {
  return h("div", { class: "banner warn" }, h("strong", null, "Sign in to Hermes to continue syncing"),
    h("div", { class: "muted" }, "Your session expired. Nothing has been lost: records stay queued on this phone and upload after you sign in."),
    h("div", { class: "row", style: "margin-top:.5rem" }, h("button", { class: "primary", onclick: () => signIn(location.hash || "#/sync") }, "Sign in")));
}

// ------------------------------------------------------------------ workflows
export const workflowsView: View = async (main) => {
  const wfs = await installedWorkflows();
  const l = await lang();
  main.append(h("div", { class: "card" }, h("h2", null, "My Workflows"),
    wfs.length ? h("ul", { class: "clean" }, ...wfs.map((w) => h("li", { class: "row" },
      h("div", { class: "grow" }, h("strong", null, text(w.definition.title, l)), h("div", { class: "muted" },
        `${w.definition.domain || "general"} · v${w.version} · ${w.definition.fields.length} questions · downloaded ${fmtTime(w.downloaded_at)}`)),
      h("button", { class: "primary", onclick: () => startWorkflow(w.id) }, "Start"))))
      : h("p", { class: "muted" }, "No workflows on this device yet. Open Offline Packs while online to download them.")));
};

export const workflowLinkView: View = async (main, p) => {
  // Deep link from Hermes (…/app/#/workflow/<id>): download if needed, then offer to start.
  const id = p.id;
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
      if (e instanceof AuthRequired) { main.append(authBanner()); return; }
      main.append(h("div", { class: "banner bad" }, `Could not download workflow "${id}": ${(e as Error).message}`));
      return;
    }
  }
  if (!stored) { main.append(h("div", { class: "banner warn" }, `Workflow "${id}" is not on this device. Connect to the internet to download it.`)); return; }
  const l = await lang();
  const wf = stored.definition;
  main.append(h("div", { class: "card" }, h("h2", null, text(wf.title, l)), h("p", null, text(wf.description, l)),
    h("p", { class: "muted" }, `Version ${stored.version} · ${wf.fields.length} questions · stored on this device`),
    h("button", { class: "primary", onclick: () => startWorkflow(id) }, "Start workflow")));
};

async function startWorkflow(id: string) {
  const draft: Draft = { id: uuid("rec"), workflow_id: id, workflow_version: (await (await db()).get("workflows", id))!.version,
    answers: {}, started_at: nowIso(), updated_at: nowIso(), lang: await lang() };
  const wf = (await (await db()).get("workflows", id))!.definition;
  for (const f of wf.fields) if (f.default !== undefined) draft.answers[f.id] = f.default;
  await (await db()).put("drafts", draft);
  await refreshPending();  // header immediately shows "1 not submitted"
  go(`#/run/${draft.id}`);
}

// ------------------------------------------------------------------ runner
export const runView: View = async (main, p) => {
  const d = await db();
  const draft = await d.get("drafts", p.id);
  if (!draft) {
    const rec = await d.get("records", p.id);
    if (rec) return go(`#/results/${rec.id}`);
    main.append(h("div", { class: "banner bad" }, "Draft not found."));
    return;
  }
  const stored = await d.get("workflows", draft.workflow_id);
  if (!stored) { main.append(h("div", { class: "banner bad" }, "This workflow is no longer on the device.")); return; }
  const wf = stored.definition;
  const l = draft.lang;
  const packs = await installedPacks("knowledge");
  const idx = new KnowledgeIndex(packs);
  let showErrors = false;
  const touched = new Set<string>();
  const form = h("div");
  const save = async () => { draft.updated_at = nowIso(); await d.put("drafts", draft); };
  const set = async (fid: string, v: unknown, rerender = true) => {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete draft.answers[fid]; else draft.answers[fid] = v;
    touched.add(fid);
    await save();
    if (rerender) render();
  };

  const notice = h("div");
  const render = () => {
    const st = computeState(wf, draft.answers, l);
    clear(form);
    form.append(notice);
    const vis = new Set(st.visible);
    for (const f of wf.fields) {
      if (!vis.has(f.id)) continue;
      form.append(fieldView(f, st, vis));
    }
    form.append(h("div", { class: "row" },
      h("button", { class: "primary", onclick: finish }, "Complete workflow"),
      h("span", { class: "muted" }, `Draft saved on this device · ${Object.keys(st.errors).length} item(s) to fix`)));
  };

  const fieldView = (f: Field, st: ReturnType<typeof computeState>, _vis: Set<string>) => {
    const req = st.required.includes(f.id);
    const errs = (showErrors || touched.has(f.id)) ? (st.errors[f.id] ?? []) : [];
    const msgs = st.messages[f.id] ?? [];
    const box = h("div", { class: "field card", id: `f-${f.id}` });
    if (f.type === "instruction") {
      box.append(h("div", { class: "banner hermes" }, text(f.label, l)),
        h("button", { onclick: () => { const r = speak(text(f.label, l), l); if (!r.ok) toast(r.reason!, "error"); } }, "🔊 Read aloud"));
      return box;
    }
    box.append(h("label", { class: "q", for: `in-${f.id}` }, text(f.label, l), f.unit ? ` (${f.unit})` : "", req ? h("span", { class: "req" }, " *") : null));
    box.append(input(f));
    if (f.help) box.append(h("div", { class: "help" }, text(f.help, l)));
    if (f.knowledge_query || f.explain_topic) box.append(explainButton(f));
    for (const e of errs) if (ERROR_TEXT[e]) box.append(h("div", { class: "err" }, ERROR_TEXT[e]));
    if (errs.includes("rule")) for (const m of msgs) box.append(h("div", { class: "err" }, m));
    return box;
  };

  const explainButton = (f: Field) => {
    const out = h("div");
    const ask = (q: string) => {
      clear(out);
      const a = idx.ask(q, { packs, lang: l, domainPacks: wf.knowledge_packs });
      if (!a.supported) { out.append(h("div", { class: "banner warn" }, a.note ?? "Not covered by installed packs.")); return; }
      out.append(h("div", { class: "banner local" }, h("strong", null, a.entry!.title), h("p", null, a.excerpt ?? ""),
        h("div", { class: "muted" }, `Source: ${a.entry!.source} · from downloaded knowledge (offline)`),
        a.followups.length ? h("div", { class: "row", style: "margin-top:.4rem" }, ...a.followups.map((fq) => h("button", { onclick: () => ask(fq) }, fq))) : null));
    };
    return h("div", null, h("button", { onclick: () => ask(f.knowledge_query || f.explain_topic || text(f.label, "en")) }, "💡 Explain / help"), out);
  };

  const input = (f: Field): HTMLElement => {
    const v = draft.answers[f.id];
    const id = `in-${f.id}`;
    const ph = text(f.placeholder, l);
    switch (f.type) {
      case "text": return h("input", { id, value: (v as string) ?? "", placeholder: ph, oninput: (e: Event) => set(f.id, (e.target as HTMLInputElement).value, false), onchange: () => render() });
      case "multiline": {
        const ta = h("textarea", { id, placeholder: ph, oninput: (e: Event) => set(f.id, (e.target as HTMLTextAreaElement).value, false), onchange: () => render() }, (v as string) ?? "");
        return h("div", null, ta, dictation(f, ta));
      }
      case "number": return h("input", { id, type: "number", inputmode: "decimal", step: "any", value: v ?? "",
        oninput: (e: Event) => { const s = (e.target as HTMLInputElement).value; set(f.id, s === "" ? undefined : Number(s), false); }, onchange: () => render() });
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

  const dictation = (f: Field, ta: HTMLTextAreaElement) => {
    const wrap = h("div", { class: "row", style: "margin-top:.4rem" });
    void installedModels().then((ms) => {
      if (!ms.some((m) => m.capability === "stt")) return;
      const rec = new VoiceRecorder();
      let on = false;
      const btn = h("button", { onclick: async () => {
        if (!on) { try { await rec.start(); on = true; btn.textContent = "■ Stop dictation"; } catch (e) { toast((e as Error).message, "error"); } return; }
        on = false; btn.textContent = "Transcribing on device…"; btn.disabled = true;
        const { blob } = await rec.stop();
        try { const r = await transcribe(blob, l); ta.value = (ta.value ? ta.value + " " : "") + r.text; await set(f.id, ta.value); }
        catch (e) { toast((e as Error).message, "error"); }
        btn.disabled = false; btn.textContent = "🎙 Dictate (offline)";
      } }, "🎙 Dictate (offline)");
      wrap.append(btn);
    });
    return wrap;
  };

  const mediaItems = (f: Field) => (Array.isArray(draft.answers[f.id]) ? draft.answers[f.id] : draft.answers[f.id] ? [draft.answers[f.id]] : []) as any[];

  const photoInput = (f: Field) => {
    const items = mediaItems(f);
    const thumbs = h("div", { class: "thumbs" });
    for (const it of items) {
      void getAttachment(it.attachment_id).then((a) => {
        if (!a) return;
        const url = URL.createObjectURL(a.blob);
        const ocrBtn = h("button", { onclick: async () => {
          const langs = await ocrLanguages();
          if (!langs.length) return toast("Install an OCR pack in Offline Packs first.", "error");
          ocrBtn.textContent = "Reading text…";
          try {
            const r = await ocr(a.blob, langs.includes(l === "hi" ? "hin" : "eng") ? (l === "hi" ? "hin" : "eng") : langs[0]);
            it.ocr_text = r.text;
            a.meta = { ...a.meta, ocr_text: r.text };
            await d.put("attachments", a);
            await set(f.id, items);
          } catch (e) { toast((e as Error).message, "error"); ocrBtn.textContent = "Extract text (OCR)"; }
        } }, "Extract text (OCR)");
        thumbs.append(h("div", null, h("img", { src: url, alt: "photo" }),
          h("div", { class: "row" }, ocrBtn, h("button", { class: "danger", onclick: async () => {
            await d.delete("attachments", a.id); await set(f.id, items.filter((x) => x.attachment_id !== a.id));
          } }, "Remove")),
          it.ocr_text !== undefined ? h("textarea", { oninput: async (e: Event) => { it.ocr_text = (e.target as HTMLTextAreaElement).value; await set(f.id, items, false); } }, it.ocr_text) : null));
      });
    }
    const max = f.validation?.max_items ?? 10;
    const fileIn = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none", onchange: async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const c = await compressPhoto(file);
        const att = await saveAttachment(draft.id, f.id, "photo", c.blob, { width: c.width, height: c.height });
        await set(f.id, [...items, { attachment_id: att.id, taken_at: nowIso() }]);
      } catch (err) { toast(`Could not read photo: ${(err as Error).message}`, "error"); }
    } }) as HTMLInputElement;
    return h("div", null, thumbs, items.length < max ? h("div", { class: "row" },
      h("button", { onclick: () => fileIn.click() }, "📷 Take / add photo"), fileIn) : h("div", { class: "muted" }, `Maximum ${max} photos.`));
  };

  const audioInput = (f: Field) => {
    const items = mediaItems(f);
    const list = h("div");
    for (const it of items) {
      void getAttachment(it.attachment_id).then((a) => {
        if (!a) return;
        const tBtn = h("button", { onclick: async () => {
          tBtn.textContent = "Transcribing on device…";
          try { const r = await transcribe(a.blob, l); it.transcript = r.text; a.meta = { ...a.meta, transcript: r.text }; await d.put("attachments", a); await set(f.id, items); }
          catch (e) { toast((e as Error).message, "error"); tBtn.textContent = "Transcribe (offline)"; }
        } }, "Transcribe (offline)");
        list.append(h("div", { class: "card" }, h("audio", { controls: true, src: URL.createObjectURL(a.blob) }),
          h("div", { class: "muted" }, `${a.meta?.duration_s ?? "?"} s · ${fmtBytes(a.size)}`),
          it.transcript ? h("p", null, `“${it.transcript}”`) : tBtn,
          h("button", { class: "danger", onclick: async () => { await d.delete("attachments", a.id); await set(f.id, items.filter((x) => x.attachment_id !== a.id)); } }, "Remove")));
      });
    }
    const rec = new VoiceRecorder();
    let on = false;
    const btn = h("button", { onclick: async () => {
      if (!on) {
        try { await rec.start(); on = true; btn.textContent = "■ Stop recording"; } catch (e) { toast(`Microphone unavailable: ${(e as Error).message}`, "error"); }
        return;
      }
      on = false;
      const { blob, duration_s } = await rec.stop();
      const att = await saveAttachment(draft.id, f.id, "audio", blob, { duration_s });
      await set(f.id, [...items, { attachment_id: att.id, recorded_at: nowIso() }]);
    } }, "🎙 Record voice note");
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
      } }, "📍 Capture location")),
      h("details", null, h("summary", { class: "muted" }, "Enter manually"), h("div", { class: "row" }, lat, lon,
        h("button", { onclick: () => set(f.id, { lat: Number(lat.value), lon: Number(lon.value), accuracy: null, timestamp: nowIso(), source: "manual" }) }, "Save"))));
  };

  const signatureInput = (f: Field) => {
    const v = draft.answers[f.id] as any;
    if (v?.attachment_id) {
      const img = h("img", { alt: "signature", style: "max-width:100%;background:#fff;border-radius:8px" });
      void getAttachment(v.attachment_id).then((a) => { if (a) img.src = URL.createObjectURL(a.blob); });
      return h("div", null, img, h("button", { onclick: async () => { await d.delete("attachments", v.attachment_id); await set(f.id, undefined); } }, "Sign again"));
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
        h("div", null, `This inspection is still a draft and has not been saved for upload. Fix ${bad.length} answer(s): ${bad.join(", ")}.`)));
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
      notice.append(h("div", { class: "banner bad", role: "alert" }, h("strong", null, "Could not save this inspection"),
        h("div", null, `${(e as Error).message}. Your answers are still in the draft — nothing was lost.`)));
      render();
      return;
    }
    toast("Saved locally. Pending synchronisation.", "ok");
    void runSync();
    go(`#/results/${rec.id}`);
  };

  main.append(h("div", { class: "card" }, h("h2", null, text(wf.title, l)), h("div", { class: "muted" }, text(wf.description, l)),
    h("div", { class: "muted" }, "Everything you enter is saved on this device as you go — no connection needed.")), form);
  render();
  void voicesReady();
};

// ------------------------------------------------------------------ results
export const resultsView: View = async (main, p) => {
  const d = await db();
  const rec = await d.get("records", p.id);
  if (!rec) { main.append(h("div", { class: "banner bad" }, "Record not found on this device.")); return; }
  const wf = (await d.get("workflows", rec.workflow_id))?.definition;
  const stored = await d.get("reports", rec.id);
  const atts = await d.getAllFromIndex("attachments", "by_record", rec.id);
  const l = rec.lang;
  const lr = rec.local_results;
  const synced = rec.sync_status === "synced" || rec.sync_status === "received";

  main.append(h("div", { class: "card" }, h("h2", null, rec.workflow_title),
    h("dl", { class: "kv" }, h("dt", null, "Completed"), h("dd", null, fmtTime(rec.completed_at)),
      h("dt", null, "Record"), h("dd", null, rec.id), h("dt", null, "Workflow version"), h("dd", null, String(rec.workflow_version)),
      h("dt", null, "Questions answered"), h("dd", null, `${lr.questions_answered} of ${lr.questions_visible}`),
      h("dt", null, "Validation"), h("dd", null, lr.validation.complete ? "All required answers valid" : "Incomplete"))));

  // Sync + analysis status: never conflate the two.
  if (!synced) {
    main.append(h("div", { class: `banner ${rec.sync_status === "conflict" || rec.sync_status === "error" ? "bad" : "local"}` },
      h("strong", null, rec.sync_status === "conflict" ? "Conflict — needs your decision" : rec.sync_status === "error" ? "Sync problem" : "Saved locally. Pending synchronization."),
      h("div", { class: "muted" }, rec.sync_status === "error" ? rec.sync_error ?? "" : "Hermes has not confirmed this record yet. The findings below were generated on this device."),
      rec.sync_status === "pending" || rec.sync_status === "syncing" ? h("div", { class: "muted" }, (() => {
        const st = getSyncState();
        return !isOnline() ? "Device is offline — it will upload automatically when FieldKit is open and connected."
          : st.reachable === false ? "Network is up but Hermes is not reachable yet — will retry automatically."
            : "Uploading when Hermes confirms…";
      })()) : null,
      rec.sync_status === "conflict" ? h("a", { class: "btn", href: "#/sync" }, "Resolve") : null));
  } else {
    main.append(h("div", { class: "banner hermes" },
      h("strong", null, rec.sync_status === "synced" ? "Synchronised — durably received by Hermes" : "Received by Hermes — media still uploading"),
      h("div", { class: "muted" }, `Server acknowledged revision ${rec.server_ack?.revision ?? rec.server_revision} at ${fmtTime(rec.server_ack?.received_at)}`),
      h("div", null, "Hermes analysis: ", h("strong", null, ANALYSIS_TEXT[rec.analysis_status] ?? rec.analysis_status))));
  }

  // Local results
  const local = h("div", { class: "card" }, h("h2", null, h("span", { class: "tag-local" }, "Local findings"), " · generated on this device"),
    h("p", { class: "muted" }, "Rule-based results from the workflow's own classification. This is not Hermes analysis."));
  if (!lr.findings.length) local.append(h("p", { class: "muted" }, "No findings were triggered."));
  local.append(h("ul", { class: "clean" }, ...lr.findings.map((f) => h("li", null, sevBadge(f.severity), " ", h("strong", null, f.label),
    f.score !== undefined ? ` — score ${f.score}` : "", f.detail ? h("div", { class: "muted" }, f.detail) : null))));
  if (lr.explanations.length) {
    local.append(h("h3", null, "Explanations from downloaded knowledge"),
      ...lr.explanations.map((e) => h("div", { class: "banner local" }, h("strong", null, e.title), h("p", null, e.text), h("div", { class: "muted" }, `Source: ${e.source}`))));
  }
  if (lr.references.length) {
    local.append(h("h3", null, "Relevant references"), h("ul", { class: "clean" }, ...lr.references.map((r) => h("li", null,
      h("a", { href: `#/knowledge/${encodeURIComponent(`${r.pack_id}::${r.entry_id}`)}` }, r.title), h("div", { class: "muted" }, r.source)))));
  }
  main.append(local);

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
    else if (["photo", "audio"].includes(f.type)) shown = `${(Array.isArray(v) ? v : [v]).length} file(s)` + (Array.isArray(v) ? v.map((x: any) => x.ocr_text ? `\nOCR: ${x.ocr_text}` : x.transcript ? `\nTranscript: ${x.transcript}` : "").join("") : "");
    else if (f.type === "signature") shown = "Signed";
    else shown = `${v}${f.unit ? ` ${f.unit}` : ""}`;
    dl.append(h("dt", null, text(f.label, l)), h("dd", { style: "white-space:pre-wrap" }, shown));
  }
  resp.append(dl);
  if (atts.length) {
    const thumbs = h("div", { class: "thumbs", style: "margin-top:.6rem" });
    for (const a of atts) {
      const url = URL.createObjectURL(a.blob);
      thumbs.append(a.kind === "audio" ? h("audio", { controls: true, src: url }) : h("img", { src: url, alt: a.kind }));
    }
    resp.append(h("h3", null, "Photos, audio and signatures"), thumbs,
      h("div", { class: "muted" }, `${atts.filter((a) => a.uploaded).length} of ${atts.length} uploaded · kept on this device`));
  }
  main.append(resp);

  // Hermes report (online result, also readable offline after download)
  main.append(hermesSection(rec, stored));
};

function hermesSection(rec: LocalRecord, stored: StoredReport | undefined) {
  const box = h("div", { class: "card" }, h("h2", null, h("span", { class: "tag-hermes" }, "Hermes report")));
  if (stored) {
    const r = stored.report;
    box.append(h("p", { class: "muted" }, `Version ${r.version} · generated ${fmtTime(r.generated_at)} by ${r.generated_by} · downloaded ${fmtTime(stored.downloaded_at)} (available offline)`));
    reportBody(box, r);
  } else if (rec.sync_status !== "synced" && rec.sync_status !== "received") {
    box.append(h("p", { class: "muted" }, "Available after the record is synchronised and Hermes has analysed it."));
  } else {
    box.append(h("p", { class: "muted" }, `Analysis status: ${ANALYSIS_TEXT[rec.analysis_status] ?? rec.analysis_status}. No report downloaded yet.`));
  }
  if (rec.sync_status === "synced" || rec.sync_status === "received") {
    box.append(h("div", { class: "row" },
      h("button", { onclick: async () => {
        try { const n = await refreshReports(rec.id); toast(n ? "Report downloaded for offline use." : "No new report yet.", n ? "ok" : "info"); go(`#/results/${rec.id}?r=${Date.now()}`); }
        catch (e) { toast(e instanceof AuthRequired ? "Sign in to Hermes first." : `Offline or unavailable: ${(e as Error).message}`, "error"); }
      } }, stored ? "Check for newer report" : "Download report"),
      ["not_requested", "failed"].includes(rec.analysis_status) ? h("button", { onclick: async () => {
        try { await requestAnalysis(rec.id); toast("Analysis requested.", "ok"); go(`#/results/${rec.id}?r=${Date.now()}`); }
        catch (e) { toast((e as Error).message, "error"); }
      } }, "Request Hermes analysis") : null));
  }
  return box;
}

/** Body of a Hermes report — shared by this device's records and records from other devices. */
export function reportBody(box: HTMLElement, r: any): void {
  {
    if (r.requires_review) box.append(h("div", { class: "banner warn" }, h("strong", null, "Requires human review"), r.review_reason ? h("div", null, r.review_reason) : null));
    box.append(h("p", null, r.summary));
    if (r.images?.note) {
      box.append(h("div", { class: `banner ${r.images.analyzed === false ? "warn" : "hermes"}` },
        h("strong", null, r.images.analyzed === false ? "Photos not analysed" : "Photos analysed"), h("div", null, r.images.note)));
    }
    if (r.issues?.length) box.append(h("h3", null, "Issues identified"), h("ul", { class: "clean" }, ...r.issues.map((i: any) => h("li", null, sevBadge(i.severity), " ", h("strong", null, i.title), h("div", { class: "muted" }, i.evidence)))));
    if (r.missing_information?.length) box.append(h("h3", null, "Missing information"), h("ul", null, ...r.missing_information.map((m: string) => h("li", null, m))));
    if (r.suggested_actions?.length) box.append(h("h3", null, "Suggested actions"), h("ul", { class: "clean" }, ...r.suggested_actions.map((a: any) => h("li", null, h("span", { class: "badge" }, a.priority), " ", a.action))));
    if (r.followups?.length) box.append(h("h3", null, "Follow-up tasks"), h("ul", { class: "clean" }, ...r.followups.map((f: any) => h("li", null, h("strong", null, f.title), f.due_date ? ` — due ${f.due_date}` : "", f.detail ? h("div", { class: "muted" }, f.detail) : null))));
    if (r.references?.length) box.append(h("h3", null, "Supporting references"), h("ul", null, ...r.references.map((x: any) => h("li", null, `${x.title}${x.source ? ` — ${x.source}` : ""}`))));
  }
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
  if (!names) names = new Map((await api<{ devices: any[] }>("devices")).devices.map((x: any) => [x.id, x.label]));
  const wfDef = (await d.get("workflows", rec.workflow_id))?.definition;
  return { id: rec.id, workflow_id: rec.workflow_id, workflow_title: wfDef ? text(wfDef.title, await lang()) : (rec.workflow_title ?? rec.workflow_id),
    workflow_version: rec.workflow_version, device_id: rec.device_id ?? "",
    device_label: names.get(rec.device_id) || (rec.device_id === await deviceId() ? "This device" : "Another device"),
    completed_at: rec.completed_at, received_at: rec.received_at, revision: rec.revision, analysis_status: rec.analysis_status,
    answers: rec.answers, local_results: rec.local_results, report, report_id: rec.report_id ?? null, downloaded_at: nowIso(),
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
  let note = "";
  try {
    const [{ records }, { devices }, who] = await Promise.all([api<{ records: ServerLike[] }>("records?limit=500"),
      api<{ devices: any[] }>("devices"), api<{ user_id: string }>("me")]);
    index = { user_id: who.user_id, at: nowIso(), records, devices: devices.map((x: any) => [x.id, x.label]) };
    await setSetting("server_index", index);
    account = who.user_id;
    live = true;
  } catch (e) {
    note = e instanceof AuthRequired ? "Signed out. Sign in to Hermes to see every record in your account."
      : "Offline. Records marked “Needs internet” open once you're connected.";
  }
  const copies = await accountCopies(account);
  const names = new Map(index?.devices ?? []);
  const list = unifiedRecords(local, index?.records ?? [], copies, names, me);
  const localById = new Map(local.map((r) => [r.id, r]));
  const onlineOnly = list.filter((r) => r.availability === "needs-internet");

  const card = h("div", { class: "card", id: "saved-records" }, h("h2", null, "Saved Records"),
    h("p", { class: "muted" }, "Every record in your Hermes account, from all your devices. Records marked “Available offline” open without internet."));
  if (note) {
    card.append(h("div", { class: "banner warn", id: "records-note" }, note,
      note.startsWith("Signed out") ? h("div", null, h("button", { onclick: () => signIn("#/records") }, "Sign in")) : null));
  } else if (index) card.append(h("p", { class: "muted" }, `Up to date with Hermes · ${fmtTime(index.at)}`));
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
      r.availability === "waiting" ? h("span", null, " ", h("span", { class: "badge avail-waiting" }, "Waiting to sync")) : null,
      h("div", { class: "muted" }, [r.source === "This device" ? "This device" : `From ${r.source}`, fmtTime(r.when),
        r.syncNote ? STATUS_TEXT[r.syncNote] : null, `analysis: ${ANALYSIS_TEXT[r.analysis] ?? r.analysis}`, r.hasReport ? "report available" : null]
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
        rec?.sync_status === "synced" ? h("button", { class: "danger", onclick: async () => {
          await deleteRecord(r.id); toast("Removed from this device. It's still in your Hermes account.", "ok"); go(`#/records?r=${Date.now()}`);
        } }, "Remove from device") : null));
  })) : h("p", { class: "muted" }, "No records yet."));
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
      main.append(h("div", { class: "banner warn" }, e instanceof AuthRequired ? "Sign in to Hermes to open records from other devices."
        : "This record isn't kept on this device. Connect to the internet to open it."));
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
      h("dt", null, "Hermes analysis"), h("dd", null, ANALYSIS_TEXT[r.analysis_status] ?? r.analysis_status),
      h("dt", null, "Availability"), h("dd", { "data-availability": copy ? "kept-offline" : "needs-internet" }, copy ? `Available offline (downloaded ${fmtTime(copy.downloaded_at)})` : "Needs internet"))));
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of Object.entries(r.answers ?? {})) {
    const f = wf?.fields.find((x) => x.id === k);
    let shown = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (f?.type === "single_choice") shown = text(f.options?.find((o) => o.value === v)?.label, l) || shown;
    else if (f?.type === "checkbox") shown = v ? "Yes" : "No";
    else if (f?.type === "photo" || f?.type === "audio") shown = `${(Array.isArray(v) ? v : [v]).length} file(s), viewable in the dashboard`;
    dl.append(h("dt", null, f ? text(f.label, l) : k), h("dd", null, shown));
  }
  main.append(h("div", { class: "card" }, h("h2", null, "Answers"), dl));
  const rep = h("div", { class: "card", id: "remote-report" }, h("h2", null, h("span", { class: "tag-hermes" }, "Hermes report")));
  if (r.report) reportBody(rep, r.report); else rep.append(h("p", { class: "muted" }, "No Hermes report yet."));
  main.append(rep);
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
  const ops = await d.getAll("outbox");
  const st = getSyncState();
  const waiting = recs.filter((r) => !["synced", "received"].includes(r.sync_status));
  main.append(h("div", { class: "card" }, h("h2", null, "Pending Sync"),
    h("dl", { class: "kv" },
      h("dt", null, "Device network"), h("dd", null, isOnline() ? "Connected (as reported by the browser)" : "Offline"),
      h("dt", null, "Hermes"), h("dd", null, st.reachable === true ? `Reachable — last contact ${fmtTime(st.last_contact)}`
        : st.reachable === false ? "Not reachable (no internet, captive Wi-Fi, or server down)" : "Not checked yet"),
      h("dt", null, "Awaiting confirmation"), h("dd", null, `${st.awaiting} record(s)${st.attention ? ` · ${st.attention} need attention` : ""}`),
      h("dt", null, "Upload steps queued"), h("dd", null, String(ops.length)),
      h("dt", null, "Last server confirmation"), h("dd", null, fmtTime(st.last_confirmed)),
      h("dt", null, "Last attempt"), h("dd", null, fmtTime(st.last_run)), h("dt", null, "Last success"), h("dd", null, fmtTime(st.last_ok)),
      st.last_error ? h("dt", null, "Last error") : null, st.last_error ? h("dd", null, st.last_error) : null),
    h("div", { class: "row", style: "margin-top:.6rem" },
      h("button", { class: "primary", disabled: st.running, onclick: async () => { await runSync({ force: true }); go(`#/sync?r=${Date.now()}`); } }, st.running ? "Syncing…" : "Sync now"),
      h("button", { onclick: () => signIn("#/sync") }, "Sign in again"))));
  main.append(h("div", { class: "card" }, h("h2", null, `Waiting (${waiting.length})`),
    waiting.length ? h("ul", { class: "clean" }, ...waiting.map((r) => h("li", null, h("a", { href: `#/results/${r.id}` }, r.workflow_title),
      h("div", { class: "muted" }, `${STATUS_TEXT[r.sync_status]}${r.sync_error ? ` — ${r.sync_error}` : ""}`),
      r.conflict ? conflictBox(r) : null))) : h("p", { class: "muted" }, "Everything on this device has been received by Hermes.")));
};

function conflictBox(r: LocalRecord) {
  const keys = [...new Set([...Object.keys(r.answers), ...Object.keys(r.conflict!.server_answers)])]
    .filter((k) => JSON.stringify(r.answers[k]) !== JSON.stringify(r.conflict!.server_answers[k]));
  return h("div", { class: "banner bad" }, h("strong", null, "This record was changed elsewhere."),
    h("dl", { class: "kv" }, ...keys.flatMap((k) => [h("dt", null, k), h("dd", null, `this phone: ${JSON.stringify(r.answers[k])} · server: ${JSON.stringify(r.conflict!.server_answers[k])}`)])),
    h("div", { class: "row" },
      h("button", { onclick: async () => { await resolveConflict(r.id, "use_client"); go(`#/sync?r=${Date.now()}`); } }, "Keep this phone's version"),
      h("button", { onclick: async () => { await resolveConflict(r.id, "keep_server"); go(`#/sync?r=${Date.now()}`); } }, "Use server version")));
}

export const reportsView: View = async (main) => {
  const d = await db();
  const reps = await d.getAll("reports");
  const recs = new Map((await d.getAll("records")).map((r) => [r.id, r]));
  main.append(h("div", { class: "card" }, h("h2", null, "Downloaded Hermes reports"),
    h("p", { class: "muted" }, "These stay readable without internet."),
    reps.length ? h("ul", { class: "clean" }, ...reps.map((r) => h("li", null, h("a", { href: `#/results/${r.record_id}` }, recs.get(r.record_id)?.workflow_title ?? r.record_id),
      h("div", { class: "muted" }, `v${r.version} · downloaded ${fmtTime(r.downloaded_at)}${r.report.requires_review ? " · requires review" : ""}`),
      h("div", null, String(r.report.summary ?? "").slice(0, 200))))) : h("p", { class: "muted" }, "No reports downloaded yet."),
    h("button", { onclick: async () => {
      try { const n = await refreshReports(); toast(`${n} new report(s) downloaded.`, "ok"); go(`#/reports?r=${Date.now()}`); }
      catch (e) { toast(e instanceof AuthRequired ? "Sign in to Hermes first." : "Offline — showing downloaded reports.", "error"); }
    } }, "Check for new reports")));
  const copies = (await accountCopies()).filter((c) => c.report);
  if (copies.length) {
    main.append(h("div", { class: "card", id: "other-device-reports" }, h("h2", null, "From your other devices (available offline)"),
      h("ul", { class: "clean" }, ...copies.map((c) => h("li", null, h("a", { href: `#/remote/${c.id}` }, c.workflow_title),
        h("div", { class: "muted" }, `${c.device_label} · kept ${fmtTime(c.downloaded_at)}${c.report.requires_review ? " · requires review" : ""}`),
        h("div", null, String(c.report.summary ?? "").slice(0, 200)))))));
  }
};

export async function whoAmI(): Promise<{ user_id: string; display_name: string; provider?: string } | null> {
  try { return await api("me"); } catch { return null; }
}

export type { Attachment };
