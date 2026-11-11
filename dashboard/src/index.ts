// FieldKit tab for the Hermes dashboard. Bundled by esbuild into a single IIFE (dist/index.js).
// React, UI primitives and authenticated fetch come from window.__HERMES_PLUGIN_SDK__ (never bundled).
// Visual language: a field manifest. Records are ledger lines with a status mark; the sync track is the one
// bold element. Ink and paper come from the Hermes theme (--midground-base / --background-base).
import qrcode from "qrcode-generator";

declare global { interface Window { __HERMES_PLUGIN_SDK__: any; __HERMES_PLUGINS__: any } }

(function () {
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;
  const React = SDK.React;
  const h = React.createElement;
  const { useState, useEffect, useCallback } = SDK.hooks;
  const API = "/api/plugins/fieldkit";
  const get = (p: string): Promise<any> => SDK.fetchJSON(`${API}/${p}`);
  const post = (p: string, body?: unknown): Promise<any> => SDK.fetchJSON(`${API}/${p}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  // Public plugin-asset address: outside the /api auth gate, so launches with an expired session open the app
  // (which offers sign-in) instead of a raw 401 JSON page.
  const APP_PATH = "/dashboard-plugins/fieldkit/app_dist/index.html";
  const appUrl = () => `${window.location.origin}${APP_PATH}`;

  // ---------------------------------------------------------------- styles (scoped to .fk)
  const CSS = `
.fk{--ink:var(--midground-base,#1d2a2a);--paper:var(--background-base,#fbfaf7);
  --rule:color-mix(in srgb,var(--ink) 14%,transparent);--rule-soft:color-mix(in srgb,var(--ink) 7%,transparent);
  --mute:color-mix(in srgb,var(--ink) 62%,transparent);--wash:color-mix(in srgb,var(--ink) 4%,transparent);
  --ok:color-mix(in srgb,#3fae80 72%,var(--ink));--wait:color-mix(in srgb,#d39a2c 72%,var(--ink));
  --bad:color-mix(in srgb,#e0533b 78%,var(--ink));--old:color-mix(in srgb,#8f80d6 72%,var(--ink));
  color:var(--ink);font-family:var(--theme-font-sans,inherit);font-size:13px;line-height:1.45;
  padding:16px;max-width:1240px;font-variant-numeric:tabular-nums}
.fk *{box-sizing:border-box}
.fk ::selection{background:color-mix(in srgb,var(--ink) 25%,transparent)}
.fk input{caret-color:var(--ink)}
.fk h2{font-size:15px;font-weight:600;margin:0}
.fk h3{font-size:13px;font-weight:600;margin:0 0 6px}
.fk p{margin:0}
.fk .mute{color:var(--mute)}
.fk .id{font-family:var(--theme-font-mono,ui-monospace,monospace);font-size:11px;color:var(--mute);word-break:break-all}
.fk-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--rule);margin-bottom:16px}
.fk-chip{font-size:12px;padding:1px 8px;border:1px solid var(--rule);border-radius:999px;color:var(--mute);white-space:nowrap}
.fk-chip.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 50%,transparent)}
.fk-tabs{margin-left:auto;display:flex;border:1px solid var(--rule);border-radius:7px;overflow:hidden}
.fk-tabs button{all:unset;cursor:pointer;padding:6px 14px;font-size:13px;color:var(--mute);border-left:1px solid var(--rule)}
.fk-tabs button:first-child{border-left:0}
.fk-tabs button:hover{color:var(--ink);background:var(--wash)}
.fk-tabs button[aria-pressed=true]{color:var(--paper);background:var(--ink);font-weight:600}
.fk button:focus-visible,.fk input:focus-visible,.fk summary:focus-visible,.fk a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.fk-btn{all:unset;cursor:pointer;font-size:12px;padding:4px 10px;border:1px solid var(--rule);border-radius:6px;white-space:nowrap}
.fk-btn:hover{background:var(--wash);border-color:color-mix(in srgb,var(--ink) 30%,transparent)}
.fk-btn.solid{background:var(--ink);color:var(--paper);border-color:var(--ink);font-weight:600}
.fk-btn[disabled]{opacity:.5;cursor:default}
.fk-sec{margin-bottom:24px}
.fk-sec>header{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.fk-sec>header .act{margin-left:auto;display:flex;gap:8px;align-items:center}
.fk-cols{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,8fr);gap:28px}
.fk-err{color:var(--bad);margin:6px 0}
.fk-empty{padding:14px 0;color:var(--mute);border-top:1px solid var(--rule)}
/* sync track */
.fk-track{display:flex;height:14px;border-radius:3px;overflow:hidden;background:var(--rule-soft);margin:10px 0 8px}
.fk-track>span{height:100%;min-width:3px}
.fk-legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px}
.fk-legend b{font-size:15px;font-weight:650;margin-right:4px}
.fk-dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:1px}
.fk-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);margin-top:12px}
.fk-stats>div{padding:8px 12px 8px 0}
.fk-stats>div+div{padding-left:12px;border-left:1px solid var(--rule-soft)}
.fk-stats dt{font-size:12px;color:var(--mute)}
.fk-stats dd{margin:0;font-size:20px;font-weight:650}
.fk-stats dd.small{font-size:13px;font-weight:500;padding-top:6px}
.fk-stats .bad{color:var(--bad)}.fk-stats .wait{color:var(--wait)}
/* ledger */
.fk-ledger{border-top:1px solid var(--rule)}
.fk-line{display:grid;grid-template-columns:8px minmax(0,1fr) minmax(0,170px) 120px 64px 58px;gap:12px;align-items:center;
  padding:6px 0;border-bottom:1px solid var(--rule-soft)}
