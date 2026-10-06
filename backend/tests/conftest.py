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
