// Image preparation for on-device OCR (tesseract.js). Phone photos of printed pages are the hard case:
// the text is small relative to the frame, lighting is uneven (hand/phone shadow), and iPhone JPEGs are stored
// in sensor orientation with an EXIF rotation tag. Before 0.2.4 FieldKit downscaled every photo to 1800 px and
// passed it to Tesseract unchanged, which produced mostly gibberish at ~20-30% confidence on real iPhone photos.

/** Decode an image honouring its EXIF orientation (an <img> element does this on every current browser,
 *  including iOS Safari; createImageBitmap does not reliably). Falls back to createImageBitmap. */
export async function decodeImage(blob: Blob): Promise<{ src: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof Image !== "undefined" && typeof URL !== "undefined") {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      if (img.naturalWidth > 0) return { src: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch { /* fall through */ }
    URL.revokeObjectURL(url);
  }
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
  return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
}

/** Draw `src` scaled so its long side is `longSide` (never above `maxPixels`), optionally rotated by 90° steps. */
export function drawScaled(src: CanvasImageSource, w: number, h: number, longSide: number, rotate = 0, maxPixels = 9_000_000): HTMLCanvasElement {
  let scale = longSide / Math.max(w, h);
  if (w * h * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
  const quarter = ((rotate % 360) + 360) % 360 / 90;
  const c = document.createElement("canvas");
  [c.width, c.height] = quarter % 2 ? [sh, sw] : [sw, sh];
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.translate(c.width / 2, c.height / 2);
  g.rotate(quarter * Math.PI / 2);
  g.drawImage(src, -sw / 2, -sh / 2, sw, sh);
  return c;
}

/**
 * Grayscale + illumination flattening + contrast stretch, in place. Dark text on light paper is assumed (the
 * normal case for forms, labels and notices). The local paper brightness is estimated per 32 px block as a high
 * percentile, spread with a max filter (so blocks covered by bold text still find paper) and interpolated;
 * dividing by it removes shadows and vignetting that defeat Tesseract's global (Otsu) threshold.
 */
export function flattenForOcr(img: ImageData): ImageData {
  const { width: W, height: H, data } = img;
  const gray = new Float32Array(W * H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  const B = 32, bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  const bg = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    hist.fill(0);
    let n = 0;
    for (let y = by * B; y < Math.min(H, by * B + B); y++) for (let x = bx * B; x < Math.min(W, bx * B + B); x++) { hist[gray[y * W + x] | 0]++; n++; }
    let k = 255, acc = 0;
    const want = n * 0.08;                      // 92nd percentile = paper, even with dense text
    while (k > 0 && acc + hist[k] < want) acc += hist[k--];
    bg[by * bw + bx] = k;
  }
  // 5x5 max filter then 3x3 mean over the block grid.
  const mx = new Float32Array(bg.length);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let m = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) m = Math.max(m, bg[yy * bw + xx]);
    }
    mx[y * bw + x] = m;
  }
  const sm = new Float32Array(bg.length);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) { s += mx[yy * bw + xx]; c++; }
    }
    sm[y * bw + x] = Math.max(24, s / c);
  }
  // Divide by the bilinearly interpolated background, then stretch so the darkest 1% of ink becomes black.
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const b = (sm[y0 * bw + x0] * (1 - tx) + sm[y0 * bw + x1] * tx) * (1 - ty) + (sm[y1 * bw + x0] * (1 - tx) + sm[y1 * bw + x1] * tx) * ty;
      out[y * W + x] = Math.min(1, gray[y * W + x] / b);
    }
  }
  const h2 = new Uint32Array(256);
  for (const v of out) h2[(v * 255) | 0]++;
  let lo = 0, acc = 0;
  while (lo < 255 && acc + h2[lo] < out.length * 0.01) acc += h2[lo++];
  const lov = lo / 255, span = Math.max(0.15, 0.97 - lov);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const v = Math.max(0, Math.min(1, (out[i] - lov) / span));
    const g8 = Math.round(255 * v * v * (3 - 2 * v) * 0.35 + 255 * v * 0.65);   // gentle S-curve: crisper strokes
    data[p] = data[p + 1] = data[p + 2] = g8;
    data[p + 3] = 255;
  }
  return img;
}

/** Long side to OCR at: big enough that ordinary print reaches the ~20-30 px x-height Tesseract needs. */
export const OCR_LONG_SIDE = 3000;

export interface OcrWord { text: string; confidence: number }
export interface OcrLine { words: OcrWord[] }
export interface OcrPass { rotation: number; flattened: boolean; text: string; confidence: number; kept: number; dropped: number; score: number }

/** Tesseract page output (blocks → paragraphs → lines → words) to plain lines of words. */
export function pageLines(data: any): OcrLine[] {
  return (data?.blocks ?? []).flatMap((b: any) => (b.paragraphs ?? []).flatMap((p: any) => (p.lines ?? []).map((l: any) =>
    ({ words: (l.words ?? []).map((w: any) => ({ text: String(w.text ?? ""), confidence: Number(w.confidence ?? 0) })) }))));
}

