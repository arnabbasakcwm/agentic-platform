"""Usage accounting: collection, pricing, storage, dashboard totals, and recording — offline."""

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

import agentic_platform.app as app_module
import agentic_platform.graph_builder as gb
from agentic_platform import usage as usage_mod
from agentic_platform.agent_schema import AgentOutput, AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    MongoUsageStore,
    UsageRecord,
)
from agentic_platform.usage import UsageCallback, UsageCollector

TABLE = {
    "currency": "USD",
    "models": {
        "google_genai/gemini-pro": {
            "input_per_1m": 2.0,
            "output_per_1m": 12.0,
            "long_context": {"above_prompt_tokens": 200000, "input_per_1m": 4.0, "output_per_1m": 18.0},
        },
        "openai/text-embedding-3-small": {"input_per_1m": 0.02, "output_per_1m": 0},
    },
}


def _report(callbacks, input_tokens, output_tokens):
    """What a real chat model does at the end of a call: hand its usage to the callbacks."""
    result = LLMResult(generations=[[ChatGeneration(message=AIMessage(
        content="", usage_metadata={"input_tokens": input_tokens, "output_tokens": output_tokens,
                                    "total_tokens": input_tokens + output_tokens}))]])
    for cb in callbacks or []:
        cb.on_llm_end(result, run_id=uuid.uuid4())


# ---------------------------------------------------------------------------- collector + pricing
def test_collector_totals_per_agent_and_model_across_calls():
    c = UsageCollector()
    cb = UsageCallback(c, kind="run", provider="google_genai", model="gemini-pro", agent_id="a")
    _report([cb], 1000, 200)
    _report([cb], 1500, 300)  # e.g. a retry
    c.add(kind="embedding_query", provider="openai", model="text-embedding-3-small",
          input_tokens=12, agent_id="a", estimated=True)
    a = {(e["kind"], e["model"]): e for e in c.entries("a")}
    run = a[("run", "gemini-pro")]
    assert (run["calls"], run["input_tokens"], run["output_tokens"]) == (2, 2500, 500)
    assert a[("embedding_query", "text-embedding-3-small")]["estimated"] is True
    assert c.totals() == {"calls": 3, "input_tokens": 2512, "output_tokens": 500}


def test_cost_uses_the_long_context_rate_for_long_prompts():
    c = UsageCollector()
    c.add(kind="run", provider="google_genai", model="gemini-pro", input_tokens=100_000, output_tokens=1_000)
    c.add(kind="run", provider="google_genai", model="gemini-pro", input_tokens=300_000, output_tokens=2_000)
    entry = c.entries()[0]
    assert entry["long_input_tokens"] == 300_000 and entry["long_output_tokens"] == 2_000
    expected = (100_000 * 2 + 1_000 * 12 + 300_000 * 4 + 2_000 * 18) / 1_000_000
    assert usage_mod.cost(entry, TABLE) == pytest.approx(expected)


def test_unpriced_models_have_no_cost_and_estimates_are_counted():
    assert usage_mod.cost({"provider": "groq", "model": "x", "input_tokens": 5, "output_tokens": 5}, TABLE) is None
    assert usage_mod.estimate_tokens("abcdefghi") == 3
    assert usage_mod.estimate_tokens(["abcd", "ab"]) == 2


def test_the_shipped_price_table_loads_and_cites_its_sources():
    table = usage_mod.load_prices()
    assert table["currency"] == "USD"
    for key, rate in table["models"].items():
        assert "/" in key and rate["source_url"].startswith("https://") and rate["checked_on"]


# ---------------------------------------------------------------------------- compiled graphs report usage
class _ReportingStructured:
    def __init__(self, output, tokens):
        self.output, self.tokens = output, tokens

    def invoke(self, messages, config=None):
        _report((config or {}).get("callbacks"), *self.tokens)
        return self.output


class _ReportingLLM:
    def __init__(self, output, tokens=(100, 20)):
        self.structured = _ReportingStructured(output, tokens)
        self.decisions = iter(["w", "FINISH"])  # a router's choices over the whole run

    def with_structured_output(self, schema):
        if schema is AgentOutput:
            return self.structured
        decisions = self.decisions
        llm = self

        class Router:
            def invoke(self, messages, config=None):
                _report((config or {}).get("callbacks"), 50, 5)
                return gb._SupervisorDecision(next_agent=next(decisions))

        return Router() if llm.structured.output is None else llm.structured

    def bind_tools(self, tools):
        return self


