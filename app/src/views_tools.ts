// Offline Assistant, Knowledge, Dictionary, Translate, OCR, Offline Packs and Settings.
import { AuthRequired } from "./api";
import { APP_VERSION, signIn } from "./config";
import { db, deleteRecord, deviceId, getSetting, setSetting } from "./db";
import { text } from "./engine";
import {
  capabilities, installedModels, installOcr, installStt, installTranslation, localVoices, ocr, ocrLanguages, removeModel,
  speak, transcribe, translate, translationPairs, voicesReady,
} from "./intel";
import { KnowledgeIndex, lookup } from "./knowledge";
import { VoiceRecorder } from "./media";
import {
  fetchCatalog, installedPacks, installedWorkflows, installPack, installWorkflow, removePack, removeWorkflow, requestPersistence,
  storageInfo, updatesAvailable,
} from "./packs";
import { getSyncState } from "./sync";
import { clear, fmtBytes, fmtTime, h, isOnline, toast } from "./util";
import { authBanner, go, lang, readiness, whoAmI, type View } from "./views_core";

// ------------------------------------------------------------------ assistant
export const assistantView: View = async (main) => {
  const l = await lang();
  const packs = await installedPacks("knowledge");
  const idx = new KnowledgeIndex(packs);
  const out = h("div");
  const q = h("input", { placeholder: "Ask a question, e.g. “Explain photosynthesis”", enterkeyhint: "search" }) as HTMLInputElement;
  const ask = async (query: string) => {
    q.value = query;
    clear(out);
    let a = idx.ask(query, { packs, lang: l });
    let via = "";
    // Multilingual: if a Devanagari question finds nothing, try the installed offline hi→en model.
    if (!a.supported && /[ऀ-ॿ]/.test(query) && (await translationPairs()).some(([f, t]) => f === "hi" && t === "en")) {
      try {
        const tq = await translate(query, "hi", "en");
        const b = idx.ask(tq.text, { packs, lang: l });
        if (b.supported) { a = b; via = `Searched using offline translation: “${tq.text}”`; }
      } catch { /* keep original answer */ }
    }
    if (!a.supported) {
      out.append(h("div", { class: "banner warn" }, h("strong", null, "Not covered by your downloaded knowledge"), h("div", null, a.note ?? ""),
        a.others.length ? h("div", null, "Closest topics: ", ...a.others.map((o) => h("button", { onclick: () => go(`#/knowledge/${encodeURIComponent(o.key)}`) }, o.title))) : null));
      return;
    }
    const e = a.entry!;
    out.append(h("div", { class: "card" }, h("h2", null, e.title), via ? h("div", { class: "muted" }, via) : null,
      h("p", null, a.excerpt ?? e.text),
      h("div", { class: "muted" }, `Source: ${e.source} · ${e.pack_title} · answered offline from downloaded knowledge (retrieval, not generated)`),
      h("div", { class: "row", style: "margin-top:.5rem" },
        h("a", { class: "btn", href: `#/knowledge/${encodeURIComponent(e.key)}` }, "Full explanation"),
        h("button", { onclick: () => { const r = speak(a.excerpt ?? e.text, l); if (!r.ok) toast(r.reason!, "error"); } }, "🔊 Read aloud")),
      a.followups.length ? h("div", null, h("h3", null, "Follow-up questions"), h("div", { class: "row" }, ...a.followups.map((f) => h("button", { onclick: () => ask(f) }, f)))) : null,
      a.related.length ? h("div", null, h("h3", null, "Related topics"), h("div", { class: "row" }, ...a.related.map((r) => h("a", { class: "btn", href: `#/knowledge/${encodeURIComponent(r.key)}` }, r.title)))) : null));
  };
  main.append(h("div", { class: "card" }, h("h2", null, "Offline Assistant"),
    h("p", { class: "muted" }, `Answers come from ${idx.size} entries in your downloaded knowledge packs, with sources. It does not invent answers.`),
    h("form", { class: "row", onsubmit: (e: Event) => { e.preventDefault(); void ask(q.value); } }, h("div", { class: "grow" }, q), h("button", { class: "primary" }, "Ask")),
    h("div", { class: "row", style: "margin-top:.5rem" }, ...["Explain photosynthesis", "Common reasons for equipment vibration", "Causes of leaf discoloration"]
      .map((s) => h("button", { onclick: () => ask(s) }, s)))), out);
};

