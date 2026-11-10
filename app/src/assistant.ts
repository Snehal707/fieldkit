// Offline assistant engine (0.2.5). Understands questions, follow-ups, photo text and voice transcripts by meaning
// (multilingual embeddings), tracks the conversation, links workspace terms, runs decision guides, and explains records
// and Hermes reports, composing answers only from workspace content, records and reports, with citations. Anything it
// cannot support is reported as not covered and queued for Hermes as a knowledge gap. No text is generated.
import { cosine, isFollowUp, itemReference, linkEntities, prototypes, rankIntents, SUPPORT_THRESHOLD, type Entity, type Prototype } from "./assistant_core";
import type { Intent } from "./assistant_intents";
import { classify, text, type Workflow } from "./engine";
import { answerGuide, currentQuestion, outcomeOf, startGuide, type Guide, type GuideRun } from "./guides";

export type EmbedFn = (texts: string[]) => Promise<number[][] | null>;

export interface Item {
  key: string; kind: "entry" | "guide" | "term" | "claim"; title: string; body: string; type?: string;
  status?: string; source?: string; href?: string; workspaceId?: string; guide?: Guide; raw?: any;
}

export interface Corpus { items: Item[]; vecs: (number[] | null)[]; protos: Prototype[]; entities: Entity[]; mode: "meaning" | "basic";
  workspaces: { id: string; title: string; decisionScale: any[]; guides: Guide[]; status: Record<string, string>; workflows: string[] }[] }

export interface AskContext { record?: { id: string; workflow_id: string; answers: Record<string, unknown>; completed_at?: string } | null;
  report?: any; workflow?: Workflow | null; history?: { id: string; completed_at?: string; answers: Record<string, unknown>; report?: any }[];
  /** The workspace the user is working in (chosen on the assistant page, or the last one opened). */
  workspaceId?: string | null }

export interface State {
  lang: string; lastIntent?: Intent; topic?: Entity; issueIndex?: number; lastItems?: Item[];
  guide?: { run: GuideRun; guide: Guide; workspaceId: string; status?: Record<string, string> } | null; turns: number;
}

export interface Citation { title: string; status?: string; source?: string; href?: string }
export interface Reply {
  kind: "answer" | "not_covered" | "clarify" | "guide_question" | "guide_outcome";
  text: string; intent?: Intent; citations: Citation[]; uncertainty?: string; options?: { label: string; value: unknown }[];
  suggestions?: { label: string; query: string }[]; links?: { label: string; href: string }[]; gap?: boolean; score?: number;
}

export const STATUS_TEXT: Record<string, string> = {
  verified: "Verified source", user_procedure: "Your procedure", supported: "Supported by a source",
  local_practice: "Learned from your team's verified outcomes",
  conflicting: "Sources disagree", unverified: "Not verified", example: "Example content",
};

const L = (lang: string, en: string, hi: string) => (lang === "hi" ? hi : en);
export const detectLang = (q: string, fallback: string) => (/[ऀ-ॿ]/.test(q) ? "hi" : /[a-z]{3}/i.test(q) ? "en" : fallback);

