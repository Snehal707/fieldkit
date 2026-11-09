// Audio preparation for on-device Whisper. Voice notes recorded on a phone start and end with silence (tap to
// start, tap to stop), are often quiet (phone at arm's length) and noisy. Whisper hallucinates on long silence
// ("Thank you for watching", repeated phrases) and the quantised tiny model degrades on low-level input.
// Measured on synthetic phone-style recordings (tests/eval/stt_eval.mjs): trimming + level normalisation +
// a repetition guard cut English word errors from 8.9% to 7.9% with the old pack, and to 3.7% with the
// fp32-encoder pack; Hindi output stopped looping.

/** Remove DC offset, trim leading/trailing silence (keeping 0.3 s), and normalise the peak to 0.9 (≤30x gain). */
export function prepareSpeech(x: Float32Array, rate = 16000): Float32Array {
  const n = x.length;
  if (!n) return x;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = x[i] - mean;
  const F = Math.round(rate * 0.02), frames = Math.floor(n / F);
  let z = y;
  if (frames >= 5) {
    const rms = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let i = f * F; i < (f + 1) * F; i++) s += y[i] * y[i];
      rms[f] = Math.sqrt(s / F);
    }
    const sorted = Float32Array.from(rms).sort();
    const floor = sorted[Math.floor(frames * 0.1)], peak = sorted[frames - 1];
    const thr = Math.max(floor * 3, peak * 0.08);
    let a = 0, b = frames - 1;
    while (a < frames && rms[a] < thr) a++;
    while (b > a && rms[b] < thr) b--;
    if (a < b) {
      const pad = Math.round(0.3 * rate);
      z = y.slice(Math.max(0, a * F - pad), Math.min(n, (b + 1) * F + pad));
    }
  }
  let pk = 0;
  for (const v of z) pk = Math.max(pk, Math.abs(v));
  const g = pk > 1e-4 ? Math.min(0.9 / pk, 30) : 1;
  if (g !== 1) for (let i = 0; i < z.length; i++) z[i] *= g;
  return z;
}

/** True if the recording has no speech-level signal at all (so we say so instead of letting Whisper invent text). */
export function isSilent(x: Float32Array): boolean {
  let pk = 0;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  return pk < 0.003;
}

/** Whisper generation options: a repetition guard and a length cap tied to the audio duration. */
export function whisperOptions(samples: number, language: string, rate = 16000): Record<string, unknown> {
  const seconds = samples / rate;
  return { language, task: "transcribe", chunk_length_s: 30, stride_length_s: 5,
    no_repeat_ngram_size: 4, max_new_tokens: Math.min(440, Math.ceil(seconds * 20) + 16) };
}

/** Collapse a phrase repeated 3+ times in a row (a residual Whisper loop) to one occurrence. */
export function collapseRepeats(text: string): string {
  return text.replace(/(\b.{3,60}?)(?:[\s,.;]+\1){2,}/gu, "$1").replace(/\s{2,}/g, " ").trim();
}