// ------------------------------------------------------------------ knowledge
export const knowledgeView: View = async (main, p) => {
  const l = await lang();
  const packs = await installedPacks("knowledge");
  if (p.key) {
    const [pid, eid] = decodeURIComponent(p.key).split("::");
    const pack = packs.find((x) => x.id === pid);
    const e = pack?.content.entries.find((x: any) => x.id === eid);
    if (!e) { main.append(h("div", { class: "banner warn" }, "Topic not found in installed packs.")); return; }
    main.append(h("div", { class: "card" }, h("h2", null, text(e.title, l)), h("div", { class: "muted" }, `${e.type} · ${text(pack!.content.title, l)}`),
      h("p", { style: "white-space:pre-wrap" }, text(e.text, l)), h("div", { class: "muted" }, `Source: ${e.source || text(pack!.content.source?.title, l)}`),
      h("button", { onclick: () => { const r = speak(text(e.text, l), l); if (!r.ok) toast(r.reason!, "error"); } }, "🔊 Read aloud"),
      (e.related ?? []).length ? h("div", null, h("h3", null, "Related"), ...(e.related as string[]).map((r) => {
        const re = pack!.content.entries.find((x: any) => x.id === r);
        return re ? h("a", { class: "btn", href: `#/knowledge/${encodeURIComponent(`${pid}::${r}`)}` }, text(re.title, l)) : null;
      })) : null));
    return;
  }
  main.append(h("div", { class: "card" }, h("h2", null, "Knowledge"),
    packs.length ? null : h("p", { class: "muted" }, "No knowledge packs installed."),
    ...packs.map((pk) => h("div", null, h("h3", null, text(pk.content.title, l)), h("ul", { class: "clean" },
      ...pk.content.entries.map((e: any) => h("li", null, h("a", { href: `#/knowledge/${encodeURIComponent(`${pk.id}::${e.id}`)}` }, text(e.title, l)),
        h("span", { class: "muted" }, ` · ${e.type}`))))))));
};

// ------------------------------------------------------------------ dictionary
export const dictionaryView: View = async (main) => {
  const packs = await installedPacks("dictionary");
  const out = h("div");
  const q = h("input", { placeholder: "Search a word (English or हिंदी)", oninput: () => render() }) as HTMLInputElement;
  const render = () => {
    clear(out);
    const hits = lookup(packs, q.value);
    if (q.value && !hits.length) out.append(h("p", { class: "muted" }, "Not found in installed dictionaries."));
    for (const d of hits) {
      out.append(h("div", { class: "card" }, h("h2", null, d.term, h("span", { class: "muted" }, ` · ${d.lang}`)), h("p", null, d.definition),
        Object.keys(d.translations).length ? h("div", null, "Translations: ", Object.entries(d.translations).map(([k, v]) => `${k}: ${v}`).join(" · ")) : null,
        d.synonyms.length ? h("div", { class: "muted" }, `Synonyms: ${d.synonyms.join(", ")}`) : null,
        d.examples.length ? h("ul", null, ...d.examples.map((x) => h("li", null, x))) : null,
        d.related.length ? h("div", { class: "row" }, "Related: ", ...d.related.map((r) => h("button", { onclick: () => { q.value = r; render(); } }, r))) : null,
        h("div", { class: "muted" }, `Source: ${d.source}${d.match !== "exact" ? ` · ${d.match} match` : ""}`)));
    }
  };
  main.append(h("div", { class: "card" }, h("h2", null, "Dictionary"), h("p", { class: "muted" }, `${packs.length} dictionary pack(s) on this device · works offline`), q), out);
};

