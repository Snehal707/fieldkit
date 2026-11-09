// Offline-assistant understanding evaluation: intent recognition and paraphrase retrieval in English and Hindi,
// for candidate on-device embedding models (Transformers.js in Node, same ONNX files the PWA downloads), against a
// keyword (MiniSearch BM25) baseline. Data: tests/eval/assistant_set.json + the example knowledge packs.
// Usage: node tests/eval/assistant_eval.mjs <cacheDir> [modelId ...]
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import MiniSearch from "minisearch";
import { INTENT_EXAMPLES } from "../../app/src/assistant_intents.ts";
import { prototypes, rankIntents, SUPPORT_THRESHOLD } from "../../app/src/assistant_core.ts";

const T = await import("@huggingface/transformers");
T.env.cacheDir = process.argv[2];
const MODELS = process.argv.slice(3).length ? process.argv.slice(3) : ["Xenova/multilingual-e5-small", "Xenova/paraphrase-multilingual-MiniLM-L12-v2"];
const root = resolve(import.meta.dirname, "../..");
const set = JSON.parse(readFileSync(join(root, "tests/eval/assistant_set.json"), "utf8"));
const txt = (v, l = "en") => (typeof v === "string" ? v : v?.[l] ?? v?.en ?? Object.values(v ?? {})[0] ?? "");
const entries = readdirSync(join(root, "examples")).flatMap((d) => JSON.parse(readFileSync(join(root, "examples", d, "knowledge.json"), "utf8")).entries);
const docs = (l) => entries.map((e) => ({ id: e.id, text: `${txt(e.title, l)}. ${txt(e.text, l)}`.slice(0, 1200) }));

// Keyword baseline.
const ms = new MiniSearch({ fields: ["text"], storeFields: ["id"] });
ms.addAll(docs("en").map((d, i) => ({ ...d, id: d.id })));
let kw = { en: [0, 0], hi: [0, 0] };
for (const r of set.retrieval) { const hit = ms.search(r.q, { fuzzy: 0.2, prefix: true })[0]; kw[r.lang][1]++; if (hit?.id === r.expect) kw[r.lang][0]++; }
console.log(JSON.stringify({ model: "keyword BM25 (current assistant)", retrieval_top1: { en: kw.en[0] / kw.en[1], hi: kw.hi[0] / kw.hi[1] } }));

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
for (const model of MODELS) {
  const e5 = model.includes("e5");
  const pipe = await T.pipeline("feature-extraction", model, { dtype: "q8" });
  const emb = async (texts, kind) => {
    const out = await pipe(texts.map((t) => (e5 ? `${kind}: ${t}` : t)), { pooling: "mean", normalize: true });
    return out.tolist();
  };
  // Retrieval: query vs each entry (embedded in its own language, plus English fallback).
  const dv = await emb(docs("en").map((d) => d.text), "passage");
  const dvh = await emb(docs("hi").map((d) => d.text), "passage");
  const res = { en: [0, 0, 0], hi: [0, 0, 0] };
  for (const r of set.retrieval) {
    const [q] = await emb([r.q], "query");
    const scores = entries.map((e, i) => ({ id: e.id, s: Math.max(cos(q, dv[i]), cos(q, dvh[i])) })).sort((a, b) => b.s - a.s);
    res[r.lang][2]++;
    if (scores[0].id === r.expect) res[r.lang][0]++;
    if (scores.slice(0, 3).some((x) => x.id === r.expect)) res[r.lang][1]++;
  }
  // Intents: nearest prototype (max over examples in both languages).
  const protos = prototypes();
  const pv = await emb(protos.map((p) => p.text), "query");
  protos.forEach((p, i) => { p.vec = pv[i]; });
  const classify = async (q) => { const [v] = await emb([q], "query"); return rankIntents(q, v, protos); };
  const fresh = { en: [0, 0], hi: [0, 0] }, freshMiss = [];
  for (const r of set.fresh_intents_test ?? []) {
    const ranked = await classify(r.q);
    fresh[r.lang][1]++;
    if (ranked[0][0] === r.expect) fresh[r.lang][0]++; else freshMiss.push(`${r.q} → ${ranked[0][0]} (want ${r.expect})`);
  }
  const fr = { en: [0, 0], hi: [0, 0] };
  for (const r of set.fresh_retrieval ?? []) {
    const [q] = await emb([r.q], "query");
    const top = entries.map((e, i) => ({ id: e.id, s: Math.max(cos(q, dv[i]), cos(q, dvh[i])) })).sort((a, b) => b.s - a.s)[0];
    fr[r.lang][1]++; if (top.id === r.expect) fr[r.lang][0]++;
  }
  console.log(JSON.stringify({ model, fresh_intent_top1: { en: fresh.en[0] / fresh.en[1], hi: fresh.hi[0] / fresh.hi[1] },
    fresh_retrieval_top1: { en: fr.en[0] / fr.en[1], hi: fr.hi[0] / fr.hi[1] }, freshMiss }));
  const ia = { en: [0, 0], hi: [0, 0] };
  const misses = [];
  for (const r of set.intents_test) {
    const ranked = await classify(r.q);
    ia[r.lang][1]++;
    if (ranked[0][0] === r.expect) ia[r.lang][0]++; else misses.push(`${r.q} → ${ranked[0][0]} (want ${r.expect})`);
  }
  // Out of scope: best retrieval score and best intent score should both be low.
  const inScope = [], oos = [];
  for (const r of set.retrieval) { const [q] = await emb([r.q], "query"); inScope.push(Math.max(...entries.map((e, i) => Math.max(cos(q, dv[i]), cos(q, dvh[i]))))); }
  for (const r of set.out_of_scope_test) { const [q] = await emb([r.q], "query"); oos.push(Math.max(...entries.map((e, i) => Math.max(cos(q, dv[i]), cos(q, dvh[i]))))); }
  const f = (n) => +n.toFixed(3);
  console.log(JSON.stringify({ model,
    retrieval_top1: { en: f(res.en[0] / res.en[2]), hi: f(res.hi[0] / res.hi[2]) }, retrieval_top3: { en: f(res.en[1] / res.en[2]), hi: f(res.hi[1] / res.hi[2]) },
    intent_top1: { en: f(ia.en[0] / ia.en[1]), hi: f(ia.hi[0] / ia.hi[1]) },
    in_scope_min_score: f(Math.min(...inScope)), out_of_scope_max_score: f(Math.max(...oos)),
    in_scope_above_threshold: f(inScope.filter((x) => x >= SUPPORT_THRESHOLD).length / inScope.length),
    out_of_scope_rejected: f(oos.filter((x) => x < SUPPORT_THRESHOLD).length / oos.length), misses }));
}
