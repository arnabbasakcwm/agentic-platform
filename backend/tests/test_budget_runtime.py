"""A run that hits its budget stops gracefully: finished agents keep their answers, the error is
typed and the same on every endpoint, nothing more is spent (P5.5)."""

import json
import time

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.graph_builder as gb
import agentic_platform.usage as usage_mod
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig, RunBounds
from agentic_platform.model_gateway import GatewayRunnable
from agentic_platform.stores import (
    BudgetNode,
    InMemoryAgentGrantStore,
    InMemoryAuditStore,
    InMemoryBudgetStore,
    InMemoryKnowledgeStore,
    InMemoryLedgerStore,
    InMemoryModelPolicyStore,
    InMemoryProjectStore,
    InMemoryRunStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    TeamMembership,
    TeamRecord,
)

from .test_budget_gateway import Model

LLM = LLMConfig(provider="google_genai", model="m")
PRICES = {"currency": "USD", "models": {"google_genai/m": {"input_per_1m": 10, "output_per_1m": 20}}}
CALL_COST = 30_000  # 1000 in + 1000 out at 10 / 20 micro-USD per token
ESTIMATE = None  # filled by the fixture


@pytest.fixture
def w(monkeypatch):
    for name, s in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()), ("_teams", InMemoryTeamStore()),
                    ("_grants", InMemoryAgentGrantStore()), ("_models", InMemoryModelPolicyStore()),
                    ("_audit", InMemoryAuditStore()), ("_usage", InMemoryUsageStore()), ("_budgets", InMemoryBudgetStore()),
                    ("_ledger", InMemoryLedgerStore()), ("_runs", InMemoryRunStore()), ("_knowledge", InMemoryKnowledgeStore())]:
        monkeypatch.setattr(app_module, name, s)
    monkeypatch.setattr(app_module, "_offered_cached", lambda: ["google_genai/m"])
    monkeypatch.setattr(app_module, "FLUSH_EVERY_S", 0)
    monkeypatch.setattr(usage_mod, "_PRICES", PRICES)
    monkeypatch.setattr(gb, "_NODE_BACKOFF_S", 0)
    plan = AgentPlan(
        agents=[AgentSpec(id="a", role="r", system_prompt="p", llm=LLM),
                AgentSpec(id="b", role="r", system_prompt="p", llm=LLM, depends_on=["a"])],
        orchestration_pattern="sequential", bounds=RunBounds(max_retries=3),
    )
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    model = Model(in_tokens=1000, out_tokens=1000)
    monkeypatch.setattr(gb, "get_llm", lambda cfg: GatewayRunnable(model, cfg.provider, cfg.model))
    client = TestClient(app_module.app)

    class W:
        c, h, ids = client, {}, {}

        @classmethod
        def user(cls, name, teams=()):
            r = client.post("/auth/register", json={"email": f"{name}@example.com", "password": "a-long-password"}).json()
            for t, tr in teams:
                app_module._teams.set_member(TeamMembership(team_id=t, user_id=r["user"]["id"], role=tr))
            cls.h[name], cls.ids[name] = {"Authorization": f"Bearer {r['access_token']}"}, r["user"]["id"]

        @classmethod
        def budget(cls, who, amount, **kw):
            nid = f"user:{cls.ids[who]}"
            if app_module._budgets.get("org") is None:
                app_module._budgets.create(BudgetNode(id="org", scope_type="org", scope_id="org", parent_id=None, amount=10**12))
            app_module._budgets.create(BudgetNode(id=nid, scope_type="user", scope_id=cls.ids[who], parent_id="org", amount=amount, **kw))
            return nid

    W.model = model
    W.user("owner")
    W.pid = client.post("/projects", json={"brief": "x"}, headers=W.h["owner"]).json()["project_id"]
    assert client.post(f"/projects/{W.pid}/compile", headers=W.h["owner"]).status_code == 200
    return W


def wait_run(w, who, run_id):
    for _ in range(300):
        run = w.c.get(f"/projects/{w.pid}/runs/{run_id}", headers=w.h[who]).json()["run"]
        if run["status"] != "running":
            return run
        time.sleep(0.02)
    raise AssertionError("run did not finish")


def tight(w, who="owner"):
    """A budget that covers agent a, and then too little is left for agent b."""
    return w.budget(who, CALL_COST + 5_000)


