"""The gateway charges every model call to the budget chain: atomic reservation, real cost,
ledger, hard/soft limits, unpriced models, fallbacks (P5.3)."""

import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

import agentic_platform.app as app_module
import agentic_platform.usage as usage_mod
from agentic_platform.agent_schema import AgentOutput
from agentic_platform.errors import BudgetExceededError, ModelNotPermittedError, RunStoppedError
from agentic_platform.model_gateway import CallIdentity, GatewayRunnable
from agentic_platform.stores import (
    BudgetNode,
    InMemoryAgentGrantStore,
    InMemoryAuditStore,
    InMemoryBudgetStore,
    InMemoryLedgerStore,
    InMemoryModelPolicyStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    OrgModelSettings,
    UserRecord,
    period_start_for,
)

PRICES = {
    "currency": "USD",
    "models": {
        "p/m": {"input_per_1m": 10, "output_per_1m": 20},  # micro-USD per token
        "p/fb": {"input_per_1m": 1, "output_per_1m": 2},
        "p/cents": {"input_per_1m": 0.15, "output_per_1m": 0.6},
        "p/long": {"input_per_1m": 1, "output_per_1m": 2, "long_context": {"above_prompt_tokens": 1000, "input_per_1m": 4, "output_per_1m": 8}},
    },
}
OFFERED = ["p/m", "p/fb", "p/free", "p/cents"]


class Model:
    """A chat model: reports tokens through the callbacks like a provider would."""

    def __init__(self, in_tokens=100, out_tokens=50, report=True, fail=None, delay=0.0):
        self.in_tokens, self.out_tokens, self.report, self.fail, self.delay = in_tokens, out_tokens, report, fail, delay
        self.calls, self._lock = 0, threading.Lock()

    def with_structured_output(self, schema):
        return self

    def bind_tools(self, tools):
        return self

    def invoke(self, messages, config=None, **kw):
        with self._lock:
            self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        if self.report:
            msg = AIMessage(content="x", usage_metadata={"input_tokens": self.in_tokens, "output_tokens": self.out_tokens,
                                                         "total_tokens": self.in_tokens + self.out_tokens})
            for cb in (config or {}).get("callbacks", []):
                cb.on_llm_end(LLMResult(generations=[[ChatGeneration(message=msg)]]))
        if self.fail:
            raise self.fail
        return AgentOutput(content="x")


@pytest.fixture
def env(monkeypatch):
    for name, s in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()), ("_teams", InMemoryTeamStore()),
                    ("_grants", InMemoryAgentGrantStore()), ("_models", InMemoryModelPolicyStore()),
                    ("_audit", InMemoryAuditStore()), ("_usage", InMemoryUsageStore()),
                    ("_budgets", InMemoryBudgetStore()), ("_ledger", InMemoryLedgerStore())]:
        monkeypatch.setattr(app_module, name, s)
    monkeypatch.setattr(app_module, "_offered_cached", lambda: list(OFFERED))
    monkeypatch.setattr(usage_mod, "_PRICES", PRICES)
    for uid in ("u", "runner", "owner"):
        app_module._users.create(UserRecord(id=uid, email=f"{uid}@example.com", password_hash="x"))

    class E:
        pass

    e = E()

    def node(scope, sid, amount, parent, **kw):
        nid = BudgetNode.make_id(scope, sid)
        return app_module._budgets.create(BudgetNode(id=nid, scope_type=scope, scope_id=sid, parent_id=parent, amount=amount, **kw))

    e.node = node
    e.rem = lambda nid: app_module._budgets.get(nid).remaining
    e.ledger = lambda **kw: app_module._ledger.list(**kw)
    e.audit = lambda action: [x for x in app_module._audit.list(limit=100) if x.action == action]

    def call(model, key="p/m", user="u", team=None, prompt="hi", agent="a", gw_model=None):
        provider, name = key.split("/", 1)
        llm = GatewayRunnable(model, provider, name, rebuild=lambda p, m: gw_model or model)
        cfg = {"configurable": {"identity": CallIdentity(user_id=user, project_id="p1", team_id=team), "agent_id": agent}}
        return llm.with_structured_output(AgentOutput).invoke(prompt, cfg)

    e.call = call
    e.estimate = lambda key="p/m", prompt="hi": usage_mod.cost_micro(*key.split("/", 1), usage_mod.estimate_tokens(prompt), 1024)
    return e