const LETTER = /[\p{L}\p{N}]/u;

/**
 * Keep the words Tesseract is reasonably sure of and drop texture it misread as text (page edges, desk grain,
 * shadows: low-confidence fragments and stray symbols). Confidence is the character-weighted mean of what is kept,
 * so it describes the text the user actually gets. `score` rewards both confidence and the amount of readable text,
 * which is how the right orientation is told apart from a sideways one.
 */
export function keepWords(lines: OcrLine[], minConfidence = 40): Omit<OcrPass, "rotation" | "flattened"> {
  let kept = 0, dropped = 0, chars = 0, confSum = 0, score = 0;
  const out: string[] = [];
  for (const l of lines) {
    const ws = l.words.filter((w) => w.text.trim());
    const ok = ws.filter((w) => {
      const t = w.text.trim();
      const letters = [...t].filter((ch) => LETTER.test(ch)).length;
      if (!letters) return false;                                       // pure punctuation/edge marks
      if (w.confidence < minConfidence) return false;
      return !(t.length <= 2 && w.confidence < 70 && ws.length > 2);   // isolated 1-2 char fragments
    });
    kept += ok.length; dropped += ws.length - ok.length;
    if (!ok.length) continue;
    for (const w of ok) { const n = [...w.text].length; chars += n; confSum += w.confidence * n; score += n * (w.confidence / 100) ** 2; }
    out.push(ok.map((w) => w.text.trim()).join(" "));
  }
  return { text: out.join("\n"), confidence: chars ? Math.round(confSum / chars) : 0, kept, dropped, score };
}

export interface RunOcrOptions { longSide?: number; probeSide?: number; onPass?: (label: string) => void }

/** Tesseract parameters FieldKit sets on its OCR workers. tesseract.js defaults to PSM 6 ("a single uniform
 *  block"), which on a photo merges page edges, desk and text into one block; PSM 3 (automatic layout) is right
 *  for photos of documents, labels and notices. */
export const OCR_PARAMS = { tessedit_pageseg_mode: "3", user_defined_dpi: "300" };

/**
 * Recognise text in a photo: decode with EXIF orientation, OCR at a resolution where ordinary print is legible,
 * and only if the result is weak try an illumination-flattened copy and the other three orientations, keeping the
 * best-scoring pass. `recognize` runs Tesseract on a canvas and returns its page output (blocks enabled).
 */
export async function runOcr(blob: Blob, recognize: (c: HTMLCanvasElement) => Promise<any>, opts: RunOcrOptions = {}): Promise<OcrPass & { passes: number }> {
  const im = await decodeImage(blob);
  const target = opts.longSide ?? OCR_LONG_SIDE;
  // Upscale small images to the target; never downscale below it (the old 1800 px cap made small print illegible).
  const long = Math.max(target, Math.min(Math.max(im.width, im.height), target));
  // High confidence alone is not "good": on an unevenly lit photo Tesseract's layout analysis can read only the
  // heading (95% confident, three words) and classify the shaded body text as a picture. So both the flattened and
  // the plain image are always read, and the pass that recovers the most confident text wins.
  const good = (p: OcrPass | null) => !!p && p.confidence >= 80 && p.score >= 40;
  let best: OcrPass | null = null, passes = 0;
  const read = async (side: number, rotation: number, flattened: boolean): Promise<OcrPass> => {
    const c = drawScaled(im.src, im.width, im.height, side, rotation);
    if (flattened) { const g = c.getContext("2d")!; g.putImageData(flattenForOcr(g.getImageData(0, 0, c.width, c.height)), 0, 0); }
    const r = { rotation, flattened, ...keepWords(pageLines(await recognize(c))) };
    c.width = c.height = 0;                                            // release canvas memory promptly (iOS)
    passes++;
    return r;
  };
  const attempt = async (rotation: number, flattened: boolean) => {
    opts.onPass?.(rotation ? `Reading the photo rotated ${rotation}°…` : flattened ? "Reading text (correcting uneven light)…" : "Reading text…");
    const r = await read(long, rotation, flattened);
    if (!best || r.score > best.score) best = r;
  };
  try {
    await attempt(0, true);
    await attempt(0, false);
    if (!good(best) && (best!.confidence < 60 || best!.score < 15)) {
      // Weak result: maybe the photo is sideways or upside down. Probe the orientations cheaply at low resolution
      // and do a full-resolution pass only for an orientation that clearly reads better than upright.
      opts.onPass?.("Checking whether the photo is sideways…");
      const side = opts.probeSide ?? 1600, flat = best!.flattened;
      const probes: OcrPass[] = [];
      for (const rot of [0, 90, 270, 180]) probes.push(await read(side, rot, flat));
      const upright = probes[0].score, top = probes.slice(1).sort((a, b) => b.score - a.score)[0];
      if (top.score > Math.max(4, upright * 1.5)) await attempt(top.rotation, flat);
    }
  } finally { im.close(); }
  return { ...(best as unknown as OcrPass), passes };
}
