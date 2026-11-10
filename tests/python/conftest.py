import pytest


@pytest.fixture(autouse=True)
def _fresh_source_page_cache():
    """Source pages fetched for the excerpt check are cached per process; tests must not see each other's pages."""
    from fieldkit_core import workspace as ws
    ws._MEM.clear()
    ws._INFLIGHT.clear()
    yield
    ws._MEM.clear()
    ws._INFLIGHT.clear()


@pytest.fixture(autouse=True)
def _isolated_hermes_home(tmp_path_factory, monkeypatch):
    """Code that asks Hermes for its configuration (e.g. whether auxiliary.fieldkit_vision is set) must read an empty
    test home, never the developer's ~/.hermes."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path_factory.mktemp("hermes-home")))
    monkeypatch.delenv("FIELDKIT_VISION_TASK", raising=False)
    yield