def full_tree(e, user=10_000_000):
    e.node("org", "org", 100_000_000, None)
    e.node("team", "T", 50_000_000, "org")
    e.node("user", "u", user, "team:T")


# ------------------------------------------------------------------------------ cost maths
def test_costs_are_exact_integers_in_micro_usd():
    assert usage_mod.cost_micro("p", "m", 100, 50, PRICES) == 2000
    assert usage_mod.cost_micro("p", "cents", 1_000_000, 1_000_000, PRICES) == 150_000 + 600_000  # no float drift
    assert usage_mod.cost_micro("p", "cents", 1, 1, PRICES) == 1  # rounded up: a call is never free
    assert usage_mod.cost_micro("p", "ghost", 1, 1, PRICES) is None
    assert usage_mod.cost_micro("p", "long", 500, 100, PRICES) == 500 + 200
    assert usage_mod.cost_micro("p", "long", 2000, 100, PRICES) == 2000 * 4 + 100 * 8  # long-context rate
    assert isinstance(usage_mod.cost_micro("p", "m", 1, 1, PRICES), int)


# ------------------------------------------------------------------------------ charging
def test_a_call_is_charged_its_real_cost_on_every_budget_of_the_chain(env):
    full_tree(env)
    model = Model(in_tokens=100, out_tokens=50)
    env.call(model, team="T")
    for nid, start in (("user:u", 10_000_000), ("team:T", 50_000_000), ("org", 100_000_000)):
        assert env.rem(nid) == start - 2000, nid  # the estimate was replaced by the actual cost
    [entry] = env.ledger()
    assert (entry.user_id, entry.team_id, entry.project_id, entry.agent_id) == ("u", "T", "p1", "a")
    assert (entry.model, entry.input_tokens, entry.output_tokens, entry.cost_micro) == ("m", 100, 50, 2000)
    assert entry.estimate_micro == env.estimate() and entry.outcome == "ok" and not entry.estimated and not entry.unpriced
    assert entry.nodes == ["user:u", "team:T", "org"]


def test_when_the_provider_reports_no_tokens_the_estimate_is_charged_and_flagged(env):
    full_tree(env)
    env.call(Model(report=False), team="T")
    assert env.rem("user:u") == 10_000_000 - env.estimate()
    assert env.ledger()[0].estimated is True and env.ledger()[0].cost_micro == env.estimate()


def test_a_failed_call_gives_the_reservation_back(env):
    full_tree(env)
    with pytest.raises(ValueError):
        env.call(Model(report=False, fail=ValueError("provider down")), team="T")
    assert env.rem("user:u") == 10_000_000 and env.rem("org") == 100_000_000
    [entry] = env.ledger()
    assert entry.outcome == "failed" and entry.cost_micro == 0


def test_a_failed_call_that_already_used_tokens_is_still_charged_for_them(env):
    full_tree(env)
    with pytest.raises(ValueError):
        env.call(Model(in_tokens=100, out_tokens=50, fail=ValueError("cut off")), team="T")
    assert env.rem("user:u") == 10_000_000 - 2000 and env.ledger()[0].outcome == "failed"


def test_the_team_budget_is_charged_even_when_the_person_has_none(env):
    env.node("org", "org", 100_000_000, None)
    env.node("team", "T", 50_000_000, "org")
    env.call(Model(), team="T")
    assert env.rem("team:T") == 50_000_000 - 2000 and env.ledger()[0].nodes == ["team:T", "org"]


def test_calls_with_no_budgets_and_calls_without_an_identity_cost_nothing_to_meter(env):
    env.call(Model(), team="T")  # no budgets exist: unlimited, but still in the ledger
    assert env.ledger()[0].nodes == [] and env.ledger()[0].cost_micro == 2000
    llm = GatewayRunnable(Model(), "p", "m")
    llm.with_structured_output(AgentOutput).invoke("planner call", {})
    assert len(env.ledger()) == 1  # no identity: not metered here


def test_the_runner_pays_not_the_owner(env):
    env.node("org", "org", 100_000_000, None)
    env.node("user", "owner", 10_000_000, "org")
    env.node("user", "runner", 10_000_000, "org")
    env.call(Model(), user="runner")
    assert env.rem("user:runner") == 10_000_000 - 2000 and env.rem("user:owner") == 10_000_000


