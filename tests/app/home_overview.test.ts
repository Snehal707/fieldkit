// Home's compact overview: which workspace is "current", and what "Recent activity" lists. Pure, offline logic.
import { describe, expect, it } from "vitest";
import { pickCurrent, recentActivity } from "../../app/src/workspace";

const ws = (id: string, starter = false) => ({ manifest: { workspace_id: id, starter } });

describe("current workspace", () => {
  it("is the one last opened while it is still on the phone", () => {
    expect(pickCurrent([ws("a"), ws("b")], "b")?.manifest.workspace_id).toBe("b");
  });
  it("falls back to an own workspace before the example, and to the example when it is the only one", () => {
    expect(pickCurrent([ws("starter", true), ws("mine")], "removed")?.manifest.workspace_id).toBe("mine");
    expect(pickCurrent([ws("starter", true)], "")?.manifest.workspace_id).toBe("starter");
  });
  it("is none when no workspace is installed", () => {
    expect(pickCurrent([], "a")).toBeNull();
  });
});

describe("recent activity", () => {
  const rec = (id: string, at: string, sync_status = "synced") => ({ id, workflow_id: "f", completed_at: at, sync_status });
  const draft = (id: string, at: string) => ({ id, workflow_id: "f", started_at: at, updated_at: at });

  it("lists unfinished entries first, then the newest saved entries, with their sync state", () => {
    const out = recentActivity([rec("r1", "2026-11-10T08:00:00Z"), rec("r2", "2026-11-10T09:00:00Z", "pending")],
      [draft("d1", "2026-11-09T07:00:00Z")]);
    expect(out.map((a) => [a.id, a.state, a.href])).toEqual([
      ["d1", "draft", "#/run/d1"], ["r2", "waiting", "#/results/r2"], ["r1", "synced", "#/results/r1"]]);
  });
  it("caps saved entries at the limit but never hides an unfinished one", () => {
    const recs = Array.from({ length: 8 }, (_, i) => rec(`r${i}`, `2026-11-10T0${i}:00:00Z`));
    expect(recentActivity(recs, [], 5)).toHaveLength(5);
    const drafts = Array.from({ length: 7 }, (_, i) => draft(`d${i}`, `2026-11-10T0${i}:00:00Z`));
    expect(recentActivity(recs, drafts, 5)).toHaveLength(7);
  });
  it("never calls a record synced while its files are still uploading (matches the header and Pending Sync)", () => {
    expect(recentActivity([rec("r", "2026-11-10T08:00:00Z", "received")], [])[0].state).toBe("uploading");
    for (const s of ["pending", "syncing", "error", "conflict"]) expect(recentActivity([rec("r", "2026-11-10T08:00:00Z", s)], [])[0].state).toBe("waiting");
  });
});
