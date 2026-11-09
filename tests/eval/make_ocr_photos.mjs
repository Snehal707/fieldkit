// Synthetic "iPhone photo of a printed page" test images for OCR regression (no real user data):
// 4032x3024 sensor-orientation JPEG with EXIF orientation 6 (phone held upright), page skewed 2°, uneven light,
// sensor noise, focus/shake blur. Variants: "page" (large print), "small" (ordinary ~10-11 pt print shot from arm's
// length), "dim" (small print, indoor light, more noise and shake).
// Usage: node tests/eval/make_ocr_photos.mjs <out dir>   (writes <lang>_<variant>.jpg and ocr_text.json)
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const out = process.argv[2];
export const TEXT = {
  en: ["EQUIPMENT INSPECTION NOTICE", "Pump P-204 must be isolated before maintenance.", "Check the bearing temperature every shift and", "record the oil level in the logbook.", "Replace the safety guard if it is cracked or loose.", "Report any leak near the outlet valve immediately.", "Inspector signature is required on every form."],
  hi: ["उपकरण निरीक्षण सूचना", "रखरखाव से पहले पंप को बंद करें।", "हर पाली में बेयरिंग का तापमान जांचें।", "तेल का स्तर रजिस्टर में लिखें।", "टूटा हुआ सुरक्षा कवर तुरंत बदलें।", "वाल्व के पास रिसाव की सूचना दें।"],
};
writeFileSync(join(out, "ocr_text.json"), JSON.stringify(TEXT, null, 1));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const VARIANTS = {
  page: { size: 64, pageWidth: 2700, blur: 1.1, noise: 10, shade: "#7a7a7a", shake: 0 },
  small: { size: 30, pageWidth: 2500, blur: 1.6, noise: 14, shade: "#6a6a6a", shake: 3 },
  dim: { size: 30, pageWidth: 2500, blur: 1.8, noise: 26, shade: "#4a4a4a", shake: 5, dark: 0.55 },
};
async function photo(name, lines, font, v) {
  const W = 2250, H = 3000;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f4f1ea"/>
    ${lines.map((l, i) => `<text x="170" y="${380 + i * v.size * 1.9}" font-family="${font}" font-size="${i === 0 ? v.size * 1.25 : v.size}" font-weight="${i === 0 ? 700 : 400}" fill="#1d1d1f">${esc(l)}</text>`).join("")}</svg>`;
  const pg = await sharp(await sharp(Buffer.from(svg)).png().toBuffer()).rotate(2, { background: "#5a5550" }).resize({ width: v.pageWidth }).toBuffer();
  const m = await sharp(pg).metadata();
  const scene = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: "#5a5550" } })
    .composite([{ input: pg, left: Math.round((3024 - m.width) / 2), top: Math.round((4032 - m.height) / 2) }]).png().toBuffer();
  const shade = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="3024" height="4032"><defs><radialGradient id="g" cx="25%" cy="20%" r="95%">
    <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${v.shade}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
  let buf = await sharp(scene).composite([{ input: await sharp(shade).png().toBuffer(), blend: "multiply" }]).png().toBuffer();
  if (v.dark) buf = await sharp(buf).linear(v.dark, 0).png().toBuffer();
  buf = await sharp(buf).blur(v.blur).png().toBuffer();
  if (v.shake) { const k = v.shake * 2 + 1; buf = await sharp(buf).convolve({ width: k, height: 3, kernel: [...Array(k).fill(0), ...Array(k).fill(1 / k), ...Array(k).fill(0)] }).png().toBuffer(); }
  const raw = await sharp(buf).rotate(-90).raw().toBuffer({ resolveWithObject: true });
  const px = Buffer.from(raw.data); let s = 1;
  for (let i = 0; i < px.length; i++) { s = (s * 16807) % 2147483647; px[i] = Math.max(0, Math.min(255, px[i] + ((s % (2 * v.noise + 1)) - v.noise))); }
  writeFileSync(join(out, name), await sharp(px, { raw: raw.info }).jpeg({ quality: 88 }).withMetadata({ orientation: 6 }).toBuffer());
}
for (const [vn, v] of Object.entries(VARIANTS)) {
  await photo(`en_${vn}.jpg`, TEXT.en, "Arial", v);
  await photo(`hi_${vn}.jpg`, TEXT.hi, "Nirmala UI", v);
}
console.log("written", Object.keys(VARIANTS).length * 2, "photos to", out);
