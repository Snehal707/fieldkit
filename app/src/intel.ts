// Optional on-device tools for collecting observations: sentence translation (Transformers.js + ONNX Runtime Web) and
// reading text from photos (OCR, tesseract.js). Heavy libraries load lazily.
//
// Model and WASM files come from their pinned upstream hosts the first time a pack is installed and
// are cached on the device (Transformers.js Cache API store, tesseract IndexedDB + service worker
// upstream cache). After installation no network request is needed; FieldKit never calls a remote
// translation or OCR service.
import { TESSDATA, TESSERACT_CORE } from "./config";
import { db, type InstalledModel } from "./db";
import { OCR_PARAMS, runOcr } from "./ocr_prep";
import { protectTerms, restoreTerms, splitSentences, termPairs, tidyOutput, type GlossaryEntry } from "./translate_prep";
import { nowIso, sha256Hex } from "./util";

export type Progress = (p: { file?: string; loaded?: number; total?: number; progress?: number; status?: string }) => void;

let tf: Promise<typeof import("@huggingface/transformers")> | null = null;
async function transformers() {
  if (!tf) {
    tf = import("@huggingface/transformers").then((m) => {
      m.env.allowLocalModels = false;
      m.env.useBrowserCache = true;
      m.env.useWasmCache = true;
      const onnx = m.env.backends.onnx as any;
      if (onnx?.wasm) onnx.wasm.numThreads = 1;  // no SharedArrayBuffer without cross-origin isolation
      return m;
    });
  }
  return tf;
}

const pipes = new Map<string, Promise<any>>();

let building: Promise<unknown> = Promise.resolve();

function pipelineFor(manifest: any, onProgress?: Progress): Promise<any> {
  const key = manifest.id;
  if (!pipes.has(key)) {
    // Transformers.js 4.3.1 looks up tokenizer_config.json without the `revision` option (always "main"),
    // which misses the pinned-revision cache and goes to the network when offline. Baking the pinned commit
    // into remotePathTemplate while this pipeline is built makes EVERY file resolve to the same pinned,
    // cached URL. Builds are serialised because the template is global.
    const p = building.then(() => transformers()).then(async (m) => {
      const prev = m.env.remotePathTemplate;
      m.env.remotePathTemplate = `{model}/resolve/${manifest.revision}/`;
      try {
        return await m.pipeline(manifest.task, manifest.model, {
          revision: manifest.revision, dtype: manifest.dtype ?? "q8", device: "wasm",
          progress_callback: (x: any) => onProgress?.(x),
        } as any);
      } finally {
        m.env.remotePathTemplate = prev;
      }
    });
    building = p.catch(() => undefined);
    p.catch(() => pipes.delete(key));
    pipes.set(key, p);
  }
  return pipes.get(key)!;
}

async function verifyCachedFiles(manifest: any): Promise<{ ok: boolean; detail: string }> {
  // Transformers.js caches responses keyed by URL; check pinned sizes and SHA-256 where published.
  try {
    const names = await caches.keys();
    const results: string[] = [];
    for (const f of manifest.files ?? []) {
      let res: Response | undefined;
      for (const n of names) {
        res = await (await caches.open(n)).match(f.url);
        if (res) break;
      }
      if (!res) { results.push(`missing ${f.url.split("/").pop()}`); continue; }
      const buf = await res.arrayBuffer();
      if (f.size && buf.byteLength !== f.size) { results.push(`size mismatch ${f.url.split("/").pop()}`); continue; }
      if (f.sha256) {
        const h = await sha256Hex(buf);
        if (h !== f.sha256) { results.push(`sha256 mismatch ${f.url.split("/").pop()}`); continue; }
      }
    }
    return { ok: results.length === 0, detail: results.join("; ") || "pinned files verified" };
  } catch (e) {
    return { ok: false, detail: `verification unavailable: ${(e as Error).message}` };
  }
}

async function markInstalled(manifest: any, verified: boolean, detail: string): Promise<InstalledModel> {
  const m: InstalledModel = { id: manifest.id, capability: manifest.capability, version: manifest.version, title: manifest.title,
    installed_at: nowIso(), verified, verify_detail: detail, size: manifest.download_size, manifest };
  await (await db()).put("models", m);
  return m;
}

export async function installedModels(): Promise<InstalledModel[]> {
  return (await db()).getAll("models");
}

