// The offline assistant's vector cache. (The 0.2.5 learning-event queue was removed in 0.2.6; its IndexedDB store is
// kept so existing installs upgrade cleanly.)
import { db } from "./db";

/** Vector cache for the assistant (kept per model; cleared with site data). */
export function vectorCache(model: string) {
  return {
    async get(k: string) { return (await (await db()).get("vectors", `${model}|${k}`))?.vec; },
    async put(k: string, vec: number[]) { await (await db()).put("vectors", { key: `${model}|${k}`, vec }); },
  };
}
