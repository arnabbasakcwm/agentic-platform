"""A revoked share ends a live run at its next model call (P3.4)."""

import pytest

import agentic_platform.app as app_module
import agentic_platform.graph_builder as gb
from agentic_platform.agent_schema import AgentOutput, AgentPlan, AgentSpec, LLMConfig, RunBounds
from agentic_platform.errors import AccessRevokedError, RunStoppedError
from agentic_platform.graph_builder import compile_graph
from agentic_platform.model_gateway import CallContext, CallIdentity, GatewayRunnable, ModelGateway, check_identity
from agentic_platform.stores import (
    AgentGrant,
    InMemoryAgentGrantStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUserStore,
    ProjectRecord,
    TeamMembership,
    TeamRecord,
    UserRecord,
)
from agentic_platform.usage import UsageCollector


class Structured:
    def __init__(self, text, on_call=None):
        self.text, self.on_call, self.calls = text, on_call, 0

    def invoke(self, messages, config=None, **kw):
        self.calls += 1
        if self.on_call:
            self.on_call()
        return AgentOutput(content=self.text)


class Chat:
    def __init__(self, structured):
        self._s = structured

    def with_structured_output(self, schema):
        return self._s

    def bind_tools(self, tools):
        return self


def spec(agent_id, model, **kw):
    return AgentSpec(id=agent_id, role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model=model), **kw)


@pytest.fixture
def env(monkeypatch):
    stores = dict(_store=InMemoryProjectStore(), _users=InMemoryUserStore(), _teams=InMemoryTeamStore(),
                  _grants=InMemoryAgentGrantStore())
    for name, s in stores.items():
        monkeypatch.setattr(app_module, name, s)
    owner = UserRecord(id="owner", email="o@example.com", password_hash="x")
    runner = UserRecord(id="runner", email="r@example.com", password_hash="x")
    app_module._users.create(owner)
    app_module._users.create(runner)
    plan = AgentPlan(agents=[spec("a", "m-a"), spec("b", "m-b", depends_on=["a"])], orchestration_pattern="sequential",
                     bounds=RunBounds(max_retries=1))
    project = ProjectRecord(id="p1", tenant_id="owner", brief="b", plan=plan)
    app_module._store.create(project)
    app_module._grants.upsert(AgentGrant(id=AgentGrant.make_id("p1", "*", "user", "runner"), project_id="p1",
                                         grantee_type="user", grantee_id="runner", level="use", granted_by="owner"))
    monkeypatch.setattr(gb.time, "sleep", lambda s: None)

    def install(a, b):
        by = {"m-a": a, "m-b": b}
        monkeypatch.setattr(gb, "get_llm", lambda cfg: GatewayRunnable(Chat(by[cfg.model]), cfg.provider, cfg.model))

    class E:
        pass

    e = E()
    e.project, e.plan, e.install = project, plan, install
    e.revoke = lambda: app_module._grants.revoke(AgentGrant.make_id("p1", "*", "user", "runner"))
    e.run = lambda user="runner": list(
        gb.run_graph_events(compile_graph(plan), {"q": 1}, plan.bounds, UsageCollector(),
                            identity=app_module._call_identity(project, user))
    )
    return e


def test_the_gateway_check_runs_before_every_call_and_blocks_it():
    seen = []

    def check(agent_id):
        seen.append(agent_id)
        if len(seen) > 1:
            raise AccessRevokedError()

    ident = CallIdentity(user_id="u", check=check)
    inner = Structured("x")
    llm = GatewayRunnable(Chat(inner), "p", "m", ModelGateway())
    cfg = {"configurable": {"identity": ident, "agent_id": "a"}}
    llm.with_structured_output(dict).invoke("1", cfg)
    with pytest.raises(AccessRevokedError):
        llm.with_structured_output(dict).invoke("2", cfg)
    assert inner.calls == 1 and seen == ["a", "a"]
    assert issubclass(AccessRevokedError, RunStoppedError)  # handled as "the run is over", never retried


def test_calls_without_an_identity_are_unaffected():
    inner = Structured("x")
    GatewayRunnable(Chat(inner), "p", "m", ModelGateway()).with_structured_output(dict).invoke("1", {})
    assert inner.calls == 1
    check_identity(CallContext("p", "m", {"configurable": {"identity": "not-an-identity"}}))  # ignored, no crash


def test_revoking_mid_run_stops_before_the_next_agents_model_call(env):
    a, b = Structured("first"), Structured("second")
    a.on_call = env.revoke  # access disappears while agent a is thinking
    env.install(a, b)
    events = env.run()
    names = [e for e, _ in events]
    assert "node_completed" in names  # the call already in flight finishes, as documented
    failed = events[-1]
    assert failed[0] == "run_failed" and failed[1]["error_type"] == "AccessRevokedError"
    assert (a.calls, b.calls) == (1, 0)  # nothing more was spent


def test_revoked_before_the_first_call_nothing_runs(env):
    a, b = Structured("first"), Structured("second")
    env.install(a, b)
    env.revoke()
    events = env.run()
    assert events[-1][0] == "run_failed" and events[-1][1]["error_type"] == "AccessRevokedError"
    assert (a.calls, b.calls) == (0, 0)


def test_a_run_with_access_completes_normally(env):
    a, b = Structured("first"), Structured("second")
    env.install(a, b)
    events = env.run()
    assert events[-1][0] == "run_completed" and (a.calls, b.calls) == (1, 1)


def test_the_owner_is_never_cut_off_by_a_grant_change(env):
    a, b = Structured("first"), Structured("second")
    a.on_call = env.revoke
    env.install(a, b)
    assert env.run(user="owner")[-1][0] == "run_completed"


def test_leaving_the_team_ends_a_run_that_relied_on_a_team_share(env):
    app_module._teams.create_team(TeamRecord(id="A", name="A"))
    app_module._teams.set_member(TeamMembership(team_id="A", user_id="runner", role="member"))
    env.revoke()
    app_module._grants.upsert(AgentGrant(id=AgentGrant.make_id("p1", "*", "team", "A"), project_id="p1",
                                         grantee_type="team", grantee_id="A", level="use", granted_by="owner"))
    a, b = Structured("first"), Structured("second")
    a.on_call = lambda: app_module._teams.remove_member("A", "runner")
    env.install(a, b)
    events = env.run()
    assert events[-1][1]["error_type"] == "AccessRevokedError" and (a.calls, b.calls) == (1, 0)


def test_downgrading_below_use_also_stops_the_run(env):
    a, b = Structured("first"), Structured("second")
    a.on_call = lambda: app_module._grants.upsert(AgentGrant(
        id=AgentGrant.make_id("p1", "*", "user", "runner"), project_id="p1", grantee_type="user",
        grantee_id="runner", level="view", granted_by="owner"))
    env.install(a, b)
    assert env.run()[-1][1]["error_type"] == "AccessRevokedError" and b.calls == 0


def test_deleting_the_project_stops_a_live_run(env):
    a, b = Structured("first"), Structured("second")
    a.on_call = lambda: app_module._store.delete("p1")
    env.install(a, b)
    events = env.run()
    assert events[-1][1]["error_type"] == "AccessRevokedError" and b.calls == 0
