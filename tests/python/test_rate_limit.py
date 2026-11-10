"""0.2.6 trial finding: Nous Portal answered 429 "fair-share rate limit, retry_after 1972" and FieldKit burnt all three
attempts in ~100 s, marking the reports failed. A rate limit now waits as told and keeps the record pending."""
import pytest
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fieldkit_core import analysis, db  # noqa: E402




@pytest.fixture(autouse=True)
def _review_every_record(monkeypatch):
    """These tests exercise automatic report jobs, which since 0.2.6 run only when review is switched on."""
    from fieldkit_core import db as _db
    monkeypatch.setattr(_db, "DEFAULT_AFTER_SYNC", "analyze")

class RateLimitError(Exception):
    status_code = 429


def test_rate_limited_analysis_waits_as_told_and_never_fails(tmp_path, monkeypatch):
    s = db.Store(path=str(tmp_path / "t.db"))
    wf = {"id": "w", "title": "W", "fields": [{"id": "a", "type": "text", "label": "A"}]}
    s.save_workflow(db.ALL, wf, publish=True)
    s.sync_record("alice", "k1", "dev", {"id": "rec_rl_0001", "workflow_id": "w", "workflow_version": 1, "base_revision": 0,
                                         "answers": {"a": "x"}}, auto_analyze=True)

    def busy(*_a, **_k):
        raise RateLimitError("Error code: 429 - {'status': 429, 'reason': 'rate_limited', 'retry_after': 1972}")
    monkeypatch.setattr(analysis, "analyze_record", busy)
    for _ in range(5):                                   # far more tries than max_attempts
        with s.tx() as c:
            c.execute("UPDATE jobs SET next_run_at=0")
        out = analysis.process_pending(s, llm=object())
        assert out and out[0]["status"] == "pending" and 1900 < out[0]["retry_in_s"] <= 1972
    job = s.list_jobs()[0]
    assert job["status"] == "pending" and job["attempts"] == 0 and job["next_run_at"] > time.time() + 1800
    assert "busy (rate limited)" in job["last_error"]
    assert s.get_record(db.ALL, "rec_rl_0001")["analysis_status"] == "pending"
    # Other errors still use the normal retry budget.
    monkeypatch.setattr(analysis, "analyze_record", lambda *a, **k: (_ for _ in ()).throw(ValueError("bad output")))
    with s.tx() as c:
        c.execute("UPDATE jobs SET next_run_at=0")
    assert analysis.process_pending(s, llm=object())[0]["status"] == "pending"
    assert s.list_jobs()[0]["attempts"] == 1


def test_rate_limit_delay_parsing():
    assert analysis.rate_limit_delay(RateLimitError("429 retry_after: 120")) == 120
    assert analysis.rate_limit_delay(Exception("rate limit exceeded")) == analysis.RATE_LIMIT_DEFAULT_S
    assert analysis.rate_limit_delay(Exception("retry-after: 999999 rate limit")) == analysis.RATE_LIMIT_MAX_S
    assert analysis.rate_limit_delay(Exception("timeout")) is None


def test_schema_mismatch_gets_one_corrective_retry():
    """Seen with openai/gpt-5.4-mini: an extra top-level key made Hermes reject the report; one retry with the error."""
    calls = []

    class Llm:
        def complete_structured(self, **kw):
            calls.append(kw["instructions"])
            if len(calls) == 1:
                raise ValueError("Plugin LLM structured output did not match schema: Additional properties are not allowed "
                                 "('suggested_actions' was unexpected)")
            return {"ok": True}
    assert analysis._structured_call(Llm(), {"record": {}}, [], None) == {"ok": True}
    assert len(calls) == 2 and "suggested_actions" in calls[1] and "ONLY the keys" in calls[1]

    class Broken:
        def complete_structured(self, **kw):
            raise TimeoutError("timed out")
    import pytest
    with pytest.raises(TimeoutError):
        analysis._structured_call(Broken(), {"record": {}}, [], None)