def test_the_run_stops_after_the_agent_that_fit_and_keeps_its_answer(w):
    nid = tight(w)
    started = w.c.post(f"/projects/{w.pid}/runs", json={"input": {"q": 1}}, headers=w.h["owner"])
    assert started.status_code == 202
    run = wait_run(w, "owner", started.json()["run"]["id"])
    assert run["status"] == "failed" and run["error"]["error_type"] == "BUDGET_EXCEEDED"
    assert "user:" in run["error"]["message"]
    assert list(run["outputs"]) == ["a"]  # agent a finished and its answer is kept
    assert run["events"][-1]["event"] == "run_failed"
    assert w.model.calls == 1  # b never reached the provider, and nothing was retried
    assert app_module._budgets.get(nid).remaining == 5_000  # a's real cost; nothing left reserved
    [entry] = app_module._ledger.list()
    assert entry.agent_id == "a" and entry.cost_micro == CALL_COST
    assert [e.details["remaining"] for e in app_module._audit.list(limit=50) if e.action == "budget.blocked"] == [5_000]


def test_usage_up_to_the_stop_is_recorded(w):
    tight(w)
    rid = w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["owner"]).json()["run"]["id"]
    run = wait_run(w, "owner", rid)
    assert run["usage"] is not None and run["usage"]["input_tokens"] == 1000
    since = __import__("datetime").datetime(2000, 1, 1, tzinfo=__import__("datetime").timezone.utc)
    assert sum(u.input_tokens for u in app_module._usage.list_all(since)) == 1000


def test_the_synchronous_run_answers_402_with_the_scope(w):
    tight(w)
    r = w.c.post(f"/projects/{w.pid}/run", json={"input": {}}, headers=w.h["owner"])
    assert r.status_code == 402
    body = r.json()
    assert body["error_type"] == "BUDGET_EXCEEDED" and body["details"]["scope"].startswith("user:")


def test_the_streaming_run_ends_with_a_typed_run_failed_event(w):
    tight(w)
    r = w.c.post(f"/projects/{w.pid}/run/stream", json={"input": {}}, headers=w.h["owner"])
    events = [(l[7:], None) for l in r.text.splitlines() if l.startswith("event: ")]
    names = [n for n, _ in events]
    assert names[-1] == "run_failed" and "node_completed" in names
    failed = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")][-1]
    assert failed["error_type"] == "BUDGET_EXCEEDED"


def test_a_single_agent_call_answers_402_too(w):
    w.budget("owner", 10)  # cannot cover any call
    r = w.c.post(f"/projects/{w.pid}/agents/a/invoke", json={"input": {}}, headers=w.h["owner"])
    assert r.status_code == 402 and r.json()["error_type"] == "BUDGET_EXCEEDED"
    assert w.model.calls == 0 and app_module._ledger.list() == []


def test_one_persons_empty_budget_does_not_stop_anyone_else(w):
    w.user("other")
    w.budget("owner", 10)
    w.budget("other", 10_000_000)
    assert w.c.post(f"/projects/{w.pid}/agents/a/invoke", json={"input": {}}, headers=w.h["owner"]).status_code == 402
    # share with `other`: they run on their own budget, the owner's emptiness is irrelevant
    app_module._teams.create_team(TeamRecord(id="T", name="T"))
    for n in ("owner", "other"):
        app_module._teams.set_member(TeamMembership(team_id="T", user_id=w.ids[n], role="member"))
    ok = w.c.put(f"/projects/{w.pid}/grants", headers=w.h["owner"],
                 json={"grantee_type": "user", "grantee_id": w.ids["other"], "level": "use"})
    assert ok.status_code == 200
    r = w.c.post(f"/projects/{w.pid}/agents/a/invoke", json={"input": {}}, headers=w.h["other"])
    assert r.status_code == 200
    assert app_module._budgets.get(f"user:{w.ids['other']}").remaining == 10_000_000 - CALL_COST
    assert app_module._budgets.get(f"user:{w.ids['owner']}").remaining == 10


def test_a_budget_with_room_lets_the_whole_run_finish(w):
    w.budget("owner", 10_000_000)
    rid = w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["owner"]).json()["run"]["id"]
    run = wait_run(w, "owner", rid)
    assert run["status"] == "completed" and sorted(run["outputs"]) == ["a", "b"]
    assert len(app_module._ledger.list()) == 2