.fk-line.compact{grid-template-columns:8px minmax(0,1fr) 64px 58px}
.fk-line.compact .state{display:none}
.fk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.fk-more{all:unset;cursor:pointer;font-size:12px;color:var(--mute);padding:8px 0;text-decoration:underline;text-underline-offset:3px}
.fk-more:hover{color:var(--ink)}
.fk-line .rail{width:8px;height:8px;border-radius:2px;align-self:start;margin-top:6px}
.fk-line .t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fk-line .sub{font-weight:400;color:var(--mute)}
.fk-line .when{font-size:12px;color:var(--mute);text-align:right}
.fk-line .state{font-size:12px}
.fk-line.open{background:var(--wash)}
.fk-detail{border-bottom:1px solid var(--rule);padding:12px 12px 16px 20px;background:var(--wash)}
.fk-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.fk-kv{display:grid;grid-template-columns:minmax(110px,38%) 1fr;margin:0;border-top:1px solid var(--rule-soft)}
.fk-kv dt,.fk-kv dd{margin:0;padding:4px 8px 4px 0;border-bottom:1px solid var(--rule-soft)}
.fk-kv dt{color:var(--mute)}
.fk-kv dd{white-space:pre-wrap;word-break:break-word}
.fk-kv .diff{background:color-mix(in srgb,var(--wait) 16%,transparent)}
.fk-files{display:flex;flex-wrap:wrap;gap:10px}
.fk-files figure{margin:0;width:180px}
.fk-files img{display:block;max-width:180px;max-height:180px;border-radius:4px;border:1px solid var(--rule)}
.fk-files img.sig{background:#fff}
.fk-files audio{width:180px}
.fk-files figcaption{font-size:12px;color:var(--mute);margin-top:3px}
.fk-files .pending{width:180px;padding:10px;border:1px dashed var(--rule);border-radius:4px;font-size:12px;color:var(--mute)}
.fk details>summary{cursor:pointer;color:var(--mute);font-size:12px;margin-top:8px}
.fk pre{white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto;background:var(--rule-soft);padding:8px;border-radius:4px;margin:6px 0 0}
.fk-legacy{margin-top:14px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--old) 40%,transparent);border-radius:8px;background:color-mix(in srgb,var(--old) 6%,transparent)}
.fk-legacy h3{color:var(--old)}
.fk-hint{font-size:12px;color:var(--mute);margin-top:12px}
.fk-filter{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.fk-filter input{background:transparent;color:var(--ink);border:1px solid var(--rule);border-radius:6px;padding:5px 9px;font:inherit;width:320px;max-width:100%}
.fk-table{width:100%;border-collapse:collapse}
.fk-table th{text-align:left;font-weight:500;font-size:12px;color:var(--mute);padding:4px 12px 4px 0;border-bottom:1px solid var(--rule)}
.fk-table td{padding:6px 12px 6px 0;border-bottom:1px solid var(--rule-soft);vertical-align:top}
.fk-conflict{border:1px solid color-mix(in srgb,var(--bad) 45%,transparent);border-radius:8px;padding:10px 12px;margin-bottom:12px}
.fk-conflict .acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.fk-mobile{display:grid;grid-template-columns:auto minmax(0,1fr);gap:24px;align-items:start}
.fk-mobile img{background:#fff;border-radius:6px;padding:4px;display:block}
.fk-mobile ol{margin:10px 0;padding-left:20px}
.fk-mobile li{margin:4px 0}
.fk-url{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fk-url a{color:inherit;word-break:break-all}
@media (max-width:820px){.fk-cols,.fk-detail-grid,.fk-mobile{grid-template-columns:1fr}
  .fk-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.fk-stats>div:nth-child(3){padding-left:0;border-left:0}
  .fk-line{grid-template-columns:3px minmax(0,1fr) 84px 60px}.fk-line .wf,.fk-line .state{display:none}
  .fk-line,.fk-line.compact{grid-template-columns:8px minmax(0,1fr) 52px 58px}
  .fk-tabs{margin-left:0;width:100%;display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--rule)}
  .fk-tabs button{border-left:0;text-align:center;background:var(--paper)}}
@media (prefers-reduced-motion:no-preference){.fk-detail{animation:fk-in .14s ease-out}
  @keyframes fk-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}}`;

  // ---------------------------------------------------------------- helpers
  const toDate = (v: any) => new Date(typeof v === "number" ? v * 1000 : v);
  const ts = (v: any) => (v ? toDate(v).toLocaleString() : "—");
  function ago(v: any): string {
    if (!v) return "—";
    const s = Math.round((Date.now() - toDate(v).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return toDate(v).toLocaleDateString();
  }
  const When = ({ v }: { v: any }) => h("span", { title: ts(v) }, ago(v));

  function useLoad<T>(fn: () => Promise<T>, deps: any[] = []): [T | null, string | null, () => void] {
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const load = useCallback(() => { fn().then((d) => { setData(d); setErr(null); }, (e: any) => setErr(String(e?.message ?? e))); }, deps);
    useEffect(() => { load(); }, [load]);
    return [data, err, load];
  }

  function Section(props: { title: string; meta?: any; actions?: any; children?: any }) {
    return h("section", { className: "fk-sec" },
      h("header", null, h("h2", null, props.title), props.meta ? h("span", { className: "mute" }, props.meta) : null,
        props.actions ? h("div", { className: "act" }, props.actions) : null),
      props.children);
  }
  /** First n items, then a "Show all" toggle: long lists stay scannable. */
  function useMore<T>(items: T[], n = 8): [T[], any] {
    const [all, setAll] = useState(false);
    if (items.length <= n) return [items, null];
    return [all ? items : items.slice(0, n),
      h("button", { className: "fk-more", onClick: () => setAll(!all) }, all ? "Show fewer" : `Show all ${items.length}`)];
  }
  const Err = ({ msg }: { msg: string | null }) => (msg ? h("div", { className: "fk-err", role: "alert" }, msg) : null);
  const Loading = () => h("div", { className: "fk-empty" }, "Loading…");

  // ---------------------------------------------------------------- sync states
  const STATE: Record<string, { word: string; color: string }> = {
    complete: { word: "synced", color: "var(--ok)" },
    received: { word: "files still uploading", color: "var(--wait)" },
  };
  const stateOf = (k: string) => STATE[k] ?? { word: k.replace(/_/g, " "), color: "var(--bad)" };
  const total = (o: any) => Object.values(o ?? {}).reduce((a: number, n: any) => a + Number(n || 0), 0) as number;

  /** The sync track: records by state as one proportional bar. */
  function Track({ byStatus, conflicts }: { byStatus: any; conflicts: number }) {
    const entries = Object.entries(byStatus ?? {}).filter(([, n]) => Number(n) > 0)
      .sort(([a], [b]) => (a === "complete" ? -1 : b === "complete" ? 1 : 0)) as [string, number][];
    const n = total(byStatus);
    if (!n) return h("p", { className: "fk-empty" }, "Nothing synchronised yet. Records appear here once a phone syncs.");
    return h("div", null,
      h("div", { className: "fk-track", role: "img", "aria-label": entries.map(([k, c]) => `${c} ${stateOf(k).word}`).join(", ") },
        entries.map(([k, c]) => h("span", { key: k, style: { width: `${(c / n) * 100}%`, background: stateOf(k).color } }))),
      h("div", { className: "fk-legend" },
        entries.map(([k, c]) => h("span", { key: k }, h("i", { className: "fk-dot", style: { background: stateOf(k).color } }), h("b", null, c), stateOf(k).word)),
        conflicts > 0 ? h("span", null, h("i", { className: "fk-dot", style: { background: "var(--bad)" } }), h("b", null, conflicts),
          conflicts === 1 ? "conflict to resolve" : "conflicts to resolve") : null));
  }

  function Stats({ sync }: { sync: any }) {
    const n = total(sync.records_by_sync_status);
    const cell = (label: string, value: any, cls = "") => h("div", null, h("dt", null, label), h("dd", { className: cls }, value));
    return h("dl", { className: "fk-stats" },
      cell("Synchronised records", n),
      cell("Files still uploading", sync.attachments_outstanding, sync.attachments_outstanding ? "wait" : ""),
      cell(sync.open_conflicts ? "Open conflicts" : "No open conflicts", sync.open_conflicts, sync.open_conflicts ? "bad" : ""),
      cell("Last record received", h(When, { v: sync.last_received_at }), "small"));
  }

  // ---------------------------------------------------------------- Overview
  function Overview() {
    const [st, err] = useLoad(() => Promise.all([get("status"), get("sync/status"), get("records?limit=8"), get("workspaces")]));
    if (!st) return err ? h(Err, { msg: err }) : h(Loading);
    const [status, sync, recs, wss] = st as any[];
    const own = (wss.workspaces ?? []).filter((w: any) => !w.starter);
    return h("div", null,
      h(Section, { title: "FieldKit status", actions: [
        h("span", { key: "v", className: "fk-chip" }, `version ${status.version}`),
        h("span", { key: "a", className: `fk-chip${status.app_built ? "" : " bad"}` }, status.app_built ? "phone app built" : "phone app NOT built")] },
        h(Track, { byStatus: sync.records_by_sync_status, conflicts: sync.open_conflicts }),
        h(Stats, { sync }),
        h("p", { className: "fk-hint" }, "FieldKit collects and syncs. Ask your Hermes agent to read, analyse or summarise synced entries.")),
      h("div", { className: "fk-cols" },
        h(Section, { title: "Workspaces", meta: own.length || null },
          own.length ? h(Workspaces, { items: own })
            : h("p", { className: "fk-empty" }, "No workspace yet. In Hermes, say: “Set up FieldKit for my work.”")),
        h(Section, { title: "Recent records" }, h(RecordList, { records: recs.records, compact: true }))));
  }

  function Workspaces({ items }: { items: any[] }) {
    const [shown, more] = useMore(items);
    return h("div", null, h("table", { className: "fk-table" },
      h("thead", null, h("tr", null, h("th", null, "Workspace"), h("th", null, "Version"), h("th", null, "Updated"))),
      h("tbody", null, shown.map((w: any) => h("tr", { key: w.id },
        h("td", null, h("div", null, w.title), h("div", { className: "id" }, w.id)),
        h("td", null, w.published_version ?? "draft"),
        h("td", { className: "mute" }, h(When, { v: w.updated_at })))))), more);
  }

  // ---------------------------------------------------------------- Records
  function RecordList({ records, compact }: { records: any[]; compact?: boolean }) {
    const [open, setOpen] = useState(null);
    if (!records?.length) return h("p", { className: "fk-empty" }, "No synchronised records yet.");
    return h("div", { className: "fk-ledger" }, records.map((r: any) => {
      const s = stateOf(r.sync_status), isOpen = open === r.id;
      return h(React.Fragment, { key: r.id },
        h("div", { className: `fk-line${compact ? " compact" : ""}${isOpen ? " open" : ""}` },
          h("span", { className: "rail", style: { background: s.color }, title: s.word, "aria-hidden": true }),
          h("div", { style: { minWidth: 0 } },
            h("div", { className: "t" }, r.workflow_title || r.workflow_id, r.subject ? h("span", { className: "sub" }, `  ${r.subject}`) : null),
            h("div", { className: "id" }, r.id)),
          compact ? null : h("span", { className: "id wf", title: "Workflow id" }, r.workflow_id),
          h("span", { className: "state", style: { color: s.color } }, s.word),
          h("span", { className: "when" }, h("span", { className: "fk-sr" }, `${s.word}, received `), h(When, { v: r.received_at })),
          h("button", { className: "fk-btn", "aria-expanded": isOpen, onClick: () => setOpen(isOpen ? null : r.id) }, isOpen ? "Hide" : "Details")),
        isOpen ? h(RecordDetail, { id: r.id }) : null);
    }));
  }

  const label = (v: any) => (v && typeof v === "object" ? v.en ?? Object.values(v)[0] : v);
  /** One answer as text: option labels, Yes/No, file counts; anything else compact JSON. */
  function answerText(v: any, f?: any): any {
    if (v === null || v === undefined || v === "") return h("span", { className: "mute" }, "—");
    const opt = (x: any) => label((f?.options ?? []).find((o: any) => o.value === x)?.label) ?? String(x);
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === "object" && (x.attachment_id || x.id))) return `${v.length} file${v.length === 1 ? "" : "s"} (below)`;
      return v.every((x) => typeof x !== "object") ? v.map(opt).join(", ") : JSON.stringify(v);
    }
    if (typeof v === "object") return v.attachment_id ? "1 file (below)" : JSON.stringify(v);
    return opt(v);
  }
  /** [key, label, field] rows: the form's order first, then answers the form no longer lists. */
  function answerRows(answers: any, wf: any): [string, string, any][] {
    const out: [string, string, any][] = [], seen = new Set<string>();
    for (const f of wf?.fields ?? []) if (f.id in (answers ?? {})) { out.push([f.id, String(label(f.label) ?? f.id), f]); seen.add(f.id); }
    for (const k of Object.keys(answers ?? {})) if (!seen.has(k)) out.push([k, k.replace(/_/g, " "), undefined]);
    return out;
  }

  function Attachment({ a }: { a: any }) {
    const [url, setUrl] = useState(null);
    useEffect(() => {
      if (a.status !== "stored") return;
      let u: string | null = null;
      const fetcher = SDK.authedFetch || fetch;
      fetcher(`${API}/attachments/${a.id}`).then((r: Response) => r.blob()).then((b: Blob) => { u = URL.createObjectURL(b); setUrl(u); }).catch(() => undefined);
      return () => { if (u) URL.revokeObjectURL(u); };
    }, [a.id]);
    const noun = a.kind === "signature" ? "Signature" : a.kind === "audio" ? "Voice note" : a.kind === "photo" ? "Photo" : "File";
    if (a.status !== "stored") return h("div", { className: "pending" }, `${noun} still uploading`, h("div", { className: "id" }, a.mime));
    if (!url) return h("div", { className: "pending" }, `Loading ${noun.toLowerCase()}…`);
    const signed = a.signed_at ? `signed ${String(a.signed_at).replace("T", " ").slice(0, 16)}` : "";
    return h("figure", null,
      String(a.mime).startsWith("audio/") ? h("audio", { controls: true, src: url })
        : h("a", { href: url, target: "_blank", rel: "noopener" },
          h("img", { src: url, alt: `${noun}${a.field_label ? `: ${a.field_label}` : ""}`, className: a.kind === "signature" ? "sig" : "" })),
      h("figcaption", null, h("div", null, a.field_label || noun), signed ? h("div", null, signed) : null,
        a.transcript ? h("div", null, `“${a.transcript}”`) : null));
  }

  function RecordDetail({ id }: { id: string }) {
    const [data, err] = useLoad(async () => {
      const rec = await get(`records/${id}`);
      const [wf, rep, qs] = await Promise.all([
        get(`workflows/${encodeURIComponent(rec.workflow_id)}?version=${rec.workflow_version}`).catch(() => null),
        get(`records/${id}/report`).catch(() => null), get(`records/${id}/questions`).catch(() => ({ questions: [] }))]);
      return [rec, wf, rep, qs];
    }, [id]);
    if (!data) return h("div", { className: "fk-detail" }, err ? h(Err, { msg: err }) : "Loading…");
    const [rec, wf, rep, qs] = data as any[];
    const rows = answerRows(rec.answers, wf);
    const findings = rec.local_results?.findings ?? [];
    const questions = qs?.questions ?? [];
    return h("div", { className: "fk-detail" },
      h("div", { className: "fk-detail-grid" },
        h("div", null, h("h3", null, "Answers"),
          rows.length ? h("dl", { className: "fk-kv" }, rows.map(([k, l, f]) => [h("dt", { key: `t${k}` }, l), h("dd", { key: `d${k}` }, answerText(rec.answers[k], f))]))
            : h("p", { className: "mute" }, "No answers recorded."),
          h("details", null, h("summary", null, "Raw answers (JSON)"), h("pre", null, JSON.stringify(rec.answers, null, 2)))),
        h("div", null, h("h3", null, rec.attachments?.length ? (rec.attachment_summary || `${rec.attachments.length} file(s)`) : "Files"),
          rec.attachments?.length ? h("div", { className: "fk-files" }, rec.attachments.map((a: any) => h(Attachment, { key: a.id, a })))
            : h("p", { className: "mute" }, "No photos, voice notes or signatures."),
          h("dl", { className: "fk-kv", style: { marginTop: 12 } },
            h("dt", null, "Completed on phone"), h("dd", null, ts(rec.completed_at)),
            h("dt", null, "Received by Hermes"), h("dd", null, ts(rec.received_at)),
            h("dt", null, "Revision"), h("dd", null, rec.revision),
            rec.workspace_id ? [h("dt", { key: "wt" }, "Workspace"), h("dd", { key: "wd", className: "id" }, rec.workspace_id)] : null,
            rec.device_id ? [h("dt", { key: "dt" }, "Device"), h("dd", { key: "dd", className: "id" }, rec.device_id)] : null))),
      findings.length ? h("div", { className: "fk-legacy" }, h("h3", null, "Phone findings (FieldKit before 0.3)"),
        findings.map((f: any, i: number) => h("div", { key: i }, h(Sev, { s: f.severity }), " ", f.label, f.detail ? `: ${f.detail}` : ""))) : null,
      questions.length ? h("div", { className: "fk-legacy" }, h("h3", null, "Questions answered by FieldKit before 0.3"),
        questions.map((q: any) => h("div", { key: q.id, style: { margin: "6px 0" } },
          h("div", null, h("b", null, q.question), h("span", { className: "mute" }, `  ${q.status}`)), q.answer ? h("div", null, q.answer.answer) : null))) : null,
      rep ? h("div", { className: "fk-legacy" }, h("h3", null, "Report from FieldKit before 0.3"), h(ReportView, { r: rep })) : null,
      h("p", { className: "fk-hint" }, "To analyse this entry, ask your Hermes agent. It can open the photos and voice notes."));
  }

  const sevColor: Record<string, string> = { critical: "var(--bad)", high: "var(--bad)", medium: "var(--wait)", low: "var(--ok)", info: "var(--mute)" };
  const Sev = ({ s }: { s: string }) => h("b", { style: { color: sevColor[s] ?? undefined, fontSize: 12 } }, s);
  const INTEGRITY: Record<string, string> = { intact: "intact (SHA-256 verified)", mismatch: "DOES NOT MATCH the captured file",
    missing: "missing", not_uploaded: "not uploaded yet" };

  /** Files of a legacy report as evidence: voice-note transcripts, signatures with integrity. */
  function Evidence({ att }: { att: any }) {
    const vn = att.voice_notes ?? {};
    return h("div", { style: { margin: "6px 0" } },
      h("b", null, "Evidence: "), att.summary,
      vn.attached > 0 && h("div", null, `Voice notes: ${vn.transcribed} of ${vn.attached} transcribed`,
        att.evidence.filter((e: any) => e.kind === "audio").map((e: any) => h("div", { key: e.attachment_id },
          e.transcript ? `“${e.transcript}” (${e.transcript_source === "device" ? "transcribed on the phone" : "transcribed by Hermes"})`
            : `Not transcribed: ${e.transcript_error ?? "unknown reason"}`))),
      att.evidence.filter((e: any) => e.kind === "signature").map((e: any) => h("div", { key: e.attachment_id, style: { marginTop: 4 } },
        `${e.field_label || "Signature"}${e.signed_at ? `, signed ${String(e.signed_at).replace("T", " ").slice(0, 16)}` : ""}: file ${INTEGRITY[e.integrity] ?? e.integrity}`,
        e.stored && h("div", { className: "fk-files" }, h(Attachment, { a: { id: e.attachment_id, mime: e.mime, status: "stored", kind: "signature" } })))));
  }

  function ReportView({ r }: { r: any }) {
    const list = (title: string, items: any[], fn: (x: any) => any) => items?.length > 0 &&
      h("div", { style: { marginTop: 6 } }, h("b", null, title), h("ul", { style: { margin: "2px 0", paddingLeft: 18 } }, items.map((x, k) => h("li", { key: k }, fn(x)))));
    return h("div", null,
      h("div", { className: "mute", style: { fontSize: 12 } }, `Version ${r.version}, ${ts(r.generated_at)}, by ${[r.generated_by, r.provider, r.model].filter(Boolean).join(" ")}`),
      r.requires_review && h("div", { style: { color: "var(--wait)", fontWeight: 600 } }, `Requires human review${r.review_reason ? `: ${r.review_reason}` : ""}`),
      r.decision?.outcome && h("div", { style: { margin: "6px 0" } },
        h("b", null, "Decision: "), (r.decision_scale ?? []).find((d: any) => d.id === r.decision.outcome)?.label || r.decision.outcome,
        `, confidence ${r.decision.confidence}`, typeof r.decision.deadline_days === "number" ? `, within ${r.decision.deadline_days} day(s)` : "",
        r.decision.escalate_to ? `, escalate to ${r.decision.escalate_to}` : "", h("div", null, r.decision.rationale)),
      h("p", { style: { margin: "6px 0" } }, r.summary),
      list("Next actions", r.next_actions, (a) => [a.action, a.who ? ` (${a.who}${typeof a.by_when_days === "number" ? `, within ${a.by_when_days} day(s)` : ""})` : "",
        h("div", { key: "v", className: "mute", style: { fontSize: 12 } }, `Verify: ${a.verify_by}. ${a.origin === "ai_suggestion" ? "AI suggestion" : `From workspace ${a.origin}`}`)]),
      list("Uncertain", r.uncertainty, (u) => `${u.unknown}: ${u.how_to_resolve}`),
      r.quality?.problems?.length > 0 && h("div", { style: { color: "var(--wait)" } }, `Quality checks not passed: ${r.quality.problems.join("; ")}`),
      r.images?.note && h("div", { style: { margin: "6px 0" } }, h("b", null, r.images.analyzed === false ? "Photos not analysed: " : "Photos: "), r.images.note),
      r.attachments?.evidence?.length > 0 && h(Evidence, { att: r.attachments }),
      list("Issues", r.issues, (i) => [h(Sev, { key: "s", s: i.severity }), ` ${i.title}: ${i.evidence}`]),
      list("Missing information", r.missing_information, (m) => m),
      list("Suggested actions", r.suggested_actions, (a) => `${a.action} (${a.priority})`),
      list("References", r.references, (x) => `${x.title}${x.source ? `, ${x.source}` : ""}`));
  }

  function Records() {
    const [wf, setWf] = useState("");
    const [q, setQ] = useState("");
    useEffect(() => { const t = setTimeout(() => setQ(wf.trim()), 250); return () => clearTimeout(t); }, [wf]);
    const [data, err] = useLoad(() => get(`records?limit=100${q ? `&workflow_id=${encodeURIComponent(q)}` : ""}`), [q]);
    const recs = data?.records ?? [];
    const ids = Array.from(new Set(recs.map((r: any) => r.workflow_id))) as string[];
    return h(Section, { title: "Synchronised records", meta: data ? (recs.length === 100 ? "latest 100, newest first" : `${recs.length}, newest first`) : null },
      h("div", { className: "fk-filter" },
        h("input", { placeholder: "Filter by workflow id, e.g. equipment-inspection", value: wf, list: "fk-wf-ids", "aria-label": "Filter by workflow id",
          onChange: (e: any) => setWf(e.target.value) }),
        h("datalist", { id: "fk-wf-ids" }, ids.map((i) => h("option", { key: i, value: i }))),
        wf ? h("button", { className: "fk-btn", onClick: () => setWf("") }, "Clear") : null),
      h(Err, { msg: err }),
      data ? h(RecordList, { records: recs }) : err ? null : h(Loading));
  }

  // ---------------------------------------------------------------- Sync
  function Conflict({ c, onDone }: { c: any; onDone: () => void }) {
    const [server] = useLoad(() => get(`records/${c.record_id}`).catch(() => null), [c.record_id]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const phone = c.client_payload?.record?.answers ?? {};
    const mine = (server as any)?.answers ?? {};
    const keys = Array.from(new Set([...Object.keys(mine), ...Object.keys(phone)]));
    const resolve = (resolution: string) => { setBusy(true); setErr(null);
      post(`sync/conflicts/${c.id}/resolve`, { resolution }).then(onDone, (e: any) => { setErr(String(e?.message ?? e)); setBusy(false); }); };
    const txt = (v: any) => (v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));
    return h("div", { className: "fk-conflict" },
      h("div", null, h("b", null, c.form_title || "Record"), c.subject ? h("span", null, `  ${c.subject}`) : null,
        c.workspace_title ? h("span", { className: "mute" }, `  in ${c.workspace_title}`) : null,
        c.completed_at ? h("span", { className: "mute" }, `  ${new Date(c.completed_at).toLocaleString()}`) : null),
      h("div", { className: "id" }, c.record_id),
      h("p", { className: "mute" }, `The phone edited revision ${c.base_revision}; Hermes already has revision ${c.server_revision}. Choose which copy to keep.`),
      server ? h("table", { className: "fk-table", style: { marginTop: 8 } },
        h("thead", null, h("tr", null, h("th", null, "Answer"), h("th", null, "Hermes copy"), h("th", null, "Phone copy"))),
        h("tbody", null, keys.map((k) => {
          const diff = JSON.stringify(mine[k]) !== JSON.stringify(phone[k]);
          return h("tr", { key: k, style: diff ? { background: "color-mix(in srgb,var(--wait) 16%,transparent)" } : undefined },
            h("td", { className: "mute" }, k.replace(/_/g, " ")), h("td", null, txt(mine[k])), h("td", null, txt(phone[k])));
        })))
        : h("pre", null, JSON.stringify(phone, null, 2)),
      h(Err, { msg: err }),
      h("div", { className: "acts" },
        h("button", { className: "fk-btn", disabled: busy, onClick: () => resolve("keep_server") }, "Keep server version"),
        h("button", { className: "fk-btn solid", disabled: busy, onClick: () => resolve("use_client") }, "Use phone version")));
  }

  function Devices({ items }: { items: any[] }) {
    const [shown, more] = useMore(items);
    return h("div", null, h("table", { className: "fk-table" },
      h("thead", null, h("tr", null, h("th", null, "Device"), h("th", null, "Last seen"), h("th", null, "Device id"))),
      h("tbody", null, shown.map((d: any) => h("tr", { key: d.id },
        h("td", null, d.label || h("span", { className: "mute" }, "Unnamed device")),
        h("td", null, h(When, { v: d.last_seen })), h("td", { className: "id" }, d.id))))), more);
  }

  function Sync() {
    const [data, err, reload] = useLoad(() => Promise.all([get("sync/status"), get("sync/conflicts")]));
    if (!data) return err ? h(Err, { msg: err }) : h(Loading);
    const [st, cf] = data as any[];
    return h("div", null,
      h(Section, { title: "Synchronisation", actions: h("button", { className: "fk-btn", onClick: reload }, "Refresh") },
        h(Track, { byStatus: st.records_by_sync_status, conflicts: st.open_conflicts }),
        h(Stats, { sync: st }),
        h(Err, { msg: err })),
      h(Section, { title: "Conflicts", meta: cf.conflicts.length ? `${cf.conflicts.length} open` : null },
        cf.conflicts.length ? cf.conflicts.map((c: any) => h(Conflict, { key: c.id, c, onDone: reload }))
          : h("p", { className: "fk-empty" }, "No open conflicts. Edits from every phone have been merged.")),
      h(Section, { title: "Devices", meta: st.devices.length || null },
        st.devices.length ? h(Devices, { items: st.devices })
          : h("p", { className: "fk-empty" }, "No phone has synced yet. Open the Mobile Access tab to set one up.")));
  }

  // ---------------------------------------------------------------- Mobile access
  function Mobile() {
    const url = appUrl();
    const [copied, setCopied] = useState(false);
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const copy = () => navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
    return h(Section, { title: "Open FieldKit on a phone" },
      h("div", { className: "fk-mobile" },
        h("img", { src: qr.createDataURL(5, 4), alt: "QR code for the FieldKit app" }),
        h("div", null,
          h("div", { className: "fk-url" }, h("a", { href: url, target: "_blank", rel: "noopener" }, url),
            h("button", { className: "fk-btn", onClick: copy }, copied ? "Copied" : "Copy link")),
          h("ol", null,
            h("li", null, "Scan the code (or open the link) on the phone while online and sign in to Hermes."),
            h("li", null, "Open your workspace and tap “Download everything for offline”. Optional: OCR and translation packs in Offline Packs."),
            h("li", null, "Add to Home Screen. Android: menu, then Install app. iPhone: Share, then Add to Home Screen."),
            h("li", null, "Check the Offline readiness card on Home. After that it works with no connection.")),
          h("p", { className: "fk-hint" }, "Service workers need HTTPS: the phone must reach this dashboard over https:// (or localhost)."))));
  }

  const TABS: [string, () => any][] = [["Overview", Overview], ["Records", Records],
    ["Synchronization", Sync], ["Mobile Access", Mobile]];

  function FieldKitPage() {
    const [tab, setTab] = useState("Overview");
    const View = (TABS.find(([n]) => n === tab) ?? TABS[0])[1];
    return h("div", { className: "fk" },
      h("style", null, CSS),
      h("div", { className: "fk-top" },
        h("span", { className: "mute" }, "Observations collected offline on phones, synced to Hermes"),
        h("nav", { className: "fk-tabs", "aria-label": "FieldKit sections" },
          TABS.map(([n]) => h("button", { key: n, type: "button", "aria-pressed": n === tab, onClick: () => setTab(n) }, n)))),
      h(View, null));
  }

  window.__HERMES_PLUGINS__?.register?.("fieldkit", FieldKitPage);
})();
