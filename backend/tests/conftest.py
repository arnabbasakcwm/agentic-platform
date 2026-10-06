"""Suite-wide fixtures. The suite is offline: nothing here may reach a real cloud service."""

import pytest

import agentic_platform.bedrock_catalog as bedrock_catalog


@pytest.fixture(autouse=True)
def _no_live_bedrock_catalog(monkeypatch):
    """The Bedrock model catalog is read live from AWS; with real credentials in .env that
    would make every /providers call a network call. Tests get an empty catalog unless
    they install their own."""
    monkeypatch.setattr(bedrock_catalog, "_fetch", lambda session=None: [])
    bedrock_catalog._cache.update(at=0.0, models=[])
    yield
    bedrock_catalog._cache.update(at=0.0, models=[])


@pytest.fixture(autouse=True)
def _no_live_bigquery(monkeypatch):
    """BigQuery is reached by federating the platform's AWS identity, and .env holds real
    settings: a test that forgot to install a fake client must fail, not call Google."""
    import agentic_platform.app as app_module
    import agentic_platform.datasources as datasources

    def offline(*args, **kwargs):
        raise RuntimeError("the offline suite must not sign in to Google; install a fake BigQuery client")

    monkeypatch.setattr(datasources, "gcp_credentials", offline)
    app_module._BQ_CLIENTS.clear()
    yield
    app_module._BQ_CLIENTS.clear()


@pytest.fixture(autouse=True)
def _runs_in_memory(monkeypatch):
    """Saved runs never reach a real database from the offline suite (.env may point at
    one): every test gets its own in-memory run store."""
    import agentic_platform.app as app_module
    from agentic_platform.stores import InMemoryRunStore

    monkeypatch.setattr(app_module, "_runs", InMemoryRunStore())


@pytest.fixture(autouse=True)
def _no_live_model_checks(monkeypatch):
    """Tool-calling checks call the real model and are stored platform-wide: the offline
    suite gets an in-memory store and a check that can't tell (tests that need a verdict
    install their own)."""
    import agentic_platform.app as app_module
    import agentic_platform.capabilities as caps
    from agentic_platform.stores import InMemoryModelCapabilityStore

    monkeypatch.setattr(app_module, "_capabilities", InMemoryModelCapabilityStore())
    monkeypatch.setattr(caps, "probe_tool_calling", lambda provider, model, usage=None: None)
