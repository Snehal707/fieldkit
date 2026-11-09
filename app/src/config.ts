// URL layout (hash routing, so the document path is always the app root). The app is LAUNCHED from Hermes'
// public plugin-asset path <root>/dashboard-plugins/fieldkit/app_dist/index.html — outside the /api auth gate, so
// a Home Screen launch with an expired session (or no service worker) opens the app instead of Hermes' raw
// 401 JSON. All data still goes through the authenticated API at <root>/api/plugins/fieldkit/. The legacy
// address <root>/api/plugins/fieldkit/app/ keeps working for existing installs.
const here = new URL(".", import.meta.url); // .../<app>/assets/
export const APP_BASE = new URL("../", here);
export const APP_ENTRY = "index.html";
export const PUBLIC_APP_PATH = "dashboard-plugins/fieldkit/app_dist/";
export const LEGACY_APP_PATH = "api/plugins/fieldkit/app/";

/** Dashboard root (keeps any URL prefix) for an app served from either address. */
export function dashboardRootFor(appBase: URL): URL {
  const p = appBase.pathname;
  for (const marker of ["/" + PUBLIC_APP_PATH, "/" + LEGACY_APP_PATH]) {
    const i = p.indexOf(marker);
    if (i >= 0) return new URL(p.slice(0, i + 1), appBase);
  }
  return new URL("/", appBase);
}

export const DASHBOARD_ROOT = dashboardRootFor(APP_BASE);
export const API_BASE = new URL("api/plugins/fieldkit/", DASHBOARD_ROOT);
export const PUBLIC_APP_URL = new URL(PUBLIC_APP_PATH + APP_ENTRY, DASHBOARD_ROOT);
export const RUNNING_FROM_LEGACY_PATH = APP_BASE.pathname.endsWith("/" + LEGACY_APP_PATH);

export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), API_BASE).toString();
}

/**
 * Hermes rejects every `/api/...` path as a post-login `next` target (dashboard_auth is_safe_next_path). The
 * public app address is not under /api, so Hermes returns the user straight to the app after sign-in.
 * The screen to reopen is remembered in localStorage (see rememberReturn / takeReturn).
 */
export function loginUrlFor(dashboardRoot: URL): string {
  const next = new URL(PUBLIC_APP_PATH + APP_ENTRY, dashboardRoot).pathname;
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
export const APP_VERSION = "0.1.9";