def _spec(id_, depends_on=()):
    return AgentSpec(id=id_, role="r", system_prompt="p",
                     llm=LLMConfig(provider="google_genai", model="gemini-pro"), depends_on=list(depends_on))


@pytest.mark.parametrize("pattern", ["sequential", "parallel"])
def test_runs_report_tokens_per_agent(monkeypatch, pattern):
    monkeypatch.setattr(gb, "get_llm", lambda cfg: _ReportingLLM(AgentOutput(content="ok")))
    agents = [_spec("a"), _spec("b"), _spec("c", ["a", "b"])] if pattern == "parallel" else [_spec("a"), _spec("b", ["a"])]
    plan = AgentPlan(agents=agents, orchestration_pattern=pattern)
    result = gb.run_graph(gb.compile_graph(plan), {"q": "x"}, plan.bounds)
    per_agent = {e["agent_id"]: e for e in result["usage"]}
    assert set(per_agent) == {a.id for a in agents}
    assert all((e["input_tokens"], e["output_tokens"], e["calls"]) == (100, 20, 1) for e in per_agent.values())


def test_supervisor_routing_calls_count_too(monkeypatch):
    llms = {"router-model": _ReportingLLM(None), "worker-model": _ReportingLLM(AgentOutput(content="ok"))}
    monkeypatch.setattr(gb, "get_llm", lambda cfg: llms[cfg.model])
    sup = AgentSpec(id="sup", role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model="router-model"))
    w = AgentSpec(id="w", role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model="worker-model"))
    plan = AgentPlan(agents=[sup, w], orchestration_pattern="supervisor", supervisor_id="sup")
    result = gb.run_graph(gb.compile_graph(plan), {"q": "x"}, plan.bounds)
    per_agent = {e["agent_id"]: e for e in result["usage"]}
    assert per_agent["sup"]["calls"] == 2 and per_agent["sup"]["input_tokens"] == 100  # two routing calls
    assert per_agent["w"]["model"] == "worker-model"


def test_streamed_runs_carry_usage_in_their_events(monkeypatch):
    monkeypatch.setattr(gb, "get_llm", lambda cfg: _ReportingLLM(AgentOutput(content="ok")))
    plan = AgentPlan(agents=[_spec("a")], orchestration_pattern="sequential")
    events = dict(gb.run_graph_events(gb.compile_graph(plan), {"q": "x"}, plan.bounds))
    assert events["node_completed"]["usage"][0]["input_tokens"] == 100
    assert events["run_completed"]["usage"][0]["agent_id"] == "a"


def test_planner_usage_counts_every_attempt(monkeypatch):
    import agentic_platform.meta_planner_prompt as mp

    plan = AgentPlan(agents=[_spec("a")], orchestration_pattern="sequential")
    calls = iter([ValueError("bad plan"), plan])

    class Structured:
        def invoke(self, messages, config=None):
            _report((config or {}).get("callbacks"), 3000, 400)
            outcome = next(calls)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    class LLM:
        def with_structured_output(self, schema):
            return Structured()

    monkeypatch.setattr(mp, "get_llm", lambda cfg: LLM())
    monkeypatch.setattr(mp, "_semantic_check", lambda *a, **k: None)
    monkeypatch.setattr(mp.time, "sleep", lambda s: None)
    collector = UsageCollector()
    mp.plan_project("brief", usage=collector)
    (entry,) = collector.entries()
    assert (entry["kind"], entry["calls"], entry["input_tokens"]) == ("planner", 2, 6000)


# ---------------------------------------------------------------------------- dashboard
def _record(**kw):
    fields = dict(id=uuid.uuid4().hex, tenant_id="u1", kind="run", provider="google_genai", model="gemini-pro",
                  calls=1, input_tokens=1000, output_tokens=100, cost=0.0032, run_id="r1", agent_id="a",
                  project_id="p1", at=datetime(2026, 10, 5, 9, tzinfo=timezone.utc))
    return UsageRecord(**{**fields, **kw}).model_dump()


