// Offline Assistant screen (0.2.5): a conversation grounded in the workspace, the open record and its report.
import { beginGuide, buildCorpus, newState, respond, type AskContext, type Corpus, type Reply, type State } from "./assistant";
import { db } from "./db";
import { text, type Workflow } from "./engine";
import { subjectField } from "./followups";
import { embed, embeddingModelId, installedModels, ocr, ocrLanguages, speak, transcribe, translate, translationPairs } from "./intel";
import { logEvent, vectorCache } from "./learning";
import { VoiceRecorder } from "./media";
import { installedPacks } from "./packs";
import { clear, h, toast } from "./util";
import { lang, type View } from "./views_core";

async function loadContext(params: URLSearchParams): Promise<AskContext> {
  const d = await db();
  const rid = params.get("record"), remoteId = params.get("remote");
  let record: AskContext["record"] = null, report: any = null;
  if (rid) {
    const r = await d.get("records", rid);
    if (r) { record = { id: r.id, workflow_id: r.workflow_id, answers: r.answers, completed_at: r.completed_at }; report = (await d.get("reports", rid))?.report ?? null; }
  } else if (remoteId) {
    const c = await d.get("remote", remoteId);
    if (c) { record = { id: c.id, workflow_id: c.workflow_id, answers: c.answers, completed_at: c.completed_at }; report = c.report; }
  }
  const workflow: Workflow | null = record ? (await d.get("workflows", record.workflow_id))?.definition ?? null : null;
  const history: AskContext["history"] = [];
  if (record && workflow) {
    const fid = subjectField(workflow);
    const subj = fid ? String(record.answers?.[fid] ?? "").toLowerCase() : "";
    if (subj) {
      for (const r of await d.getAll("records")) if (r.workflow_id === workflow.id && String(r.answers?.[fid!] ?? "").toLowerCase() === subj)
        history.push({ id: r.id, completed_at: r.completed_at, answers: r.answers, report: (await d.get("reports", r.id))?.report });
      for (const c of await d.getAll("remote")) if (c.workflow_id === workflow.id && String((c.answers as any)?.[fid!] ?? "").toLowerCase() === subj && !history.some((x) => x.id === c.id))
        history.push({ id: c.id, completed_at: c.completed_at, answers: c.answers as any, report: c.report });
    }
  }
  return { record, report, workflow, history };
}

