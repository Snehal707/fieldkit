// Learning events queued on the phone for Hermes (0.2.5): unanswered offline questions (knowledge gaps), feedback on
// answers and reports, and verified outcomes from follow-up checks. Synced by sync.ts; Hermes keeps them separate
// (an AI suggestion, a user's opinion and a verified outcome are different kinds of evidence).
import { db, type LearningEvent } from "./db";
import { nowIso, uuid } from "./util";

export async function logEvent(kind: LearningEvent["kind"], payload: Record<string, unknown>,
  opts: { workspace_id?: string; ref_type?: string; ref_id?: string } = {}): Promise<LearningEvent> {
  const ev: LearningEvent = { id: uuid("lev"), kind, payload, created_at: nowIso(), sent: 0, idempotency_key: uuid("lik"), ...opts };
  await (await db()).put("learning", ev);
  return ev;
}

export async function pendingEvents(): Promise<LearningEvent[]> {
  return (await db()).getAllFromIndex("learning", "by_sent", 0);
}

export async function markSent(ids: string[]): Promise<void> {
  const d = await db();
  const tx = d.transaction("learning", "readwrite");
  for (const id of ids) {
    const ev = await tx.store.get(id);
    if (ev) await tx.store.put({ ...ev, sent: 1 });
  }
  await tx.done;
}

/** Vector cache for the assistant (kept per model; cleared with site data). */
export function vectorCache(model: string) {
  return {
    async get(k: string) { return (await (await db()).get("vectors", `${model}|${k}`))?.vec; },
    async put(k: string, vec: number[]) { await (await db()).put("vectors", { key: `${model}|${k}`, vec }); },
  };
}
