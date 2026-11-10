// The workspace's offline summary is pure counting over entries stored on the phone.
import { describe, expect, it } from "vitest";
import { summarizeLocal } from "../../app/src/workspace";

describe("offline workspace summary", () => {
  it("counts entries, today's, unfinished and waiting to sync, for this workspace only", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const recs = [
      { workflow_id: "a", completed_at: "2026-11-10T08:00:00Z", sync_status: "pending" },
      { workflow_id: "a", completed_at: "2026-11-09T08:00:00Z", sync_status: "synced" },
      { workflow_id: "b", completed_at: "2026-11-10T09:00:00Z", sync_status: "synced" },
      { workflow_id: "a", completed_at: "2026-11-10T10:00:00Z", sync_status: "received" },
    ];
    const s = summarizeLocal(["a"], recs, [{ workflow_id: "a" }, { workflow_id: "b" }], now);
    expect(s).toEqual({ total: 3, today: 2, unfinished: 1, waiting: 1, latest: "2026-11-10T10:00:00Z" });
    expect(summarizeLocal(["z"], recs, [], now)).toMatchObject({ total: 0, unfinished: 0 });
  });
});
