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
