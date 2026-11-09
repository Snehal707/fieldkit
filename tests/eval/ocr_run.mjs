// Runs the OCR harness (tests/eval/ocr_harness.ts, bundled with esbuild) in a real browser against the
// synthetic iPhone-style photos made by make_ocr_photos.mjs, and prints character error rates.
// Usage: node tests/eval/ocr_run.mjs <dir with en_page.jpg/hi_page.jpg + ocr_text.json> <bundle.js> [chromium|webkit] [modes]
import { chromium, webkit } from "@playwright/test";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const [dir, bundle, eng = "chromium", modesArg = "old-field,old-tool,new-tool,new-field", variantsArg = "page,small,dim"] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../..");
const ref = JSON.parse(readFileSync(join(dir, "ocr_text.json"), "utf8"));
const ctx = await (eng === "webkit" ? webkit : chromium).launchPersistentContext(mkdtempSync(join(tmpdir(), "fk-ocr-")));
const page = await ctx.newPage();
const files = {
  "/": ["text/html", "<!doctype html><meta charset=utf-8><script src=/bundle.js></script>"],
  "/bundle.js": ["text/javascript", readFileSync(bundle)],
  "/worker.min.js": ["text/javascript", readFileSync(join(root, "node_modules/tesseract.js/dist/worker.min.js"))],
};
await page.route("http://ocr.test/**", (r) => {
  const p = new URL(r.request().url()).pathname;
  if (files[p]) return r.fulfill({ contentType: files[p][0], body: files[p][1] });
  if (p.startsWith("/core/")) return r.fulfill({ contentType: p.endsWith(".wasm") ? "application/wasm" : "text/javascript", body: readFileSync(join(root, "node_modules/tesseract.js-core", p.slice(6))) });
  if (p.startsWith("/img/")) return r.fulfill({ contentType: "image/jpeg", body: readFileSync(join(dir, p.slice(5))) });
  return r.fulfill({ status: 404, body: "" });
});
await page.goto("http://ocr.test/");
const norm = (s) => [...s.replace(/\s+/g, "")];
function ed(a, b) { let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length]; }
for (const variant of variantsArg.split(",")) for (const [lang, code] of [["en", "eng"], ["hi", "hin"]]) {
  for (const mode of modesArg.split(",")) {
    const r = await page.evaluate(([u, l, m]) => window.run(u, l, m), [`/img/${lang}_${variant}.jpg`, code, mode]);
    const R = norm(ref[lang].join("")), H = norm(r.text);
    console.log(JSON.stringify({ engine: eng, variant, lang, mode, CER: +(ed(R, H) / R.length * 100).toFixed(1), confidence: Math.round(r.confidence), rot: r.rotation, flat: r.flattened, passes: r.passes, dropped: r.dropped, ms: r.ms, text: r.text.replace(/\n/g, " | ").slice(0, 160) }));
  }
}
await ctx.close();