export async function removeModel(id: string): Promise<void> {
  pipes.delete(id);
  await (await db()).delete("models", id);
  // Cached weights stay in the runtime cache until the user clears storage; we report usage instead of guessing.
}

/** Speech-to-text and "question understanding" packs were removed in 0.3: forget them and free their cached files.
 *  Runs once per start; translation and OCR packs are untouched. */
export async function freeRetiredModels(): Promise<number> {
  const d = await db();
  const retired = (await d.getAll("models")).filter((m) => !["translation", "ocr"].includes(m.capability));
  for (const m of retired) {
    await d.delete("models", m.id);
    const name = String(m.manifest?.model ?? "");
    if (!name || typeof caches === "undefined") continue;
    for (const key of await caches.keys()) {
      const c = await caches.open(key);
      for (const req of await c.keys()) if (req.url.includes(name)) await c.delete(req);
    }
  }
  return retired.length;
}

// ------------------------------------------------------------------ translation
export async function installTranslation(manifest: any, onProgress?: Progress): Promise<InstalledModel> {
  const pipe = await pipelineFor(manifest, onProgress);
  const sample = manifest.direction?.[0] === "hi" ? "नमस्ते" : "Hello";
  const out = await pipe(sample, { max_new_tokens: 16 });
  if (!out?.[0]?.translation_text) throw new Error("Translation self-test produced no output");
  const v = await verifyCachedFiles(manifest);
  return markInstalled(manifest, v.ok, v.detail);
}

/** Terminology from the installed dictionary packs (reviewed translations) for one direction. */
async function glossary(from: string, to: string) {
  const packs = await (await db()).getAllFromIndex("packs", "by_kind", "dictionary");
  return termPairs(packs.flatMap((p) => (p.content?.entries ?? []) as GlossaryEntry[]), from, to);
}

export interface TranslationResult { text: string; model: string; ms: number; terms: { source: string; target: string }[] }

export async function translate(textIn: string, from: string, to: string): Promise<TranslationResult> {
  const models = await installedModels();
  const m = models.find((x) => x.capability === "translation" && x.manifest.direction?.[0] === from && x.manifest.direction?.[1] === to);
  if (!m) throw new Error(`No offline ${from}→${to} translation pack installed`);
  const t0 = performance.now();
  const pipe = await pipelineFor(m.manifest);
  const pairs = await glossary(from, to);
  const used = new Map<string, string>();
  const one = async (s: string) => (await pipe(s, { max_new_tokens: 256 }))[0].translation_text as string;
  // Sentence by sentence (long inputs stay within the model's context) and line by line (lists keep their shape).
  const lines: string[] = [];
  for (const sentences of splitSentences(textIn)) {
    const outs: string[] = [];
    for (const s of sentences) {
      const p = protectTerms(s, pairs);
      let out = await one(p.text);
      if (p.slots.length) {
        const r = restoreTerms(out, p.slots);
        if (r.ok) { out = r.text; for (const x of p.slots) used.set(x.source, x.target); }
        else out = await one(s);                        // the model lost a placeholder: plain translation instead
      }
      outs.push(tidyOutput(out, to));
    }
    lines.push(outs.join(" "));
  }
  return { text: lines.join("\n").trim(), model: m.manifest.model, ms: Math.round(performance.now() - t0),
    terms: [...used].map(([source, target]) => ({ source, target })) };
}

export async function translationPairs(): Promise<[string, string][]> {
  return (await installedModels()).filter((m) => m.capability === "translation").map((m) => m.manifest.direction as [string, string]);
}

// ------------------------------------------------------------------ OCR
let ocrWorkers = new Map<string, Promise<any>>();
const workerPath = () => new URL("../vendor/tesseract/worker.min.js", import.meta.url).toString();

const UPSTREAM_CACHE = "fieldkit-upstream-v1";

/**
 * The tesseract worker loads its WASM core with importScripts(), which (in Chromium) is not routed
 * through FieldKit's service worker — offline it would depend on the evictable HTTP cache. So FieldKit
 * fetches the pinned core itself into its own Cache API store and hands the worker a same-origin blob URL.
 * The "#core.wasm.js" fragment satisfies tesseract's "path ends with js → load this exact file" check.
 */