// ------------------------------------------------------------------ translate
export const translateView: View = async (main) => {
  const pairs = await translationPairs();
  if (!pairs.length) {
    main.append(h("div", { class: "card" }, h("h2", null, "Translate"), h("p", null, "No offline translation model is installed."),
      h("a", { class: "btn primary", href: "#/packs" }, "Install translation in Offline Packs")));
    return;
  }
  const sel = h("select", null, ...pairs.map(([f, t]) => h("option", { value: `${f}>${t}` }, `${f} → ${t}`))) as HTMLSelectElement;
  const src = h("textarea", { placeholder: "Type or paste a sentence…" }) as HTMLTextAreaElement;
  const out = h("div");
  const btn = h("button", { class: "primary", onclick: async () => {
    const [f, t] = sel.value.split(">");
    if (!src.value.trim()) return;
    btn.disabled = true; btn.textContent = "Translating on device…";
    clear(out);
    try {
      const r = await translate(src.value, f, t);
      out.append(h("div", { class: "card" }, h("p", { style: "font-size:1.1rem" }, r.text),
        h("div", { class: "muted" }, `Translated on this device with ${r.model} in ${r.ms} ms — no network used.`),
        h("button", { onclick: () => { const s = speak(r.text, t); if (!s.ok) toast(s.reason!, "error"); } }, "🔊 Read aloud")));
    } catch (e) { out.append(h("div", { class: "banner bad" }, (e as Error).message)); }
    btn.disabled = false; btn.textContent = "Translate";
  } }, "Translate");
  main.append(h("div", { class: "card" }, h("h2", null, "Translate (offline)"), sel, h("div", { style: "height:.5rem" }), src,
    h("div", { class: "row", style: "margin-top:.5rem" }, btn, sttButton(src))), out);
};

function sttButton(target: HTMLTextAreaElement) {
  const wrap = h("span");
  void installedModels().then((ms) => {
    if (!ms.some((m) => m.capability === "stt")) return;
    const rec = new VoiceRecorder();
    let on = false;
    const b = h("button", { onclick: async () => {
      if (!on) { try { await rec.start(); on = true; b.textContent = "■ Stop"; } catch (e) { toast((e as Error).message, "error"); } return; }
      on = false; b.textContent = "Transcribing…";
      const { blob } = await rec.stop();
      try { target.value = (await transcribe(blob, await lang())).text; } catch (e) { toast((e as Error).message, "error"); }
      b.textContent = "🎙 Speak";
    } }, "🎙 Speak");
    wrap.append(b);
  });
  return wrap;
}

// ------------------------------------------------------------------ OCR
export const ocrView: View = async (main) => {
  const langs = await ocrLanguages();
  if (!langs.length) {
    main.append(h("div", { class: "card" }, h("h2", null, "Scan text"), h("p", null, "No offline OCR language pack is installed."), h("a", { class: "btn primary", href: "#/packs" }, "Install OCR")));
    return;
  }
  const sel = h("select", null, ...langs.map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
  const out = h("textarea", { placeholder: "Recognised text appears here (editable)" }) as HTMLTextAreaElement;
  const status = h("div", { class: "muted" });
  const prog = h("progress", { max: 1, value: 0 }) as HTMLProgressElement;
  const file = h("input", { type: "file", accept: "image/*", capture: "environment", onchange: async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    status.textContent = "Reading text on this device…";
    try {
      const r = await ocr(f, sel.value, (p) => { if (p.progress !== undefined) prog.value = p.progress; });
      out.value = r.text;
      status.textContent = `Done offline · confidence ${Math.round(r.confidence)}%`;
    } catch (err) { status.textContent = (err as Error).message; }
  } });
  main.append(h("div", { class: "card" }, h("h2", null, "Scan text (OCR, offline)"), h("div", { class: "row" }, sel, file), prog, status, out,
    h("button", { onclick: async () => { await navigator.clipboard?.writeText(out.value).catch(() => undefined); toast("Copied"); } }, "Copy")));
};

