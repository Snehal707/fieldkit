"""Accounts with more than 500 records: the list API pages through every record (stable order, exact total), stays
per-account, and Hermes' record tool searches all of them, not only the newest 500."""
import json

from fieldkit_core import tools
from test_api import PREFIX, H, _install, env  # noqa: F401  (fixture)

N = 1234


def _bulk(env, owner="alice", n=N, wf="equipment-inspection"):
    rows = []
    for i in range(n):
        # every 7 records share one received_at, so the id tie-breaker matters for stable pages
        rows.append((f"rec_bulk_{owner}_{i:05d}", owner, "dev_bulk", wf, 1, 1, json.dumps({"asset_id": f"BLK-{i:04d}"}),
                     "{}", f"h{i}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 1_700_000_000 + i // 7, 0, "complete"))
    with env.store.tx() as c:   # one transaction (row-by-row autocommit is slow on Windows)
        c.executemany(
            "INSERT INTO records(id, owner_user_id, device_id, workflow_id, workflow_version, revision, answers, local_results, "
            "content_hash, created_local_at, completed_at, received_at, updated_at, sync_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)


def _all_pages(env, user="alice", limit=500):
    ids, offset, pages = [], 0, 0
    while offset is not None:
        body = env.client.get(f"{PREFIX}/records?limit={limit}&offset={offset}", headers=H(user)).json()
        ids += [r["id"] for r in body["records"]]
        total, offset, pages = body["total"], body["next_offset"], pages + 1
    return ids, total, pages


def test_every_record_is_reachable_page_by_page(env):
    _install(env)
    _bulk(env)
    ids, total, pages = _all_pages(env)
    assert total == N and len(ids) == N and len(set(ids)) == N           # all of them, no repeats, no gaps
    assert pages == 3                                                      # 500 + 500 + 234
    assert ids[0] == f"rec_bulk_alice_{N - 1:05d}"                         # newest first
    ids_small, _, _ = _all_pages(env, limit=97)                            # any page size gives the same list
    assert ids_small == ids


def test_first_page_still_works_for_older_phones(env):
    _install(env)
    _bulk(env)
    body = env.client.get(f"{PREFIX}/records?limit=500", headers=H()).json()
    assert len(body["records"]) == 500 and body["total"] == N and body["next_offset"] == 500
    assert env.client.get(f"{PREFIX}/records?limit=501", headers=H()).status_code == 422
    assert env.client.get(f"{PREFIX}/records?offset=-1", headers=H()).status_code == 422


def test_paging_is_per_account(env):
    _install(env)
    _bulk(env, "alice")
    _bulk(env, "bob", 600)
    a_ids, a_total, _ = _all_pages(env, "alice")
    b_ids, b_total, _ = _all_pages(env, "bob")
    assert (a_total, b_total) == (N, 600)
    assert all("_alice_" in i for i in a_ids) and all("_bob_" in i for i in b_ids)
    assert env.client.get(f"{PREFIX}/records?limit=500&offset=0", headers=H("carol")).json() == {"records": [], "total": 0, "next_offset": None}


def test_hermes_tool_finds_a_subject_older_than_the_newest_500(env):
    _install(env)
    _bulk(env)
    out = json.loads(tools.handler_for("fieldkit_list_records")({"subject": "BLK-0003"}))
    assert out["ok"] and [r["id"] for r in out["records"]] == ["rec_bulk_alice_00003"]
    many = json.loads(tools.handler_for("fieldkit_list_records")({"limit": 500}))
    assert many["count"] == 500
