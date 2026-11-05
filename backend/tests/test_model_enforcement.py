"""Model privileges are enforced in the gateway on every call, fallbacks included (P4.3)."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.graph_builder as gb
from agentic_platform.agent_schema import AgentOutput, AgentPlan, AgentSpec, LLMConfig, RunBounds
from agentic_platform.errors import ModelNotPermittedError, RunStoppedError
from agentic_platform.graph_builder import compile_graph
from agentic_platform.model_gateway import CallIdentity, GatewayRunnable, ModelGateway, Redirect
from agentic_platform.stores import (
    AgentGrant,
    InMemoryAgentGrantStore,
    InMemoryAuditStore,
    InMemoryModelPolicyStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    OrgModelSettings,
    ModelAllowlist,
    ProjectRecord,
    TeamMembership,
    TeamRecord,
    UserRecord,
)
from agentic_platform.usage import UsageCallback, UsageCollector

OFFERED = ["google_genai/ok-model", "google_genai/blocked-model", "groq/fallback", "groq/other"]


class Structured:
    def __init__(self, text):
        self.text, self.calls = text, 0

    def invoke(self, messages, config=None, **kw):
        self.calls += 1
        return AgentOutput(content=self.text)


class Chat:
    def __init__(self, structured):
        self._s = structured

    def with_structured_output(self, schema):
        return self._s

    def bind_tools(self, tools):
        return self


def spec(agent_id, model, provider="google_genai", **kw):
    return AgentSpec(id=agent_id, role="r", system_prompt="p", llm=LLMConfig(provider=provider, model=model), **kw)


@pytest.fixture
def env(monkeypatch):
    for name, s in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()), ("_teams", InMemoryTeamStore()),
                    ("_grants", InMemoryAgentGrantStore()), ("_models", InMemoryModelPolicyStore()),
                    ("_audit", InMemoryAuditStore()), ("_usage", InMemoryUsageStore())]:
        monkeypatch.setattr(app_module, name, s)
    monkeypatch.setattr(app_module, "_offered_models", lambda: list(OFFERED))
    monkeypatch.setattr(app_module, "_offered_cached", lambda: list(OFFERED))
    monkeypatch.setattr(app_module, "_FALLBACK_SEEN", {})
    for uid, role in (("owner", "user"), ("runner", "user"), ("root", "master")):
        app_module._users.create(UserRecord(id=uid, email=f"{uid}@example.com", password_hash="x", role=role))
    app_module._teams.create_team(TeamRecord(id="T", name="T"))
    monkeypatch.setattr(gb.time, "sleep", lambda s: None)

    class E:
        structured: dict[str, Structured] = {}

    e = E()

    def make(*agents, team=None):
        plan = AgentPlan(agents=list(agents), orchestration_pattern="sequential", bounds=RunBounds(max_retries=3))
        project = ProjectRecord(id="p1", tenant_id="owner", brief="b", plan=plan, team_id=team, team_access=bool(team))
        app_module._store.create(project)
        app_module._grants.upsert(AgentGrant(id=AgentGrant.make_id("p1", "*", "user", "runner"), project_id="p1",
                                             grantee_type="user", grantee_id="runner", level="use", granted_by="owner"))
        by_key = {k: Structured(f"from {k}") for k in OFFERED}
        e.structured = by_key
        monkeypatch.setattr(gb, "get_llm", lambda cfg: GatewayRunnable(
            Chat(by_key[f"{cfg.provider}/{cfg.model}"]), cfg.provider, cfg.model,
            rebuild=lambda p, m: Chat(by_key[f"{p}/{m}"])))
        e.project, e.plan = project, plan
        return project

    e.make = make
    e.run = lambda user="runner": list(gb.run_graph_events(
        compile_graph(e.plan), {"q": 1}, e.plan.bounds, UsageCollector(),
        identity=app_module._call_identity(e.project, user)))
    e.models = lambda: app_module._models
    e.audit = lambda action: [x for x in app_module._audit.list(limit=100) if x.action == action]
    return e


def last(events):
    return events[-1][0], events[-1][1]


def test_an_allowed_model_runs_untouched(env):
    env.make(spec("a", "ok-model"))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model"]))
    kind, data = last(env.run())
    assert kind == "run_completed" and env.structured["google_genai/ok-model"].calls == 1
    assert env.audit("model.blocked") == [] and env.audit("model.fallback") == []


def test_a_blocked_model_stops_the_agent_with_a_typed_error_and_is_never_called_or_retried(env):
    env.make(spec("a", "blocked-model"))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model"]))
    kind, data = last(env.run())
    assert kind == "run_failed" and data["error_type"] == "MODEL_NOT_PERMITTED"
    assert "org" in data["message"]
    assert env.structured["google_genai/blocked-model"].calls == 0  # not one call, not three retries
    [entry] = env.audit("model.blocked")
    assert entry.actor_id == "runner" and entry.details["model"] == "google_genai/blocked-model" and entry.details["reason"] == "org"


def test_each_layer_blocks_and_names_itself(env):
    project = env.make(spec("a", "blocked-model"), team="T")
    cases = [
        ("team", lambda: env.models().set_allowlist(ModelAllowlist(id="team:T", scope_type="team", scope_id="T", models=["groq/*"], set_by="r"))),
        ("member", lambda: env.models().set_allowlist(ModelAllowlist(id="member:T:runner", scope_type="member", scope_id="T:runner", models=["groq/*"], set_by="r"))),
        ("user", lambda: env.models().set_allowlist(ModelAllowlist(id="user:runner", scope_type="user", scope_id="runner", models=["groq/*"], set_by="r"))),
    ]
    for layer, setup in cases:
        app_module._models = InMemoryModelPolicyStore()
        setup()
        kind, data = last(env.run())
        assert (kind, data["error_type"]) == ("run_failed", "MODEL_NOT_PERMITTED"), layer
        assert f"your {layer} limit" in data["message"], layer
    assert env.structured["google_genai/blocked-model"].calls == 0


def test_the_teams_rules_follow_the_projects_work_and_personal_projects_have_none(env):
    env.make(spec("a", "blocked-model"))  # personal project: no team layer
    env.models().set_allowlist(ModelAllowlist(id="team:T", scope_type="team", scope_id="T", models=["groq/*"], set_by="r"))
    assert last(env.run())[0] == "run_completed"


def test_a_later_agent_on_a_blocked_model_is_stopped_after_earlier_ones_finish(env):
    env.make(spec("a", "ok-model"), spec("b", "blocked-model", depends_on=["a"]))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model"]))
    events = env.run()
    assert "node_completed" in [e for e, _ in events]
    assert last(events)[1]["error_type"] == "MODEL_NOT_PERMITTED"
    assert (env.structured["google_genai/ok-model"].calls, env.structured["google_genai/blocked-model"].calls) == (1, 0)


def test_the_org_fallback_replaces_a_blocked_model_when_the_person_may_use_it(env):
    env.make(spec("a", "blocked-model"))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model", "groq/*"], fallback_model="groq/fallback"))
    kind, data = last(env.run())
    assert kind == "run_completed"
    assert data["outputs"]["a"]["content"] == "from groq/fallback"
    assert (env.structured["google_genai/blocked-model"].calls, env.structured["groq/fallback"].calls) == (0, 1)
    [entry] = env.audit("model.fallback")
    assert entry.details["used"] == "groq/fallback" and entry.details["model"] == "google_genai/blocked-model"
    assert entry.details["reason"] == "org"


def test_a_fallback_the_person_may_not_use_is_not_used(env):
    env.make(spec("a", "blocked-model"))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model", "groq/*"], fallback_model="groq/fallback"))
    env.models().set_allowlist(ModelAllowlist(id="user:runner", scope_type="user", scope_id="runner", models=["google_genai/ok-model"], set_by="r"))
    kind, data = last(env.run())
    assert kind == "run_failed" and data["error_type"] == "MODEL_NOT_PERMITTED"
    assert env.structured["groq/fallback"].calls == 0 and len(env.audit("model.blocked")) == 1


def test_an_agents_own_fallback_wins_over_the_orgs(env):
    env.make(spec("a", "blocked-model"))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model", "groq/*"], fallback_model="groq/fallback"))
    from agentic_platform.stores import AgentFallback

    env.models().set_agent_fallback(AgentFallback(id="p1:a", project_id="p1", agent_id="a", model="groq/other", set_by="owner"))
    kind, data = last(env.run())
    assert kind == "run_completed" and data["outputs"]["a"]["content"] == "from groq/other"
    assert env.structured["groq/fallback"].calls == 0


def test_the_fallback_is_noted_once_not_on_every_call(env):
    env.make(spec("a", "blocked-model"), spec("b", "blocked-model", depends_on=["a"]))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model", "groq/*"], fallback_model="groq/fallback"))
    env.run()
    env.run()
    assert len(env.audit("model.fallback")) == 2  # one per agent, however many calls or runs in the window


def test_the_owner_and_the_super_admin_follow_the_same_rules_with_one_exception(env):
    env.make(spec("a", "blocked-model"))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model"]))
    app_module._grants.upsert(AgentGrant(id=AgentGrant.make_id("p1", "*", "user", "root"), project_id="p1",
                                         grantee_type="user", grantee_id="root", level="use", granted_by="owner"))
    assert last(env.run(user="owner"))[1]["error_type"] == "MODEL_NOT_PERMITTED"  # the owner is limited too
    assert last(env.run(user="root"))[1]["error_type"] == "MODEL_NOT_PERMITTED"  # the org catalog binds everyone
    env.models().set_org(OrgModelSettings())
    env.models().set_allowlist(ModelAllowlist(id="user:root", scope_type="user", scope_id="root", models=["groq/*"], set_by="r"))
    assert last(env.run(user="root"))[0] == "run_completed"  # the Super Admin ignores per-user lists
    assert last(env.run(user="owner"))[0] == "run_completed"


def test_tool_loops_and_derived_models_are_gated_too():
    calls = []

    def hook(ctx):
        calls.append(ctx.model)
        raise ModelNotPermittedError(f"{ctx.provider}/{ctx.model}", "team")

    gw = ModelGateway()
    gw.before_call = hook
    inner = Structured("x")
    llm = GatewayRunnable(Chat(inner), "p", "m", gw)
    for derived in (llm, llm.bind_tools([1]), llm.with_structured_output(dict), llm.bind_tools([1]).with_structured_output(dict)):
        with pytest.raises(ModelNotPermittedError):
            derived.invoke("x", {})
    assert len(calls) == 4 and inner.calls == 0
    assert issubclass(ModelNotPermittedError, RunStoppedError)


def test_a_redirect_replays_the_same_derivations_on_the_other_model_and_relabels_token_counts():
    seen = {}

    class Rec:
        def __init__(self, name):
            self.name, self.steps = name, []

        def bind_tools(self, tools):
            self.steps.append(("bind_tools", tools))
            return self

        def with_structured_output(self, schema):
            self.steps.append(("structured", schema))
            return self

        def invoke(self, input, config=None, **kw):
            seen["ran"] = self.name
            seen["steps"] = list(self.steps)
            seen["labels"] = [cb._labels for cb in (config or {}).get("callbacks", [])]
            return "ok"

    gw = ModelGateway()
    gw.before_call = lambda ctx: Redirect("groq", "fb", ModelNotPermittedError("p/m", "team"))
    usage = UsageCollector()
    llm = GatewayRunnable(Rec("original"), "p", "m", gw, rebuild=lambda p, m: Rec(f"{p}/{m}"))
    cfg = {"callbacks": [UsageCallback(usage, kind="run", provider="p", model="m", agent_id="a")]}
    assert llm.bind_tools(["t"]).with_structured_output(dict).invoke("hi", cfg) == "ok"
    assert seen["ran"] == "groq/fb" and seen["steps"] == [("bind_tools", ["t"]), ("structured", dict)]
    assert seen["labels"] == [{"kind": "run", "provider": "groq", "model": "fb", "agent_id": "a"}]


def test_a_redirect_with_nothing_to_rebuild_from_keeps_the_block():
    gw = ModelGateway()
    gw.before_call = lambda ctx: Redirect("groq", "fb", ModelNotPermittedError("p/m", "org"))
    with pytest.raises(ModelNotPermittedError):
        GatewayRunnable(Chat(Structured("x")), "p", "m", gw).invoke("x", {})


def test_calls_without_an_identity_are_not_model_limited(env):
    env.make(spec("a", "blocked-model"))
    env.models().set_org(OrgModelSettings(catalog=["google_genai/ok-model"]))
    llm = gb.get_llm(LLMConfig(provider="google_genai", model="blocked-model"))
    assert llm.with_structured_output(dict).invoke("planner call", {}).content == "from google_genai/blocked-model"


# ------------------------------------------------------------------ the API surface
@pytest.fixture
def api(env, monkeypatch):
    plan = AgentPlan(agents=[spec("a", "ok-model")], orchestration_pattern="sequential")
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    client = TestClient(app_module.app)

    def login(name, teams=()):
        r = client.post("/auth/register", json={"email": f"{name}@x.example", "password": "a-long-password"}).json()
        for t, tr in teams:
            app_module._teams.set_member(TeamMembership(team_id=t, user_id=r["user"]["id"], role=tr))
        return {"Authorization": f"Bearer {r['access_token']}"}

    client.login = login
    return client


def test_agent_fallbacks_are_set_by_those_who_manage_the_project(api):
    owner, other = api.login("owner2"), api.login("other2")
    pid = api.post("/projects", json={"brief": "x"}, headers=owner).json()["project_id"]
    url = f"/projects/{pid}/agents/a/fallback"
    assert api.put(url, json={"model": "groq/fallback"}, headers=owner).json()["fallback"]["model"] == "groq/fallback"
    assert api.put(url, json={"model": "groq/fallback"}, headers=owner).status_code == 200  # same: no new entry
    assert len([x for x in app_module._audit.list(limit=50) if x.action == "model.fallback_set"]) == 1
    assert api.put(url, json={"model": "groq/*"}, headers=owner).json()["error_type"] == "UnknownModel"
    assert api.put(url, json={"model": "ghost/model"}, headers=owner).status_code == 422
    assert api.put(f"/projects/{pid}/agents/zzz/fallback", json={"model": "groq/other"}, headers=owner).status_code == 422
    assert api.put(url, json={"model": "groq/other"}, headers=other).status_code == 404
    assert api.delete(url, headers=other).status_code == 404
    assert app_module._models.get_agent_fallback(pid, "a").model == "groq/fallback"
    assert api.delete(url, headers=owner).json() == {"cleared": True}
    assert api.delete(url, headers=owner).json() == {"cleared": False}


def test_a_blocked_model_is_a_403_with_the_typed_code_on_the_synchronous_endpoint(api, monkeypatch):
    owner = api.login("owner3")
    pid = api.post("/projects", json={"brief": "x"}, headers=owner).json()["project_id"]
    app_module._store.mark_compiled(pid, 1)
    monkeypatch.setattr(app_module, "_compiled_graph", lambda p: object())

    def blocked(*a, **k):
        raise ModelNotPermittedError("google_genai/ok-model", "team")

    monkeypatch.setattr(app_module, "run_graph", blocked)
    r = api.post(f"/projects/{pid}/run", json={"input": {}}, headers=owner)
    assert r.status_code == 403 and r.json()["error_type"] == "MODEL_NOT_PERMITTED"
    assert r.json()["details"] == {"model": "google_genai/ok-model", "reason": "team"}