// ----------------------------------------------------------------------------- corpus
/** Build the searchable corpus from installed workspace manifests, knowledge and dictionary packs. */
export async function buildCorpus(packs: { id: string; kind: string; content: any }[], embedFn: EmbedFn, lang: string,
  cache?: { get(k: string): Promise<number[] | undefined>; put(k: string, v: number[]): Promise<void> }): Promise<Corpus> {
  const items: Item[] = [];
  const entities: Entity[] = [];
  const workspaces: Corpus["workspaces"] = [];
  const wsByPack = new Map<string, string>();
  for (const p of packs.filter((x) => x.kind === "workspace")) {
    const m = p.content;
    workspaces.push({ id: m.workspace_id, title: text(m.title, lang), decisionScale: m.report_policy?.decision_scale ?? [], guides: m.guides ?? [],
      status: Object.fromEntries((m.evidence ?? []).map((e: any) => [e.id, e.status])), workflows: (m.workflows ?? []).map((w: any) => w.id) });
    for (const pid of m.packs ?? []) wsByPack.set(pid, m.workspace_id);
    const status = new Map<string, string>((m.evidence ?? []).map((e: any) => [e.id, e.status]));
    const src = new Map<string, any>((m.sources ?? []).map((s: any) => [s.id, s]));
    for (const g of m.guides ?? []) {
      const qs = Object.values(g.nodes ?? {}).map((n: any) => text(n.question, lang) || text(n.outcome?.title, lang)).filter(Boolean).join(". ");
      items.push({ key: `guide:${m.workspace_id}:${g.id}`, kind: "guide", title: text(g.title, lang), body: qs, workspaceId: m.workspace_id, guide: g,
        status: bestOf((g.evidence_ids ?? []).map((x: string) => status.get(x) ?? "unverified")), href: `#/guide/${m.workspace_id}/${g.id}` });
      entities.push({ id: `guide:${g.id}`, kind: "guide", names: Object.values(g.title ?? {}).map(String), ref: g, ws: m.workspace_id });
    }
    for (const e of m.evidence ?? []) {
      if (!["verified", "supported", "user_procedure", "local_practice", "conflicting"].includes(e.status)) continue;
      const ex = (e.excerpts ?? [])[0];
      const s = ex ? src.get(ex.source_id) : null;
      items.push({ key: `claim:${m.workspace_id}:${e.id}`, kind: "claim", title: e.claim, body: ex?.quote ?? "", status: e.status,
        source: s ? `${s.publisher || s.title}${ex.locator ? `, ${ex.locator}` : ""}` : undefined, workspaceId: m.workspace_id, raw: e });
    }
  }
  for (const p of packs.filter((x) => x.kind === "knowledge")) {
    const c = p.content;
    for (const e of c.entries ?? []) {
      items.push({ key: `entry:${p.id}::${e.id}`, kind: "entry", type: e.type, title: text(e.title, lang), body: text(e.text, lang),
        status: e.evidence_status ?? (wsByPack.has(p.id) ? "unverified" : "example"), source: e.source || text(c.source?.title, lang) || text(c.title, lang),
        href: `#/knowledge/${encodeURIComponent(`${p.id}::${e.id}`)}`, workspaceId: wsByPack.get(p.id), raw: e });
    }
  }
  for (const p of packs.filter((x) => x.kind === "dictionary")) {
    for (const e of p.content.entries ?? []) {
      const names = [e.term, ...Object.values(e.translations ?? {}), ...(e.synonyms ?? [])].map(String).filter(Boolean);
      items.push({ key: `term:${p.id}::${e.term}`, kind: "term", title: String(e.term), body: `${e.definition ?? ""} ${Object.values(e.translations ?? {}).join(", ")}`,
        source: text(p.content.title, lang), workspaceId: wsByPack.get(p.id), raw: e });
      entities.push({ id: `term:${e.term}`, kind: "term", names, ref: e, ws: wsByPack.get(p.id) });
    }
  }
  const protos = prototypes(packs.filter((x) => x.kind === "workspace").flatMap((p) => p.content.intents ?? []));
  const docs = items.map((it) => `${it.title}. ${it.body}`.slice(0, 600));
  const probe = await embedFn(["probe"]);
  if (!probe) return { items, vecs: items.map(() => null), protos, entities, mode: "basic", workspaces };
  const vecs = await cachedEmbed(docs, embedFn, cache);
  const pv = await cachedEmbed(protos.map((p) => p.text), embedFn, cache);
  protos.forEach((p, i) => { p.vec = pv[i] ?? undefined; });
  return { items, vecs, protos, entities, mode: "meaning", workspaces };
}

function bestOf(st: string[]): string {
  const rank: Record<string, number> = { verified: 5, user_procedure: 5, supported: 4, local_practice: 4, conflicting: 3, unverified: 1 };
  return st.sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0] ?? "unverified";
}

function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ":" + s.length;
}

