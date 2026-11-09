// Whisper accuracy evaluation (Transformers.js in Node with onnxruntime-node: the same pinned ONNX files the PWA
// downloads). English WER and Hindi CER on synthetic speech (tests/eval/tts.ps1 + stt_sentences.json), clean and
// "phone" (quiet, 12 dB SNR noise, 1.5 s / 2 s of noise before and after). Mode "fieldkit" applies the app's own
// app/src/audio_prep.ts (trim + normalise + repetition guard + length cap).
// Usage: node tests/eval/stt_eval.mjs <wav dir> '<json configs>' [none|fieldkit] [cacheDir]
//   configs: [{"model":"Xenova/whisper-tiny","dtype":{"encoder_model":"fp32","decoder_model_merged":"q8"},"revision":"..."}]
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareSpeech, whisperOptions, collapseRepeats } from "../../app/src/audio_prep.ts";
const T = await import("@huggingface/transformers");
const dir = process.argv[2];
const configs = JSON.parse(process.argv[3]);
const prep = process.argv[4] ?? "none";
T.env.cacheDir = process.argv[5] ?? join(dir, "..", "hf-cache");
const S = JSON.parse(readFileSync(resolve(import.meta.dirname, "stt_sentences.json"), "utf8"));

function wav(path) {
  const b = readFileSync(path); let o = 12, data, rate = 16000, bits = 16;
  while (o < b.length) { const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === "fmt ") { rate = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22); }
    if (id === "data") data = b.subarray(o + 8, o + 8 + n); o += 8 + n + (n & 1); }
  const f = new Float32Array(data.length / 2); for (let i = 0; i < f.length; i++) f[i] = data.readInt16LE(i * 2) / 32768;
  if (rate !== 16000) throw new Error("rate " + rate); return f;
}
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
// "phone": quiet far-field level, room noise at ~12 dB SNR, 1.5 s of noise before and 2 s after (tap to start/stop).
function phone(x) {
  let p = 0; for (const v of x) p += v * v; p /= x.length;
  const gain = 0.12, noise = Math.sqrt(p * gain * gain / Math.pow(10, 12 / 10));
  const out = new Float32Array(x.length + 16000 * 3.5);
  for (let i = 0; i < out.length; i++) { const j = i - 24000; out[i] = (j >= 0 && j < x.length ? x[j] * gain : 0) + noise * gauss(); }
  return out;
}
const variants = { clean: (x) => x, phone };

const ones = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
const num = (n) => n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
const normEn = (s) => s.toLowerCase().replace(/\d+/g, (d) => +d < 100 ? num(+d) : d).replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
const normHi = (s) => [...s.replace(/[।,.!?\-'"“”]/g, "").replace(/\s+/g, "")];
function ed(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length]; }

const files = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
const results = [];
for (const c of configs) {
  const t0 = Date.now();
  const pipe = await T.pipeline("automatic-speech-recognition", c.model, { dtype: c.dtype, revision: c.revision ?? "main" });
  const load = Date.now() - t0;
  for (const [vn, vf] of Object.entries(variants)) {
    const agg = { en: [0, 0], hi: [0, 0] }; let ms = 0; const samples = [];
    for (const f of files) {
      const lang = f.slice(0, 2), idx = +f.match(/_(\d+)\.wav$/)[1];
      let audio = vf(wav(join(dir, f)));
      if (prep === "fieldkit") audio = prepareSpeech(audio);
      const t = Date.now();
      const language = lang === "hi" ? "hindi" : "english";
      const out = await pipe(audio, prep === "fieldkit" ? whisperOptions(audio.length, language)
        : { language, task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
      if (prep === "fieldkit") out.text = collapseRepeats(out.text);
      ms += Date.now() - t;
      const ref = S[lang][idx], hyp = String(out.text).trim();
      const [R, H] = lang === "en" ? [normEn(ref), normEn(hyp)] : [normHi(ref), normHi(hyp)];
      agg[lang][0] += ed(R, H); agg[lang][1] += R.length;
      if (samples.length < 4 && (f.includes("ravi_0") || f.includes("kalpana_0") || f.includes("zira_3") || f.includes("hemant_2"))) samples.push(`${f}: ${hyp}`);
    }
    const r = { model: c.model, dtype: JSON.stringify(c.dtype), prep, variant: vn, en_WER: +(agg.en[0] / agg.en[1] * 100).toFixed(1), hi_CER: +(agg.hi[0] / agg.hi[1] * 100).toFixed(1), avg_ms: Math.round(ms / files.length), load_ms: load, samples };
    results.push(r); console.log(JSON.stringify(r));
  }
  await pipe.dispose?.();
}
