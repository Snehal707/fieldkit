// On-device intelligence: sentence translation, speech-to-text (Transformers.js + ONNX Runtime Web),
// OCR (tesseract.js) and text-to-speech (local voices only). Heavy libraries load lazily.
//
// Model and WASM files come from their pinned upstream hosts the first time a pack is installed and
// are cached on the device (Transformers.js Cache API store, tesseract IndexedDB + service worker
// upstream cache). After installation no network request is needed; FieldKit never calls a remote
// translation, OCR or speech service.
import { TESSDATA, TESSERACT_CORE } from "./config";
import { db, type InstalledModel } from "./db";
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

// ------------------------------------------------------------------ translation
export async function installTranslation(manifest: any, onProgress?: Progress): Promise<InstalledModel> {
  const pipe = await pipelineFor(manifest, onProgress);
  const sample = manifest.direction?.[0] === "hi" ? "नमस्ते" : "Hello";
  const out = await pipe(sample, { max_new_tokens: 16 });
  if (!out?.[0]?.translation_text) throw new Error("Translation self-test produced no output");
  const v = await verifyCachedFiles(manifest);
  return markInstalled(manifest, v.ok, v.detail);
}

export async function translate(textIn: string, from: string, to: string): Promise<{ text: string; model: string; ms: number }> {
  const models = await installedModels();
  const m = models.find((x) => x.capability === "translation" && x.manifest.direction?.[0] === from && x.manifest.direction?.[1] === to);
  if (!m) throw new Error(`No offline ${from}→${to} translation pack installed`);
  const t0 = performance.now();
  const pipe = await pipelineFor(m.manifest);
  // Translate sentence by sentence so long inputs stay within the model's context.
  const parts = textIn.split(/(?<=[.!?।])\s+/u).filter((s) => s.trim());
  const outs: string[] = [];
  for (const s of parts.length ? parts : [textIn]) {
    const r = await pipe(s, { max_new_tokens: 256 });
    outs.push(r[0].translation_text);
  }
  return { text: outs.join(" "), model: m.manifest.model, ms: Math.round(performance.now() - t0) };
}

export async function translationPairs(): Promise<[string, string][]> {
  return (await installedModels()).filter((m) => m.capability === "translation").map((m) => m.manifest.direction as [string, string]);
}

// ------------------------------------------------------------------ speech to text
export async function installStt(manifest: any, onProgress?: Progress): Promise<InstalledModel> {
  const pipe = await pipelineFor(manifest, onProgress);
  const silence = new Float32Array(16000);
  await pipe(silence, { language: "english", task: "transcribe" });
  const v = await verifyCachedFiles(manifest);
  return markInstalled(manifest, v.ok, v.detail);
}

export async function decodeTo16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  const audio = await ctx.decodeAudioData(buf.slice(0));
  await ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

export async function transcribe(blob: Blob, lang: string): Promise<{ text: string; engine: string }> {
  const m = (await installedModels()).find((x) => x.capability === "stt");
  if (!m) throw new Error("No offline speech-to-text pack installed");
  const pipe = await pipelineFor(m.manifest);
  const audio = await decodeTo16k(blob);
  const language = { en: "english", hi: "hindi", mr: "marathi" }[lang] ?? "english";
  const out = await pipe(audio, { language, task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
  return { text: (Array.isArray(out) ? out[0].text : out.text).trim(), engine: `${m.manifest.model} (on device)` };
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

/** Downscale large photos before OCR to stay within mobile memory. */
export async function prepareImage(blob: Blob, maxSide = 1800): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

export async function ocr(blob: Blob, lang = "eng", onProgress?: Progress): Promise<{ text: string; confidence: number }> {
  const models = await installedModels();
  if (!models.some((m) => m.capability === "ocr" && m.manifest.lang_code === lang)) throw new Error(`No offline OCR pack for ${lang}`);
  const w = await ocrWorker(lang, onProgress);
  const img = await prepareImage(blob);
  const { data } = await w.recognize(img);
  return { text: data.text.trim(), confidence: data.confidence };
}

export async function ocrLanguages(): Promise<string[]> {
  return (await installedModels()).filter((m) => m.capability === "ocr").map((m) => m.manifest.lang_code);
}

// ------------------------------------------------------------------ text to speech (local voices only)
export function localVoices(lang?: string): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === "undefined") return [];
  return speechSynthesis.getVoices().filter((v) => v.localService && (!lang || v.lang.toLowerCase().startsWith(lang.toLowerCase())));
}

export function voicesReady(): Promise<void> {
  if (typeof speechSynthesis === "undefined" || speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((r) => {
    speechSynthesis.addEventListener("voiceschanged", () => r(), { once: true });
    setTimeout(r, 1500);
  });
}

export function speak(textIn: string, lang: string): { ok: boolean; voice?: string; reason?: string } {
  const voices = localVoices(lang);
  if (!voices.length) return { ok: false, reason: `No on-device voice for "${lang}" on this device. FieldKit does not use network voices.` };
  const u = new SpeechSynthesisUtterance(textIn);
  u.voice = voices[0];
  u.lang = voices[0].lang;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  return { ok: true, voice: `${voices[0].name} (${voices[0].lang}, local)` };
}

// ------------------------------------------------------------------ capabilities
export interface Caps { mediaRecorder: boolean; tts: boolean; camera: boolean; geolocation: boolean; wasm: boolean; cacheApi: boolean;
  nativeLocalStt: "available" | "downloadable" | "unavailable" | "unknown" }

export async function capabilities(): Promise<Caps> {
  let nativeLocalStt: Caps["nativeLocalStt"] = "unknown";
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  try {
    if (SR?.available) nativeLocalStt = await SR.available({ langs: ["en-US"], processLocally: true });
    else nativeLocalStt = "unavailable";
  } catch { nativeLocalStt = "unavailable"; }
  return {
    mediaRecorder: typeof MediaRecorder !== "undefined", tts: typeof speechSynthesis !== "undefined",
    camera: true /* file input with capture= works on every target browser */, geolocation: "geolocation" in navigator,
    wasm: typeof WebAssembly === "object", cacheApi: typeof caches !== "undefined", nativeLocalStt,
  };
}
