// How this browser treats FieldKit's on-device data, in plain language.
//
// Facts (WebKit "Updates to Storage Policy", Safari 17 / iOS 17; Storage API spec):
// * By default every site is "best-effort": data stays on the device but the browser MAY clear it when the device
//   is very low on space or the site has not been used for a long time (least-recently-used first). A site with an
//   open page is never cleared.
// * navigator.storage.persist() asks the browser to exempt FieldKit from that automatic clean-up. The BROWSER decides
//   (WebKit uses heuristics such as being opened as a Home Screen web app); "declined" is common on iPhone and is
//   not an error. Even when granted, the user can still delete data.
// * A Home Screen web app has the same storage quota as the site in Safari; installing does not guarantee
//   permanent storage.
export type StorageKind = "unsupported" | "protected" | "best-effort";

export interface StorageState {
  kind: StorageKind;
  usage?: number;
  quota?: number;
  standalone: boolean;  // opened as an installed (Home Screen) app
}

export interface StorageMessage {
  label: string;        // short status
  detail: string;       // one or two calm sentences
  tone: "ok" | "info";  // never "error": best-effort storage is normal, not a failure
  canRequest: boolean;  // offer the "Ask to protect" button
}

export function isStandalone(): boolean {
  try {
    return (navigator as any).standalone === true || matchMedia("(display-mode: standalone)").matches;
  } catch { return false; }
}

export async function storageState(): Promise<StorageState> {
  const standalone = isStandalone();
  const s: any = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!s || typeof s.persisted !== "function") return { kind: "unsupported", standalone };
  let est: { usage?: number; quota?: number } = {};
  try { est = (await s.estimate?.()) ?? {}; } catch { /* optional */ }
  let persisted = false;
  try { persisted = !!(await s.persisted()); } catch { /* treat as best-effort */ }
  return { kind: persisted ? "protected" : "best-effort", usage: est.usage, quota: est.quota, standalone };
}

/** Ask the browser to protect FieldKit's data. Returns the resulting kind (never throws). */
export async function requestProtection(): Promise<StorageKind> {
  const s: any = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!s || typeof s.persist !== "function") return "unsupported";
  try { return (await s.persist()) ? "protected" : "best-effort"; } catch { return "best-effort"; }
}

export function storageMessage(st: StorageState): StorageMessage {
  if (st.kind === "protected") {
    return { label: "Protected", tone: "ok", canRequest: false,
      detail: "This browser has agreed not to clear FieldKit's data automatically. You can still delete it yourself." };
  }
  if (st.kind === "unsupported") {
    return { label: "Standard storage", tone: "info", canRequest: false,
      detail: "This browser doesn't offer storage protection. Your records stay on this device; sync when you can and use Export data for an extra backup." };
  }
  return { label: "Standard storage (not protected)", tone: "info", canRequest: true,
    detail: "Your records stay on this device and are kept until they sync. The browser decides whether to protect site data — "
      + "on iPhone it often doesn't, and that's normal. It may only clear data from sites that haven't been used for a long "
      + "time or when the phone is almost out of space. Open FieldKit and sync regularly, and use Export data for an extra backup."
      + (st.standalone ? "" : " Opening FieldKit from the Home Screen makes protection more likely (not guaranteed).") };
}

/** Message after the user pressed "Ask to protect". */
export function requestOutcome(kind: StorageKind): { text: string; tone: "ok" | "info" } {
  if (kind === "protected") return { text: "Storage protected: the browser won't clear FieldKit's data automatically.", tone: "ok" };
  if (kind === "unsupported") return { text: "This browser doesn't offer storage protection. Your data is still saved on this device.", tone: "info" };
  return { text: "The browser kept standard storage (common on iPhone). Your records are still saved on this device — keep syncing regularly.", tone: "info" };
}

// ------------------------------------------------------------------ language names
export function languageLabel(code: string, uiLang = "en"): string {
  const base = code.split(/[-_]/)[0].toLowerCase();
  try {
    const dn = new (Intl as any).DisplayNames([uiLang], { type: "language" });
    return dn.of(code.replace("_", "-")) || dn.of(base) || code;
  } catch { return code; }
}
