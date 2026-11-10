// Questions about one visit (0.2.6). Asked online or offline, queued on this phone with their record, workspace and
// photos; sent after the record syncs; answered by Hermes from that record's evidence; the answer comes back to the
// same visit and stays readable offline. Case-specific: never a workspace rule.
import { api, AuthRequired } from "./api";
import { db, type LocalQuestion } from "./db";
import { workspaceForEntry } from "./workspace";
import { nowIso, uuid } from "./util";

export const SUGGESTED_QUESTIONS: Record<string, string[]> = {
  en: ["What should I do next?", "What do the photos show?", "Is anything missing or unusual in this visit?",
    "How does this compare with the last visit?"],
  hi: ["अब मुझे क्या करना चाहिए?", "फोटो में क्या दिख रहा है?", "इस मुलाकात में कुछ छूटा या असामान्य है?", "पिछली मुलाकात से तुलना कैसी है?"],
};


/** Queue a question about a saved record (works offline). */
export async function askAboutRecord(recordId: string, question: string, lang: string): Promise<LocalQuestion> {
  const d = await db();
  const rec = await d.get("records", recordId);
  if (!rec) throw new Error("This visit is not saved on this phone.");
  const text = question.trim();
  if (!text) throw new Error("Write a question first.");
  const photos = (await d.getAllFromIndex("attachments", "by_record", recordId)).filter((a) => a.kind === "photo").map((a) => a.id);
  const q: LocalQuestion = { id: uuid("q"), record_id: recordId, workspace_id: rec.workspace_id ?? await workspaceForEntry(rec.workflow_id), question: text.slice(0, 1000),
    lang, attachment_ids: photos, status: "queued", created_at: nowIso() };
  await d.put("questions", q);
  return q;
}

export async function questionsFor(recordId: string): Promise<LocalQuestion[]> {
  const d = await db();
  return (await d.getAllFromIndex("questions", "by_record", recordId)).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** "Ask again" for a question Hermes could not answer: queued again on this phone (works offline). */
export async function askAgain(id: string): Promise<void> {
  const d = await db();
  const q = await d.get("questions", id);
  if (q && q.status === "failed") await d.put("questions", { ...q, status: "queued", retry: true, error: undefined });
}

/** Sync step: send queued questions whose record Hermes already has, then fetch answers. Returns how many changed. */
export async function syncQuestions(): Promise<number> {
  const d = await db();
  const all = await d.getAll("questions");
  let changed = 0;
  for (const q of all.filter((x) => x.status === "queued")) {
    const rec = await d.get("records", q.record_id);
    if (!rec || !["synced", "received"].includes(rec.sync_status)) continue;      // the visit must reach Hermes first
    try {
      await api(`records/${encodeURIComponent(q.record_id)}/questions`, { method: "POST",
        json: { id: q.id, question: q.question, lang: q.lang, workspace_id: q.workspace_id, attachment_ids: q.attachment_ids,
          ...(q.retry ? { retry: true } : {}) } });
      await d.put("questions", { ...q, status: "sent", sent_at: nowIso(), error: undefined, retry: undefined });
      changed++;
    } catch (e) {
      if (e instanceof AuthRequired) throw e;
      await d.put("questions", { ...q, error: (e as Error).message.slice(0, 200) });
    }
  }
  const waiting = new Set((await d.getAll("questions")).filter((x) => x.status === "sent").map((x) => x.record_id));
  for (const rid of waiting) {
    const res = await api<{ questions: any[] }>(`records/${encodeURIComponent(rid)}/questions`);
    for (const sq of res.questions ?? []) {
      const local = await d.get("questions", sq.id);
      if (!local) continue;
      if (sq.status === "answered" && sq.answer && local.status !== "answered") {
        await d.put("questions", { ...local, status: "answered", answer: sq.answer, answered_at: nowIso(), error: undefined });
        changed++;
      } else if (sq.status === "failed" && local.status !== "failed") {
        await d.put("questions", { ...local, status: "failed", error: sq.error ?? "Hermes could not answer" });
        changed++;
      } else if (sq.error && sq.status === "queued" && local.error !== sq.error) {
        await d.put("questions", { ...local, error: sq.error });   // e.g. "model busy, retrying in 20 min"
      }
    }
  }
  return changed;
}
