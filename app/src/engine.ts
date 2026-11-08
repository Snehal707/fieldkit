// Deterministic workflow engine — TypeScript twin of fieldkit_core/engine.py.
// Behaviour is pinned by tests/vectors/*.json, which both implementations run.
// Workflows are data only: nothing here evaluates code.

export type Answers = Record<string, unknown>;
export type Label = string | Record<string, string>;
export interface Cond { op: string; field?: string; value?: unknown; all?: Cond[]; any?: Cond[]; cond?: Cond }
export interface Option { value: string | number | boolean; label: Label }
export interface Field {
  id: string; type: string; label: Label; help?: Label; placeholder?: Label; section?: Label;
  required?: boolean; required_if?: Cond; visible_if?: Cond; default?: unknown; unit?: string;
  options?: Option[]; knowledge_query?: string; explain_topic?: string;
  validation?: {
    min?: number; max?: number; integer?: boolean; min_length?: number; max_length?: number; pattern?: string;
    min_items?: number; max_items?: number; max_accuracy_m?: number; rules?: { when: Cond; message: Label }[];
  };
}
export interface TreeNode { result?: { label: Label; severity?: string }; if?: Cond; then?: TreeNode; else?: TreeNode }
export interface Workflow {
  id: string; version?: number; status?: string; title: Label; description?: Label; domain?: string;
  languages?: string[]; default_language?: string; knowledge_packs?: string[]; dictionary_packs?: string[];
  review_required?: boolean; fields: Field[];
  classification?: {
    rules?: { id: string; label: Label; when: Cond; severity?: string; finding?: Label }[];
    keywords?: { id: string; label: Label; fields: string[]; keywords: string[]; min_hits?: number; severity?: string }[];
    scores?: { id: string; label: Label; items: { when: Cond; points: number }[]; bands?: { min: number; label: Label; severity?: string }[] }[];
    decision_trees?: { id: string; label: Label; root: TreeNode }[];
  };
}
export interface Finding {
  kind: string; id: string; label: string; severity: string; detail?: string; score?: number; matched?: string[]; source: "local";
}

const INPUTLESS = new Set(["instruction"]);
const MEDIA = new Set(["photo", "audio", "signature"]);
const COMPARE = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
const MAX_PATTERN_LEN = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
}