// ------------------------------------------------------------------ packs
export const packsView: View = async (main) => {
  const [wfs, packs, models] = await Promise.all([installedWorkflows(), installedPacks(), installedModels()]);
  const l = await lang();
  main.append(h("div", { class: "card" }, h("h2", null, "On this device"),
    h("h3", null, "Workflows"), wfs.length ? h("ul", { class: "clean" }, ...wfs.map((w) => h("li", { class: "row" },
      h("span", { class: "grow" }, `${text(w.definition.title, l)} · v${w.version}`),
      h("button", { class: "danger", onclick: async () => { try { await removeWorkflow(w.id); go(`#/packs?r=${Date.now()}`); } catch (e) { toast((e as Error).message, "error"); } } }, "Remove"))))
      : h("p", { class: "muted" }, "None"),
    h("h3", null, "Knowledge, dictionaries"), packs.length ? h("ul", { class: "clean" }, ...packs.map((p) => h("li", { class: "row" },
      h("span", { class: "grow" }, `${p.title} · ${p.kind} v${p.version} · ${fmtBytes(p.size)}`, h("div", { class: "muted" }, `sha256 ${p.sha256.slice(0, 12)}… verified`)),
      h("button", { class: "danger", onclick: async () => { await removePack(p.id); go(`#/packs?r=${Date.now()}`); } }, "Remove"))))
      : h("p", { class: "muted" }, "None"),
    h("h3", null, "On-device models"), models.length ? h("ul", { class: "clean" }, ...models.map((m) => h("li", { class: "row" },
      h("span", { class: "grow" }, `${m.title}`, h("div", { class: "muted" }, `${m.verified ? "✔" : "⚠"} ${m.verify_detail ?? ""} · installed ${fmtTime(m.installed_at)}`)),
      h("button", { class: "danger", onclick: async () => { await removeModel(m.id); go(`#/packs?r=${Date.now()}`); } }, "Remove"))))
      : h("p", { class: "muted" }, "None")));

  const avail = h("div", { class: "card" }, h("h2", null, "Available from Hermes"));
  main.append(avail);
  if (!isOnline()) { avail.append(h("p", { class: "muted" }, "Connect to the internet to download workflows and packs.")); return; }
  let cat;
  try { cat = await fetchCatalog(); } catch (e) {
    if (e instanceof AuthRequired) { avail.append(authBanner()); return; }
    avail.append(h("p", { class: "muted" }, `Could not reach Hermes: ${(e as Error).message}`)); return;
  }
  const upd = updatesAvailable(cat, wfs, packs);
  if (upd.workflows.length || upd.packs.length) avail.append(h("div", { class: "banner warn" }, `Updates available: ${[...upd.workflows, ...upd.packs].join(", ")}`));
  avail.append(h("h3", null, "Workflows"), h("ul", { class: "clean" }, ...cat.workflows.map((w: any) => {
    const have = wfs.find((x) => x.id === w.id);
    const b = h("button", { class: have && !upd.workflows.includes(w.id) ? "" : "primary", onclick: async () => {
      b.disabled = true; b.textContent = "Downloading…";
      try { const r = await installWorkflow(w.id); toast(`Downloaded ${w.title} (+${r.packs.length} packs)`, "ok"); if (r.failed.length) toast(`Failed: ${r.failed.join(", ")}`, "error"); }
      catch (e) { toast((e as Error).message, "error"); }
      go(`#/packs?r=${Date.now()}`);
    } }, have ? (upd.workflows.includes(w.id) ? "Update" : "Re-download") : "Download for offline");
    return h("li", { class: "row" }, h("span", { class: "grow" }, h("strong", null, w.title), h("div", { class: "muted" }, `${w.domain || "general"} · v${w.published_version}`)), b);
  })));
  avail.append(h("h3", null, "Knowledge & dictionary packs"), h("ul", { class: "clean" }, ...cat.packs.filter((p: any) => p.kind !== "model").map((p: any) => {
    const have = packs.find((x) => x.id === p.id);
    const b = h("button", { onclick: async () => { try { await installPack(p.id); toast("Installed", "ok"); } catch (e) { toast((e as Error).message, "error"); } go(`#/packs?r=${Date.now()}`); } },
      have ? (upd.packs.includes(p.id) ? "Update" : "Re-download") : "Install");
    return h("li", { class: "row" }, h("span", { class: "grow" }, `${p.title} · ${p.kind} v${p.version} · ${fmtBytes(p.size)}`), b);
  })));
  avail.append(h("h3", null, "On-device models (downloaded from pinned upstream sources)"),
    h("p", { class: "muted" }, "Large one-time downloads. Use Wi-Fi. After installation they work with no connection."),
    h("ul", { class: "clean" }, ...cat.models.packs.map((m: any) => modelRow(m, models.some((x) => x.id === m.id)))));
};

