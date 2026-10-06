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
