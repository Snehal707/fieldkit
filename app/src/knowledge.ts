// Offline question answering and dictionary lookup over installed packs.
// Retrieval only: answers are passages from downloaded knowledge with their sources — no generation,
// and questions the packs do not cover are reported as unsupported rather than guessed.
import MiniSearch from "minisearch";
import { text } from "./engine";
import type { InstalledPack } from "./db";

const STOP = new Set(("a an the of to in on for and or is are was were be by with at from as it this that what why how which who when where " +
  "do does can could should my your their its about into than then there these those please explain tell me common reasons causes").split(" "));

export interface KEntry {
  key: string; pack_id: string; pack_title: string; id: string; type: string; title: string; text: string;
  tags: string[]; related: string[]; followups: string[]; source: string; domain: string;
}

export interface Answer {
  supported: boolean; query: string; entry?: KEntry; excerpt?: string; score?: number;
  matched_terms: string[]; related: { key: string; title: string }[]; followups: string[];
  others: { key: string; title: string; score: number }[]; note?: string;
}

function processTerm(t: string): string | null {
  const x = t.toLowerCase();
  return x.length < 2 || STOP.has(x) ? null : x;
}

export class KnowledgeIndex {
  private ms: MiniSearch<KEntry>;
  readonly entries = new Map<string, KEntry>();

  constructor(packs: InstalledPack[]) {
    this.ms = new MiniSearch<KEntry>({
      idField: "key",
      fields: ["title", "text", "tags_text"],
      storeFields: ["key"],
      processTerm,
      extractField: (doc: any, field) => (field === "tags_text" ? (doc.tags ?? []).join(" ") : doc[field]),
      searchOptions: { boost: { title: 3, tags_text: 2 }, prefix: true, fuzzy: 0.15, combineWith: "OR" },
    });
    const docs: KEntry[] = [];
    for (const p of packs) {
      if (p.kind !== "knowledge") continue;
      for (const e of p.content.entries ?? []) {
        // Index every language of an entry so a Hindi or English question finds it.
        const titles = typeof e.title === "object" ? Object.values(e.title).join(" / ") : e.title;
        const bodies = typeof e.text === "object" ? Object.values(e.text).join("\n") : e.text;
        const entry: KEntry = {
          key: `${p.id}::${e.id}`, pack_id: p.id, pack_title: text(p.content.title), id: e.id, type: e.type ?? "reference",
          title: titles, text: bodies, tags: e.tags ?? [], related: e.related ?? [], followups: e.followups ?? [],
          source: e.source || text(p.content.source?.title) || text(p.content.title), domain: p.content.domain ?? "",
        };
        this.entries.set(entry.key, entry);
        docs.push(entry);
      }
    }
    this.ms.addAll(docs);
  }

  get size(): number { return this.entries.size; }

  localized(entry: KEntry, lang: string, packs: InstalledPack[]): { title: string; text: string } {
    const p = packs.find((x) => x.id === entry.pack_id);
    const raw = p?.content.entries?.find((e: any) => e.id === entry.id);
    return raw ? { title: text(raw.title, lang), text: text(raw.text, lang) } : { title: entry.title, text: entry.text };
  }

