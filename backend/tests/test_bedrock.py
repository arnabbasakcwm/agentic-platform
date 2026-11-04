"""Amazon Bedrock models: the live catalog, the chat provider, embeddings with their own
vector sizes, validation, and deployments — offline."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.bedrock_catalog as catalog
import agentic_platform.deploy as deploy
from agentic_platform import knowledge as kb
from agentic_platform.agent_schema import AgentPlan, AgentSpec, EmbeddingConfig, LLMConfig
from agentic_platform.config import EMBEDDING_OPTIONS, embedding_option
from agentic_platform.graph_builder import get_embeddings, get_llm
from agentic_platform.stores import (
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    KnowledgeChunk,
    KnowledgeDocument,
)

FOUNDATION = [
    {"modelId": "openai.gpt-oss-120b-1:0", "modelName": "gpt-oss-120b", "providerName": "OpenAI",
     "outputModalities": ["TEXT"], "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "anthropic.claude-haiku-4-5-20251001-v1:0", "modelName": "Claude Haiku 4.5", "providerName": "Anthropic",
     "outputModalities": ["TEXT"], "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "mistral.voxtral-small-24b-2507", "modelName": "Voxtral", "providerName": "Mistral",
     "outputModalities": ["TEXT"], "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "meta.llama3-8b-instruct-v1:0", "modelName": "Llama 3 8B", "providerName": "Meta",
     "outputModalities": ["TEXT"], "inferenceTypesSupported": ["PROVISIONED"], "modelLifecycle": {"status": "ACTIVE"}},
    {"modelId": "old.model-v1", "modelName": "Old", "providerName": "X",
     "outputModalities": ["TEXT"], "inferenceTypesSupported": ["ON_DEMAND"], "modelLifecycle": {"status": "LEGACY"}},
]
PROFILES = [
    {"inferenceProfileId": "global.anthropic.claude-haiku-4-5-20251001-v1:0", "inferenceProfileName": "Global Claude Haiku 4.5", "status": "ACTIVE"},
    {"inferenceProfileId": "in.anthropic.claude-haiku-4-5-20251001-v1:0", "inferenceProfileName": "IN Claude Haiku 4.5", "status": "ACTIVE"},
    {"inferenceProfileId": "global.anthropic.claude-sonnet-4-6", "inferenceProfileName": "Global Claude Sonnet 4.6", "status": "ACTIVE"},
    {"inferenceProfileId": "global.cohere.embed-v4:0", "inferenceProfileName": "Global Cohere Embed v4", "status": "ACTIVE"},
]


# ---------------------------------------------------------------------------- catalog
def test_catalog_keeps_chat_models_prefers_local_profiles_and_ranks_recommended_first():
    models = catalog.build_catalog(FOUNDATION, PROFILES)
    ids = [m["model"] for m in models]
    assert "mistral.voxtral-small-24b-2507" not in ids  # speech
    assert "global.cohere.embed-v4:0" not in ids  # embeddings
    assert "meta.llama3-8b-instruct-v1:0" not in ids  # not on-demand
    assert "old.model-v1" not in ids  # not active
    # Claude Haiku: the in-country profile replaces the bare model and the global profile.
    assert "in.anthropic.claude-haiku-4-5-20251001-v1:0" in ids
    assert "anthropic.claude-haiku-4-5-20251001-v1:0" not in ids
    assert "global.anthropic.claude-haiku-4-5-20251001-v1:0" not in ids
    # Recommended order: Sonnet 4.6, Haiku 4.5, …, gpt-oss-120b.
    assert ids[:3] == ["global.anthropic.claude-sonnet-4-6", "in.anthropic.claude-haiku-4-5-20251001-v1:0",
                       "openai.gpt-oss-120b-1:0"]
    assert all(m["provider"] == "bedrock" and m["recommended"] for m in models[:3])


def test_catalog_entries_have_clean_vendor_name_and_scope():
    models = {m["model"]: m for m in catalog.build_catalog(FOUNDATION, PROFILES + [
        {"inferenceProfileId": "global.xai.grok-4.7", "inferenceProfileName": "Global xAI Grok 4.7", "status": "ACTIVE"},
        {"inferenceProfileId": "in.openai.gpt-5.6-luna", "inferenceProfileName": "IN OpenAI GPT-5.6 Luna", "status": "ACTIVE"},
    ])}
    haiku = models["in.anthropic.claude-haiku-4-5-20251001-v1:0"]
    assert (haiku["vendor"], haiku["name"], haiku["scope"]) == ("Anthropic", "Claude Haiku 4.5", "in")
    assert haiku["label"] == "Anthropic · Claude Haiku 4.5"
    # No foundation entry to name it: the profile name, without its scope word or vendor.
    assert (models["global.xai.grok-4.7"]["vendor"], models["global.xai.grok-4.7"]["name"]) == ("xAI", "Grok 4.7")
    assert models["in.openai.gpt-5.6-luna"]["name"] == "GPT-5.6 Luna"
    oss = models["openai.gpt-oss-120b-1:0"]
    assert (oss["vendor"], oss["name"], oss["scope"]) == ("OpenAI", "gpt-oss-120b", None)


def test_only_models_the_account_can_invoke_are_listed():
    ok = {"agreementAvailability": {"status": "AVAILABLE"}, "authorizationStatus": "AUTHORIZED",
          "entitlementAvailability": "AVAILABLE", "regionAvailability": "AVAILABLE"}
    assert catalog.is_accessible(ok)
    assert not catalog.is_accessible({**ok, "agreementAvailability": {"status": "NOT_AVAILABLE"}})
    assert not catalog.is_accessible({**ok, "authorizationStatus": "NOT_AUTHORIZED"})

    models = catalog.build_catalog(FOUNDATION, PROFILES)
    asked = []

    def check(base_id):
        asked.append(base_id)
        return {"anthropic.claude-sonnet-4-6": False, "openai.gpt-oss-120b-1:0": None}.get(base_id, True)

    ids = [m["model"] for m in catalog.filter_accessible(models, check)]
    assert "global.anthropic.claude-sonnet-4-6" not in ids  # no agreement: hidden
    assert "openai.gpt-oss-120b-1:0" in ids  # access unknown: kept
    assert "in.anthropic.claude-haiku-4-5-20251001-v1:0" in ids
    assert sorted(asked) == sorted({catalog._base_id(m["model"]) for m in models})  # base ids, once each


def test_catalog_is_cached_and_survives_a_failed_refresh(monkeypatch):
    calls = []

    def fetch(session=None):
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("throttled")
        return catalog.build_catalog(FOUNDATION, PROFILES)

    monkeypatch.setattr(catalog, "_fetch", fetch)
    first = catalog.bedrock_models(now=1000.0)
    assert catalog.bedrock_models(now=1100.0) == first and len(calls) == 1  # cached
    stale = 1000.0 + catalog.CACHE_SECONDS + 1
    assert catalog.bedrock_models(now=stale, wait=True) == first  # refresh failed: last good list
    assert catalog.bedrock_models(now=stale) == first  # stale: returned at once, refreshed in the background
    assert catalog.is_bedrock_model("openai.gpt-oss-120b-1:0")


# ---------------------------------------------------------------------------- providers
def test_get_llm_builds_a_converse_client_in_the_bedrock_region():
    llm = get_llm(LLMConfig(provider="bedrock", model="in.anthropic.claude-haiku-4-5-20251001-v1:0"))
    assert type(llm._inner).__name__ == "ChatBedrockConverse"  # get_llm wraps the client in the model gateway
    assert llm.model_id == "in.anthropic.claude-haiku-4-5-20251001-v1:0"
    assert llm.region_name == "ap-south-1"


def test_embedding_options_carry_their_vector_size():
    sizes = {(o["provider"], o["model"]): o["dimensions"] for o in EMBEDDING_OPTIONS}
    assert sizes[("google_genai", "gemini-embedding-001")] == 768
    assert sizes[("bedrock", "amazon.titan-embed-text-v2:0")] == 1024
    assert embedding_option("bedrock", "made-up") is None
    titan = get_embeddings(EmbeddingConfig(provider="bedrock", model="amazon.titan-embed-text-v2:0"))
    assert (titan.provider, titan.model) == ("bedrock", "amazon.titan-embed-text-v2:0")


def test_a_snapshot_refuses_vectors_of_mixed_sizes():
    store = InMemoryKnowledgeStore()
    store.add_document(KnowledgeDocument(id="d1", tenant_id="u", project_ids=["p"], filename="a.md", kind=".md",
                                         size_bytes=1, status="ready"))
    store.replace_chunks("u", "d1", [
        KnowledgeChunk(id="c1", tenant_id="u", document_id="d1", ordinal=0, text="a", source="s", embedding=[0.1] * 768),
        KnowledgeChunk(id="c2", tenant_id="u", document_id="d1", ordinal=1, text="b", source="s", embedding=[0.1] * 1024),
    ])
    with pytest.raises(kb.KnowledgeError, match="different sizes"):
        kb.build_snapshot(store, "u", "p", EmbeddingConfig(provider="bedrock", model="amazon.titan-embed-text-v2:0"))


# ---------------------------------------------------------------------------- API
@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(catalog, "_fetch", lambda session=None: catalog.build_catalog(FOUNDATION, PROFILES))
    monkeypatch.setattr(app_module, "aws_credentials_available", lambda: True)
    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p",
                                       llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
                     orchestration_pattern="sequential")
    seen = {}
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: seen.update(kw) or plan)
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    monkeypatch.setattr(app_module, "_knowledge", InMemoryKnowledgeStore())
    monkeypatch.setattr(app_module, "_usage", InMemoryUsageStore())
    client = TestClient(app_module.app)
    token = client.post("/auth/register", json={"email": "ada@example.com", "password": "a-long-password"}).json()["access_token"]
    client.headers["Authorization"] = f"Bearer {token}"
    client.planner_saw = seen
    return client


def test_providers_list_the_accounts_bedrock_models(api):
    providers = api.get("/providers").json()["providers"]
    bedrock = [p for p in providers if p["provider"] == "bedrock"]
    assert bedrock[0]["model"] == "global.anthropic.claude-sonnet-4-6" and bedrock[0]["group"] == "Amazon Bedrock"
    assert all(p["available"] for p in bedrock)
    assert any(p["provider"] == "google_genai" for p in providers)


def test_agents_can_be_moved_to_a_bedrock_model_but_not_an_unknown_one(api):
    pid = api.post("/projects", json={"brief": "x"}).json()["project_id"]
    ok = api.put(f"/projects/{pid}/agents", json={"agents": [
        {"id": "a", "provider": "bedrock", "model": "in.anthropic.claude-haiku-4-5-20251001-v1:0", "tools": []}]})
    assert ok.status_code == 200
    assert ok.json()["plan"]["agents"][0]["llm"]["provider"] == "bedrock"
    bad = api.put(f"/projects/{pid}/agents", json={"agents": [
        {"id": "a", "provider": "bedrock", "model": "anthropic.claude-made-up", "tools": []}]})
    assert bad.status_code == 422


def test_creating_a_project_rejects_models_that_arent_offered(api):
    r = api.post("/projects", json={"brief": "x", "available_llms": [{"provider": "bedrock", "model": "no.such-model"}]})
    assert r.status_code == 422
    r = api.post("/projects", json={"brief": "x", "available_llms": [{"provider": "bedrock", "model": "openai.gpt-oss-120b-1:0"}]})
    assert r.status_code == 201
    assert api.planner_saw["available_llms"] == [{"provider": "bedrock", "model": "openai.gpt-oss-120b-1:0"}]


def test_the_library_can_use_a_bedrock_embedding_model(api, monkeypatch):
    monkeypatch.setattr(app_module, "embedding_available", lambda provider: True)
    r = api.put("/knowledge/embedding", json={"provider": "bedrock", "model": "amazon.titan-embed-text-v2:0"})
    assert r.status_code in (200, 202) and r.json()["embedding"]["model"] == "amazon.titan-embed-text-v2:0"
    options = {(o["provider"], o["model"]): o for o in r.json()["embedding_options"]}
    assert options[("bedrock", "global.cohere.embed-v4:0")]["dimensions"] == 1024
    assert api.put("/knowledge/embedding", json={"provider": "bedrock", "model": "nope"}).status_code == 422


# ---------------------------------------------------------------------------- deploy
def test_bedrock_plans_deploy_without_model_keys(monkeypatch):
    for name in ("GOOGLE_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p",
                                       llm=LLMConfig(provider="bedrock", model="openai.gpt-oss-120b-1:0"),
                                       tools=["knowledge_search"])],
                     orchestration_pattern="sequential")
    titan = EmbeddingConfig(provider="bedrock", model="amazon.titan-embed-text-v2:0")
    assert deploy.runtime_environment(plan, titan) == {}  # no key: the execution role calls Bedrock
    assert "boto3" not in deploy.PLATFORM_ONLY_PACKAGES  # langchain-aws needs it in the runtime


def test_platform_created_roles_may_invoke_bedrock():
    import boto3

    from agentic_platform.agentcore import AgentCoreCloud

    cloud = AgentCoreCloud("ap-south-1", session=boto3.Session(
        aws_access_key_id="x", aws_secret_access_key="y", region_name="ap-south-1"))
    cloud._account = "123456789012"
    statement = next(s for s in cloud._role_policy()["Statement"] if s.get("Sid") == "InvokeBedrockModels")
    assert "bedrock:InvokeModel" in statement["Action"]
    assert "arn:aws:bedrock:*:123456789012:inference-profile/*" in statement["Resource"]