function modelRow(m: any, installed: boolean) {
  const prog = h("progress", { max: 100, value: 0, style: "display:none" }) as HTMLProgressElement;
  const status = h("div", { class: "muted" }, `${m.license} · ${fmtBytes(m.download_size)}${m.quality_note ? ` · ${m.quality_note}` : ""}`);
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
      const fn = m.capability === "translation" ? installTranslation : m.capability === "stt" ? installStt : installOcr;
      const r = await fn(m, onProgress);
      status.textContent = `Installed and self-tested on this device · ${r.verify_detail}`;
      toast(`${m.title} ready offline`, "ok");
    } catch (e) { status.textContent = `Install failed: ${(e as Error).message}`; }
    b.disabled = false;
  } }, installed ? "Reinstall" : "Install");
  return h("li", null, h("div", { class: "row" }, h("strong", { class: "grow" }, m.title), b), status, prog);
}

// ------------------------------------------------------------------ settings
export const settingsView: View = async (main) => {
  const [l, dev, st, me, caps, checks] = await Promise.all([lang(), deviceId(), storageInfo(), isOnline() ? whoAmI() : Promise.resolve(null), capabilities(), readiness()]);
  await voicesReady();
  const d = await db();
  main.append(h("div", { class: "card" }, h("h2", null, "Settings"),
    h("label", { class: "q" }, "Workflow language"),
    h("select", { onchange: async (e: Event) => { await setSetting("lang", (e.target as HTMLSelectElement).value); toast("Saved"); } },
      ...[["en", "English"], ["hi", "हिंदी"]].map(([v, n]) => h("option", { value: v, selected: v === l }, n))),
    h("dl", { class: "kv", style: "margin-top:.8rem" },
      h("dt", null, "Account"), h("dd", null, me ? `${me.display_name || me.user_id}` : getSyncState().auth_required ? "Session expired" : isOnline() ? "Not signed in" : "Offline"),
      h("dt", null, "Device"), h("dd", null, dev), h("dt", null, "App version"), h("dd", null, APP_VERSION),
      h("dt", null, "Storage used"), h("dd", null, st.supported ? `${fmtBytes(st.usage)} of ${fmtBytes(st.quota)}` : "unknown"),
      h("dt", null, "Persistent storage"), h("dd", null, st.persisted === null ? "not supported" : st.persisted ? "granted" : "not granted"),
      h("dt", null, "Local voices"), h("dd", null, localVoices().map((v) => v.lang).join(", ") || "none on this device"),
      h("dt", null, "Native on-device speech"), h("dd", null, caps.nativeLocalStt),
      h("dt", null, "Offline ready"), h("dd", null, checks.slice(0, 3).every((c) => c.ok !== false) ? "yes" : "no")),
    h("div", { class: "row", style: "margin-top:.8rem" },
      h("button", { onclick: async () => { const r = await requestPersistence(); toast(r ? "Persistent storage granted" : "The browser declined; data may be evicted under storage pressure.", r ? "ok" : "error"); go(`#/settings?r=${Date.now()}`); } }, "Request persistent storage"),
      h("button", { onclick: () => signIn("#/settings") }, "Sign in to Hermes"),
      h("a", { class: "btn", href: "#/diagnostics" }, "Connection diagnostics"))));

  main.append(h("div", { class: "card" }, h("h2", null, "Backup & recovery"),
    h("p", { class: "muted" }, "Export everything on this device (records, media, reports, drafts) to a file you can keep or move to another device."),
    h("div", { class: "row" },
      h("button", { onclick: async () => exportData() }, "Export data"),
      h("label", { class: "btn" }, "Import backup", h("input", { type: "file", accept: "application/json", style: "display:none", onchange: async (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) { const n = await importData(f); toast(`Restored ${n.records} record(s), ${n.attachments} file(s). Existing items were kept.`, "ok"); }
      } })))));

  const synced = (await d.getAll("records")).filter((r) => r.sync_status === "synced");
  main.append(h("div", { class: "card" }, h("h2", null, "Free up space"),
    h("p", { class: "muted" }, `${synced.length} record(s) are fully synchronised and can be removed from this phone. Unsynchronised records are never removed.`),
    h("button", { class: "danger", disabled: !synced.length, onclick: async () => {
      for (const r of synced) await deleteRecord(r.id);
      toast(`Removed ${synced.length} synced record(s).`, "ok"); go(`#/settings?r=${Date.now()}`);
    } }, "Remove synced records")));
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