export const assistantView: View = async (main, p) => {
  const l = await lang();
  const params = new URLSearchParams((location.hash.split("?")[1] ?? ""));
  const packs = await installedPacks();
  const model = await embeddingModelId();
  const status = h("div", { class: "muted", id: "assistant-mode" }, "Preparing the assistant…");
  const log = h("div", { id: "chat", class: "chat", "aria-live": "polite" });
  const input = h("input", { id: "ask", placeholder: l === "hi" ? "प्रश्न पूछें…" : "Ask a question…", enterkeyhint: "send", autocomplete: "off" }) as HTMLInputElement;
  const ctx = await loadContext(params);
  let state: State = newState(l);
  let corpus: Corpus | null = null;

  const header = h("div", { class: "card" }, h("h2", null, "Offline Assistant"), status);
  if (ctx.record) {
    const fid = ctx.workflow ? subjectField(ctx.workflow) : undefined;
    header.append(h("div", { class: "banner local", id: "assistant-context" },
      `Asking about: ${ctx.workflow ? text(ctx.workflow.title, l) : ctx.record.workflow_id}${fid && ctx.record.answers?.[fid] ? ` · ${ctx.record.answers[fid]}` : ""}`
      + (ctx.report ? ` · Hermes report v${ctx.report.version ?? ""}` : " · no Hermes report yet")));
  }
  main.append(header, log);

  const bubble = (who: "user" | "bot", ...kids: (Node | string | null)[]) => {
    const b = h("div", { class: `msg ${who}` }, ...kids);
    log.append(b);
    b.scrollIntoView({ block: "end" });
    return b;
  };

  /** The workspace a question belongs to: the open report's, else the built (non-starter) workspace on this device. */
  const wsId = (): string | undefined => ctx.report?.workspace?.id ?? corpus?.workspaces.find((w) => !w.id.startsWith("starter-"))?.id;
  const show = (q: string, r: Reply) => {
    const body = h("div", { class: "msg-text" }, r.text);
    const box = bubble("bot", body);
    box.setAttribute("data-kind", r.kind);
    if (r.intent) box.setAttribute("data-intent", r.intent);
    if (r.uncertainty) box.append(h("div", { class: "banner warn uncertainty" }, r.uncertainty));
    if (r.citations.length) box.append(h("div", { class: "citations muted" }, ...r.citations.map((c) =>
      h("div", null, c.href ? h("a", { href: c.href }, c.title) : c.title, c.status ? ` · ${c.status}` : "", c.source ? ` · ${c.source}` : ""))));
    if (r.options?.length) box.append(h("div", { class: "row options" }, ...r.options.map((o) => h("button", { onclick: () => ask(String(o.label)) }, o.label))));
    if (r.links?.length) box.append(h("div", { class: "row" }, ...r.links.map((x) => h("a", { class: "btn", href: x.href }, x.label))));
    if (r.suggestions?.length) box.append(h("div", { class: "row" }, ...r.suggestions.map((s) => h("button", { onclick: () => ask(s.query) }, s.label))));
    const other = state.lang === "hi" ? "en" : "hi";
    const tools = h("div", { class: "row msg-tools" },
      h("button", { onclick: async () => {
        if (!(await translationPairs()).some(([f, t]) => f === state.lang && t === other)) return toast("Install the offline translation pack first.", "error");
        try { const t = await translate(r.text, state.lang, other); body.textContent = t.text; } catch (e) { toast((e as Error).message, "error"); }
      } }, "Translate"),
      h("button", { onclick: () => { const s = speak(body.textContent ?? "", state.lang); if (!s.ok) toast(s.reason!, "error"); } }, "🔊"),
      h("button", { "aria-label": "Helpful", onclick: async () => { await logEvent("user_feedback", { question: q, answer: r.text.slice(0, 500), helpful: true, intent: r.intent }, { workspace_id: wsId() }); toast("Thanks — noted for Hermes", "ok"); } }, "👍"),
      h("button", { "aria-label": "Not helpful", onclick: async () => { await logEvent("user_feedback", { question: q, answer: r.text.slice(0, 500), helpful: false, intent: r.intent }, { workspace_id: wsId() }); toast("Noted — Hermes will look at it", "ok"); } }, "👎"));
    box.append(tools);
  };

  const ask = async (q: string) => {
    q = q.trim();
    if (!q || !corpus) return;
    input.value = "";
    bubble("user", q);
    const res = await respond(corpus, state, q, ctx, embed);
    state = res.state;
    show(q, res.reply);
    if (res.reply.gap) {
      await logEvent("knowledge_gap", { question: q, lang: state.lang, best_score: res.reply.score ?? 0, record_id: ctx.record?.id ?? null,
        workflow_id: ctx.record?.workflow_id ?? null }, { workspace_id: wsId() });
    }
  };

  const form = h("form", { class: "row ask-bar", onsubmit: (e: Event) => { e.preventDefault(); void ask(input.value); } },
    h("div", { class: "grow" }, input), h("button", { class: "primary" }, "Ask"));
  const extras = h("div", { class: "row" });
  main.append(h("div", { class: "card" }, form, extras));

  void (async () => {
    if ((await installedModels()).some((m) => m.capability === "stt")) {
      const rec = new VoiceRecorder();
      let on = false;
      const mic = h("button", { onclick: async () => {
        if (!on) { try { await rec.start(); on = true; mic.textContent = "■ Stop"; } catch (e) { toast((e as Error).message, "error"); } return; }
        on = false; mic.textContent = "Transcribing…";
        try { const t = await transcribe((await rec.stop()).blob, state.lang); input.value = t.text; } catch (e) { toast((e as Error).message, "error"); }
        mic.textContent = "🎙 Speak";
      } }, "🎙 Speak");
      extras.append(mic);
    }
    if ((await ocrLanguages()).length) {
      const file = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none", onchange: async (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        const langs = await ocrLanguages();
        try { const r = await ocr(f, langs.includes(state.lang === "hi" ? "hin" : "eng") ? (state.lang === "hi" ? "hin" : "eng") : langs[0]);
          input.value = r.text.split("\n").slice(0, 3).join(" "); if (r.note) toast(r.note, r.quality === "poor" ? "error" : "info"); }
        catch (err) { toast((err as Error).message, "error"); }
      } }) as HTMLInputElement;
      extras.append(file, h("button", { onclick: () => file.click() }, "📷 Text from photo"));
    }
  })();

  const vcache = model ? vectorCache(model) : undefined;
  corpus = await buildCorpus(packs.map((x) => ({ id: x.id, kind: x.kind, content: x.content })), embed, l, vcache);
  clear(status);
  status.append(corpus.mode === "meaning"
    ? `Understands questions by meaning (English and Hindi) · ${corpus.items.length} items from your workspaces and packs · answers only from them, with sources.`
    : h("span", null, "Basic search (matching words). For questions in your own words and in Hindi, install ",
      h("a", { href: "#/packs" }, "Question understanding"), " in Offline Packs."));
  if (!corpus.items.length && !ctx.report) {
    log.append(h("div", { class: "banner warn" }, "Nothing to answer from yet: download a workspace or knowledge packs first.", h("div", null, h("a", { class: "btn", href: "#/workspaces" }, "Workspaces"))));
  }
  // Start a decision guide directly (from a report action or the workspace page).
  const gws = p.ws ?? params.get("ws"), gid = p.gid ?? params.get("guide");
  if (gws && gid) {
    const res = beginGuide(corpus, state, gws, gid, ctx);
    if (res) { state = res.state; show("", res.reply); }
    else bubble("bot", "That guide isn't on this device. Download its workspace first.");
  } else {
    const starters = ctx.report ? (l === "hi" ? ["रिपोर्ट समझाइए", "पहले क्या करूँ?", "पहली समस्या समझाइए"] : ["Explain the report", "What should I do first?", "Explain issue 1"])
      : corpus.workspaces.flatMap((w) => w.guides.slice(0, 3).map((g) => text(g.title, l))).slice(0, 4);
    if (starters.length) log.append(h("div", { class: "row starters" }, ...starters.map((s) => h("button", { onclick: () => ask(s) }, s))));
  }
  const pre = params.get("q");
  if (pre) await ask(pre);
};
