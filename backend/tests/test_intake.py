"""The new-project conversation: an intake turn answers, asks clarifying questions and
keeps a brief, and creates nothing; planning stays the user's explicit step."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.meta_planner_prompt as mp
from agentic_platform.agent_schema import AgentPlan, AgentSpec, BriefTurn, ClarifyingQuestion, LLMConfig
from agentic_platform.errors import PlannerError
from agentic_platform.stores import (
    InMemoryDataSourceStore,
    InMemoryKnowledgeStore,
    InMemoryMcpServerStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
)


class _Recorder:
    """llm.with_structured_output(BriefTurn) stand-in: scripted turns, prompts kept."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.prompts = []

    def invoke(self, messages, config=None):
        self.prompts.append(messages[-1].content)
        return self.outcomes.pop(0)


def _patch(monkeypatch, outcomes):
    recorder = _Recorder(outcomes)

    class LLM:
        def with_structured_output(self, schema):
            return recorder

    monkeypatch.setattr(mp, "get_llm", lambda cfg: LLM())
    monkeypatch.setattr(mp.time, "sleep", lambda s: None)
    return recorder


GREETING = BriefTurn(
    reply="Hello! What would you like your agents to do?",
    questions=[ClarifyingQuestion(question="What should they work on?", options=["Emails", "Research"])],
)
READY = BriefTurn(
    reply="I have what I need. Shall I plan the team now?",
    brief="Summarise one email per run and post it to a chat.",
    ready=True,
    name="Email digest",
)


# ---------------------------------------------------------------------------- discuss_brief
def test_a_greeting_gets_questions_and_no_brief(monkeypatch):
    _patch(monkeypatch, [GREETING])
    turn = mp.discuss_brief([("user", "hello")])
    assert turn.brief == "" and not turn.ready and not turn.plan_now
    assert turn.questions[0].options == ["Emails", "Research"]


def test_too_many_questions_go_back_to_the_model(monkeypatch):
    many = BriefTurn(reply="?", questions=[ClarifyingQuestion(question=f"q{i}") for i in range(5)])
    recorder = _patch(monkeypatch, [many, GREETING])
    assert mp.discuss_brief([("user", "hi")]) == GREETING
    assert "ask at most 3 questions" in recorder.prompts[1]


def test_plan_now_needs_a_brief(monkeypatch):
    eager = BriefTurn(reply="Planning!", plan_now=True)
    recorder = _patch(monkeypatch, [eager, eager, eager])
    with pytest.raises(PlannerError):
        mp.discuss_brief([("user", "go")])
    assert "`plan_now` needs a non-empty `brief`" in recorder.prompts[1]


def test_history_is_capped_and_only_names_reach_the_model(monkeypatch):
    recorder = _patch(monkeypatch, [READY])
    history = [("user" if i % 2 == 0 else "assistant", f"message {i}") for i in range(30)]
    mp.discuss_brief(history, knowledge_files=["policy.pdf"], data_tables=["p.d.trips"])
    prompt = recorder.prompts[0]
    assert "message 13" not in prompt and "message 14" in prompt and "message 29" in prompt
    assert "'policy.pdf'" in prompt and "`p.d.trips`" in prompt


# ---------------------------------------------------------------------------- API
@pytest.fixture
def api(monkeypatch):
    for name, store in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()),
                        ("_knowledge", InMemoryKnowledgeStore()), ("_usage", InMemoryUsageStore()),
                        ("_datasources", InMemoryDataSourceStore()), ("_mcp", InMemoryMcpServerStore())]:
        monkeypatch.setattr(app_module, name, store)
    client = TestClient(app_module.app)

    def login(email):
        token = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}

    client.login = login
    return client


def test_chatting_creates_nothing_and_counts_usage(api, monkeypatch):
    h = api.login("ada@example.com")
    seen = {}

    def fake(history, **kw):
        seen["history"] = history
        collector = kw["usage"]
        collector.add(kind="assistant", provider="google_genai", model="m", input_tokens=10, output_tokens=5)
        return GREETING

    monkeypatch.setattr(app_module, "discuss_brief", fake)
    r = api.post("/brief/chat", json={"messages": [{"role": "user", "content": "hello"}]}, headers=h)
    assert r.status_code == 200
    assert r.json()["brief"] == "" and r.json()["questions"][0]["question"] == "What should they work on?"
    assert seen["history"] == [("user", "hello")]
    assert api.get("/projects", headers=h).json()["projects"] == []
    user_id = api.get("/auth/me", headers=h).json()["id"]
    from datetime import datetime, timezone

    kinds = [u.kind for u in app_module._usage.list(user_id, datetime(2000, 1, 1, tzinfo=timezone.utc))]
    assert kinds == ["assistant"]


def test_chat_needs_sign_in_own_attachments_and_a_user_turn(api, monkeypatch):
    monkeypatch.setattr(app_module, "discuss_brief", lambda history, **kw: GREETING)
    body = {"messages": [{"role": "user", "content": "hi"}]}
    assert api.post("/brief/chat", json=body).status_code == 401
    h = api.login("ada@example.com")
    r = api.post("/brief/chat", json={**body, "document_ids": ["someone-elses"]}, headers=h)
    assert r.status_code == 404
    r = api.post("/brief/chat", json={"messages": [{"role": "assistant", "content": "hi"}]}, headers=h)
    assert r.status_code == 422


def test_the_intake_conversation_is_kept_on_the_new_project(api, monkeypatch):
    plan = AgentPlan(
        agents=[AgentSpec(id="a", role="r", system_prompt="p",
                          llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
        orchestration_pattern="sequential",
    )
    captured = {}

    def planner(**kw):
        captured.update(kw)
        return plan

    monkeypatch.setattr(app_module, "plan_project", planner)
    h = api.login("ada@example.com")
    intake = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "What should they do?"},
              {"role": "user", "content": "Summarise emails"}]
    r = api.post("/projects", json={"brief": READY.brief, "intake": intake}, headers=h)
    assert r.status_code == 201
    assert captured["user_brief"] == READY.brief
    project = api.get(f"/projects/{r.json()['project_id']}", headers=h).json()
    assert [(m["role"], m["content"]) for m in project["conversation"]] == [(m["role"], m["content"]) for m in intake]