def test_dashboard_totals_by_day_model_project_kind_and_runs():
    records = [
        _record(),
        _record(agent_id="b", input_tokens=500, cost=0.0022),
        _record(kind="embedding_query", provider="openai", model="text-embedding-3-small", input_tokens=10,
                output_tokens=0, cost=0.0000002, estimated=True),
        _record(kind="planner", run_id="r2", agent_id=None, project_id="gone", cost=0.01),
        _record(kind="deployed_run", run_id="r3", provider="groq", model="llama", cost=None,
                at=datetime(2026, 10, 4, 9, tzinfo=timezone.utc)),
    ]
    d = usage_mod.dashboard(records, start=date(2026, 10, 3), days=3, project_names={"p1": "Travel"})
    assert d["totals"]["runs"] == 2  # r1 (local) and r3 (deployed); planner calls aren't runs
    assert d["totals"]["cost"] == pytest.approx(0.0032 + 0.0022 + 0.0000002 + 0.01, abs=1e-6)  # 6 dp
    assert d["totals"]["unpriced_tokens"] == 1100 and d["totals"]["estimated_tokens"] == 10
    assert [x["date"] for x in d["by_day"]] == ["2026-10-03", "2026-10-04", "2026-10-05"]
    assert d["by_day"][0]["cost"] == 0 and d["by_day"][1]["unpriced_tokens"] == 1100
    models = {m["model"]: m for m in d["by_model"]}
    assert models["llama"]["priced"] is False and models["text-embedding-3-small"]["estimated"] is True
    projects = {p["project_id"]: p for p in d["by_project"]}
    assert projects["p1"]["name"] == "Travel" and projects["p1"]["runs"] == 2
    assert projects["gone"]["name"] == "Deleted project" and projects["gone"]["exists"] is False
    run = next(r for r in d["recent_runs"] if r["run_id"] == "r1")
    assert run["deployed"] is False and len(run["agents"]) == 3  # two agents + their search query
    assert d["recent_runs"][0]["run_id"] == "r1"  # newest first
    assert next(r for r in d["recent_runs"] if r["run_id"] == "r3")["deployed"] is True


# ---------------------------------------------------------------------------- store contract
@pytest.fixture(params=["memory", "mongo"])
def usage_store(request):
    if request.param == "memory":
        yield InMemoryUsageStore()
        return
    import os

    from pymongo.errors import PyMongoError

    from agentic_platform.stores import mongo_database

    db = mongo_database(os.environ.get("MONGODB_URI") or "mongodb://localhost:27017",
                        f"agentic_platform_test_{uuid.uuid4().hex[:8]}", timeout_ms=500)
    try:
        db.client.admin.command("ping")
    except PyMongoError:
        db.client.close()
        pytest.skip("no MongoDB server reachable")
    try:
        yield MongoUsageStore(db)
    finally:
        db.client.drop_database(db.name)
        db.client.close()


def test_usage_store_lists_by_tenant_time_and_project(usage_store):
    now = datetime.now(timezone.utc)
    rec = lambda **kw: UsageRecord(**{**_record(at=now), **kw})  # noqa: E731
    usage_store.add_many([
        rec(id="old", at=now - timedelta(days=40)),
        rec(id="mine", project_id="p1"),
        rec(id="other-project", project_id="p2"),
        rec(id="theirs", tenant_id="u2"),
    ])
    usage_store.add_many([])
    since = now - timedelta(days=30)
    assert sorted(r.id for r in usage_store.list("u1", since)) == ["mine", "other-project"]
    assert [r.id for r in usage_store.list("u1", since, "p1")] == ["mine"]
    assert [r.id for r in usage_store.list("u2", since)] == ["theirs"]


