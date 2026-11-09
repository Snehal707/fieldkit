// Dictionary-guided terminology for on-device translation. The OPUS-MT models FieldKit can run on a phone are
// small general-domain models: they translate everyday sentences reasonably but garble field vocabulary
// ("The bearing is hot." → "गर्म हवा और गर्म है;" = "hot air and is hot"). FieldKit already ships per-domain
// dictionaries with reviewed translations, so terms found in an installed dictionary are swapped for placeholders
// the model copies through unchanged (e.g. "XQ1"), and the dictionary's own translation is put back afterwards.
// If the model drops a placeholder, that sentence is translated again without terminology (never a broken result).

export interface GlossaryEntry { term: string; translations: Record<string, string>; synonyms?: string[]; lang?: string }
export interface TermPair { source: string; target: string }
export interface Protected { text: string; slots: { token: string; target: string; source: string }[] }

/** Build source→target term pairs for one direction from dictionary entries (both directions are supported). */
export function termPairs(entries: GlossaryEntry[], from: string, to: string): TermPair[] {
  const out: TermPair[] = [];
  const seen = new Set<string>();
  const add = (s: string | undefined, t: string | undefined) => {
    const src = (s ?? "").trim(), tgt = (t ?? "").trim();
    if (!src || !tgt || src.length < 2 || seen.has(src.toLowerCase())) return;
    seen.add(src.toLowerCase());
    out.push({ source: src, target: tgt });
  };
  for (const e of entries) {
    const lang = e.lang ?? "en";
    if (lang === from) {                       // e.g. en entry with translations.hi, translating en→hi
      add(e.term, e.translations?.[to]);
      for (const syn of e.synonyms ?? []) add(syn, e.translations?.[to]);
    } else if (lang === to) {                  // reverse direction: hi term → en headword
      add(e.translations?.[from], e.term);
    }
  }
  return out.sort((a, b) => b.source.length - a.source.length);   // longest match first ("safety guard" before "guard")
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// \b does not work for Devanagari (combining marks are not "word" characters), so match on letter boundaries.
const boundary = (s: string) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${esc(s)}(?![\\p{L}\\p{M}\\p{N}])`, "giu");

export function protectTerms(text: string, pairs: TermPair[]): Protected {
  const slots: Protected["slots"] = [];
  let out = text;
  for (const p of pairs) {
    const re = boundary(p.source);
    if (!re.test(out)) continue;
    const token = `XQ${slots.length + 1}`;
    out = out.replace(boundary(p.source), token);
    slots.push({ token, target: p.target, source: p.source });
    if (slots.length >= 9) break;
  }
  return { text: out, slots };
}

/** Put the dictionary translations back. `ok` is false if the model lost or altered a placeholder. */
export function restoreTerms(translated: string, slots: Protected["slots"]): { text: string; ok: boolean } {
  let out = translated, ok = true;
  for (const s of slots) {
    const re = new RegExp(`(?<![A-Za-z0-9])${s.token}(?![0-9])`, "g");
    if (!re.test(out)) { ok = false; continue; }
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${s.token}(?![0-9])`, "g"), s.target);
  }
  if (/XQ\d/.test(out)) ok = false;
  return { text: out, ok };
}

/** Hindi ends sentences with the danda (।); the en→hi model often emits a Latin full stop or a stray ';'. */
export function tidyOutput(text: string, to: string): string {
  let t = text.trim();
  if (to === "hi") t = t.replace(/\s*[.;]+$/u, "।").replace(/\s+।/gu, "।");
  return t;
}

/** Split into sentences (and lines), keeping line breaks so a translated list keeps its shape. */
export function splitSentences(text: string): string[][] {
  return text.split(/\r?\n/).map((line) => line.split(/(?<=[.!?।])\s+/u).map((s) => s.trim()).filter(Boolean));
}
