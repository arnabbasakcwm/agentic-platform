"""Project lists are scoped: own projects plus what a person's teams share (P2.1)."""

import time
import uuid

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform import policy
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    MongoProjectStore,
    MongoTeamStore,
    ProjectRecord,
    TeamMembership,
    TeamRecord,
)

from .test_stores import backend  # noqa: F401


@pytest.fixture
def api(monkeypatch):
    for name, store in [
        ("_store", InMemoryProjectStore()),
        ("_users", InMemoryUserStore()),
        ("_usage", InMemoryUsageStore()),
        ("_teams", InMemoryTeamStore()),
    ]:
        monkeypatch.setattr(app_module, name, store)
    plan = AgentPlan(
        agents=[AgentSpec(id="a", role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
        orchestration_pattern="sequential",
    )
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    client = TestClient(app_module.app)

    def login(email):
        r = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()
        return {"Authorization": f"Bearer {r['access_token']}"}, r["user"]["id"]

    def make(headers, brief):
        return client.post("/projects", json={"brief": brief}, headers=headers).json()["project_id"]

    client.login, client.make = login, make
    for team in ("A", "B"):
        app_module._teams.create_team(TeamRecord(id=team, name=team))
    return client


def _join(user_id, team, role="member"):
    app_module._teams.set_member(TeamMembership(team_id=team, user_id=user_id, role=role))


def _ids(response):
    assert response.status_code == 200
    return {p["project_id"] for p in response.json()["projects"]}


def test_a_member_lists_their_own_plus_what_their_team_shares(api):
    ada_h, ada = api.login("ada@example.com")
    bob_h, bob = api.login("bob@example.com")
    _join(ada, "A")
    _join(bob, "A")
    own = api.make(ada_h, "ada's own")
    shared = api.make(bob_h, "bob shares with team A")
    private = api.make(bob_h, "bob keeps this")
    app_module._store.set_team(shared, "A", True)
    app_module._store.set_team(private, "A", False)  # in the team but owner-only
    assert _ids(api.get("/projects", headers=ada_h)) == {own, shared}
    assert _ids(api.get("/projects", headers=bob_h)) == {shared, private}


def test_another_teams_projects_never_appear(api):
    ada_h, ada = api.login("ada@example.com")
    bob_h, bob = api.login("bob@example.com")
    _join(ada, "A")
    _join(bob, "B")
    theirs = api.make(bob_h, "bob's team B project")
    app_module._store.set_team(theirs, "B", True)
    assert theirs not in _ids(api.get("/projects", headers=ada_h))


def test_group_admin_of_a_sees_a_but_only_member_level_in_b(api):
    ga_h, ga = api.login("ga@example.com")
    bob_h, bob = api.login("bob@example.com")
    _join(ga, "A", "group_admin")
    _join(ga, "B", "member")
    _join(bob, "A")
    in_a = api.make(bob_h, "team A")
    in_a_private = api.make(bob_h, "team A private")
    in_b = api.make(bob_h, "team B")
    app_module._store.set_team(in_a, "A", True)
    app_module._store.set_team(in_a_private, "A", False)
    app_module._store.set_team(in_b, "B", True)
    assert _ids(api.get("/projects", headers=ga_h)) == {in_a, in_b}  # never the private one


def test_summaries_say_whose_and_which_team(api):
    ada_h, ada = api.login("ada@example.com")
    bob_h, bob = api.login("bob@example.com")
    _join(ada, "A")
    mine = api.make(ada_h, "mine")
    theirs = api.make(bob_h, "theirs")
    app_module._store.set_team(theirs, "A", True)
    rows = {p["project_id"]: p for p in api.get("/projects", headers=ada_h).json()["projects"]}
    assert rows[mine]["mine"] is True and rows[mine]["team_id"] is None
    assert rows[theirs]["mine"] is False and rows[theirs]["team_id"] == "A" and rows[theirs]["team_access"] is True


def test_super_admin_lists_all_only_on_request_and_nobody_else_can(api):
    root_h, root = api.login("root@example.com")
    app_module._users.set_role(root, "master", by="test")
    sub_h, sub = api.login("sub@example.com")
    app_module._users.set_role(sub, "admin", by="test")
    ada_h, _ = api.login("ada@example.com")
    mine = api.make(root_h, "root's")
    adas = api.make(ada_h, "ada's personal")
    assert _ids(api.get("/projects", headers=root_h)) == {mine}  # default list stays "mine"
    assert _ids(api.get("/projects?scope=all", headers=root_h)) == {mine, adas}
    assert _ids(api.get("/projects?scope=all", headers=sub_h)) == set()  # ignored, never widened
    assert _ids(api.get("/projects?scope=all", headers=ada_h)) == {adas}


def test_unauthenticated_list_is_refused(api):
    assert api.get("/projects").status_code == 401


# --------------------------------------------------------------- the store query, both backends
def test_list_for_teams_returns_only_team_visible_projects(backend):  # noqa: F811
    store = InMemoryProjectStore() if backend is None else MongoProjectStore(backend)
    plan = AgentPlan(
        agents=[AgentSpec(id="a", role="w", system_prompt="p", llm=LLMConfig(provider="google_genai", model="m"))],
        orchestration_pattern="sequential",
    )

    def put(team_id, access):
        r = ProjectRecord(id=uuid.uuid4().hex, tenant_id="o", brief="b", plan=plan, team_id=team_id, team_access=access)
        store.create(r)
        return r.id

    a_shared, a_private, b_shared, personal = put("A", True), put("A", False), put("B", True), put(None, False)
    assert {p.id for p in store.list_for_teams(["A"])} == {a_shared}
    assert {p.id for p in store.list_for_teams(["A", "B"])} == {a_shared, b_shared}
    assert store.list_for_teams([]) == []
    assert a_private not in {p.id for p in store.list_for_teams(["A", "B"])} and personal not in {p.id for p in store.list_for_teams(["A"])}