async function cachedEmbed(texts: string[], embedFn: EmbedFn, cache?: { get(k: string): Promise<number[] | undefined>; put(k: string, v: number[]): Promise<void> }) {
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  const todo: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = cache ? await cache.get(hashText(texts[i])) : undefined;
    if (hit) out[i] = hit; else todo.push(i);
  }
  for (let b = 0; b < todo.length; b += 16) {
    const batch = todo.slice(b, b + 16);
    const vs = (await embedFn(batch.map((i) => texts[i]))) ?? [];
    for (let j = 0; j < batch.length; j++) {
      out[batch[j]] = vs[j] ?? null;
      if (cache && vs[j]) await cache.put(hashText(texts[batch[j]]), vs[j]);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- retrieval
const STOP = new Set(("the and for are was were what which who whom whose when where why how does did can could should would will "
  + "this that these those with from into about than then there their them they you your yours our ours his her its not but "
  + "have has had been being any all some more most very just also please tell explain give show is it in of to a an "
  + "क्या है हैं था थी थे का की के को में से पर और या यह वह इस उस एक मैं मुझे आप कैसे क्यों कब कहाँ कौन होता होती").split(/\s+/));

function rank(corpus: Corpus, qv: number[] | null, q: string, kinds: Item["kind"][], topic?: Entity, scope?: string): { item: Item; score: number }[] {
  const words = [...new Set(q.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))];
  return corpus.items.map((item, i) => {
    if (!kinds.includes(item.kind)) return null;
    if (scope && item.workspaceId && item.workspaceId !== scope) return null;   // another workspace's content
    let s = qv && corpus.vecs[i] ? cosine(qv, corpus.vecs[i]!) : 0;
    if (!qv) {   // basic mode: content-word overlap only (no meaning model installed)
      const hay = `${item.title} ${item.body}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      s = hits >= Math.min(2, words.length) && words.length ? hits / words.length * 0.6 : 0;
    }
    if (topic && `${item.title} ${item.body}`.toLowerCase().includes(String(topic.names[0] ?? "").toLowerCase())) s += 0.05;
    if (item.status === "unverified") s -= 0.03;
    return { item, score: s };
  }).filter((x): x is { item: Item; score: number } => !!x).sort((a, b) => b.score - a.score);
}

function cite(it: Item): Citation {
  return { title: it.title, status: it.status ? STATUS_TEXT[it.status] ?? it.status : undefined, source: it.source, href: it.href };
}

// ----------------------------------------------------------------------------- answering
export function newState(lang: string): State { return { lang, turns: 0, guide: null }; }

/** The workspace to answer from: the open report's, the record's workflow's, or the one the user is working in.
 *  Undefined = all downloaded content (one workspace on the device, or the user chose "all"). Content that belongs to
 *  no workspace (general knowledge packs) is always included. */
export function scopeOf(corpus: Corpus, ctx: AskContext): string | undefined {
  const has = (id?: string | null) => !!id && corpus.workspaces.some((w) => w.id === id);
  if (has(ctx.report?.workspace?.id)) return ctx.report.workspace.id;
  const byWf = ctx.record ? corpus.workspaces.find((w) => w.workflows.includes(ctx.record!.workflow_id))?.id : undefined;
  if (byWf) return byWf;
  return has(ctx.workspaceId) ? ctx.workspaceId! : undefined;
}

/** No Hermes report yet: answer "what now / why / is it safe" from the record's on-phone result (the workspace's own
 *  rules), labelled as such. Seen in a real trial: these questions got "not covered" while the phone already knew. */
function localFindingsReply(ctx: AskContext, lang: string): Reply | null {
  if (!ctx.record || !ctx.workflow) return null;
  const fs = classify(ctx.workflow, ctx.record.answers as any, lang);
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  fs.sort((a, b) => (order[a.severity] ?? 5) - (order[b.severity] ?? 5));
  const lines = fs.map((f) => `• ${f.label}${f.detail && f.detail !== f.label ? ` — ${f.detail}` : ""}`);
  return { kind: "answer", citations: [{ title: L(lang, "On-phone result (your workspace rules)", "फ़ोन पर परिणाम (आपके कार्यक्षेत्र के नियम)") }],
    text: [L(lang, "No Hermes report yet. From your workspace rules, on this phone:", "अभी हर्मीस रिपोर्ट नहीं है। आपके नियमों के अनुसार, इसी फ़ोन पर:"),
      lines.length ? lines.join("\n") : L(lang, "Your rules found nothing that needs action for this record.", "आपके नियमों में इस रिकॉर्ड के लिए कोई कार्रवाई नहीं निकली।")].join("\n"),
    uncertainty: L(lang, "Hermes adds its full opinion after this record syncs.", "सिंक होने के बाद हर्मीस अपनी पूरी राय जोड़ेगा।") };
}

export async function respond(corpus: Corpus, state: State, question: string, ctx: AskContext, embedFn: EmbedFn): Promise<{ reply: Reply; state: State }> {
  const q = question.trim();
  const lang = detectLang(q, state.lang);
  let st: State = { ...state, lang, turns: state.turns + 1 };
  const qv = corpus.mode === "meaning" ? ((await embedFn([q])) ?? [])[0] ?? null : null;

  // 1. An open decision guide takes the answer first.
  if (st.guide && !st.guide.run.done) {
    const value = parseGuideAnswer(st.guide.guide, st.guide.run, q, lang);
    if (value !== undefined) return guideStep(st, answerGuide(st.guide.guide, st.guide.run, value, ctx.record?.answers ?? {}), ctx, lang);
    if (q.split(/\s+/).length <= 3) {
      return { reply: guideQuestionReply(st.guide.guide, st.guide.run, lang, ctx, L(lang, "Please choose one of the answers below.", "कृपया नीचे दिए गए उत्तरों में से एक चुनें।")), state: st };
    }
    st = { ...st, guide: null };                         // a full new question: leave the guide
  }

  // 2. Understanding: intent by meaning + word cues; references; follow-ups; entities.
  const ranked = rankIntents(q, qv, corpus.protos);
  let intent: Intent | undefined = ranked[0]?.[0];
  const ref = itemReference(q);
  const follow = isFollowUp(q);
  const weak = (ranked[0]?.[1] ?? 0) < (corpus.mode === "meaning" ? 0.4 : 0.1);
  if (follow && weak && st.lastIntent) intent = st.lastIntent;
  // A question that matches no intent clearly (and names no issue/action) is answered only from evidence above the
  // support threshold, never by a report handler (e.g. "who won the match yesterday?" is not "compare with last time").
  else if (weak && !ref) intent = undefined;
  if (ref?.kind === "issue" && !["why", "what_next", "is_it_safe"].includes(intent ?? "")) intent = "explain_issue";
  const scope = scopeOf(corpus, ctx);
  const ents = linkEntities(q, [...corpus.entities.filter((e) => !scope || !e.ws || e.ws === scope), ...contextEntities(ctx, lang)]);
  const topic = ents[0] ?? (follow ? st.topic : undefined);
  st = { ...st, lastIntent: intent, topic };
  if (ref?.kind === "issue") st.issueIndex = ref.index < 0 ? (ctx.report?.issues?.length ?? 1) : ref.index;

  const r = ctx.report;
  const reply = (x: Reply) => ({ reply: { ...x, intent }, state: st });
  const hasPrevious = (ctx.history ?? []).some((h) => h.id !== ctx.record?.id);
  if (ctx.record && !r?.decision && (["what_next", "why", "is_it_safe", "explain_report", "explain_issue"].includes(intent ?? "")
      || (intent === "compare_to_previous" && !hasPrevious))) {
    const lf = localFindingsReply(ctx, lang);
    if (lf) return reply(lf);
  }

  switch (intent) {
    case "translate":
      return reply({ kind: "answer", text: L(lang, "Use “Translate” under an answer to change its language.", "किसी उत्तर के नीचे “अनुवाद” दबाकर भाषा बदलें।"), citations: [] });
    case "explain_report":
      if (r?.decision) return reply(reportSummary(r, lang));
      break;
    case "explain_issue": {
      const i = pickIssue(r, st.issueIndex, q, qv, topic);
      if (i) { st.issueIndex = i.index; return reply(explainIssue(r, i.index, ctx, lang)); }
      break;
    }
    case "why":
      if (r?.decision) {
        const i = st.issueIndex ? explainIssue(r, st.issueIndex, ctx, lang) : null;
        return reply({ kind: "answer", text: [r.decision.rationale, i?.text].filter(Boolean).join("\n\n"), citations: i?.citations ?? [],
          uncertainty: uncertaintyText(r, lang) });
      }
      break;
    case "what_next":
      if (r?.next_actions?.length) return reply(nextActions(r, lang, st.issueIndex));
      break;
    case "is_it_safe":
      if (r?.decision) return reply(decisionReply(r, lang));
      break;
    case "compare_to_previous":
      if (ctx.record && hasPrevious) return reply(compare(ctx, lang));
      if (ctx.record && r?.next_actions?.length) return reply(nextActions(r, lang, st.issueIndex));
      break;
  }

  // 3. Workspace content: guides for how-to / troubleshoot / safety, claims for requirements, terms for definitions.
  if (intent === "define_term") {
    const term = ents.find((e) => e.kind === "term") ?? (topic?.kind === "term" ? topic : undefined);
    if (term) return reply(defineTerm(term, lang));
  }
  const kinds: Item["kind"][] = intent === "check_requirement" ? ["claim", "entry"] : intent === "define_term" ? ["term", "entry"]
    // "What should I do / is it safe": a guide or entry first, but the user's own rules (claims) answer it too.
    : ["how_to", "troubleshoot", "is_it_safe", "what_next"].includes(intent ?? "") ? ["guide", "entry", "claim"] : ["entry", "guide", "claim", "term"];
  const hits = rank(corpus, qv, topic && follow ? `${topic.names[0]} ${q}` : q, kinds, topic, scope);
  const top = hits[0];
  const threshold = corpus.mode === "meaning" ? SUPPORT_THRESHOLD : 0.3;
  if (!top || top.score < threshold) {
    return { reply: { kind: "not_covered", intent, gap: true, score: top?.score ?? 0, citations: [],
      text: L(lang, "This isn't covered by the knowledge on this device, so I won't guess. I've noted the question for Hermes to research when you're back online.",
        "यह इस डिवाइस के ज्ञान में शामिल नहीं है, इसलिए मैं अनुमान नहीं लगाऊँगा। ऑनलाइन होने पर हर्मीस इस पर शोध करेगा, मैंने प्रश्न नोट कर लिया है।"),
      suggestions: hits.slice(0, 3).filter((h) => h.score > threshold * 0.6).map((h) => ({ label: h.item.title, query: h.item.title })) }, state: st };
  }
  st.lastItems = hits.slice(0, 3).map((h) => h.item);
  if (top.item.kind === "guide" && top.item.guide && top.item.workspaceId) {
    const run = startGuide(top.item.guide, top.item.workspaceId, ctx.record?.answers ?? {});
    st.guide = { run, guide: top.item.guide, workspaceId: top.item.workspaceId, status: corpus.workspaces.find((w) => w.id === top.item.workspaceId)?.status };
    return guideStep(st, run, ctx, lang, top.item);
  }
  const close = hits[1] && hits[1].score > top.score - 0.02 && hits[1].item.title !== top.item.title;
  return reply({ kind: "answer", text: `${top.item.title}\n\n${excerpt(top.item.body, q)}`, citations: [cite(top.item)], score: top.score,
    uncertainty: top.item.status === "unverified" ? L(lang, "Background only: not verified against a source for your region.", "केवल पृष्ठभूमि: आपके क्षेत्र के स्रोत से सत्यापित नहीं।")
      : top.item.status === "conflicting" ? L(lang, "Sources disagree on this. Follow your escalation contact or the stricter rule.", "स्रोत इस पर असहमत हैं। अपने वरिष्ठ से पूछें या सख्त नियम मानें।") : undefined,
    suggestions: close ? [{ label: L(lang, `Or did you mean: ${hits[1].item.title}?`, `या आपका मतलब था: ${hits[1].item.title}?`), query: hits[1].item.title }] : undefined,
    links: top.item.href ? [{ label: L(lang, "Open the full entry", "पूरी जानकारी खोलें"), href: top.item.href }] : undefined });
}

function excerpt(body: string, q: string): string {
  const sents = body.split(/(?<=[.!?।])\s+/u);
  if (body.length <= 600) return body;
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const scored = sents.map((s, i) => ({ i, n: words.filter((w) => s.toLowerCase().includes(w)).length }));
  const best = scored.sort((a, b) => b.n - a.n)[0]?.i ?? 0;
  return sents.slice(Math.max(0, best - 1), best + 3).join(" ");
}

function contextEntities(ctx: AskContext, lang: string): Entity[] {
  const out: Entity[] = [];
  for (const f of ctx.workflow?.fields ?? []) out.push({ id: `field:${f.id}`, kind: "field", names: [text(f.label, lang), text(f.label, "en"), f.id].filter(Boolean), ref: f });
  (ctx.report?.issues ?? []).forEach((i: any, k: number) => out.push({ id: `issue:${k + 1}`, kind: "issue", names: [i.title], ref: k + 1 }));
  return out;
}

function pickIssue(r: any, idx: number | undefined, q: string, qv: number[] | null, topic?: Entity): { index: number } | null {
  const issues = r?.issues ?? [];
  if (!issues.length) return null;
  if (idx && idx >= 1 && idx <= issues.length) return { index: idx };
  if (topic?.kind === "issue") return { index: topic.ref };
  const ql = q.toLowerCase();
  const k = issues.findIndex((i: any) => ql.includes(String(i.title).toLowerCase().split(" ")[0]));
  return { index: k >= 0 ? k + 1 : 1 };
}

function fieldValue(ctx: AskContext, ref: string, lang: string): string {
  const f = ctx.workflow?.fields.find((x) => x.id === ref);
  const v = ctx.record?.answers?.[ref];
  if (!f) return v === undefined || typeof v === "object" ? ref : `${ref}: ${v}`;
  const label = text(f.label, lang);
  if (v === undefined) return label;
  const shown = f.type === "single_choice" ? text(f.options?.find((o) => o.value === v)?.label, lang) || String(v)
    : f.type === "checkbox" ? (v ? L(lang, "Yes", "हाँ") : L(lang, "No", "नहीं")) : Array.isArray(v) ? `${v.length}` : typeof v === "object" ? "" : String(v);
  return shown ? `${label}: ${shown}${f.unit ? ` ${f.unit}` : ""}` : label;
}

function explainIssue(r: any, index: number, ctx: AskContext, lang: string): Reply {
  const it = r.issues[index - 1];
  const tr = lang !== "en" ? r.translations?.[lang]?.issues?.[index - 1] : null;
  const ev = (it.evidence_refs ?? []).map((e: any) => `• ${e.kind === "answer" || e.kind === "measurement" ? fieldValue(ctx, e.ref, lang) : `${e.kind.replace(/_/g, " ")} ${e.ref}`}${e.quote ? ` — “${e.quote}”` : ""}`);
  const acts = (r.next_actions ?? []).filter((a: any) => String(a.action).toLowerCase().includes(String(it.title).toLowerCase().split(" ")[0])).slice(0, 2);
  return { kind: "answer", citations: [{ title: L(lang, "Hermes report", "हर्मीस रिपोर्ट"), source: `v${r.version ?? ""}` }],
    text: [`${L(lang, "Issue", "समस्या")} ${index}: ${tr || it.title} (${it.severity})`, it.interpretation, ev.length ? `${L(lang, "Evidence", "प्रमाण")}:\n${ev.join("\n")}` : "",
      acts.length ? `${L(lang, "What to do", "क्या करें")}: ${acts.map((a: any) => a.action).join("; ")}` : ""].filter(Boolean).join("\n\n"),
    suggestions: [{ label: L(lang, "What should I do next?", "आगे क्या करूँ?"), query: L(lang, "What should I do next?", "आगे क्या करूँ?") }] };
}

function decisionReply(r: any, lang: string): Reply {
  const step = (r.decision_scale ?? []).find((d: any) => d.id === r.decision.outcome);
  const label = typeof step?.label === "object" ? text(step.label, lang) : step?.label ?? r.decision.outcome;
  const tr = lang !== "en" ? r.translations?.[lang] : null;
  return { kind: "answer", citations: [{ title: L(lang, "Hermes report", "हर्मीस रिपोर्ट"), source: `v${r.version ?? ""}` }],
    text: [`${L(lang, "Decision", "निर्णय")}: ${label} (${L(lang, "confidence", "विश्वास")}: ${r.decision.confidence})`, tr?.rationale || r.decision.rationale,
      r.decision.escalate_to ? `${L(lang, "Escalate to", "सूचित करें")}: ${r.decision.escalate_to}` : ""].filter(Boolean).join("\n\n"),
    uncertainty: uncertaintyText(r, lang) };
}

function reportSummary(r: any, lang: string): Reply {
  const d = decisionReply(r, lang);
  const tr = lang !== "en" ? r.translations?.[lang] : null;
  const first = (r.next_actions ?? [])[0];
  return { ...d, text: [d.text, tr?.summary || r.summary, first ? `${L(lang, "First", "पहले")}: ${first.action}` : ""].filter(Boolean).join("\n\n") };
}

function nextActions(r: any, lang: string, issueIndex?: number): Reply {
  const tr = lang !== "en" ? r.translations?.[lang]?.next_actions : null;
  const acts = r.next_actions as any[];
  const lines = acts.map((a, i) => `${i + 1}. ${tr?.[i] || a.action}${a.who ? ` (${a.who}` + (typeof a.by_when_days === "number" ? `, ${a.by_when_days <= 0 ? L(lang, "now", "अभी") : L(lang, `within ${a.by_when_days} days`, `${a.by_when_days} दिन में`)})` : ")") : ""}\n   ${L(lang, "Check it worked", "जाँचें")}: ${a.verify_by}${a.origin === "ai_suggestion" ? ` · ${L(lang, "AI suggestion", "एआई सुझाव")}` : ""}`);
  const links = acts.filter((a) => a.origin === "guide" && a.guide_id && r.workspace?.id)
    .map((a) => ({ label: L(lang, `Guide: ${a.action}`, `मार्गदर्शिका: ${a.action}`), href: `#/guide/${r.workspace.id}/${a.guide_id}` }));
  void issueIndex;
  return { kind: "answer", text: lines.join("\n"), citations: [{ title: L(lang, "Hermes report", "हर्मीस रिपोर्ट"), source: `v${r.version ?? ""}` }], links };
}

function uncertaintyText(r: any, lang: string): string | undefined {
  const u = r.uncertainty ?? [];
  return u.length ? `${L(lang, "Not certain", "अनिश्चित")}: ${u.map((x: any) => `${x.unknown} (${x.how_to_resolve})`).join("; ")}` : undefined;
}

function defineTerm(e: Entity, lang: string): Reply {
  const t = e.ref ?? {};
  const tr = Object.entries(t.translations ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  return { kind: "answer", text: `${t.term}${tr ? ` (${tr})` : ""}\n\n${t.definition ?? ""}`, citations: [{ title: t.term, source: t.source }] };
}

function compare(ctx: AskContext, lang: string): Reply {
  const hist = (ctx.history ?? []).filter((h) => h.id !== ctx.record?.id).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  if (!ctx.record || !hist.length) {
    return { kind: "answer", citations: [], text: L(lang, "There is no earlier record of this subject on this device to compare with.", "इस विषय का कोई पिछला रिकॉर्ड इस डिवाइस पर नहीं है।") };
  }
  const prev = hist[0];
  const changes: string[] = [];
  for (const f of ctx.workflow?.fields ?? []) {
    const a = prev.answers?.[f.id], b = ctx.record.answers?.[f.id];
    if (typeof a === "number" && typeof b === "number" && a !== b) changes.push(`${text(f.label, lang)}: ${a} → ${b}${f.unit ? ` ${f.unit}` : ""}`);
    else if ((typeof a === "string" || typeof a === "boolean") && a !== b && b !== undefined && f.type !== "text" && f.type !== "multiline") changes.push(`${text(f.label, lang)}: ${fmtV(f, a, lang)} → ${fmtV(f, b, lang)}`);
  }
  const pd = prev.report?.decision?.outcome;
  return { kind: "answer", citations: [{ title: L(lang, "Earlier record", "पिछला रिकॉर्ड"), source: String(prev.completed_at ?? "") }],
    text: [`${L(lang, "Compared with", "तुलना")} ${String(prev.completed_at ?? "").slice(0, 10)}:`, changes.length ? changes.join("\n") : L(lang, "No measured values changed.", "कोई मापा गया मान नहीं बदला।"),
      pd ? `${L(lang, "Previous decision", "पिछला निर्णय")}: ${pd}` : ""].filter(Boolean).join("\n") };
}

function fmtV(f: any, v: unknown, lang: string): string {
  if (f.type === "checkbox") return v ? L(lang, "Yes", "हाँ") : L(lang, "No", "नहीं");
  return text(f.options?.find((o: any) => o.value === v)?.label, lang) || String(v);
}

// ----------------------------------------------------------------------------- guides in the conversation
function parseGuideAnswer(g: Guide, run: GuideRun, q: string, lang: string): unknown {
  const cq = currentQuestion(g, run, lang);
  if (!cq) return undefined;
  const s = q.trim().toLowerCase();
  if (cq.input === "yes_no") {
    if (/^(yes|y|yeah|yep|done|हाँ|हां|जी|true)\b/.test(s)) return true;
    if (/^(no|n|nope|not|नहीं|false)\b/.test(s)) return false;
    return undefined;
  }
  if (cq.input === "number") { const m = s.replace(",", ".").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : undefined; }
  if (cq.options.length) {
    const hit = cq.options.find((o) => s === String(o.label).toLowerCase() || s === String(o.value).toLowerCase() || s.includes(String(o.label).toLowerCase()));
    return hit ? hit.value : undefined;
  }
  // Free text: a short reply is an answer; a full new question (ends with "?" or is long) is not.
  return q.trim() && !/[?？]\s*$/.test(q) && q.trim().split(/\s+/).length <= 6 ? q.trim() : undefined;
}

function guideQuestionReply(g: Guide, run: GuideRun, lang: string, ctx: AskContext, prefix = ""): Reply {
  const fieldLabel = (id: string) => text(ctx.workflow?.fields.find((f) => f.id === id)?.label, lang) || id;
  const cq = currentQuestion(g, run, lang, fieldLabel)!;
  return { kind: "guide_question", text: [prefix, cq.text].filter(Boolean).join("\n"), citations: [{ title: text(g.title, lang) }],
    options: cq.options.map((o) => ({ label: o.label, value: o.value })) };
}

function guideStep(st: State, run: GuideRun, ctx: AskContext, lang: string, item?: Item): { reply: Reply; state: State } {
  const g = st.guide!.guide;
  st = { ...st, guide: { ...st.guide!, run } };
  const from = run.steps.filter((x) => x.source === "record").map((x) => fieldValue(ctx, String(g.nodes[x.node]?.field ?? x.slot), lang));
  const intro = item ? `${L(lang, "Guide", "मार्गदर्शिका")}: ${item.title}${from.length ? `\n${L(lang, "From this record", "इस रिकॉर्ड से")}: ${from.join("; ")}` : ""}` : "";
  if (!run.done) return { reply: { ...guideQuestionReply(g, run, lang, ctx, intro), intent: "how_to" }, state: st };
  const out = outcomeOf(g, run);
  const keep = st.guide;
  st = { ...st, guide: null };
  if (!out) {
    return { reply: { kind: "guide_outcome", intent: "how_to", citations: [{ title: text(g.title, lang) }],
      text: L(lang, "The guide doesn't cover this combination of answers. Don't guess: ask your escalation contact.", "मार्गदर्शिका इन उत्तरों को शामिल नहीं करती। अनुमान न लगाएँ: अपने वरिष्ठ से पूछें।") }, state: st };
  }
  const status = keep?.status ?? {};
  const acts = (out.actions ?? []).map((a) => {
    const s = a.kind === "escalate" ? "" : bestOf((a.evidence_ids ?? out.evidence_ids ?? []).map((x) => status[x] ?? "unverified"));
    return `• ${text(a.text, lang)}${a.kind === "escalate" ? ` (${L(lang, "escalate", "सूचित करें")})` : s ? ` — ${STATUS_TEXT[s] ?? s}` : ""}`;
  });
  return { reply: { kind: "guide_outcome", intent: "how_to", citations: [{ title: text(g.title, lang), status: undefined }],
    text: [`${L(lang, "Outcome", "परिणाम")}: ${text(out.title, lang) || out.decision}`, acts.join("\n"),
      out.escalate_to ? `${L(lang, "Escalate to", "सूचित करें")}: ${out.escalate_to}` : ""].filter(Boolean).join("\n\n") }, state: st };
}

/** Start a workspace guide in the conversation (from a report action or the workspace page). */
export function beginGuide(corpus: Corpus, state: State, workspaceId: string, guideId: string, ctx: AskContext): { reply: Reply; state: State } | null {
  const item = corpus.items.find((i) => i.kind === "guide" && i.workspaceId === workspaceId && i.guide?.id === guideId);
  if (!item?.guide) return null;
  const run = startGuide(item.guide, workspaceId, ctx.record?.answers ?? {});
  const st: State = { ...state, guide: { run, guide: item.guide, workspaceId, status: corpus.workspaces.find((w) => w.id === workspaceId)?.status } };
  return guideStep(st, run, ctx, state.lang, item);
}
