"""Models that can't call tools: the one-time check, the planner and compiler rules, the
JSON answer path, the clear failure, and the API — offline (fake models)."""

import threading

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.capabilities as caps
import agentic_platform.graph_builder as gb
from agentic_platform.agent_schema import AgentOutput, AgentPlan, AgentSpec, LLMConfig
from agentic_platform.errors import ModelCannotCallToolsError
from agentic_platform.graph_builder import compile_graph, initial_state
from agentic_platform.meta_planner_prompt import _build_user_message, _semantic_check
from agentic_platform.stores import (
    InMemoryDataSourceStore,
    InMemoryKnowledgeStore,
    InMemoryModelCapabilityStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
)
from agentic_platform.usage import UsageCollector

# The real check, taken before the suite-wide fixture stubs it (these tests give it fake models).
REAL_PROBE = caps.probe_tool_calling
GEMMA = "google.gemma-3-12b-it"
HAIKU = "in.anthropic.claude-haiku-4-5-20251001-v1:0"


class Reply:
    def __init__(self, content="", tool_calls=None, tokens=(10, 5)):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage_metadata = {"input_tokens": tokens[0], "output_tokens": tokens[1]}


class FakeModel:
    """A chat model that either calls tools or answers in prose; `json_replies` are what
    a plain invoke returns, in order."""

    def __init__(self, calls_tools=True, error=None, json_replies=None, structured=None):
        self.calls_tools = calls_tools
        self.error = error
        self.json_replies = list(json_replies or [])
        self.structured = structured
        self.seen = []

    def bind_tools(self, tools):
        return self

    def with_structured_output(self, schema):
        model = self

        class Structured:
            def invoke(self, messages, config=None):
                return model.structured

        return Structured()

    def invoke(self, messages, config=None):
        self.seen.append(messages)
        self.config = config
        if self.error:
            raise self.error
        if self.json_replies:
            return Reply(content=self.json_replies.pop(0))
        if self.calls_tools:
            return Reply(tool_calls=[{"name": "record_value", "args": {"value": 42}, "id": "c1"}])
        return Reply(content="I recorded 42 for you!")


# ---------------------------------------------------------------------------- the check
@pytest.mark.parametrize("model, verdict", [
    (FakeModel(calls_tools=True), True),
    (FakeModel(calls_tools=False), False),
    (FakeModel(error=RuntimeError("ValidationException: This model doesn't support tool use.")), False),
    (FakeModel(error=RuntimeError("ThrottlingException: too many requests")), None),
])
def test_the_check_asks_for_one_tool_call(monkeypatch, model, verdict):
    monkeypatch.setattr(gb, "get_llm", lambda cfg: model)
    collector = UsageCollector()
    assert REAL_PROBE("bedrock", GEMMA, collector) is verdict
    # The check's tokens are counted, labelled as a model check.
    (callback,) = model.config["callbacks"]
    assert callback._labels["kind"] == "model_check" and callback._labels["model"] == GEMMA


def test_platform_providers_are_never_checked():
    assert not caps.needs_check("google_genai") and not caps.needs_check("openai") and caps.needs_check("bedrock")


# ---------------------------------------------------------------------------- planner rule
def _plan(model, tools=(), supervisor=False):
    agents = [AgentSpec(id="worker", role="r", system_prompt="p", tools=list(tools),
                        llm=LLMConfig(provider="bedrock", model=model))]
    if supervisor:
        agents.insert(0, AgentSpec(id="lead", role="r", system_prompt="p", llm=LLMConfig(provider="bedrock", model=model)))
        return AgentPlan(agents=agents, orchestration_pattern="supervisor", supervisor_id="lead")
    return AgentPlan(agents=agents, orchestration_pattern="sequential")


