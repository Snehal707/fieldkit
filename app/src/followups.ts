// Follow-up verification (0.2.5): a report's checks ("vibration below 4.5 mm/s after alignment") are asked on the next
// inspection of the same subject (asset, farm, class…), and the answers travel with the new record so Hermes can tell
// verified outcomes from suggestions.
import { db, type Draft } from "./db";
import type { Workflow } from "./engine";

export interface FollowupCheck { id: string; what: string; how: string; result?: "done" | "not_done" | "cannot_check"; value?: string;
  report_id: string; record_id: string; asked_at?: string }

/** The record's subject: the first short text field (an asset id, farm or class name). */
export function subjectField(wf: Workflow): string | undefined {
  return wf.fields.find((f) => f.type === "text")?.id;
}

function checksFrom(report: any, recordId: string): FollowupCheck[] {
  const rid = report?.report_id ?? "";
  const out: FollowupCheck[] = [];
  (report?.follow_up_verification ?? []).forEach((c: any, i: number) =>
    out.push({ id: `fc_${rid}_v${i}`, what: String(c.what ?? ""), how: String(c.how ?? ""), report_id: rid, record_id: recordId }));
  (report?.next_actions ?? []).forEach((a: any, i: number) => {
    if (a?.verify_by) out.push({ id: `fc_${rid}_a${i}`, what: String(a.action ?? ""), how: String(a.verify_by), report_id: rid, record_id: recordId });
  });
  return out.filter((c) => c.what || c.how);
}

/** Checks from the latest report for the same workflow and subject, on this device or in a downloaded copy. */
export async function previousChecks(wf: Workflow, answers: Record<string, unknown>, excludeRecord?: string):
  Promise<{ date: string; checks: FollowupCheck[]; subject: string } | null> {
  const fid = subjectField(wf);
  const subject = fid ? String(answers[fid] ?? "").trim().toLowerCase() : "";
  if (!subject) return null;
  const d = await db();
  const candidates: { date: string; report: any; record: string }[] = [];
  for (const r of await d.getAll("records")) {
    if (r.id === excludeRecord || r.workflow_id !== wf.id || String(r.answers?.[fid!] ?? "").trim().toLowerCase() !== subject) continue;
    const rep = (await d.get("reports", r.id))?.report;
    if (rep) candidates.push({ date: r.completed_at ?? "", report: rep, record: r.id });
  }
  for (const c of await d.getAll("remote")) {
    if (c.id === excludeRecord || c.workflow_id !== wf.id || !c.report) continue;
    if (String((c.answers as any)?.[fid!] ?? "").trim().toLowerCase() === subject) candidates.push({ date: c.completed_at ?? "", report: c.report, record: c.id });
  }
  candidates.sort((a, b) => b.date.localeCompare(a.date));
  for (const c of candidates) {
    const checks = checksFrom(c.report, c.record);
    if (checks.length) return { date: c.date, checks, subject };
  }
  return null;
}

export function setCheck(draft: Draft, check: FollowupCheck, patch: Partial<FollowupCheck>): void {
  const list = draft.followup_checks ?? [];
  const i = list.findIndex((x) => x.id === check.id);
  const next = { ...check, ...(i >= 0 ? list[i] : {}), ...patch, asked_at: new Date().toISOString() };
  if (i >= 0) list[i] = next; else list.push(next);
  draft.followup_checks = list;
}
