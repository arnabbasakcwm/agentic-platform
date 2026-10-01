import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.errors import StoreUnavailableError
from agentic_platform.stores import InMemoryProjectStore, InMemoryUserStore
from fastapi.testclient import TestClient


def _plan():
    return AgentPlan(
        agents=[
            AgentSpec(
                id="a",
                role="worker",
                system_prompt="do it",
                llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"),
            )
        ],
        orchestration_pattern="sequential",
    )


def _client(monkeypatch):
    # Stub the planner so API tests never hit a real model.
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: _plan())
    # Always the in-memory store, whatever MONGODB_URI the developer's .env holds.
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    app_module._COMPILED.clear()
    client = TestClient(app_module.app)
    # Project routes need a signed-in user; auth itself is covered in test_auth.py.
    session = client.post(
        "/auth/register", json={"email": "tester@example.com", "password": "a-long-password"}
    ).json()
    client.headers["Authorization"] = f"Bearer {session['access_token']}"
    return client


def test_health(monkeypatch):
    c = _client(monkeypatch)
    assert c.get("/health").json() == {"status": "ok"}


def test_create_returns_plan(monkeypatch):
    c = _client(monkeypatch)
    r = c.post("/projects", json={"brief": "x", "agent_count": 1})
    assert r.status_code == 201
    assert r.json()["plan"]["agents"][0]["id"] == "a"


def test_get_unknown_project_is_404(monkeypatch):
    c = _client(monkeypatch)
    r = c.get("/projects/does-not-exist")
    assert r.status_code == 404
    assert r.json()["error_type"] == "ProjectNotFound"


def test_run_before_compile_is_409(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x", "agent_count": 1}).json()["project_id"]
    r = c.post(f"/projects/{pid}/run", json={"input": {"q": "x"}})
    assert r.status_code == 409
    assert r.json()["error_type"] == "NotCompiled"


def test_agent_count_is_optional_and_passed_through(monkeypatch):
    c = _client(monkeypatch)
    seen = []
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: seen.append(kw) or _plan())
    assert c.post("/projects", json={"brief": "x"}).status_code == 201
    assert c.post("/projects", json={"brief": "x", "agent_count": 3}).status_code == 201
    assert [kw["requested_agent_count"] for kw in seen] == [None, 3]


def test_empty_brief_rejected(monkeypatch):
    c = _client(monkeypatch)
    assert c.post("/projects", json={"brief": ""}).status_code == 422


def test_agent_count_out_of_range_rejected(monkeypatch):
    c = _client(monkeypatch)
    r = c.post("/projects", json={"brief": "x", "agent_count": 0})
    assert r.status_code == 422


