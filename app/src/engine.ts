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
  options?: Option[];
  validation?: {
    min?: number; max?: number; integer?: boolean; min_length?: number; max_length?: number; pattern?: string;
    min_items?: number; max_items?: number; max_accuracy_m?: number; rules?: { when: Cond; message: Label }[];
  };
}
export interface Workflow {
  id: string; version?: number; status?: string; title: Label; description?: Label; domain?: string;
  languages?: string[]; default_language?: string; fields: Field[];
  metadata?: { subject_field?: string };
}
/** A finding computed on the phone by FieldKit before 0.3 (forms no longer classify; kept to show old entries). */
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

/** The language ``text(v, lang)`` actually shows: ``lang`` when the label has it, else the fallback (English), else
 *  the label's first language. Used to mark form text with the right ``lang`` attribute for screen readers. */
export function textLang(v: Label | undefined | null, lang = "en", fallback = "en"): string {
  if (!v || typeof v !== "object") return fallback;
  if (v[lang]) return lang;
  if (v[fallback]) return fallback;
  return Object.keys(v)[0] ?? fallback;
}

/** Answer words for a yes/no question, in the form language; English when the language has none. */
export const YES_NO: Record<string, [string, string]> = { en: ["Yes", "No"], hi: ["हाँ", "नहीं"] };
export const yesNoLang = (lang: string): string => (YES_NO[lang] ? lang : "en");
export function yesNo(v: unknown, lang: string): string { const [yes, no] = YES_NO[yesNoLang(lang)]; return v ? yes : no; }

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


export interface Summary {
  validation: { complete: boolean; errors: Record<string, string[]>; messages: Record<string, string[]> };
  questions_answered: number; questions_visible: number;
}

export function summarize(wf: Workflow, answers: Answers, lang = "en"): Summary {
  const st = computeState(wf, answers, lang);
  const vis = new Set(st.visible);
  const asked = wf.fields.filter((f) => vis.has(f.id) && !INPUTLESS.has(f.type));
  return {
    validation: { complete: st.complete, errors: st.errors, messages: st.messages },
    questions_answered: asked.filter((f) => !isEmpty(answers[f.id])).length,
    questions_visible: asked.length,
  };
}

export const ERROR_TEXT: Record<string, string> = {
  required: "This answer is required.", type: "Please enter a valid value.", pattern: "Does not match the expected format.",
  min: "Value is below the minimum.", max: "Value is above the maximum.", integer: "Enter a whole number.",
  min_length: "Too short.", max_length: "Too long.", option: "Choose one of the listed options.",
  min_items: "Select more items.", max_items: "Too many items.", range: "Coordinates out of range.",
  accuracy: "Location accuracy is too low — try again outdoors.", rule: "",
};
