// URL layout. The app is served at <dashboard>/api/plugins/fieldkit/app/ and all routing is hash-based,
// so the document path is always the app root. Derived from the module URL so it works under any prefix.
const here = new URL(".", import.meta.url); // .../app/assets/
export const APP_BASE = new URL("../", here); // .../api/plugins/fieldkit/app/
export const API_BASE = new URL("../", APP_BASE); // .../api/plugins/fieldkit/
export const DASHBOARD_ROOT = new URL("../../../", API_BASE); // /api/plugins/fieldkit/ → dashboard root (keeps any prefix)

export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), API_BASE).toString();
}

/**
 * Hermes rejects every `/api/...` path as a post-login `next` target (dashboard_auth is_safe_next_path), so
 * pointing `next` at the app itself silently lands the user on the dashboard. Instead return through
 * FieldKit's static page at <root>/dashboard-plugins/fieldkit/return.html, which forwards to the app.
 * The screen to reopen is remembered in localStorage (see rememberReturn / takeReturn).
 */
export function loginUrlFor(dashboardRoot: URL): string {
  const next = new URL("dashboard-plugins/fieldkit/return.html", dashboardRoot).pathname;
  return new URL(`login?next=${encodeURIComponent(next)}`, dashboardRoot).toString();
}

export function loginUrl(): string {
  return loginUrlFor(DASHBOARD_ROOT);
}

const RETURN_KEY = "fieldkit-return-hash";

export function rememberReturn(hash: string): void {
  try { localStorage.setItem(RETURN_KEY, hash.startsWith("#/") ? hash : "#/"); } catch { /* storage blocked */ }
}

export function takeReturn(): string | null {
  try {
    const v = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    return v && v.startsWith("#/") ? v : null;
  } catch { return null; }
}

/** Navigate to Hermes sign-in, coming back to `returnHash` in FieldKit afterwards. */
export function signIn(returnHash = "#/sync"): void {
  rememberReturn(returnHash);
  location.assign(loginUrl());
}

// Pinned upstream runtimes (see fieldkit_core/models.json and THIRD_PARTY.md).
export const TESSERACT_CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0";
export const TESSDATA = (lang: string) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int`;
export const APP_VERSION = "0.1.2";
