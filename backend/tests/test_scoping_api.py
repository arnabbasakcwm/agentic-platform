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
    RunRecord,
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


# ------------------------------------------------------------------- by-id access (P2.2)
def _setup_team_project(api):
    """ada owns a project shared with team A; ga administers A; mem is a plain member of A;
    out is in no team. Returns headers and ids."""
    ada_h, ada = api.login("ada@example.com")
    ga_h, ga = api.login("ga@example.com")
    mem_h, mem = api.login("mem@example.com")
    out_h, out = api.login("out@example.com")
    _join(ada, "A")
    _join(ga, "A", "group_admin")
    _join(mem, "A")
    pid = api.make(ada_h, "the team's project")
    app_module._store.set_team(pid, "A", True)
    return dict(ada=ada_h, ga=ga_h, mem=mem_h, out=out_h, ada_id=ada), pid


def test_outsiders_get_404_never_403_on_every_kind_of_by_id_route(api):
    h, pid = _setup_team_project(api)
    for call in (
        lambda: api.get(f"/projects/{pid}", headers=h["out"]),
        lambda: api.get(f"/projects/{pid}/runs", headers=h["out"]),
        lambda: api.get(f"/projects/{pid}/runs/nope", headers=h["out"]),
        lambda: api.get(f"/projects/{pid}/deployment", headers=h["out"]),
        lambda: api.patch(f"/projects/{pid}", json={"name": "x"}, headers=h["out"]),
        lambda: api.delete(f"/projects/{pid}", headers=h["out"]),
        lambda: api.post(f"/projects/{pid}/compile", headers=h["out"]),
    ):
        r = call()
        assert r.status_code == 404, r.text
    assert api.get(f"/projects/{pid}").status_code == 401  # no token at all
    # and a real project looks exactly like a missing one
    real = api.get(f"/projects/{pid}", headers=h["out"])
    missing = api.get("/projects/does-not-exist", headers=h["out"])
    assert real.status_code == missing.status_code == 404
    assert real.json().keys() == missing.json().keys() and real.json()["error_type"] == missing.json()["error_type"]


def test_a_plain_team_member_can_view_the_config_but_not_act(api):
    h, pid = _setup_team_project(api)
    body = api.get(f"/projects/{pid}", headers=h["mem"]).json()
    assert body["brief"] == "the team's project" and body["can_manage"] is False
    assert body["conversation"] == [] and body["knowledge"] is None and body["deployment"] is None
    assert api.patch(f"/projects/{pid}", json={"name": "x"}, headers=h["mem"]).status_code == 404
    assert api.post(f"/projects/{pid}/compile", headers=h["mem"]).status_code == 404
    assert api.delete(f"/projects/{pid}", headers=h["mem"]).status_code == 404
    assert api.get(f"/projects/{pid}/runs", headers=h["mem"]).status_code == 404
    assert api.get(f"/projects/{pid}", headers=h["ada"]).json()["can_manage"] is True


def test_an_owner_only_project_is_invisible_to_its_teammates(api):
    h, pid = _setup_team_project(api)
    app_module._store.set_team(pid, "A", False)
    for who in ("mem", "ga", "out"):
        assert api.get(f"/projects/{pid}", headers=h[who]).status_code == 404, who
    assert api.get(f"/projects/{pid}", headers=h["ada"]).status_code == 200


def test_group_admin_manages_their_teams_project_including_its_runs(api):
    h, pid = _setup_team_project(api)
    app_module._runs.create(RunRecord(id="run1", tenant_id=h["ada_id"], project_id=pid, status="completed"))
    assert api.get(f"/projects/{pid}", headers=h["ga"]).json()["can_manage"] is True
    assert [r["id"] for r in api.get(f"/projects/{pid}/runs", headers=h["ga"]).json()["runs"]] == ["run1"]
    assert api.get(f"/projects/{pid}/runs/run1", headers=h["ga"]).json()["run"]["id"] == "run1"
    assert api.patch(f"/projects/{pid}", json={"name": "renamed"}, headers=h["ga"]).status_code == 200
    assert api.get(f"/projects/{pid}/runs", headers=h["out"]).status_code == 404


def test_group_admin_of_a_has_no_management_power_in_team_b(api):
    h, _ = _setup_team_project(api)
    bob_h, bob = api.login("bob@example.com")
    _join(bob, "B")
    _join(app_module._users.get_by_email("ga@example.com").id, "B", "member")  # ga: plain member of B
    in_b = api.make(bob_h, "team B's project")
    app_module._store.set_team(in_b, "B", True)
    assert api.get(f"/projects/{in_b}", headers=h["ga"]).json()["can_manage"] is False
    assert api.patch(f"/projects/{in_b}", json={"name": "x"}, headers=h["ga"]).status_code == 404
    assert api.get(f"/projects/{in_b}/runs", headers=h["ga"]).status_code == 404


def test_super_admin_reaches_any_project_a_sub_admin_does_not(api):
    h, pid = _setup_team_project(api)
    root_h, root = api.login("root@example.com")
    sub_h, sub = api.login("sub@example.com")
    app_module._users.set_role(root, "master", by="t")
    app_module._users.set_role(sub, "admin", by="t")
    assert api.get(f"/projects/{pid}", headers=root_h).json()["can_manage"] is True
    assert api.get(f"/projects/{pid}", headers=sub_h).status_code == 404
    assert api.patch(f"/projects/{pid}", json={"name": "x"}, headers=sub_h).status_code == 404


def test_removing_someone_from_the_team_takes_effect_on_their_next_request(api):
    h, pid = _setup_team_project(api)
    assert api.get(f"/projects/{pid}", headers=h["mem"]).status_code == 200
    mem_id = app_module._users.get_by_email("mem@example.com").id
    app_module._teams.remove_member("A", mem_id)
    assert api.get(f"/projects/{pid}", headers=h["mem"]).status_code == 404