  ask(query: string, opts: { lang?: string; packs?: InstalledPack[]; domainPacks?: string[] } = {}): Answer {
    const terms = query.split(/[\s\p{P}]+/u).map(processTerm).filter((t): t is string => !!t);
    const empty: Answer = { supported: false, query, matched_terms: [], related: [], followups: [], others: [] };
    if (!terms.length || !this.size) return { ...empty, note: this.size ? "Ask a more specific question." : "No knowledge packs are installed." };
    let results = this.ms.search(query);
    if (opts.domainPacks?.length) {
      const preferred = results.filter((r) => opts.domainPacks!.includes(this.entries.get(r.id)!.pack_id));
      if (preferred.length) results = [...preferred, ...results.filter((r) => !preferred.includes(r))];
    }
    if (!results.length) return { ...empty, note: "This question is not covered by the installed knowledge packs." };
    const top = results[0];
    const matched = [...new Set(Object.keys(top.match))];
    // Support threshold: enough of the meaningful question terms must hit the same entry.
    const coverage = matched.length / terms.length;
    const supported = matched.length >= Math.min(2, terms.length) || (terms.length <= 2 && coverage >= 0.5);
    const entry = this.entries.get(top.id)!;
    const shown = opts.packs ? this.localized(entry, opts.lang ?? "en", opts.packs) : { title: entry.title, text: entry.text };
    const others = results.slice(1, 4).map((r) => ({ key: r.id, title: this.entries.get(r.id)!.title, score: r.score }));
    const related = entry.related
      .map((rid) => this.entries.get(`${entry.pack_id}::${rid}`))
      .filter((e): e is KEntry => !!e)
      .map((e) => ({ key: e.key, title: opts.packs ? this.localized(e, opts.lang ?? "en", opts.packs).title : e.title }));
    if (!supported) {
      return { ...empty, matched_terms: matched, others: [{ key: top.id, title: entry.title, score: top.score }, ...others],
        note: "The installed packs do not contain enough information to answer this. Closest topics are listed below." };
    }
    return { supported: true, query, entry: { ...entry, title: shown.title, text: shown.text }, excerpt: bestExcerpt(shown.text, terms),
      score: top.score, matched_terms: matched, related, followups: entry.followups, others };
  }

  byKey(key: string): KEntry | undefined { return this.entries.get(key); }
}

/** Up to three sentences with the most query-term overlap, kept in original order. */
export function bestExcerpt(body: string, terms: string[]): string {
  const sentences = body.split(/(?<=[.!?।])\s+/u).filter(Boolean);
  if (sentences.length <= 3) return body;
  const scored = sentences.map((s, i) => {
    const low = s.toLowerCase();
    return { i, s, score: terms.reduce((a, t) => a + (low.includes(t) ? 1 : 0), 0) };
  });
  const pick = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 3).sort((a, b) => a.i - b.i);
  if (pick.every((p) => p.score === 0)) return sentences.slice(0, 3).join(" ");
  return pick.map((p) => p.s).join(" ");
}

// ------------------------------------------------------------------ dictionary
export interface DictHit {
  term: string; lang: string; definition: string; translations: Record<string, string>; examples: string[];
  synonyms: string[]; related: string[]; source: string; pack_id: string; match: "exact" | "prefix" | "translation" | "fuzzy";
}

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function lookup(packs: InstalledPack[], q: string, limit = 20): DictHit[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const out: DictHit[] = [];
  const rank = { exact: 0, translation: 1, prefix: 2, fuzzy: 3 } as const;
  for (const p of packs) {
    if (p.kind !== "dictionary") continue;
    for (const e of p.content.entries ?? []) {
      const term = String(e.term).toLowerCase();
      const trans = Object.values(e.translations ?? {}).map((x) => String(x).toLowerCase());
      let match: DictHit["match"] | null = null;
      if (term === query) match = "exact";
      else if (trans.includes(query)) match = "translation";
      else if (term.startsWith(query) || (e.synonyms ?? []).some((s: string) => s.toLowerCase().startsWith(query))) match = "prefix";
      else if (query.length >= 4 && lev(term, query) <= (query.length > 7 ? 2 : 1)) match = "fuzzy";
      if (match) {
        out.push({ term: e.term, lang: e.lang, definition: e.definition, translations: e.translations ?? {}, examples: e.examples ?? [],
          synonyms: e.synonyms ?? [], related: e.related ?? [], source: e.source || text(p.content.source?.title) || text(p.content.title),
          pack_id: p.id, match });
      }
    }
  }
  return out.sort((a, b) => rank[a.match] - rank[b.match] || a.term.localeCompare(b.term)).slice(0, limit);
}
