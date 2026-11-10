// FieldKit tab for the Hermes dashboard. Bundled by esbuild into a single IIFE (dist/index.js).
// React, UI primitives and authenticated fetch come from window.__HERMES_PLUGIN_SDK__ (never bundled).
import qrcode from "qrcode-generator";

declare global { interface Window { __HERMES_PLUGIN_SDK__: any; __HERMES_PLUGINS__: any } }

(function () {
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;
  const React = SDK.React;
  const h = React.createElement;
  const { useState, useEffect, useCallback } = SDK.hooks;
  const C = SDK.components || {};
  const Card = C.Card || "div", CardHeader = C.CardHeader || "div", CardTitle = C.CardTitle || "h3", CardContent = C.CardContent || "div";
  const Button = C.Button || "button", Badge = C.Badge || "span";
  const API = "/api/plugins/fieldkit";
  const get = (p: string): Promise<any> => SDK.fetchJSON(`${API}/${p}`);
  const post = (p: string, body?: unknown): Promise<any> => SDK.fetchJSON(`${API}/${p}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  const del = (p: string): Promise<any> => SDK.fetchJSON(`${API}/${p}`, { method: "DELETE" });
  const ts = (v: any) => (v ? new Date(typeof v === "number" ? v * 1000 : v).toLocaleString() : "—");
  // Public plugin-asset address: outside the /api auth gate, so launches with an expired session open the app
  // (which offers sign-in) instead of a raw 401 JSON page.
  const APP_PATH = "/dashboard-plugins/fieldkit/app_dist/index.html";
  const appUrl = () => `${window.location.origin}${APP_PATH}`;
  const box = { border: "1px solid var(--border, #e5e7eb)", borderRadius: 10, padding: 12, marginBottom: 12 };
  const pre = { whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 360, overflow: "auto", background: "rgba(127,127,127,.08)", padding: 8, borderRadius: 6 };
  const row = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
  const sevColor: Record<string, string> = { critical: "#b91c1c", high: "#dc2626", medium: "#d97706", low: "#15803d", info: "#2563eb" };

  function useLoad<T>(fn: () => Promise<T>, deps: any[] = []): [T | null, string | null, () => void] {
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const load = useCallback(() => { fn().then((d) => { setData(d); setErr(null); }, (e: any) => setErr(String(e?.message ?? e))); }, deps);
    useEffect(() => { load(); }, [load]);
    return [data, err, load];
  }

  function Section(props: { title: string; children?: any; actions?: any }) {
    return h(Card, { style: { marginBottom: 16 } },
      h(CardHeader, null, h("div", { style: { ...row, justifyContent: "space-between" } }, h(CardTitle, null, props.title), props.actions)),
      h(CardContent, null, props.children));
  }

  function Err({ msg }: { msg: string | null }) { return msg ? h("div", { style: { color: "#b91c1c", margin: "8px 0" } }, msg) : null; }
  function Sev({ s }: { s: string }) { return h(Badge, { style: { color: sevColor[s] ?? undefined } }, s); }

  // ---------------------------------------------------------------- Overview
  function Overview() {
    const [st, err] = useLoad(() => Promise.all([get("status"), get("sync/status"), get("records?limit=5"), get("workspaces")]));
    if (!st) return h(Err, { msg: err }) || h("div", null, "Loading…");
    const [status, sync, recs, wss] = st as any[];
    const own = (wss.workspaces ?? []).filter((w: any) => !w.starter);
    return h("div", null,
      h(Section, { title: "FieldKit status" },
        h("div", { style: row }, h(Badge, null, `version ${status.version}`), h(Badge, null, `app ${status.app_built ? "built" : "NOT built"}`)),
        h("p", null, `Records: ${counts(sync.records_by_sync_status)} · Files still uploading: ${sync.attachments_outstanding} · Open conflicts: ${sync.open_conflicts}`),
        h("p", { style: { fontSize: 13, opacity: .8 } }, "FieldKit collects and syncs. Ask your Hermes agent to read, analyse or summarise synced entries.")),
      h(Section, { title: "Workspaces" }, own.length ? own.map((w: any) => h("div", { key: w.id, style: box },
        h("b", null, w.title), ` · version ${w.published_version ?? "draft"}`, h("div", { style: small }, w.id)))
        : "No workspace yet. In Hermes: “Set up FieldKit for my work.”"),
      h(Section, { title: "Recent records" }, h(RecordList, { records: recs.records })));
  }

  // ---------------------------------------------------------------- Records
  const STATE_WORDS: Record<string, string> = {
    complete: "complete", received: "files still uploading",
  };
  /** {"complete": 7} → "7 complete" */
  function counts(o: any): string {
    const parts = Object.entries(o ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${STATE_WORDS[k] ?? k.replace(/_/g, " ")}`);
    return parts.length ? parts.join(", ") : "none";
  }
  /** "Equipment inspection · PMP-0045" */
  function title(r: any): string {
    return `${r.workflow_title || r.workflow_id}${r.subject ? ` · ${r.subject}` : ""}`;
  }
  const small = { fontSize: 11, opacity: .55, fontFamily: "monospace" };

  function RecordList({ records }: { records: any[] }) {
    const [open, setOpen] = useState(null);
    if (!records?.length) return h("div", null, "No synchronised records yet.");
    return h("div", null, records.map((r: any) => h("div", { key: r.id, style: box },
      h("div", { style: row }, h("div", { style: { flex: 1 } }, h("b", null, title(r)), h("div", { style: small }, r.id)),
        h(Badge, null, r.sync_status === "complete" ? "synced" : STATE_WORDS[r.sync_status] ?? r.sync_status),
        h("span", null, ts(r.received_at)),
        h(Button, { onClick: () => setOpen(open === r.id ? null : r.id) }, open === r.id ? "Hide" : "Details")),
      open === r.id && h(RecordDetail, { id: r.id }))));
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
    if (a.status !== "stored") return h("div", null, `${noun} (${a.mime}) — still uploading`);
    if (!url) return h("div", null, `Loading ${noun.toLowerCase()}…`);
    return h("figure", { style: { margin: "0 8px 8px 0" } },
      String(a.mime).startsWith("audio/") ? h("audio", { controls: true, src: url })
        : h("img", { src: url, style: { maxWidth: 220, borderRadius: 8, background: a.kind === "signature" ? "#fff" : undefined } }),
      h("figcaption", { style: { fontSize: 12, opacity: .75 } }, `${noun}${a.field_label ? ` · ${a.field_label}` : ""}${a.signed_at ? ` · signed ${String(a.signed_at).replace("T", " ").slice(0, 16)}` : ""}${a.transcript ? ` · “${a.transcript}”` : ""}`));
  }

  function RecordDetail({ id }: { id: string }) {
    const [data, err] = useLoad(() => Promise.all([get(`records/${id}`), get(`records/${id}/report`).catch(() => null),
      get(`records/${id}/questions`).catch(() => ({ questions: [] }))]), [id]);
    if (!data) return h(Err, { msg: err }) || h("div", null, "Loading…");
    const [rec, rep, qs] = data as any[];
    return h("div", { style: { marginTop: 8 } },
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
        h("div", null, h("b", null, "Answers"), h("pre", { style: pre }, JSON.stringify(rec.answers, null, 2))),
        (rec.local_results?.findings ?? []).length ? h("div", null, h("b", { style: { color: "#7c3aed" } }, "Phone findings (FieldKit before 0.3)"),
          rec.local_results.findings.map((f: any, i: number) => h("div", { key: i }, h(Sev, { s: f.severity }), " ", f.label, f.detail ? ` — ${f.detail}` : ""))) : h("div", null)),
      rec.attachments?.length > 0 && h("div", { style: { marginTop: 8 } }, h("b", null, rec.attachment_summary || `${rec.attachments.length} file(s)`),
        h("div", { style: { ...row, flexWrap: "wrap" } }, rec.attachments.map((a: any) => h(Attachment, { key: a.id, a })))),
      (qs.questions ?? []).length ? h("div", { style: { marginTop: 8 } }, h("b", { style: { color: "#0f766e" } }, "Questions answered by FieldKit before 0.3"),
        (qs.questions as any[]).map((q: any) => h("div", { key: q.id, style: { margin: "6px 0" } },
          h("div", null, h("b", null, q.question), ` · ${q.status}`), q.answer ? h("div", null, q.answer.answer) : null))) : null,
      rep ? h("div", { style: { marginTop: 8 } }, h("b", { style: { color: "#0f766e" } }, "Report from FieldKit before 0.3"), h(ReportView, { r: rep })) : null,
      h("div", { style: { ...small, marginTop: 8 } }, "To analyse this entry, ask your Hermes agent (it can open the photos and voice notes)."));
  }

  const INTEGRITY: Record<string, string> = { intact: "intact (SHA-256 verified)", mismatch: "DOES NOT MATCH the captured file",
    missing: "missing", not_uploaded: "not uploaded yet" };

  /** Files of the record as evidence: correct counts, voice-note transcripts, signatures with integrity. */
  function Evidence({ att }: { att: any }) {
    const vn = att.voice_notes ?? {};
    return h("div", { style: { margin: "6px 0" } },
      h("b", null, "Evidence: "), att.summary,
      vn.attached > 0 && h("div", null, `Voice notes: ${vn.transcribed} of ${vn.attached} transcribed`,
        att.evidence.filter((e: any) => e.kind === "audio").map((e: any) => h("div", { key: e.attachment_id, style: { fontSize: 13 } },
          e.transcript ? `“${e.transcript}” (${e.transcript_source === "device" ? "transcribed on the phone" : "transcribed by Hermes"})`
            : `Not transcribed: ${e.transcript_error ?? "unknown reason"}`))),
      att.evidence.filter((e: any) => e.kind === "signature").map((e: any) => h("div", { key: e.attachment_id, style: { marginTop: 4 } },
        `${e.field_label || "Signature"}${e.signed_at ? ` — signed ${String(e.signed_at).replace("T", " ").slice(0, 16)}` : ""} · file ${INTEGRITY[e.integrity] ?? e.integrity}`,
        e.stored && h(Attachment, { a: { id: e.attachment_id, mime: e.mime, status: "stored", kind: "signature" } }))));
  }

  function ReportView({ r }: { r: any }) {
    return h("div", { style: box },
      h("div", { style: { fontSize: 12, opacity: .7 } }, `v${r.version} · ${ts(r.generated_at)} · ${r.generated_by} · ${r.provider || ""} ${r.model || ""}`),
      r.requires_review && h("div", { style: { color: "#d97706", fontWeight: 600 } }, `Requires human review${r.review_reason ? `: ${r.review_reason}` : ""}`),
      r.decision?.outcome && h("div", { style: { margin: "6px 0", padding: 8, borderRadius: 6, border: "1px solid #0f766e" } },
        h("b", null, "Decision: "), (r.decision_scale ?? []).find((d: any) => d.id === r.decision.outcome)?.label || r.decision.outcome,
        ` · confidence ${r.decision.confidence}`, typeof r.decision.deadline_days === "number" ? ` · within ${r.decision.deadline_days} day(s)` : "",
        r.decision.escalate_to ? ` · escalate to ${r.decision.escalate_to}` : "", h("div", null, r.decision.rationale)),
      h("p", null, r.summary),
      r.next_actions?.length > 0 && h("div", null, h("b", null, "Next actions"), h("ol", null, r.next_actions.map((a: any, k: number) =>
        h("li", { key: k }, a.action, a.who ? ` (${a.who}` + (typeof a.by_when_days === "number" ? `, within ${a.by_when_days} day(s))` : ")") : "",
          h("div", { style: { fontSize: 12, opacity: .75 } }, `Verify: ${a.verify_by} · ${a.origin === "ai_suggestion" ? "AI suggestion" : `from workspace ${a.origin}`}`))))),
      r.uncertainty?.length > 0 && h("div", null, h("b", null, "Uncertain"), h("ul", null, r.uncertainty.map((u: any, k: number) => h("li", { key: k }, `${u.unknown} — ${u.how_to_resolve}`)))),
      r.quality?.problems?.length > 0 && h("div", { style: { color: "#d97706" } }, `Quality checks not passed: ${r.quality.problems.join("; ")}`),
      r.images?.note && h("div", { style: { margin: "6px 0", padding: 8, borderRadius: 6, border: `1px solid ${r.images.analyzed === false ? "#d97706" : "#0f766e"}` } },
        h("b", null, r.images.analyzed === false ? "Photos not analysed: " : "Photos: "), r.images.note),
      r.attachments?.evidence?.length > 0 && h(Evidence, { att: r.attachments }),
      r.issues?.length > 0 && h("div", null, h("b", null, "Issues"), r.issues.map((i: any, k: number) => h("div", { key: k }, h(Sev, { s: i.severity }), ` ${i.title} — ${i.evidence}`))),
      r.missing_information?.length > 0 && h("div", null, h("b", null, "Missing information"), h("ul", null, r.missing_information.map((m: string, k: number) => h("li", { key: k }, m)))),
      r.suggested_actions?.length > 0 && h("div", null, h("b", null, "Suggested actions"), h("ul", null, r.suggested_actions.map((a: any, k: number) => h("li", { key: k }, `[${a.priority}] ${a.action}`)))),
      r.references?.length > 0 && h("div", null, h("b", null, "References"), h("ul", null, r.references.map((x: any, k: number) => h("li", { key: k }, `${x.title}${x.source ? ` — ${x.source}` : ""}`)))));
  }

  function Records() {
    const [wf, setWf] = useState("");
    const [data, err] = useLoad(() => get(`records?limit=100${wf ? `&workflow_id=${encodeURIComponent(wf)}` : ""}`), [wf]);
    return h(Section, { title: "Synchronised records" }, h(Err, { msg: err }),
      h("input", { placeholder: "Filter by workflow id (e.g. equipment-inspection)", value: wf, onChange: (e: any) => setWf(e.target.value), style: { marginBottom: 8 } }),
      h(RecordList, { records: data?.records ?? [] }));
  }

  // ---------------------------------------------------------------- Sync
  function Sync() {
    const [data, err, reload] = useLoad(() => Promise.all([get("sync/status"), get("sync/conflicts")]));
    if (!data) return h(Err, { msg: err }) || h("div", null, "Loading…");
    const [st, cf] = data as any[];
    return h("div", null,
      h(Section, { title: "Synchronisation", actions: h(Button, { onClick: reload }, "Refresh") },
        h("div", null, `Last record received: ${ts(st.last_received_at)} · Attachments outstanding: ${st.attachments_outstanding} · Open conflicts: ${st.open_conflicts}`),
        h("div", null, `Records: ${counts(st.records_by_sync_status)}`),
        h("div", { style: { marginTop: 8 } }, h("b", null, "Devices"), st.devices.map((d: any) => h("div", { key: d.id }, `${d.label || "Unnamed device"} · last seen ${ts(d.last_seen)} `, h("span", { style: small }, d.id))))),
      h(Section, { title: "Conflicts" }, cf.conflicts.length ? cf.conflicts.map((c: any) => h("div", { key: c.id, style: box },
        h("div", null, `Record ${c.record_id}: phone edited revision ${c.base_revision}, server is at ${c.server_revision}`),
        h("pre", { style: pre }, JSON.stringify(c.client_payload?.record?.answers, null, 2)),
        h("div", { style: row }, h(Button, { onClick: () => post(`sync/conflicts/${c.id}/resolve`, { resolution: "keep_server" }).then(reload) }, "Keep server version"),
          h(Button, { onClick: () => post(`sync/conflicts/${c.id}/resolve`, { resolution: "use_client" }).then(reload) }, "Use phone version")))) : "No open conflicts."));
  }

  // ---------------------------------------------------------------- Mobile access
  function Mobile() {
    const url = appUrl();
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return h(Section, { title: "Open FieldKit on a phone" },
      h("div", { style: { ...row, alignItems: "flex-start" } },
        h("img", { src: qr.createDataURL(6, 8), alt: "QR code for the FieldKit app", style: { background: "#fff", borderRadius: 8 } }),
        h("div", { style: { flex: 1, minWidth: 240 } },
          h("p", null, h("a", { href: url, target: "_blank", rel: "noopener" }, url)),
          h("ol", null,
            h("li", null, "Scan the code (or open the link) on the phone while online and sign in to Hermes."),
            h("li", null, "Open your workspace and tap “Download everything for offline”. Optional: OCR and translation packs in Offline Packs."),
            h("li", null, "Add to Home Screen (Android: menu → Install app; iPhone: Share → Add to Home Screen)."),
            h("li", null, "Check the Offline readiness card on Home, then it works with no connection.")),
          h("p", { style: { fontSize: 13, opacity: .8 } }, "Service workers need HTTPS. The phone must reach this dashboard over https:// (or localhost)."))));
  }

  const TABS: [string, () => any][] = [["Overview", Overview], ["Records", Records],
    ["Synchronization", Sync], ["Mobile Access", Mobile]];

  function FieldKitPage() {
    const [tab, setTab] = useState("Overview");
    const View = (TABS.find(([n]) => n === tab) ?? TABS[0])[1];
    return h("div", { style: { padding: 16, maxWidth: 1200 } },
      h("div", { style: { ...row, marginBottom: 16 } }, TABS.map(([n]) => h(Button, { key: n, variant: n === tab ? "default" : "outline", onClick: () => setTab(n) }, n))),
      h(View, null));
  }

  window.__HERMES_PLUGINS__?.register?.("fieldkit", FieldKitPage);
})();