# ---------------------------------------------------------------------------- API
@pytest.fixture
def api(monkeypatch):
    from fastapi.testclient import TestClient

    plan = AgentPlan(agents=[_spec("a")], orchestration_pattern="sequential")

    def fake_plan(usage=None, **kw):
        if usage is not None:
            usage.add(kind="planner", provider="google_genai", model="gemini-pro", input_tokens=4000, output_tokens=800)
        return plan

    monkeypatch.setattr(app_module, "plan_project", fake_plan)
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    monkeypatch.setattr(app_module, "_knowledge", InMemoryKnowledgeStore())
    monkeypatch.setattr(app_module, "_usage", InMemoryUsageStore())
    monkeypatch.setattr(usage_mod, "_PRICES", TABLE)
    # 100k-token prompts: under the 200k long-context threshold, so the normal rate applies.
    monkeypatch.setattr(gb, "get_llm", lambda cfg: _ReportingLLM(AgentOutput(content="ok"), tokens=(100_000, 10_000)))
    app_module._COMPILED.clear()
    client = TestClient(app_module.app)

    def login(email):
        token = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}

    client.login = login
    return client


def test_runs_and_planning_are_recorded_and_priced(api):
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "Travel"}, headers=h).json()["project_id"]
    api.post(f"/projects/{pid}/compile", headers=h)
    r = api.post(f"/projects/{pid}/run", json={"input": {"q": "x"}}, headers=h).json()
    # 100k input at $2 + 10k output at $12 per 1M
    assert r["usage"]["cost"] == pytest.approx(0.2 + 0.12)
    assert r["usage"]["input_tokens"] == 100_000

    d = api.get("/usage?days=7", headers=h).json()
    kinds = {k["kind"]: k for k in d["by_kind"]}
    assert kinds["run"]["cost"] == pytest.approx(0.32)
    assert kinds["planner"]["input_tokens"] == 4000
    assert d["totals"]["runs"] == 1
    assert d["by_project"][0]["name"] == "Travel"
    assert d["recent_runs"][0]["agents"][0]["agent_id"] == "a"
    assert api.get(f"/usage?project_id={pid}", headers=h).json()["totals"]["runs"] == 1


def test_streamed_runs_are_recorded_with_usage_in_the_final_event(api):
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "Travel"}, headers=h).json()["project_id"]
    api.post(f"/projects/{pid}/compile", headers=h)
    body = api.post(f"/projects/{pid}/run/stream", json={"input": {"q": "x"}}, headers=h).text
    assert '"cost": 0.32' in body.split("event: run_completed")[1]
    assert api.get("/usage", headers=h).json()["totals"]["runs"] == 1


def test_usage_is_private_and_requires_sign_in(api):
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "Travel"}, headers=h).json()["project_id"]
    api.post(f"/projects/{pid}/compile", headers=h)
    api.post(f"/projects/{pid}/run", json={"input": {"q": "x"}}, headers=h)
    other = api.login("eve@example.com")
    assert api.get("/usage", headers=other).json()["totals"]["calls"] == 0
    assert api.get("/usage").status_code == 401


def test_recording_failures_never_fail_the_run(api, monkeypatch):
    class Broken(InMemoryUsageStore):
        def add_many(self, records):
            raise RuntimeError("database down")

    monkeypatch.setattr(app_module, "_usage", Broken())
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "Travel"}, headers=h).json()["project_id"]
    api.post(f"/projects/{pid}/compile", headers=h)
    assert api.post(f"/projects/{pid}/run", json={"input": {"q": "x"}}, headers=h).status_code == 200


def test_pricing_endpoint_lists_unpriced_models_seen(api, monkeypatch):
    monkeypatch.setattr(gb, "get_llm", lambda cfg: _ReportingLLM(AgentOutput(content="ok")))
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "x"}, headers=h).json()["project_id"]
    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p",
                                       llm=LLMConfig(provider="groq", model="llama-3.3-70b-versatile"))],
                     orchestration_pattern="sequential")
    api.patch(f"/projects/{pid}/plan", json=plan.model_dump(), headers=h)
    monkeypatch.setenv("GROQ_API_KEY", "test")
    api.post(f"/projects/{pid}/compile", headers=h)
    api.post(f"/projects/{pid}/run", json={"input": {"q": "x"}}, headers=h)
    body = api.get("/usage/pricing", headers=h).json()
    assert body["unpriced"] == ["groq/llama-3.3-70b-versatile"]
    assert "google_genai/gemini-pro" in body["models"]