async function coreBlobUrl(): Promise<string> {
  const { relaxedSimd, simd } = await import("wasm-feature-detect");
  const variant = (await relaxedSimd()) ? "relaxedsimd-lstm" : (await simd()) ? "simd-lstm" : "lstm";
  const url = `${TESSERACT_CORE}/tesseract-core-${variant}.wasm.js`;
  const cache = await caches.open(UPSTREAM_CACHE);
  let res = await cache.match(url);
  if (!res) {
    const fresh = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!fresh.ok) throw new Error(`Could not download OCR engine (${fresh.status})`);
    await cache.put(url, fresh.clone());
    res = fresh;
  }
  const blob = new Blob([await res.arrayBuffer()], { type: "text/javascript" });
  return `${URL.createObjectURL(blob)}#core.wasm.js`;
}

async function ocrWorker(lang: string, onProgress?: Progress): Promise<any> {
  if (!ocrWorkers.has(lang)) {
    const p = import("tesseract.js").then(async (T) => {
      const w = await T.createWorker(lang, 1, {
        workerPath: workerPath(), corePath: await coreBlobUrl(), langPath: TESSDATA(lang), cacheMethod: "write",
        workerBlobURL: false, logger: (x: any) => onProgress?.({ status: x.status, progress: x.progress }),
      } as any);
      await w.setParameters(OCR_PARAMS as any);
      return w;
    });
    p.catch(() => ocrWorkers.delete(lang));
    ocrWorkers.set(lang, p);
  }
  return ocrWorkers.get(lang)!;
}

export async function installOcr(manifest: any, onProgress?: Progress): Promise<InstalledModel> {
  const w = await ocrWorker(manifest.lang_code, onProgress);
  const c = document.createElement("canvas");
  c.width = 220; c.height = 60;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, 220, 60);
  g.fillStyle = "#000"; g.font = "32px sans-serif"; g.fillText(manifest.lang_code === "hin" ? "नमस्ते" : "FIELD", 10, 42);
  await w.recognize(c);  // self-test; output quality on a synthetic glyph is not asserted
  return markInstalled(manifest, true, "engine and language data loaded and executed on device");
}

export interface OcrResult {
  text: string; confidence: number; quality: "good" | "check" | "poor"; note: string; rotation: number; passes: number;
}

/** Plain-language verdict on an OCR result, so a weak read is never presented as reliable text. */
export function ocrVerdict(confidence: number, kept: number, dropped: number, chars: number): Pick<OcrResult, "quality" | "note"> {
  if (!chars) return { quality: "poor", note: "No readable text was found. Retake the photo closer to the text, in good light, holding the phone steady." };
  if (confidence >= 80 && dropped <= kept) return { quality: "good", note: "" };
  if (confidence >= 65) return { quality: "check", note: "Some words may be wrong. Check the text against the photo." };
  return { quality: "poor", note: "The photo looks blurred, dark or at an angle, so this text is unreliable. Retake it closer, in good light, holding the phone steady." };
}

export async function ocr(blob: Blob, lang = "eng", onProgress?: Progress): Promise<OcrResult> {
  const models = await installedModels();
  if (!models.some((m) => m.capability === "ocr" && m.manifest.lang_code === lang)) throw new Error(`No offline OCR pack for ${lang}`);
  const w = await ocrWorker(lang, onProgress);
  const r = await runOcr(blob, async (c) => (await w.recognize(c, {}, { text: true, blocks: true })).data,
    { onPass: (label) => onProgress?.({ status: label }) });
  return { text: r.text, confidence: r.confidence, rotation: r.rotation, passes: r.passes,
    ...ocrVerdict(r.confidence, r.kept, r.dropped, r.text.replace(/\s/g, "").length) };
}

export async function ocrLanguages(): Promise<string[]> {
  return (await installedModels()).filter((m) => m.capability === "ocr").map((m) => m.manifest.lang_code);
}

// ------------------------------------------------------------------ capabilities
export interface Caps { mediaRecorder: boolean; camera: boolean; geolocation: boolean; wasm: boolean; cacheApi: boolean }

export async function capabilities(): Promise<Caps> {
  return {
    mediaRecorder: typeof MediaRecorder !== "undefined",
    camera: true /* file input with capture= works on every target browser */, geolocation: "geolocation" in navigator,
    wasm: typeof WebAssembly === "object", cacheApi: typeof caches !== "undefined",
  };
}