async function importData(file: File): Promise<{ records: number; attachments: number }> {
  const data = JSON.parse(await file.text());
  if (data.format !== "fieldkit-backup") throw new Error("Not a FieldKit backup file");
  const d = await db();
  let records = 0, attachments = 0;
  for (const r of data.records ?? []) if (!(await d.get("records", r.id))) { await d.put("records", r); records++; }
  for (const r of data.drafts ?? []) if (!(await d.get("drafts", r.id))) await d.put("drafts", r);
  for (const r of data.reports ?? []) if (!(await d.get("reports", r.record_id))) await d.put("reports", r);
  for (const a of data.attachments ?? []) {
    if (await d.get("attachments", a.id)) continue;
    const bin = Uint8Array.from(atob(a.data_b64), (c) => c.charCodeAt(0));
    const { data_b64: _drop, ...rest } = a;
    await d.put("attachments", { ...rest, blob: new Blob([bin], { type: a.mime }) });
    attachments++;
  }
  return { records, attachments };
}

export async function storedLang(): Promise<string> { return getSetting("lang", "en"); }

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
      } else if (ct.includes("json") && body && typeof body === "object" && ("user_id" in body || "detail" in body)) {
        msg = h("div", { class: "banner hermes" }, h("strong", null, `Hermes answered just now (HTTP ${res.status}).`),
          h("div", null, `Server clock: ${date ?? "n/a"}. This phone HAS a working connection to Hermes right now — `
            + "so the internet is not actually off. Check that both Wi-Fi and Mobile Data are grey in Control Centre "
            + "(Airplane mode can keep Wi-Fi on)."));
      } else {
        msg = h("div", { class: "banner warn" }, h("strong", null, `Something answered (HTTP ${res.status}, ${ct || "no type"}) but it is NOT Hermes.`),
          h("div", null, `Answered by: ${res.url || "unknown"}. Body starts: ${typeof body === "string" ? body : JSON.stringify(body)?.slice(0, 160)}`));
      }
    } catch {
      msg = h("div", { class: "banner local" }, h("strong", null, "No connection."),
        h("div", null, "The request could not leave the phone. FieldKit is correctly working offline."));
    }
    clear(verdict);
    verdict.append(msg);
    paintList();
  };

  main.append(h("div", { class: "card" }, h("h2", null, "Connection diagnostics"),
    h("p", { class: "muted" }, "Shows exactly what FieldKit sent and what came back. Stored only on this phone."),
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