def test_the_planner_may_not_give_tools_or_routing_to_a_model_that_cant_call_them():
    options = [{"provider": "bedrock", "model": GEMMA, "tools": False}]
    _semantic_check(_plan(GEMMA), None, ["lookup"], options)  # no tools: fine
    with pytest.raises(ValueError, match="has tools but its model google.gemma-3-12b-it can't call tools"):
        _semantic_check(_plan(GEMMA, tools=["lookup"]), None, ["lookup"], options)
    with pytest.raises(ValueError, match="is the supervisor"):
        _semantic_check(_plan(GEMMA, supervisor=True), None, ["lookup"], options)
    message = _build_user_message("x", None, ["lookup"], options, None)
    assert f"model={GEMMA} (CANNOT CALL TOOLS" in message


# ---------------------------------------------------------------------------- compiler
def test_compiling_refuses_tools_on_a_model_that_cant_call_them():
    with pytest.raises(ModelCannotCallToolsError, match="'worker' has tools"):
        compile_graph(_plan(GEMMA, tools=["lookup"]), json_models={f"bedrock/{GEMMA}"})


def test_a_model_without_tool_calling_answers_by_json(monkeypatch):
    model = FakeModel(json_replies=[
        "Here you go: {not json",  # invalid: retried with the validation error
        '```json\n{"content": "## Busiest\\n- Station A", "data": {"top": "A"}}\n```',
    ])
    monkeypatch.setattr(gb, "get_llm", lambda cfg: model)
    monkeypatch.setattr(gb.time, "sleep", lambda s: None)
    result = compile_graph(_plan(GEMMA), json_models={f"bedrock/{GEMMA}"}).invoke(initial_state({"q": "x"}))
    assert result["errors"] == []
    assert result["outputs"]["worker"]["content"] == "## Busiest\n- Station A"
    # The second attempt carried the exact validation error back to the model.
    retry_text = " ".join(str(m.content) for m in model.seen[1])
    assert "previous attempt failed" in retry_text and "JSON" in retry_text
    assert "matching this JSON schema" in str(model.seen[0][-1].content)


def test_a_model_that_returns_no_structured_answer_fails_clearly(monkeypatch):
    model = FakeModel(structured=None)
    monkeypatch.setattr(gb, "get_llm", lambda cfg: model)
    monkeypatch.setattr(gb.time, "sleep", lambda s: None)
    result = compile_graph(_plan(GEMMA)).invoke(initial_state({"q": "x"}))
    (error,) = result["errors"]
    assert "ModelCannotCallToolsError" in error["error"] and "can't call tools" in error["error"]
    assert "NoneType" not in error["error"]


