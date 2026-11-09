// Decision-guide runner (0.2.5): executes a workspace guide offline. Question nodes are filled from the open record
// when they read a record field, otherwise asked; conditional edges use the workflow engine's condition evaluator;
// outcome nodes give a decision on the workspace scale, actions with their evidence status, and escalation.
// Deterministic: it never skips a question by guessing.
import { evaluate, text, type Answers } from "./engine";

export interface GuideNode {
  slot?: string; field?: string; question?: any; input?: "yes_no" | "choice" | "number" | "text"; options?: { value: unknown; label: any }[];
  next?: { when?: any; to: string }[]; default?: string;
  outcome?: { decision: string; title?: any; actions?: { text: any; evidence_ids?: string[]; kind?: string }[]; escalate_to?: string; evidence_ids?: string[] };
}
export interface Guide { id: string; title: any; workflow_id?: string; start: string; nodes: Record<string, GuideNode>; evidence_ids?: string[] }

export interface GuideRun {
  guideId: string; workspaceId: string; node: string; slots: Answers;
  steps: { node: string; slot?: string; value: unknown; source: "record" | "user" }[];
  done: boolean; stuck?: boolean;
}

const MAX_STEPS = 200;

/** Follow edges from `node` while slots allow; stop at a question that needs the user, an outcome, or a dead end. */
function advance(g: Guide, run: GuideRun, record: Answers): GuideRun {
  for (let i = 0; i < MAX_STEPS; i++) {
    const n = g.nodes[run.node];
    if (!n) return { ...run, done: true, stuck: true };
    if (n.outcome) return { ...run, done: true };
    const slot = n.slot ?? run.node;
    if (!(slot in run.slots) && n.field && record[n.field] !== undefined && record[n.field] !== "") {
      run = { ...run, slots: { ...run.slots, [slot]: record[n.field] }, steps: [...run.steps, { node: run.node, slot, value: record[n.field], source: "record" }] };
    }
    if (!(slot in run.slots)) return run;                     // the user must answer this one
    const scope = { ...record, ...run.slots };
    const edge = (n.next ?? []).find((e) => evaluate(e.when ?? null, scope));
    const to = edge?.to ?? n.default;
    if (!to) return { ...run, done: true, stuck: true };      // no rule covers this answer: escalate, don't guess
    run = { ...run, node: to };
  }
  return { ...run, done: true, stuck: true };
}

export function startGuide(g: Guide, workspaceId: string, record: Answers = {}): GuideRun {
  return advance(g, { guideId: g.id, workspaceId, node: g.start, slots: {}, steps: [], done: false }, record);
}

export function answerGuide(g: Guide, run: GuideRun, value: unknown, record: Answers = {}): GuideRun {
  const n = g.nodes[run.node];
  if (!n || n.outcome) return run;
  const slot = n.slot ?? run.node;
  const kind = inputOf(n, slot);
  if (kind === "number" && !Number.isFinite(Number(value))) return run;          // not a reading: keep asking
  const v = kind === "number" ? Number(value) : kind === "yes_no" ? value === true || value === "yes" || value === "true" : value;
  return advance(g, { ...run, slots: { ...run.slots, [slot]: v }, steps: [...run.steps, { node: run.node, slot, value: v, source: "user" }] }, record);
}

/** A node's input type: declared, or inferred from how its slot is tested (numbers compared → number, true/false →
 *  yes/no, fixed values → choice). Without this a free-text reply could be taken as a reading. */
export function inputOf(n: GuideNode, slot: string): NonNullable<GuideNode["input"]> {
  if (n.input) return n.input;
  if (n.options?.length) return "choice";
  const conds: any[] = [];
  const walk = (c: any) => { if (!c || typeof c !== "object") return; if (c.field === slot) conds.push(c); for (const k of ["all", "any"]) (c[k] ?? []).forEach(walk); if (c.cond) walk(c.cond); };
  (n.next ?? []).forEach((e) => walk(e.when));
  if (conds.some((c) => ["gt", "lt", "gte", "lte"].includes(c.op) || typeof c.value === "number")) return "number";
  if (conds.some((c) => typeof c.value === "boolean")) return "yes_no";
  if (conds.some((c) => typeof c.value === "string")) return "choice";
  return "text";
}

function inferredOptions(n: GuideNode, slot: string, lang: string): { value: unknown; label: string }[] {
  const vals = new Set<string>();
  const walk = (c: any) => { if (!c || typeof c !== "object") return; if (c.field === slot && typeof c.value === "string") vals.add(c.value); for (const k of ["all", "any"]) (c[k] ?? []).forEach(walk); if (c.cond) walk(c.cond); };
  (n.next ?? []).forEach((e) => walk(e.when));
  void lang;
  return [...vals].map((v) => ({ value: v, label: v.replace(/_/g, " ") }));
}

/** The question to show for the current node (label, kind, options), or null at an outcome. */
export function currentQuestion(g: Guide, run: GuideRun, lang: string, fieldLabel?: (id: string) => string):
  { text: string; input: GuideNode["input"]; options: { value: unknown; label: string }[] } | null {
  const n = g.nodes[run.node];
  if (!n || n.outcome || run.done) return null;
  const slot = n.slot ?? run.node;
  const input = inputOf(n, slot);
  const q = text(n.question, lang) || (n.field && fieldLabel ? fieldLabel(n.field) : "") || slot.replace(/_/g, " ");
  const options = input === "yes_no" ? [{ value: true, label: lang === "hi" ? "हाँ" : "Yes" }, { value: false, label: lang === "hi" ? "नहीं" : "No" }]
    : n.options?.length ? n.options.map((o) => ({ value: o.value, label: text(o.label, lang) || String(o.value) }))
      : input === "choice" ? inferredOptions(n, slot, lang) : [];
  return { text: q, input, options };
}

export function outcomeOf(g: Guide, run: GuideRun): GuideNode["outcome"] | null {
  return run.done && !run.stuck ? g.nodes[run.node]?.outcome ?? null : null;
}
