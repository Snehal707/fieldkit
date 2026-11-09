// Offline assistant core (0.2.5): pure functions, testable without a browser or a model.
// Understanding = multilingual sentence embeddings (meaning, English and Hindi) + word cues + dialogue state.
// Measured on tests/eval/assistant_set.json with Xenova/paraphrase-multilingual-MiniLM-L12-v2 (see tests/eval/README.md).
import { INTENT_CUES, INTENT_EXAMPLES, type Intent } from "./assistant_intents";

/** A question below this similarity to every workspace item is out of scope (measured: in-scope ≥ 0.36, off-topic ≤ 0.22). */
export const SUPPORT_THRESHOLD = 0.29;
/** Intent scores closer than this are ambiguous: ask a clarifying question instead of guessing. */
export const INTENT_MARGIN = 0.02;
export const CUE_BONUS = 0.12;

export type Vec = Float32Array | number[];
export function cosine(a: Vec, b: Vec): number {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

export interface Prototype { intent: Intent; text: string; vec?: Vec }
export function prototypes(extra: { id: string; examples: Record<string, string[]> }[] = []): Prototype[] {
  const out: Prototype[] = [];
  for (const [intent, ex] of Object.entries(INTENT_EXAMPLES) as [Intent, { en: string[]; hi: string[] }][]) {
    for (const t of [...ex.en, ...ex.hi]) out.push({ intent, text: t });
  }
  for (const x of extra) {
    if (!(x.id in INTENT_EXAMPLES)) continue;
    for (const list of Object.values(x.examples ?? {})) for (const t of list ?? []) out.push({ intent: x.id as Intent, text: t });
  }
  return out;
}

/** Rank intents: best prototype similarity per intent, plus a bonus when a strong word cue is present. */
export function rankIntents(query: string, qv: Vec | null, protos: Prototype[]): [Intent, number][] {
  const best = new Map<Intent, number>();
  if (qv) for (const p of protos) if (p.vec) best.set(p.intent, Math.max(best.get(p.intent) ?? -1, cosine(qv, p.vec)));
  for (const intent of Object.keys(INTENT_EXAMPLES) as Intent[]) {
    const cue = INTENT_CUES[intent];
    const base = best.get(intent) ?? 0;
    best.set(intent, base + (cue && cue.test(query) ? CUE_BONUS : 0));
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]);
}

// ----------------------------------------------------------------------------- references and follow-ups
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1,
  पहल: 1, दूसर: 2, तीसर: 3, चौथ: 4, पाँचव: 5, आखिरी: -1, अंतिम: -1 };

/** "issue 2", "the second problem", "दूसरी समस्या", "action 3" → { kind, index } (1-based; -1 = last). */
export function itemReference(q: string): { kind: "issue" | "action" | null; index: number } | null {
  const s = q.toLowerCase();
  const kind = /\b(issue|problem|finding)s?\b|समस्या|मुद्द/.test(s) ? "issue" : /\b(action|step|task)s?\b|कदम|कार्रवाई/.test(s) ? "action" : null;
  const num = s.match(/(?:issue|problem|finding|action|step|task|समस्या|मुद्दा|कदम)\s*(?:no\.?|number|#)?\s*(\d{1,2})/) ?? s.match(/#\s*(\d{1,2})\b/);
  if (num) return { kind, index: Number(num[1]) };
  for (const [w, n] of Object.entries(ORDINALS)) if (s.includes(w)) return kind ? { kind, index: n } : null;
  return null;
}

const PRONOUN = /\b(it|that|this|those|them|they|its)\b|\bवह\b|\bयह\b|\bइस(का|की|के|े)?\b|\bउस(का|की|के|े)?\b|\bइन्हें\b/i;
const ELLIPSIS = /^(and |what about |how about |और |तो )|\?$/i;

/** True when a short follow-up leans on the previous turn ("what about the seal?", "and that?", "उसका क्या?"). */
export function isFollowUp(q: string): boolean {
  const words = q.trim().split(/\s+/).length;
  return PRONOUN.test(q) || (words <= 5 && ELLIPSIS.test(q.trim()));
}

// ----------------------------------------------------------------------------- entity linking
export interface Entity { id: string; kind: "term" | "field" | "option" | "asset" | "issue" | "guide" | "entry"; names: string[]; ref?: any }

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Exact or near-exact mention of a known workspace name in the question (both languages). Longest match wins. */
export function linkEntities(q: string, entities: Entity[]): Entity[] {
  const nq = ` ${norm(q)} `;
  const hits: [Entity, number][] = [];
  for (const e of entities) {
    for (const n of e.names) {
      const nn = norm(n);
      if (nn.length >= 3 && nq.includes(` ${nn} `)) { hits.push([e, nn.length]); break; }
      if (nn.length >= 5 && nq.includes(nn.slice(0, Math.max(5, nn.length - 2)))) { hits.push([e, nn.length - 2]); break; }
    }
  }
  return hits.sort((a, b) => b[1] - a[1]).map(([e]) => e);
}
