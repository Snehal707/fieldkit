// Builds the locally generated results for a completed record (shown immediately, offline).
import { db, deviceId, type Draft, type LocalRecord, type LocalResults, type Reference } from "./db";
import { cleanAnswers, summarize, text, type Workflow } from "./engine";
import { KnowledgeIndex } from "./knowledge";
import { installedPacks } from "./packs";
import { enqueueRecord } from "./sync";
import { nowIso } from "./util";

export async function buildLocalResults(wf: Workflow, answers: Record<string, unknown>, lang: string): Promise<LocalResults> {
  const s = summarize(wf, answers, lang);
  const packs = await installedPacks("knowledge");
  const idx = new KnowledgeIndex(packs);
  const references: Reference[] = [];
  const explanations: LocalResults["explanations"] = [];
  const seen = new Set<string>();
  const domainPacks = wf.knowledge_packs ?? [];
  const add = (q: string) => {
    const a = idx.ask(q, { packs, lang, domainPacks });
    if (a.supported && a.entry && !seen.has(a.entry.key)) {
      seen.add(a.entry.key);
      references.push({ pack_id: a.entry.pack_id, entry_id: a.entry.id, title: a.entry.title, source: a.entry.source, excerpt: a.excerpt });
    }
    return a;
  };
  for (const f of s.findings) add(`${f.label} ${f.detail ?? ""}`);
  const visible = new Set(Object.keys(cleanAnswers(wf, answers)));
  for (const f of wf.fields) {
    if (!f.explain_topic || !visible.has(f.id)) continue;
    const a = add(f.knowledge_query || f.explain_topic);
    if (a.supported && a.entry) explanations.push({ field_id: f.id, title: a.entry.title, text: a.excerpt ?? a.entry.text, source: a.entry.source });
  }
  return { generated_at: nowIso(), source: "local", ...s, references: references.slice(0, 8), explanations };
}

/** Turn a finished draft into a durable local record + queued sync op, in that order. */
export async function completeDraft(draft: Draft, wf: Workflow): Promise<LocalRecord> {
  const answers = cleanAnswers(wf, draft.answers);
  const local = await buildLocalResults(wf, answers, draft.lang);
  if (!local.validation.complete) throw new Error("Workflow has unanswered required questions.");
  const rec: LocalRecord = {
    id: draft.id, workflow_id: wf.id, workflow_version: wf.version ?? 1, workflow_title: text(wf.title, draft.lang),
    device_id: await deviceId(), answers, local_results: local, created_local_at: draft.started_at, completed_at: nowIso(),
    lang: draft.lang, sync_status: "local", server_revision: 0, analysis_status: "not_requested",
  };
  const d = await db();
  const tx = d.transaction(["records", "drafts"], "readwrite");
  await tx.objectStore("records").put(rec);
  await tx.objectStore("drafts").delete(draft.id);
  await tx.done;
  await enqueueRecord(rec.id);
  return rec;
}
