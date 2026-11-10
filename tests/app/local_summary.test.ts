// 0.2.6: the workspace's offline summary is pure counting over records stored on the phone.
import { describe, expect, it } from "vitest";
import { summarizeLocal } from "../../app/src/workspace";

describe("offline workspace summary", () => {
  it("counts records, today's, flagged by worst severity, unfinished and waiting to sync, for this workspace only", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const recs = [
      { workflow_id: "a", completed_at: "2026-11-10T08:00:00Z", sync_status: "pending", local_results: { findings: [{ severity: "high" }, { severity: "low" }] } },
      { workflow_id: "a", completed_at: "2026-11-09T08:00:00Z", sync_status: "synced", report_id: "rep1", local_results: { findings: [] } },
      { workflow_id: "b", completed_at: "2026-11-10T09:00:00Z", sync_status: "synced", local_results: { findings: [{ severity: "critical" }] } },
      { workflow_id: "a", completed_at: "2026-11-10T10:00:00Z", sync_status: "received", local_results: { findings: [{ severity: "info" }] } },
    ];
    const s = summarizeLocal(["a"], recs, [{ workflow_id: "a" }, { workflow_id: "b" }], now);
    expect(s).toMatchObject({ total: 3, today: 2, flagged: 1, bySeverity: { high: 1 }, unfinished: 1, waiting: 1, reports: 1 });
    expect(s.latest).toBe("2026-11-10T10:00:00Z");
    expect(summarizeLocal(["z"], recs, [], now)).toMatchObject({ total: 0, flagged: 0, unfinished: 0 });
  });
});
