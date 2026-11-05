"""Contract tests for ModelPolicyStore and the model reference rules (P4.1)."""

import pytest
from pydantic import ValidationError

from agentic_platform.stores import (
    AgentFallback,
    InMemoryModelPolicyStore,
    ModelAllowlist,
    MongoModelPolicyStore,
    OrgModelSettings,
    model_key,
    model_matches,
    valid_model_ref,
)

from .test_stores import backend  # noqa: F401


@pytest.fixture
def policy(backend):  # noqa: F811
    return InMemoryModelPolicyStore() if backend is None else MongoModelPolicyStore(backend)


def test_references_accept_provider_model_and_provider_wildcards_only():
    for ok in ("openai/gpt-5", "bedrock/in.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock/arn:aws/x", "groq/*"):
        assert valid_model_ref(ok), ok
    for bad in ("", "gpt-5", "/gpt", "openai/", "open ai/gpt", "openai/gp t", "*/gpt", "openai/gpt*", "a" * 201 + "/x", "*"):
        assert not valid_model_ref(bad), bad
    assert model_key("bedrock", "in.x:0") == "bedrock/in.x:0"


def test_matching_is_exact_or_a_provider_wildcard():
    assert model_matches("openai/gpt-5", "openai/gpt-5")
    assert not model_matches("openai/gpt-5", "openai/gpt-5-mini")
    assert model_matches("openai/*", "openai/gpt-5") and not model_matches("openai/*", "openai2/gpt-5")
    assert not model_matches("openai/*", "groq/x") and not model_matches("openai/*", "openai")


def test_settings_default_to_the_whole_catalog_and_no_fallback(policy):
    org = policy.get_org()
    assert org.catalog is None and org.fallback_model is None


def test_org_settings_round_trip_and_are_validated(policy):
    policy.set_org(OrgModelSettings(catalog=["openai/gpt-5", "groq/*", "openai/gpt-5"], fallback_model="groq/llama", updated_by="root"))
    got = policy.get_org()
    assert got.catalog == ["openai/gpt-5", "groq/*"]  # de-duplicated, order kept
    assert got.fallback_model == "groq/llama" and got.updated_by == "root"
    with pytest.raises(ValidationError):
        OrgModelSettings(catalog=["nonsense"])
    with pytest.raises(ValidationError):
        OrgModelSettings(fallback_model="groq/*")  # one model, not a family


def test_allowlists_per_team_and_user_are_independent(policy):
    t = ModelAllowlist(id="team:A", scope_type="team", scope_id="A", models=["openai/*"], set_by="root")
    u = ModelAllowlist(id="user:A", scope_type="user", scope_id="A", models=["groq/x"], set_by="root")  # same id value, other kind
    policy.set_allowlist(t)
    policy.set_allowlist(u)
    assert policy.get_allowlist("team", "A").models == ["openai/*"]
    assert policy.get_allowlist("user", "A").models == ["groq/x"]
    assert policy.get_allowlist("team", "B") is None
    assert [a.id for a in policy.list_allowlists()] == ["team:A", "user:A"]
    assert [a.id for a in policy.list_allowlists("user")] == ["user:A"]
    policy.set_allowlist(t.model_copy(update={"models": []}))  # an empty list means "no model", and is kept
    assert policy.get_allowlist("team", "A").models == []
    assert policy.delete_allowlist("team", "A") is True and policy.delete_allowlist("team", "A") is False
    assert policy.get_allowlist("user", "A") is not None


def test_allowlist_validation():
    with pytest.raises(ValidationError):
        ModelAllowlist(id="team:A", scope_type="team", scope_id="A", models=["bad"], set_by="r")
    with pytest.raises(ValidationError):
        ModelAllowlist(id="team:B", scope_type="team", scope_id="A", models=[], set_by="r")
    with pytest.raises(ValidationError):
        ModelAllowlist(id="org:A", scope_type="org", scope_id="A", models=[], set_by="r")


def test_agent_fallbacks(policy):
    f = AgentFallback(id=AgentFallback.make_id("p1", "a"), project_id="p1", agent_id="a", model="groq/llama", set_by="o")
    policy.set_agent_fallback(f)
    policy.set_agent_fallback(f.model_copy(update={"id": AgentFallback.make_id("p1", "b"), "agent_id": "b"}))
    policy.set_agent_fallback(f.model_copy(update={"id": AgentFallback.make_id("p2", "a"), "project_id": "p2"}))
    assert policy.get_agent_fallback("p1", "a") == f and policy.get_agent_fallback("p1", "zz") is None
    assert policy.delete_for_project("p1") == 2 and policy.get_agent_fallback("p1", "a") is None
    assert policy.get_agent_fallback("p2", "a") is not None
    assert policy.delete_agent_fallback("p2", "a") is True and policy.delete_agent_fallback("p2", "a") is False
    with pytest.raises(ValidationError):
        AgentFallback(id="p:a", project_id="p", agent_id="a", model="groq/*", set_by="o")