# ------------------------------------------------------------------------------ limits
def test_a_hard_budget_stops_the_call_before_any_money_is_spent(env):
    full_tree(env, user=env.estimate() - 1)  # the user's budget cannot cover even the estimate
    model = Model()
    with pytest.raises(BudgetExceededError) as e:
        env.call(model, team="T")
    assert e.value.scope == "user:u" and e.value.code == "BUDGET_EXCEEDED" and isinstance(e.value, RunStoppedError)
    assert model.calls == 0 and env.ledger() == []
    assert env.rem("user:u") == env.estimate() - 1 and env.rem("team:T") == 50_000_000 and env.rem("org") == 100_000_000
    [entry] = env.audit("budget.blocked")
    assert entry.target_id == "user:u" and entry.details["needed"] == env.estimate() and entry.team_id == "T"


def test_the_scope_that_ran_out_is_named(env):
    est = env.estimate()
    env.node("org", "org", 100_000_000, None)
    env.node("team", "T", est * 2, "org")
    env.node("user", "u", est * 2, "team:T")
    app_module._budgets.reserve(["team:T"], int(est * 1.5))  # colleagues already used most of the team's budget
    with pytest.raises(BudgetExceededError) as e:
        env.call(Model(), team="T")
    assert e.value.scope == "team:T" and env.rem("user:u") == est * 2  # the user's part was given back


def test_a_soft_budget_never_blocks_it_just_goes_over(env):
    env.node("org", "org", 100_000_000, None)
    env.node("user", "u", 1000, "org", hard_limit=False)
    env.call(Model())
    env.call(Model())
    assert env.rem("user:u") == 1000 - 4000 and len(env.ledger()) == 2


def test_a_soft_budget_below_a_hard_one_still_stops_at_the_hard_one(env):
    env.node("org", "org", env.estimate() - 1, None)
    env.node("user", "u", 1000, "org", hard_limit=False)
    with pytest.raises(BudgetExceededError) as e:
        env.call(Model())
    assert e.value.scope == "org" and env.rem("user:u") == 1000


