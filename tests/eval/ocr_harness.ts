// Browser harness for the OCR evaluation (bundled with esbuild, driven by tests/eval/ocr_run.mjs). "old-*" modes
// reproduce FieldKit <= 0.2.3 (photo stored at 1600 px via createImageBitmap, OCR downscaled to 1800 px, tesseract.js
// default PSM 6); "new-*" modes run the app's own app/src/ocr_prep.ts exactly as the app does.
import { createWorker } from "tesseract.js";
import { decodeImage, drawScaled, OCR_PARAMS, runOcr } from "../../app/src/ocr_prep";

const workers: Record<string, any> = {};
async function worker(lang: string) {
  if (!workers[lang]) workers[lang] = await createWorker(lang, 1, { workerPath: "/worker.min.js", corePath: "/core/",
    langPath: `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int`, workerBlobURL: false } as any);
  return workers[lang];
}
const toJpeg = (c: HTMLCanvasElement, q: number) => new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", q));

async function oldCompress(file: Blob, maxSide = 1600, q = 0.8) {
  const bmp = await createImageBitmap(file); const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return toJpeg(c, q);
}
async function oldPrepare(blob: Blob, maxSide = 1800) {
  const bmp = await createImageBitmap(blob); const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
async function newCompress(file: Blob, maxSide: number, q: number) {   // = media.compressPhoto
  const im = await decodeImage(file); const c = drawScaled(im.src, im.width, im.height, Math.min(maxSide, Math.max(im.width, im.height))); im.close();
  return toJpeg(c, q);
}
async function newOcr(blob: Blob, lang: string) {                       // = intel.ocr
  const w = await worker(lang);
  await w.setParameters(OCR_PARAMS as any);
  return runOcr(blob, async (c) => (await w.recognize(c, {}, { text: true, blocks: true })).data);
}

(window as any).run = async (url: string, lang: string, mode: string) => {
  const file = await (await fetch(url)).blob();
  const t0 = performance.now();
  let r: any;
  if (mode === "old-field" || mode === "old-tool") {
    const src = mode === "old-field" ? await oldCompress(file) : file;
    const w = await worker(lang);
    await w.setParameters({ tessedit_pageseg_mode: "6" } as any);       // tesseract.js default, as before
    const { data } = await w.recognize(await oldPrepare(src));
    r = { text: data.text, confidence: data.confidence };
  } else if (mode === "new-tool") r = await newOcr(file, lang);                       // OCR screen: original photo
  else if (mode === "new-field") r = await newOcr(await newCompress(file, 2048, 0.85), lang);  // photo field
  else if (mode === "new-field-1600") r = await newOcr(await newCompress(file, 1600, 0.8), lang);
  else throw new Error(`unknown mode ${mode}`);
  return { ...r, ms: Math.round(performance.now() - t0) };
};
