// On-device translation accuracy (OPUS-MT via Transformers.js in Node, same ONNX files as the PWA).
// chrF (character 6-gram F-score, beta=2) against tests/eval/translation_set.json, for the general sentences and
// for the dictionary-term sentences. Mode "fieldkit" runs the app's own pipeline from app/src/translate_prep.ts
// (terminology from tests/eval/translation_terms.json, Hindi punctuation, per-sentence fallback).
// Usage: node tests/eval/translation_eval.mjs <cacheDir> '[{"dir":"en-hi","dtype":"q8","mode":"plain|fieldkit"}]'
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { termPairs, protectTerms, restoreTerms, tidyOutput } from "../../app/src/translate_prep.ts";
const T = await import("@huggingface/transformers");
T.env.cacheDir = process.argv[2];
const configs = JSON.parse(process.argv[3]);
const root = resolve(import.meta.dirname, "../..");
const data = JSON.parse(readFileSync(join(root, "tests/eval/translation_set.json"), "utf8"));
const entries = JSON.parse(readFileSync(join(root, "tests", "eval", "translation_terms.json"), "utf8")).entries;
const REV = { "en-hi": "7aad72006a1588a9c3485ed6203aed99eebbc872", "hi-en": "99853100ed9d932987a6816e8cf7b1b6742a6116" };
function ngrams(s, n) { const m = new Map(); const t = [...s.replace(/\s+/g, " ").trim()]; for (let i = 0; i + n <= t.length; i++) { const g = t.slice(i, i + n).join(""); m.set(g, (m.get(g) ?? 0) + 1); } return m; }
export function chrf(hyp, ref, N = 6, beta = 2) {
  let p = 0, r = 0, k = 0;
  for (let n = 1; n <= N; n++) { const H = ngrams(hyp, n), R = ngrams(ref, n); let m = 0, th = 0, tr = 0;
    for (const [g, c] of H) { th += c; m += Math.min(c, R.get(g) ?? 0); } for (const c of R.values()) tr += c;
    if (th && tr) { p += m / th; r += m / tr; k++; } }
  if (!k) return 0; p /= k; r /= k; return p + r ? (1 + beta * beta) * p * r / (beta * beta * p + r) * 100 : 0;
}
for (const c of configs) {
  const [from, to] = c.dir.split("-");
  const pipe = await T.pipeline("translation", `Xenova/opus-mt-${c.dir}`, { dtype: c.dtype ?? "q8", revision: REV[c.dir] });
  const pairs = termPairs(entries, from, to);
  const run = async (src) => {
    if (c.mode !== "fieldkit") return (await pipe(src, { max_new_tokens: 128 }))[0].translation_text;
    const p = protectTerms(src, pairs);
    let out = (await pipe(p.text, { max_new_tokens: 128 }))[0].translation_text;
    if (p.slots.length) { const r = restoreTerms(out, p.slots); out = r.ok ? r.text : (await pipe(src, { max_new_tokens: 128 }))[0].translation_text; }
    return tidyOutput(out, to);
  };
  const res = {};
  for (const set of ["pairs", "term_pairs"]) {
    let sum = 0; const ex = [];
    for (const [en, hi] of data[set]) {
      const [src, ref] = from === "en" ? [en, hi] : [hi, en];
      const out = await run(src); const s = chrf(out.toLowerCase(), ref.toLowerCase()); sum += s;
      if (set === "term_pairs" || ex.length < 3) ex.push(`${src} => ${out} [${s.toFixed(0)}]`);
    }
    res[set] = +(sum / data[set].length).toFixed(1);
    if (c.verbose) for (const e of ex) console.log("   ", e);
  }
  console.log(JSON.stringify({ dir: c.dir, dtype: c.dtype ?? "q8", mode: c.mode ?? "plain", chrF_general: res.pairs, chrF_terms: res.term_pairs }));
}
