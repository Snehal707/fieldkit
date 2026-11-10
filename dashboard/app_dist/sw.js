/* FieldKit service worker. Scope: the app's own subtree (/api/plugins/fieldkit/app/) — it never
 * controls the Hermes dashboard. Precaches the app shell so FieldKit reopens with no network, keeps
 * navigation working when the Hermes session has expired (401 → cached shell), never caches API
 * calls, and caches pinned upstream runtime files (tesseract core / language data on jsDelivr).
 * Transformers.js keeps its own model cache ("transformers-cache"), so model weights are not duplicated here. */
const VERSION = "cbc22db085171084";
const SHELL = `fieldkit-shell-${VERSION}`;
const UPSTREAM = "fieldkit-upstream-v1";
const UPSTREAM_HOSTS = new Set(["cdn.jsdelivr.net"]);
const SCOPE = new URL(self.registration.scope);
const INDEX = new URL("index.html", SCOPE).toString();

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const res = await fetch(new URL("precache.json", SCOPE), { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw new Error(`precache manifest unavailable (${res.status})`);
    const { files } = await res.json();
    const cache = await caches.open(SHELL);
    // Fetch one by one so a single failure is visible; install fails (and the old version stays) if any file is missing.
    for (const f of files) {
      const url = new URL(f, SCOPE).toString();
      const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(`precache failed for ${f}: ${r.status}`);
      await cache.put(url, r);
    }
    const idx = await fetch(INDEX, { credentials: "same-origin", cache: "no-store" });
    if (idx.ok) await cache.put(INDEX, idx);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("fieldkit-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});

// Hermes adds "Vary: Origin" to every response, and the app's module scripts/styles are CORS requests that carry
// an Origin header the install-time fetch did not — so a Vary-respecting lookup MISSES and the browser silently
// falls back to its evictable HTTP cache. FieldKit's own app files never vary by origin: ignore Vary for them.
const MATCH = { ignoreSearch: true, ignoreVary: true };

async function shellResponse() {
  const cache = await caches.open(SHELL);
  return (await cache.match(INDEX, MATCH)) || (await cache.match(new URL("index.html", SCOPE).toString(), MATCH)) ||
    new Response("<h1>FieldKit is not installed yet</h1><p>Open it once while online.</p>", { status: 503, headers: { "content-type": "text/html" } });
}

async function navigate(request) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3500));
  try {
    const res = await Promise.race([fetch(request), timeout]);
    if (res && res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
      (await caches.open(SHELL)).put(INDEX, res.clone());
      return res;
    }
    // 401 (expired Hermes session), redirects to login, 5xx or slow network → cached shell; the app
    // itself shows the sign-in banner when sync needs it. Data stays in IndexedDB either way.
  } catch (_) { /* offline */ }
  return shellResponse();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(SCOPE.pathname)) return; // API + dashboard: network only, never cached
    if (req.mode === "navigate") { event.respondWith(navigate(req)); return; }
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, MATCH);
      if (hit) return hit;
      try { return await fetch(req); } catch (_) { return new Response("", { status: 504 }); }
    })());
    return;
  }
  if (UPSTREAM_HOSTS.has(url.hostname)) {
    // Pinned, versioned URLs only (…@x.y.z/…), so cache-first is safe.
    event.respondWith((async () => {
      const cache = await caches.open(UPSTREAM);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // importScripts() from the OCR worker is a no-cors request → opaque response (ok === false, status 0).
      // Store those too for pinned URLs; otherwise offline OCR would depend on the evictable HTTP cache.
      if ((res.ok || res.type === "opaque") && /@\d+\.\d+\.\d+/.test(url.pathname)) await cache.put(req, res.clone());
      return res;
    })());
  }
});

self.addEventListener("sync", (event) => {
  // Background Sync (Chromium only) is an enhancement: wake any open FieldKit window to drain its queue.
  if (event.tag === "fieldkit-sync") {
    event.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage({ type: "fieldkit-sync" }))));
  }
});
