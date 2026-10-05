"""Changing agents' models and tools from the Brief page, and creating a project with
knowledge files from the new-project chat — offline."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.meta_planner_prompt as mp
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    KnowledgeDocument,
)

GEMINI = LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview", extra_params={"thinking_level": "low"})


def _plan():
    return AgentPlan(
        agents=[
            AgentSpec(id="searcher", role="r", system_prompt="p", llm=GEMINI, tools=["calculator"]),
            AgentSpec(id="writer", role="r", system_prompt="p", llm=GEMINI, depends_on=["searcher"]),
        ],
        orchestration_pattern="sequential",
    )


@pytest.fixture
def api(monkeypatch):
    seen = {}

    def fake_plan(**kw):
        seen.update(kw)
        return _plan()

    monkeypatch.setattr(app_module, "plan_project", fake_plan)
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    monkeypatch.setattr(app_module, "_knowledge", InMemoryKnowledgeStore())
    monkeypatch.setattr(app_module, "_usage", InMemoryUsageStore())
    app_module._COMPILED.clear()
    client = TestClient(app_module.app)

    def login(email):
        session = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()
        return {"Authorization": f"Bearer {session['access_token']}"}, session["user"]["id"]

    client.login = login
    client.planner_saw = seen
    return client


def _settings(**agents):
    return {"agents": [{"id": aid, **values} for aid, values in agents.items()]}


def test_changing_an_agents_model_and_tools_makes_a_new_plan_version(api):
    h, _ = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "x"}, headers=h).json()["project_id"]
    api.post(f"/projects/{pid}/compile", headers=h)

    r = api.put(f"/projects/{pid}/agents", headers=h, json=_settings(
        searcher={"provider": "openai", "model": "gpt-4o-mini", "tools": ["calculator", "lookup"]},
    ))
    assert r.status_code == 200
    body = r.json()
    agents = {a["id"]: a for a in body["plan"]["agents"]}
    assert agents["searcher"]["llm"]["model"] == "gpt-4o-mini"
    assert agents["searcher"]["llm"]["extra_params"] == {}  # Gemini-only extras don't carry over
    assert agents["searcher"]["tools"] == ["calculator", "lookup"]
    assert agents["writer"]["llm"]["model"] == "gemini-3.1-pro-preview"  # not listed: unchanged
    assert agents["writer"]["llm"]["extra_params"] == {"thinking_level": "low"}
    assert body["plan_version"] == 2 and body["compiled"] is False

    # Sending the same settings again changes nothing.
    again = api.put(f"/projects/{pid}/agents", headers=h, json=_settings(
        searcher={"provider": "openai", "model": "gpt-4o-mini", "tools": ["calculator", "lookup"]},
    )).json()
    assert again["plan_version"] == 2


def test_turning_on_an_external_tool_is_the_projects_opt_in(api):
    h, _ = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "x"}, headers=h).json()["project_id"]
    assert api.get(f"/projects/{pid}", headers=h).json()["side_effect_tools_enabled"] == []
    body = api.put(f"/projects/{pid}/agents", headers=h, json=_settings(
        searcher={"provider": "google_genai", "model": "gemini-3.1-pro-preview", "tools": ["wikipedia"]},
    )).json()
    assert body["side_effect_tools_enabled"] == ["wikipedia"]
    # The plan assistant may now use it too (it's in the project's allowed tools).
    project = app_module._store.get(pid)
    assert "wikipedia" in app_module._offered_tools(project)


def test_invalid_settings_are_rejected_and_nothing_changes(api):
    h, _ = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "x"}, headers=h).json()["project_id"]
    for bad in [
        _settings(searcher={"provider": "openai", "model": "gpt-made-up", "tools": []}),
        _settings(searcher={"provider": "google_genai", "model": "gemini-3.1-pro-preview", "tools": ["shell"]}),
        _settings(ghost={"provider": "google_genai", "model": "gemini-3.1-pro-preview", "tools": []}),
        _settings(searcher={"provider": "google_genai", "model": "gemini-3.1-pro-preview", "tools": ["knowledge_search"]}),
    ]:
        r = api.put(f"/projects/{pid}/agents", headers=h, json=bad)
        assert r.status_code == 422, bad
    assert api.get(f"/projects/{pid}", headers=h).json()["plan_version"] == 1

    other, _ = api.login("eve@example.com")
    r = api.put(f"/projects/{pid}/agents", headers=other, json=_settings(
        searcher={"provider": "openai", "model": "gpt-4o-mini", "tools": []}))
    assert r.status_code == 404


def test_knowledge_search_can_be_given_once_files_are_attached(api):
    h, user_id = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "x"}, headers=h).json()["project_id"]
    app_module._knowledge.add_document(KnowledgeDocument(
        id="d1", tenant_id=user_id, project_ids=[pid], filename="policy.pdf", kind=".pdf", size_bytes=1, status="ready"))
    r = api.put(f"/projects/{pid}/agents", headers=h, json=_settings(
        writer={"provider": "google_genai", "model": "gemini-3.1-pro-preview", "tools": ["knowledge_search"]}))
    assert r.status_code == 200
    assert {a["id"]: a["tools"] for a in r.json()["plan"]["agents"]}["writer"] == ["knowledge_search"]


def test_providers_say_whether_their_key_is_configured(api, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "x")
    providers = {p["provider"]: p for p in api.get("/providers").json()["providers"]}
    assert providers["google_genai"]["available"] is True
    assert providers["openai"]["available"] is False
    assert providers["ollama"]["available"] is True  # local, no key


# ---------------------------------------------------------------------------- new project with files
def test_creating_a_project_with_library_files_attaches_them_and_tells_the_planner(api):
    h, user_id = api.login("ada@example.com")
    for doc_id, name in [("d1", "policy.pdf"), ("d2", "fares.csv")]:
        app_module._knowledge.add_document(KnowledgeDocument(
            id=doc_id, tenant_id=user_id, filename=name, kind=".pdf", size_bytes=1, status="ready"))
    r = api.post("/projects", headers=h, json={"brief": "Answer policy questions", "document_ids": ["d1", "d2", "d1"]})
    assert r.status_code == 201
    pid = r.json()["project_id"]
    assert "knowledge_search" in api.planner_saw["available_tools"]
    assert api.planner_saw["knowledge_files"] == ["policy.pdf", "fares.csv"]
    attached = {d["filename"] for d in api.get(f"/projects/{pid}/knowledge", headers=h).json()["documents"]}
    assert attached == {"policy.pdf", "fares.csv"}


def test_without_files_the_planner_gets_no_knowledge_search(api):
    h, _ = api.login("ada@example.com")
    api.post("/projects", headers=h, json={"brief": "x", "available_tools": ["calculator", "knowledge_search"]})
    assert api.planner_saw["available_tools"] == ["calculator"]
    assert api.planner_saw["knowledge_files"] == []


def test_someone_elses_files_cant_be_attached_to_a_new_project(api):
    _, owner_id = api.login("ada@example.com")
    app_module._knowledge.add_document(KnowledgeDocument(
        id="theirs", tenant_id=owner_id, filename="secret.pdf", kind=".pdf", size_bytes=1))
    other, _ = api.login("eve@example.com")
    r = api.post("/projects", headers=other, json={"brief": "x", "document_ids": ["theirs"]})
    assert r.status_code == 404 and r.json()["error_type"] == "DocumentNotFound"
    assert api.get("/projects", headers=other).json()["projects"] == []


def test_the_planner_prompt_lists_the_attached_files():
    message = mp._build_user_message("brief", None, ["knowledge_search"], [], None, ["policy.pdf"])
    assert "KNOWLEDGE FILES" in message and "'policy.pdf'" in message
    assert "KNOWLEDGE FILES" not in mp._build_user_message("brief", None, [], [], None, None)