function num(v: unknown): number | null {
  if (typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function eq(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (a === b) return true;
  const na = num(a), nb = num(b);
  return na !== null && na === nb;
}

function cmp(op: string, a: unknown, b: unknown): boolean {
  if (op === "eq") return eq(a, b);
  if (op === "neq") return !eq(a, b);
  let x: number | string | null = num(a), y: number | string | null = num(b);
  if (x === null || y === null) {
    if (typeof a === "string" && typeof b === "string") { x = a; y = b; } else return false;
  }
  switch (op) {
    case "gt": return x > y;
    case "gte": return x >= y;
    case "lt": return x < y;
    case "lte": return x <= y;
  }
  return false;
}

export function evaluate(cond: Cond | null | undefined, answers: Answers): boolean {
  if (cond === null || cond === undefined) return true;
  if (typeof cond !== "object") return false;
  const op = cond.op;
  if (op === "and") return (cond.all ?? []).every((c) => evaluate(c, answers));
  if (op === "or") return (cond.any ?? []).some((c) => evaluate(c, answers));
  if (op === "not") return !evaluate(cond.cond, answers);
  if (op === "always") return true;
  const value = answers[cond.field ?? ""];
  const target = cond.value;
  if (COMPARE.has(op)) return Array.isArray(value) ? false : cmp(op, value, target);
  if (op === "in") return Array.isArray(target) && target.some((t) => eq(value, t));
  if (op === "contains") {
    if (Array.isArray(value)) return value.some((v) => eq(v, target));
    if (typeof value === "string" && typeof target === "string") return value.toLowerCase().includes(target.toLowerCase());
    return false;
  }
  if (op === "exists") return !isEmpty(value);
  if (op === "empty") return isEmpty(value);
  return false;
}

export function text(v: Label | undefined | null, lang = "en", fallback = "en"): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return v[lang] || v[fallback] || Object.values(v)[0] || "";
  return "";
}

export function visibleFields(wf: Workflow, answers: Answers): string[] {
  return wf.fields.filter((f) => evaluate(f.visible_if, answers)).map((f) => f.id);
}

function isRequired(f: Field, answers: Answers): boolean {
  if (INPUTLESS.has(f.type)) return false;
  if (f.required) return true;
  return f.required_if !== undefined && evaluate(f.required_if, answers);
}

function fullMatch(pattern: string, value: string): boolean {
  try { return new RegExp(`^(?:${pattern})$`).test(value); } catch { return false; }
}

function valueErrors(f: Field, value: unknown): string[] {
  const v = f.validation ?? {};
  const errs: string[] = [];
  const t = f.type;
  if (t === "text" || t === "multiline") {
    if (typeof value !== "string") return ["type"];
    const len = [...value].length;  // code points, like Python len()
    if (v.min_length !== undefined && len < v.min_length) errs.push("min_length");
    if (v.max_length !== undefined && len > v.max_length) errs.push("max_length");
    if (v.pattern && v.pattern.length <= MAX_PATTERN_LEN && !fullMatch(v.pattern, value)) errs.push("pattern");
  } else if (t === "number") {
    const n = num(value);
    if (n === null) return ["type"];
    if (v.integer && !Number.isInteger(n)) errs.push("integer");
    if (v.min !== undefined && n < v.min) errs.push("min");
    if (v.max !== undefined && n > v.max) errs.push("max");
  } else if (t === "date") {
    if (typeof value !== "string" || !DATE_RE.test(value)) return ["type"];
  } else if (t === "time") {
    if (typeof value !== "string" || !TIME_RE.test(value)) return ["type"];
  } else if (t === "checkbox") {
    if (typeof value !== "boolean") return ["type"];
  } else if (t === "single_choice") {
    if (!(f.options ?? []).some((o) => o.value === value)) return ["option"];
  } else if (t === "multi_choice") {
    const allowed = (f.options ?? []).map((o) => o.value);
    if (!Array.isArray(value) || value.some((x) => !allowed.includes(x))) return ["option"];
    if (v.min_items !== undefined && value.length < v.min_items) errs.push("min_items");
    if (v.max_items !== undefined && value.length > v.max_items) errs.push("max_items");
  } else if (t === "gps") {
    const g = value as { lat?: unknown; lon?: unknown; accuracy?: unknown };
    if (typeof value !== "object" || value === null || num(g.lat) === null || num(g.lon) === null) return ["type"];
    const lat = num(g.lat)!, lon = num(g.lon)!;
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return ["range"];
    const acc = num(g.accuracy);
    if (v.max_accuracy_m !== undefined && acc !== null && acc > v.max_accuracy_m) errs.push("accuracy");
  } else if (MEDIA.has(t)) {
    const items = Array.isArray(value) ? value : [value];
    if (!items.every((x) => x && typeof x === "object" && (x as { attachment_id?: string }).attachment_id)) return ["type"];
    if (v.max_items !== undefined && items.length > v.max_items) errs.push("max_items");
  }
  return errs;
}

export interface State {
  visible: string[]; required: string[]; errors: Record<string, string[]>; messages: Record<string, string[]>; complete: boolean;
}

export function computeState(wf: Workflow, answers: Answers, lang = "en"): State {
  const visible = visibleFields(wf, answers);
  const vis = new Set(visible);
  const errors: Record<string, string[]> = {};
  const messages: Record<string, string[]> = {};
  const required: string[] = [];
  for (const f of wf.fields) {
    if (!vis.has(f.id) || INPUTLESS.has(f.type)) continue;
    const value = answers[f.id];
    const req = isRequired(f, answers);
    if (req) required.push(f.id);
    if (isEmpty(value)) {  // required checkbox = "answered" (true or false)
      if (req) errors[f.id] = ["required"];
      continue;
    }
    const errs = valueErrors(f, value);
    for (const rule of f.validation?.rules ?? []) {
      if (evaluate(rule.when, answers)) {
        errs.push("rule");
        (messages[f.id] ??= []).push(text(rule.message, lang));
      }
    }
    if (errs.length) errors[f.id] = [...new Set(errs)].sort();
  }
  return { visible, required, errors, messages, complete: Object.keys(errors).length === 0 };
}

export function cleanAnswers(wf: Workflow, answers: Answers): Answers {
  const vis = new Set(visibleFields(wf, answers));
  const out: Answers = {};
  for (const [k, v] of Object.entries(answers)) if (vis.has(k)) out[k] = v;
  return out;
}

function answerText(v: unknown): string {
  if (Array.isArray(v)) return v.map(answerText).join(" ");
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => k === "text" || k === "transcript" || k === "ocr_text").map(([, x]) => String(x)).join(" ");
  }
  return v === null || v === undefined ? "" : String(v);
}