# ---------------------------------------------------------------------------- API
@pytest.fixture
def api(monkeypatch):
    plan = AgentPlan(agents=[AgentSpec(id="analyst", role="r", system_prompt="p", tools=["lookup"],
                                       llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview")),
                             AgentSpec(id="reporter", role="r", system_prompt="p", depends_on=["analyst"],
                                       llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
                     orchestration_pattern="sequential")
    seen = {}

    def planner(**kw):
        seen.update(kw)
        return plan

    monkeypatch.setattr(app_module, "plan_project", planner)
    for name, store in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()),
                        ("_knowledge", InMemoryKnowledgeStore()), ("_usage", InMemoryUsageStore()),
                        ("_datasources", InMemoryDataSourceStore()), ("_capabilities", InMemoryModelCapabilityStore())]:
        monkeypatch.setattr(app_module, name, store)
    monkeypatch.setattr(app_module, "_model_allowed", lambda provider, model: True)
    probes = []

    def probe(provider, model, usage=None):
        probes.append(model)
        usage.add(kind="model_check", provider=provider, model=model, input_tokens=60, output_tokens=20)
        return model != GEMMA

    monkeypatch.setattr(caps, "probe_tool_calling", probe)
    app_module._COMPILED.clear()
    client = TestClient(app_module.app)
    token = client.post("/auth/register", json={"email": "a@example.com", "password": "a-long-password"}).json()["access_token"]
    client.headers["Authorization"] = f"Bearer {token}"
    client.probes, client.seen = probes, seen
    return client


def test_a_model_is_checked_once_and_the_verdict_is_shared(api):
    r = api.post("/models/check", json={"provider": "bedrock", "model": GEMMA})
    assert r.json()["tool_calling"] is False
    assert api.post("/models/check", json={"provider": "bedrock", "model": GEMMA}).json()["tool_calling"] is False
    assert api.post("/models/check", json={"provider": "google_genai", "model": "gemini-3.1-pro-preview"}).json()["tool_calling"] is True
    assert api.probes == [GEMMA]  # checked once; Gemini never
    user_id = api.get("/auth/me").json()["id"]
    from datetime import datetime, timezone

    records = app_module._usage.list(user_id, datetime(2000, 1, 1, tzinfo=timezone.utc))
    assert [(r.kind, r.model) for r in records] == [("model_check", GEMMA)]


def test_concurrent_requests_check_a_model_once(api):
    threads = [threading.Thread(target=app_module._tool_calling, args=("bedrock", HAIKU)) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert api.probes == [HAIKU]


def test_agents_with_tools_cant_move_to_a_model_that_cant_call_them(api):
    pid = api.post("/projects", json={"brief": "bikes"}).json()["project_id"]
    r = api.put(f"/projects/{pid}/agents", json={"agents": [
        {"id": "analyst", "provider": "bedrock", "model": GEMMA, "tools": ["lookup"]}]})
    assert r.status_code == 422 and r.json()["error_type"] == "ModelCannotCallTools"
    assert "'analyst' has tools" in r.json()["message"]
    # A tool-less agent may use it, and then runs answer by JSON.
    r = api.put(f"/projects/{pid}/agents", json={"agents": [
        {"id": "reporter", "provider": "bedrock", "model": GEMMA, "tools": []}]})
    assert r.status_code == 200
    project = app_module._store.get(pid)
    assert app_module._json_models(project.plan) == {f"bedrock/{GEMMA}"}
    assert api.post(f"/projects/{pid}/compile").status_code == 200


def test_the_planner_is_told_which_chosen_models_cant_call_tools(api):
    api.post("/projects", json={"brief": "bikes", "available_llms": [{"provider": "bedrock", "model": GEMMA}]})
    assert api.seen["available_llms"] == [{"provider": "bedrock", "model": GEMMA, "tools": False}]
    # A caller can't claim a model can call tools.
    api.post("/projects", json={"brief": "bikes", "available_llms": [{"provider": "bedrock", "model": GEMMA, "tools": True}]})
    assert api.seen["available_llms"][0]["tools"] is False


def test_providers_report_what_is_known_and_runs_teach_it(api):
    providers = {p["provider"]: p for p in api.get("/providers").json()["providers"]}
    assert providers["google_genai"]["tool_calling"] is True
    pid = api.post("/projects", json={"brief": "bikes"}).json()["project_id"]
    project = app_module._store.get(pid)
    bad = project.plan.model_copy(update={"agents": [
        project.plan.agents[0].model_copy(update={"llm": LLMConfig(provider="bedrock", model="new.model-v1")}),
        project.plan.agents[1],
    ]})
    app_module._learn_from_errors(
        project.model_copy(update={"plan": bad}),
        [{"agent_id": "analyst", "error": "agent 'analyst' failed after 3 attempts: ModelCannotCallToolsError: ..."}],
    )
    assert app_module._capabilities.get("bedrock/new.model-v1").source == "run"
    assert app_module._stored_tool_calling("bedrock", "new.model-v1") is False


def test_a_deployment_carries_its_json_models(tmp_path, monkeypatch):
    import json as json_mod

    from agentic_platform import runtime_app

    (tmp_path / "models.json").write_text(json_mod.dumps([f"bedrock/{GEMMA}"]), encoding="utf-8")
    captured = {}

    def fake_compile(plan, knowledge=None, data=None, json_models=None):
        captured["json_models"] = json_models
        return object()

    monkeypatch.setattr(runtime_app, "compile_graph", fake_compile)
    runtime_app.create_app(_plan(GEMMA).model_dump(), knowledge_dir=tmp_path)
    assert captured["json_models"] == {f"bedrock/{GEMMA}"}
