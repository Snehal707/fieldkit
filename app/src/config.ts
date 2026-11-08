// URL layout. The app is served at <dashboard>/api/plugins/fieldkit/app/ and all routing is hash-based,
// so the document path is always the app root. Derived from the module URL so it works under any prefix.
const here = new URL(".", import.meta.url); // .../app/assets/
export const APP_BASE = new URL("../", here); // .../api/plugins/fieldkit/app/
export const API_BASE = new URL("../", APP_BASE); // .../api/plugins/fieldkit/
export const DASHBOARD_ROOT = new URL("../../../", API_BASE); // /api/plugins/fieldkit/ → dashboard root (keeps any prefix)

export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), API_BASE).toString();
}

export function loginUrl(returnHash = "#/sync"): string {
  const next = APP_BASE.pathname + returnHash;
  return new URL(`login?next=${encodeURIComponent(next)}`, DASHBOARD_ROOT).toString();
}

// Pinned upstream runtimes (see fieldkit_core/models.json and THIRD_PARTY.md).
export const TESSERACT_CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0";
export const TESSDATA = (lang: string) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int`;
export const APP_VERSION = "0.1.0";