function walk(node: TreeNode | undefined, answers: Answers, depth = 0): TreeNode["result"] | null {
  if (!node || typeof node !== "object" || depth > 32) return null;
  if (node.result) return node.result;
  return walk(evaluate(node.if, answers) ? node.then : node.else, answers, depth + 1);
}

export function classify(wf: Workflow, rawAnswers: Answers, lang = "en"): Finding[] {
  const cls = wf.classification ?? {};
  const answers = cleanAnswers(wf, rawAnswers);
  const out: Finding[] = [];
  for (const r of cls.rules ?? []) {
    if (evaluate(r.when, answers)) {
      out.push({ kind: "rule", id: r.id, label: text(r.label, lang), severity: r.severity ?? "info", detail: text(r.finding ?? "", lang), source: "local" });
    }
  }
  for (const kw of cls.keywords ?? []) {
    const hay = kw.fields.map((f) => answerText(answers[f])).join(" ").toLowerCase();
    const hits = [...new Set(kw.keywords.filter((k) => hay.includes(k.toLowerCase())))].sort();
    if (hits.length >= (kw.min_hits ?? 1)) {
      out.push({ kind: "keyword", id: kw.id, label: text(kw.label, lang), severity: kw.severity ?? "info", detail: hits.join(", "), matched: hits, source: "local" });
    }
  }
  for (const s of cls.scores ?? []) {
    const total = s.items.filter((i) => evaluate(i.when, answers)).reduce((a, i) => a + (i.points ?? 0), 0);
    let band: { min: number; label: Label; severity?: string } | undefined;
    for (const b of [...(s.bands ?? [])].sort((a, b) => a.min - b.min)) if (total >= b.min) band = b;
    out.push({ kind: "score", id: s.id, label: text(s.label, lang), severity: band?.severity ?? "info", score: total, detail: text(band?.label ?? "", lang), source: "local" });
  }
  for (const t of cls.decision_trees ?? []) {
    const res = walk(t.root, answers);
    if (res) out.push({ kind: "decision_tree", id: t.id, label: text(t.label, lang), severity: res.severity ?? "info", detail: text(res.label, lang), source: "local" });
  }
  return out;
}

export interface Summary {
  validation: { complete: boolean; errors: Record<string, string[]>; messages: Record<string, string[]> };
  questions_answered: number; questions_visible: number; findings: Finding[];
}

export function summarize(wf: Workflow, answers: Answers, lang = "en"): Summary {
  const st = computeState(wf, answers, lang);
  const vis = new Set(st.visible);
  const asked = wf.fields.filter((f) => vis.has(f.id) && !INPUTLESS.has(f.type));
  return {
    validation: { complete: st.complete, errors: st.errors, messages: st.messages },
    questions_answered: asked.filter((f) => !isEmpty(answers[f.id])).length,
    questions_visible: asked.length,
    findings: classify(wf, answers, lang),
  };
}

export const ERROR_TEXT: Record<string, string> = {
  required: "This answer is required.", type: "Please enter a valid value.", pattern: "Does not match the expected format.",
  min: "Value is below the minimum.", max: "Value is above the maximum.", integer: "Enter a whole number.",
  min_length: "Too short.", max_length: "Too long.", option: "Choose one of the listed options.",
  min_items: "Select more items.", max_items: "Too many items.", range: "Coordinates out of range.",
  accuracy: "Location accuracy is too low — try again outdoors.", rule: "",
};
