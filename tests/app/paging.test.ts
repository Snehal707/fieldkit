// Loading every record of an account with more than 500 records (the server sends at most 500 per request).
import { describe, expect, it } from "vitest";
import { fetchAllRecords, missingOnServer, type RecordPage, type ServerLike } from "../../app/src/device";

const recs = (n: number, prefix = "rec_") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(n - i).padStart(5, "0")}`, workflow_id: "f" }));

/** A server with paging, like FieldKit 0.3.1: newest first, total and next_offset. */
function server(all: ServerLike[]) {
  const calls: string[] = [];
  const get = async (path: string): Promise<RecordPage> => {
    calls.push(path);
    const q = new URLSearchParams(path.split("?")[1]);
    const limit = Number(q.get("limit")), offset = Number(q.get("offset") ?? 0);
    const page = all.slice(offset, offset + limit);
    return { records: page, total: all.length, next_offset: offset + page.length < all.length ? offset + page.length : null };
  };
  return { get, calls };
}

describe("loading every record", () => {
  it("reads all 1234 records in pages of 500, in order, complete", async () => {
    const all = recs(1234);
    const s = server(all);
    const out = await fetchAllRecords(s.get);
    expect(out.complete).toBe(true);
    expect(out.total).toBe(1234);
    expect(out.records.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(s.calls).toEqual(["records?limit=500&offset=0", "records?limit=500&offset=500", "records?limit=500&offset=1000"]);
  });

  it("a record arriving while paging is not lost or doubled", async () => {
    const all = recs(1100);
    const s = server(all);
    let first = true;
    const out = await fetchAllRecords(async (p) => {
      const page = await s.get(p);
      if (first) { first = false; all.unshift({ id: "rec_new_arrival", workflow_id: "f" }); }   // shifts later pages by one
      return page;
    });
    const ids = out.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of all.filter((x) => x.id !== "rec_new_arrival")) expect(ids).toContain(r.id);
    expect(out.complete).toBe(true);
  });

  it("an older server without paging gives one page, complete only if it was not full", async () => {
    const old = (n: number) => async (): Promise<RecordPage> => ({ records: recs(n).slice(0, 500) });
    expect(await fetchAllRecords(old(320))).toMatchObject({ complete: true, total: 320 });
    expect(await fetchAllRecords(old(900))).toMatchObject({ complete: false, total: 500 });
  });

  it("stops (incomplete) instead of looping when a server makes no progress", async () => {
    const stuck = async (): Promise<RecordPage> => ({ records: recs(500), total: 5000, next_offset: 500 });
    const out = await fetchAllRecords(stuck);
    expect(out.complete).toBe(false);
    expect(out.records).toHaveLength(500);
  });

  it("missing-on-Hermes is only reported from a complete list", () => {
    const local = [{ id: "rec_00001", workflow_title: "F", completed_at: "", sync_status: "synced" }];
    expect(missingOnServer(local, [], false)).toEqual([]);
    expect(missingOnServer(local, [], true)).toHaveLength(1);
    expect(missingOnServer(local, ["rec_00001"], true)).toEqual([]);
  });
});