def test_edit_plan_invalidates_compiled_graph(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x", "agent_count": 1}).json()["project_id"]
    c.post(f"/projects/{pid}/compile")
    assert c.get(f"/projects/{pid}").json()["compiled"] is True
    edited = _plan().model_dump()
    r = c.patch(f"/projects/{pid}/plan", json=edited)
    assert r.status_code == 200
    assert c.get(f"/projects/{pid}").json()["compiled"] is False
    assert pid not in app_module._COMPILED  # stale graph dropped on edit
    r = c.post(f"/projects/{pid}/run", json={"input": {"q": "x"}})
    assert r.status_code == 409


def test_compiled_project_runs_in_a_process_that_never_compiled_it(monkeypatch):
    # Restart / second-worker case: the store says the project is compiled but this
    # process holds no graph, so /run must rebuild it rather than answer NotCompiled.
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x", "agent_count": 1}).json()["project_id"]
    c.post(f"/projects/{pid}/compile")
    app_module._COMPILED.clear()
    seen = {}

    def fake_run(graph, task_input, bounds):
        seen["graph"] = graph
        return {"outputs": {"a": {"content": "ok", "data": {}}}, "errors": [], "halted": False}

    monkeypatch.setattr(app_module, "run_graph", fake_run)
    r = c.post(f"/projects/{pid}/run", json={"input": {"q": "x"}})
    assert r.status_code == 200
    assert seen["graph"] is not None
    assert r.json()["outputs"]["a"]["content"] == "ok"


def test_edit_plan_on_unknown_project_is_404(monkeypatch):
    c = _client(monkeypatch)
    r = c.patch("/projects/nope/plan", json=_plan().model_dump())
    assert r.status_code == 404
    assert r.json()["error_type"] == "ProjectNotFound"


def test_store_failure_is_a_typed_503(monkeypatch):
    c = _client(monkeypatch)

    class Broken(InMemoryProjectStore):
        def get(self, project_id):
            raise StoreUnavailableError("ServerSelectionTimeoutError")

    monkeypatch.setattr(app_module, "_store", Broken())
    r = c.get("/projects/anything")
    assert r.status_code == 503
    assert r.json()["error_type"] == "StoreUnavailable"


def test_invoke_unknown_agent_is_404(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x", "agent_count": 1}).json()["project_id"]
    r = c.post(
        f"/projects/{pid}/agents/ghost/invoke", json={"input": {"q": "x"}}
    )
    assert r.status_code == 404
    assert r.json()["error_type"] == "AgentNotFound"


def test_openapi_docs_available(monkeypatch):
    c = _client(monkeypatch)
    assert c.get("/openapi.json").status_code == 200
    assert c.get("/docs").status_code == 200


def test_list_tools_flags_side_effect_entries(monkeypatch):
    c = _client(monkeypatch)
    body = c.get("/tools").json()
    by_name = {t["name"]: t["side_effect"] for t in body["tools"]}
    assert by_name["lookup"] is False
    assert by_name["calculator"] is False
    assert by_name["web_search"] is True
    assert by_name["wikipedia"] is True
    # The advertised default matches what the API actually applies server-side.
    assert set(body["default"]) == {"lookup", "calculator"}
    # Every tool an operator can pick comes with a description to pick it by.
    assert all(t["description"] for t in body["tools"])


def test_list_projects_is_newest_first_and_summarised(monkeypatch):
    import time

    c = _client(monkeypatch)
    assert c.get("/projects").json() == {"projects": []}

    first = c.post("/projects", json={"brief": "first", "agent_count": 1}).json()["project_id"]
    second = c.post("/projects", json={"brief": "second", "agent_count": 1}).json()["project_id"]
    time.sleep(0.01)
    c.post(f"/projects/{first}/compile")  # touching a project moves it to the top

    projects = c.get("/projects").json()["projects"]
    assert [p["project_id"] for p in projects] == [first, second]
    assert projects[0] == {
        "project_id": first,
        "brief": "first",
        "orchestration_pattern": "sequential",
        "agent_count": 1,
        "compiled": True,
        "created_at": projects[0]["created_at"],
        "updated_at": projects[0]["updated_at"],
    }
    assert projects[1]["compiled"] is False
    assert "plan" not in projects[0]


def test_list_providers_marks_the_default(monkeypatch):
    c = _client(monkeypatch)
    providers = c.get("/providers").json()["providers"]
    defaults = [p for p in providers if p["default"]]
    assert len(defaults) == 1
    assert defaults[0]["provider"] == "google_genai"


def test_create_project_default_excludes_side_effect_tools(monkeypatch):
    c = _client(monkeypatch)
    seen_kwargs = {}

    def spy(**kw):
        seen_kwargs.update(kw)
        return _plan()

    monkeypatch.setattr(app_module, "plan_project", spy)
    r = c.post("/projects", json={"brief": "x", "agent_count": 1})
    assert r.status_code == 201
    assert "web_search" not in seen_kwargs["available_tools"]
    assert "lookup" in seen_kwargs["available_tools"]
    assert r.json()["side_effect_tools_enabled"] == []


def test_create_project_explicit_web_search_is_opt_in(monkeypatch):
    c = _client(monkeypatch)
    seen_kwargs = {}

    def spy(**kw):
        seen_kwargs.update(kw)
        return _plan()

    monkeypatch.setattr(app_module, "plan_project", spy)
    r = c.post(
        "/projects",
        json={"brief": "x", "agent_count": 1, "available_tools": ["lookup", "web_search"]},
    )
    assert r.status_code == 201
    assert seen_kwargs["available_tools"] == ["lookup", "web_search"]
    assert r.json()["side_effect_tools_enabled"] == ["web_search"]

    pid = r.json()["project_id"]
    assert c.get(f"/projects/{pid}").json()["side_effect_tools_enabled"] == ["web_search"]


# ------------------------------------------------------------------ /revise
def _revision(**overrides):
    from agentic_platform.agent_schema import PlanRevision

    fields = {"reply": "Changed it.", "brief": "x", "plan": _plan()}
    return PlanRevision(**{**fields, **overrides})


def _two_agent_plan():
    plan = _plan()
    second = plan.agents[0].model_copy(update={"id": "b", "depends_on": ["a"]})
    return plan.model_copy(update={"agents": [plan.agents[0], second]})


def test_revise_changes_plan_and_brief_and_records_the_conversation(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x"}).json()["project_id"]
    c.post(f"/projects/{pid}/compile")
    monkeypatch.setattr(
        app_module, "revise_plan",
        lambda **kw: _revision(reply="Added a second agent.", brief="x, twice", plan=_two_agent_plan()),
    )

    r = c.post(f"/projects/{pid}/revise", json={"message": "add a reviewer"})
    assert r.status_code == 200
    body = r.json()
    assert body["changed"] is True
    assert body["reply"]["content"] == "Added a second agent."
    assert body["reply"]["plan_version"] == 2
    project = body["project"]
    assert project["brief"] == "x, twice"
    assert [a["id"] for a in project["plan"]["agents"]] == ["a", "b"]
    assert project["plan_version"] == 2
    assert project["compiled"] is False  # a changed plan must be compiled again
    assert [m["role"] for m in project["conversation"]] == ["user", "assistant"]
    assert c.get(f"/projects/{pid}").json() == project


def test_revise_that_changes_nothing_keeps_the_project_compiled(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x"}).json()["project_id"]
    c.post(f"/projects/{pid}/compile")
    monkeypatch.setattr(app_module, "revise_plan", lambda **kw: _revision(reply="It runs in sequence."))

    body = c.post(f"/projects/{pid}/revise", json={"message": "how does it run?"}).json()
    assert body["changed"] is False
    assert body["reply"]["plan_version"] is None
    assert body["project"]["compiled"] is True
    assert body["project"]["plan_version"] == 1
    assert len(body["project"]["conversation"]) == 2


def test_revise_offers_only_opted_in_external_tools(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post(
        "/projects", json={"brief": "x", "available_tools": ["lookup", "wikipedia"]}
    ).json()["project_id"]
    seen = {}

    def spy(**kw):
        seen.update(kw)
        return _revision()

    monkeypatch.setattr(app_module, "revise_plan", spy)
    c.post(f"/projects/{pid}/revise", json={"message": "add web search"})
    assert "wikipedia" in seen["available_tools"]
    assert "calculator" in seen["available_tools"]
    assert "web_search" not in seen["available_tools"]


def test_revise_planner_failure_saves_nothing(monkeypatch):
    from agentic_platform.errors import PlannerError

    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x"}).json()["project_id"]

    def fail(**kw):
        raise PlannerError("planner failed", attempts=3, last_error="bad")

    monkeypatch.setattr(app_module, "revise_plan", fail)
    r = c.post(f"/projects/{pid}/revise", json={"message": "change it"})
    assert r.status_code == 422
    assert r.json()["error_type"] == "PlannerFailed"
    project = c.get(f"/projects/{pid}").json()
    assert project["conversation"] == []
    assert project["plan_version"] == 1


def test_revise_conflict_when_the_plan_moved_on(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x"}).json()["project_id"]

    def edit_meanwhile(**kw):
        # Someone saves a manual edit while the planner is thinking.
        app_module._store.update_plan(pid, _plan())
        return _revision(plan=_two_agent_plan())

    monkeypatch.setattr(app_module, "revise_plan", edit_meanwhile)
    r = c.post(f"/projects/{pid}/revise", json={"message": "add an agent"})
    assert r.status_code == 409
    assert r.json()["error_type"] == "PlanConflict"
    assert len(c.get(f"/projects/{pid}").json()["plan"]["agents"]) == 1


def test_revise_rejects_an_empty_message(monkeypatch):
    c = _client(monkeypatch)
    pid = c.post("/projects", json={"brief": "x"}).json()["project_id"]
    assert c.post(f"/projects/{pid}/revise", json={"message": ""}).status_code == 422
