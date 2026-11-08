import "./style.css";
import { takeReturn } from "./config";
import { refreshPending, onSyncState, restoreAuthFlag, startAutoSync, registerBackgroundSync, clearAuthRequired, getSyncState } from "./sync";
import { clear, h, isOnline, toast } from "./util";
import {
  authBanner, homeView, recordsView, reportsView, resultsView, runView, syncView, workflowLinkView, workflowsView, whoAmI, type View,
} from "./views_core";
import { assistantView, dictionaryView, knowledgeView, ocrView, packsView, settingsView, translateView } from "./views_tools";

const routes: [RegExp, View, string][] = [
  [/^#?\/?$/, homeView, "Home"],
  [/^#\/workflows$/, workflowsView, "My Workflows"],
  [/^#\/workflow\/(?<id>[^/?]+)/, workflowLinkView, "Workflow"],
  [/^#\/run\/(?<id>[^/?]+)/, runView, "Workflow"],
  [/^#\/results\/(?<id>[^/?]+)/, resultsView, "Results"],
  [/^#\/records/, recordsView, "Saved Records"],
  [/^#\/sync/, syncView, "Pending Sync"],
  [/^#\/reports/, reportsView, "Reports"],
  [/^#\/assistant/, assistantView, "Offline Assistant"],
  [/^#\/knowledge\/(?<key>[^?]+)/, knowledgeView, "Knowledge"],
  [/^#\/knowledge/, knowledgeView, "Knowledge"],
  [/^#\/dictionary/, dictionaryView, "Dictionary"],
  [/^#\/translate/, translateView, "Translate"],
  [/^#\/ocr/, ocrView, "Scan text"],
  [/^#\/packs/, packsView, "Offline Packs"],
  [/^#\/settings/, settingsView, "Settings"],
];

const app = document.getElementById("app")!;
const title = h("h1", null, "FieldKit");
const net = h("span", { class: "pill" });
const queue = h("span", { class: "pill" });
const main = h("main");
const navItems: [string, string, string][] = [["#/", "⌂", "Home"], ["#/workflows", "☑", "Workflows"], ["#/assistant", "?", "Assistant"], ["#/sync", "⇅", "Sync"], ["#/settings", "⚙", "Settings"]];
const nav = h("nav", { class: "bottom" }, ...navItems.map(([href, icon, label]) => h("a", { href }, h("span", null, icon), label)));
const authSlot = h("div", { style: "max-width:720px;margin:0 auto;padding:0 1rem" });
clear(app);
app.append(h("header", { class: "top" }, title, queue, net), authSlot, main, nav);
let authShown = false;
onSyncState((s) => {
  // App-wide: the moment a protected request returns 401, show sign-in — on whatever screen is open.
  if (s.auth_required !== authShown) {
    authShown = s.auth_required;
    clear(authSlot);
    if (s.auth_required) authSlot.append(h("div", { style: "padding-top:1rem" }, authBanner()));
  }
});

function paintNet() {
  net.textContent = isOnline() ? "● online" : "○ offline";
}
window.addEventListener("online", paintNet);
window.addEventListener("offline", paintNet);
paintNet();
onSyncState((s) => { queue.textContent = s.running ? "syncing…" : s.auth_required ? "sign-in needed" : `${s.pending} queued`; });

async function route() {
  const hash = location.hash || "#/";
  for (const [re, view, name] of routes) {
    const m = hash.match(re);
    if (m) {
      title.textContent = name === "Home" ? "FieldKit" : name;
      for (const a of nav.querySelectorAll("a")) a.classList.toggle("on", a.getAttribute("href") === (hash.split("?")[0] || "#/"));
      clear(main);
      try { await view(main, (m.groups ?? {}) as Record<string, string>); }
      catch (e) { main.append(h("div", { class: "banner bad" }, `Something went wrong: ${(e as Error).message}`)); console.error(e); }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = "#/";
}
window.addEventListener("hashchange", route);

async function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: new URL("../", import.meta.url).pathname });
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) {
          const bar = h("div", { class: "banner hermes", style: "position:fixed;left:1rem;right:1rem;bottom:76px;z-index:20" },
            "A new FieldKit version is ready. ", h("button", { class: "primary", onclick: () => { w.postMessage({ type: "skip-waiting" }); } }, "Reload"));
          document.body.appendChild(bar);
        }
      });
    });
    // Reload only when an existing worker is replaced by an update — not on first install/claim.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  } catch (e) {
    console.warn("Service worker registration failed", e);
  }
}

(async () => {
  await restoreAuthFlag();
  await refreshPending();
  // Back from Hermes sign-in (via dashboard-plugins/fieldkit/return.html): reopen the screen the user left.
  const back = takeReturn();
  if (back && (location.hash || "#/") === "#/") history.replaceState(null, "", back);
  await route();
  await registerSw();
  if (isOnline()) {
    // A successful /me clears the paused-sync flag; the screen re-renders with fresh signed-in state.
    const me = await whoAmI();
    if (me && getSyncState().auth_required) { await clearAuthRequired(); await route(); }
    if (me && back) toast(`Signed in as ${me.display_name || me.user_id}`, "ok");
    try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  }
  startAutoSync();
  void registerBackgroundSync();
  if (!isOnline()) toast("Offline mode — everything you need is on this device.");
})();