def test_n_parallel_calls_against_the_last_credit_run_exactly_one_model_call(env):
    est = env.estimate()
    env.node("org", "org", 100_000_000, None)
    env.node("user", "u", est, "org")  # exactly one call's reservation
    model = Model(delay=0.02)
    outcomes, barrier = [], threading.Barrier(20)

    def worker():
        barrier.wait()
        try:
            env.call(model)
            outcomes.append("ok")
        except BudgetExceededError:
            outcomes.append("blocked")

    threads = [threading.Thread(target=worker) for _ in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert outcomes.count("ok") == 1 and outcomes.count("blocked") == 19
    assert model.calls == 1  # the other 19 never reached the provider
    assert len(env.ledger()) == 1
    assert env.rem("user:u") == est - 2000  # settled to the real cost, nothing stuck from the refusals
    assert env.rem("org") == 100_000_000 - 2000


def test_parallel_calls_never_overspend_a_budget_that_fits_several(env):
    est = env.estimate()
    env.node("org", "org", 100_000_000, None)
    env.node("user", "u", est * 3 + 10, "org")  # room for three reservations at once
    model = Model(delay=0.02)
    outcomes, barrier = [], threading.Barrier(12)

    def worker():
        barrier.wait()
        try:
            env.call(model)
            outcomes.append("ok")
        except BudgetExceededError:
            outcomes.append("blocked")

    threads = [threading.Thread(target=worker) for _ in range(12)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    ok = outcomes.count("ok")
    assert 3 <= ok <= 12 and model.calls == ok  # at least the three that fit at once; every success hit the provider once
    assert est * 3 + 10 - env.rem("user:u") == 2000 * ok  # exactly the real cost of the successes, no phantom spend
    assert env.rem("user:u") >= 0


# ------------------------------------------------------------------------------ unpriced models
def test_an_unpriced_model_is_refused_under_a_hard_budget(env):
    full_tree(env)
    model = Model()
    with pytest.raises(ModelNotPermittedError) as e:
        env.call(model, key="p/free", team="T")
    assert e.value.reason == "unpriced" and e.value.code == "MODEL_NOT_PERMITTED"
    assert model.calls == 0 and env.rem("user:u") == 10_000_000
    [entry] = env.audit("model.blocked")
    assert entry.details["reason"] == "unpriced" and entry.details["model"] == "p/free"


def test_an_admin_override_lets_an_unpriced_model_run_at_zero_cost_with_tokens_counted(env):
    full_tree(env)
    app_module._models.set_org(OrgModelSettings(unpriced_overrides=["p/free"]))
    env.call(Model(in_tokens=70, out_tokens=30), key="p/free", team="T")
    assert env.rem("user:u") == 10_000_000
    entry = env.ledger()[0]
    assert entry.unpriced and entry.cost_micro == 0 and (entry.input_tokens, entry.output_tokens) == (70, 30)


def test_unpriced_models_are_fine_without_a_hard_budget(env):
    env.call(Model(), key="p/free")  # no budgets at all
    env.node("org", "org", 100, None, hard_limit=False)
    env.call(Model(), key="p/free")  # only a soft one
    assert [e.unpriced for e in env.ledger()] == [True, True]


def test_the_unpriced_overrides_api_is_the_super_admins_and_validated(monkeypatch):
    from fastapi.testclient import TestClient

    for name, s in [("_users", InMemoryUserStore()), ("_teams", InMemoryTeamStore()), ("_models", InMemoryModelPolicyStore()),
                    ("_audit", InMemoryAuditStore())]:
        monkeypatch.setattr(app_module, name, s)
    monkeypatch.setattr(app_module, "_offered_models", lambda: list(OFFERED))
    c = TestClient(app_module.app)
    r = c.post("/auth/register", json={"email": "root@example.com", "password": "a-long-password"}).json()
    app_module._users.set_role(r["user"]["id"], "master", by="t")
    h = {"Authorization": f"Bearer {r['access_token']}"}
    ok = c.put("/admin/models/org", json={"unpriced_overrides": ["p/free"]}, headers=h)
    assert ok.status_code == 200 and ok.json()["org"]["unpriced_overrides"] == ["p/free"]
    assert c.put("/admin/models/org", json={"unpriced_overrides": ["p/free", "ghost/x"]}, headers=h).status_code == 422
    assert c.put("/admin/models/org", json={"unpriced_overrides": ["p/*"]}, headers=h).status_code == 422
    assert app_module._models.get_org().unpriced_overrides == ["p/free"]
    [entry] = [x for x in app_module._audit.list(limit=10) if x.action == "model.org_updated"]
    assert entry.after["unpriced_overrides"] == ["p/free"]


# ------------------------------------------------------------------------------ fallbacks and periods
def test_a_redirected_call_is_priced_and_recorded_as_the_fallback_model(env):
    full_tree(env)
    app_module._models.set_org(OrgModelSettings(catalog=["p/fb", "p/cents"], fallback_model="p/fb"))
    fallback = Model(in_tokens=100, out_tokens=50)
    original = Model()
    env.call(original, key="p/m", team="T", gw_model=fallback)
    assert original.calls == 0 and fallback.calls == 1
    entry = env.ledger()[0]
    assert entry.model == "fb" and entry.cost_micro == 100 * 1 + 50 * 2  # the fallback's rate, not p/m's
    assert env.rem("user:u") == 10_000_000 - 200


def test_a_budget_in_a_new_period_is_topped_up_on_first_use(env):
    old = period_start_for("monthly", datetime.now(timezone.utc) - timedelta(days=70))
    env.node("org", "org", 100_000_000, None, period_start=old)
    env.node("user", "u", 10_000_000, "org", period_start=old)
    app_module._budgets.reserve(["user:u"], 9_999_000)  # last period's spending
    env.call(Model())
    assert env.rem("user:u") == 10_000_000 - 2000  # reset to the full amount first, then charged
    assert app_module._budgets.get("user:u").period_start.replace(tzinfo=None) >= period_start_for("monthly", datetime.now(timezone.utc)).replace(tzinfo=None) - timedelta(seconds=1)


# ------------------------------------------------------------------------------ the HTTP surface
def test_budget_exceeded_is_a_402_with_the_scope():
    import json

    handler = app_module.app.exception_handlers[BudgetExceededError]
    resp = handler(None, BudgetExceededError("team:T", -5, 100))
    assert resp.status_code == 402
    body = json.loads(resp.body)
    assert body["error_type"] == "BUDGET_EXCEEDED" and body["details"] == {"scope": "team:T", "remaining": -5, "needed": 100}
