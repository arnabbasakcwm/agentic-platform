"""Team CRUD, membership and team usage APIs (P2.4)."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.rbac_backfill import DEFAULT_TEAM_ID
from agentic_platform.stores import (
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    TeamMembership,
    TeamRecord,
    UsageRecord,
)


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

    def login(email, role=None, teams=()):
        r = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()
        uid = r["user"]["id"]
        if role:
            app_module._users.set_role(uid, role, by="test")
        for team, team_role in teams:
            app_module._teams.set_member(TeamMembership(team_id=team, user_id=uid, role=team_role))
        return {"Authorization": f"Bearer {r['access_token']}"}, uid

    client.login = login
    for t in ("A", "B"):
        app_module._teams.create_team(TeamRecord(id=t, name=f"Team {t}"))
    app_module._teams.create_team(TeamRecord(id=DEFAULT_TEAM_ID, name="Default"))
    return client


def members(team):
    return {m.user_id: m.role for m in app_module._teams.list_members(team)}


# --------------------------------------------------------------------------- create / list / get
def test_only_the_super_admin_creates_teams(api):
    root, _ = api.login("root@example.com", "master")
    r = api.post("/teams", json={"name": "  Growth   team "}, headers=root)
    assert r.status_code == 201 and r.json()["team"]["name"] == "Growth team" and r.json()["team"]["members"] == 0
    assert api.post("/teams", json={"name": ""}, headers=root).status_code == 422
    assert api.post("/teams", json={"name": "   "}, headers=root).status_code == 422
    for who, kw in [("sub", dict(role="admin")), ("ga", dict(teams=[("A", "group_admin")])), ("mem", dict(teams=[("A", "member")]))]:
        h, _ = api.login(f"{who}@example.com", **kw)
        assert api.post("/teams", json={"name": "x"}, headers=h).status_code == 404, who
    assert api.post("/teams", json={"name": "x"}).status_code == 401


def test_lists_show_only_your_teams_and_the_super_admin_sees_all(api):
    root, _ = api.login("root@example.com", "master")
    mem, _ = api.login("mem@example.com", teams=[("A", "member"), ("B", "member")])
    ga, _ = api.login("ga@example.com", teams=[("A", "group_admin")])
    out, _ = api.login("out@example.com")

    def names(h):
        return {t["id"]: t["my_role"] for t in api.get("/teams", headers=h).json()["teams"]}

    assert set(names(root)) == {"A", "B", DEFAULT_TEAM_ID}
    assert names(mem) == {"A": "member", "B": "member"}
    assert names(ga) == {"A": "group_admin"}
    assert names(out) == {}
    assert api.get("/teams/A", headers=ga).json()["team"]["name"] == "Team A"
    assert api.get("/teams/B", headers=ga).status_code == 404  # not their team
    assert api.get("/teams/A", headers=out).status_code == 404
    assert api.get("/teams/NOPE", headers=root).status_code == 404


# --------------------------------------------------------------------------- rename / delete
def test_rename_by_super_admin_and_own_group_admin_only(api):
    root, _ = api.login("root@example.com", "master")
    ga, _ = api.login("ga@example.com", teams=[("A", "group_admin"), ("B", "member")])
    mem, _ = api.login("mem@example.com", teams=[("A", "member")])
    assert api.patch("/teams/A", json={"name": "Alpha"}, headers=ga).json()["team"]["name"] == "Alpha"
    assert api.patch("/teams/B", json={"name": "Beta"}, headers=root).status_code == 200
    assert api.patch("/teams/B", json={"name": "Hijack"}, headers=ga).status_code == 404  # member-only in B
    assert api.patch("/teams/A", json={"name": "Hijack"}, headers=mem).status_code == 404
    assert app_module._teams.get_team("B").name == "Beta"


def test_delete_is_super_admin_only_and_makes_projects_personal(api):
    root, _ = api.login("root@example.com", "master")
    ga, _ = api.login("ga@example.com", teams=[("A", "group_admin")])
    ann, ann_id = api.login("ann@example.com", teams=[("A", "member")])
    pid = api.post("/projects", json={"brief": "x"}, headers=ann).json()["project_id"]
    app_module._store.set_team(pid, "A", True)
    assert api.delete("/teams/A", headers=ga).status_code == 404
    assert app_module._teams.get_team("A") is not None
    r = api.delete("/teams/A", headers=root)
    assert r.status_code == 200 and r.json()["projects_made_personal"] == 1
    assert app_module._teams.get_team("A") is None and app_module._teams.memberships_of(ann_id) == []
    p = app_module._store.get(pid)
    assert p.team_id is None and p.team_access is False
    assert api.get(f"/projects/{pid}", headers=ann).status_code == 200  # still theirs
    assert api.get(f"/projects/{pid}", headers=ga).status_code == 404  # no longer shared


def test_the_default_team_cannot_be_deleted(api):
    root, _ = api.login("root@example.com", "master")
    r = api.delete(f"/teams/{DEFAULT_TEAM_ID}", headers=root)
    assert r.status_code == 409 and r.json()["error_type"] == "TeamProtected"
    assert api.patch(f"/teams/{DEFAULT_TEAM_ID}", json={"name": "Everyone"}, headers=root).status_code == 200


# --------------------------------------------------------------------------- membership
def test_member_lists_are_for_admins_only(api):
    root, _ = api.login("root@example.com", "master")
    ga, ga_id = api.login("ga@example.com", teams=[("A", "group_admin")])
    mem, mem_id = api.login("mem@example.com", teams=[("A", "member")])
    gb, _ = api.login("gb@example.com", teams=[("B", "group_admin")])
    got = {m["user_id"]: (m["email"], m["role"]) for m in api.get("/teams/A/members", headers=ga).json()["members"]}
    assert got == {ga_id: ("ga@example.com", "group_admin"), mem_id: ("mem@example.com", "member")}
    assert len(api.get("/teams/A/members", headers=root).json()["members"]) == 2
    assert api.get("/teams/A/members", headers=mem).status_code == 404  # a member doesn't see colleagues
    assert api.get("/teams/A/members", headers=gb).status_code == 404  # another team's admin


def test_only_the_super_admin_adds_members_and_only_as_plain_members(api):
    root, _ = api.login("root@example.com", "master")
    ga, _ = api.login("ga@example.com", teams=[("A", "group_admin")])
    _, newbie = api.login("new@example.com")
    assert api.put(f"/teams/A/members/{newbie}", headers=ga).status_code == 404
    assert members("A").get(newbie) is None
    r = api.put(f"/teams/A/members/{newbie}", headers=root)
    assert r.status_code == 200 and r.json()["membership"]["role"] == "member"
    assert api.put(f"/teams/A/members/{newbie}", headers=root).status_code == 200  # idempotent
    assert members("A")[newbie] == "member"
    assert api.put("/teams/A/members/nobody", headers=root).status_code == 404
    assert api.put(f"/teams/NOPE/members/{newbie}", headers=root).status_code == 404


def test_adding_an_existing_group_admin_does_not_demote_them(api):
    root, _ = api.login("root@example.com", "master")
    _, ga_id = api.login("ga@example.com", teams=[("A", "group_admin")])
    api.put(f"/teams/A/members/{ga_id}", headers=root)
    assert members("A")[ga_id] == "group_admin"


def test_group_admin_removes_members_but_not_peers(api):
    root, _ = api.login("root@example.com", "master")
    ga, ga_id = api.login("ga@example.com", teams=[("A", "group_admin")])
    _, peer = api.login("peer@example.com", teams=[("A", "group_admin")])
    _, mem = api.login("mem@example.com", teams=[("A", "member")])
    _, other = api.login("other@example.com", teams=[("B", "member")])
    assert api.delete(f"/teams/A/members/{mem}", headers=ga).status_code == 200
    assert mem not in members("A")
    assert api.delete(f"/teams/A/members/{peer}", headers=ga).status_code == 404  # a peer admin
    assert members("A")[peer] == "group_admin"
    assert api.delete(f"/teams/A/members/{other}", headers=ga).status_code == 404  # not in this team
    assert api.delete(f"/teams/B/members/{other}", headers=ga).status_code == 404  # not their team
    assert members("B")[other] == "member"
    assert api.delete(f"/teams/A/members/{peer}", headers=root).status_code == 200  # the master may
    assert api.delete(f"/teams/A/members/{ga_id}", headers=ga).status_code == 200  # leaving yourself
    assert members("A") == {}


def test_removed_members_lose_the_teams_projects_at_once(api):
    root, _ = api.login("root@example.com", "master")
    owner, _ = api.login("owner@example.com", teams=[("A", "member")])
    mem, mem_id = api.login("mem@example.com", teams=[("A", "member")])
    pid = api.post("/projects", json={"brief": "x"}, headers=owner).json()["project_id"]
    app_module._store.set_team(pid, "A", True)
    assert api.get(f"/projects/{pid}", headers=mem).status_code == 200
    api.delete(f"/teams/A/members/{mem_id}", headers=root)
    assert api.get(f"/projects/{pid}", headers=mem).status_code == 404


# --------------------------------------------------------------------------- team usage
def _use(tenant, project, tokens, kind="run", run="r1"):
    return UsageRecord(
        id=f"{tenant}-{project}-{run}-{kind}", tenant_id=tenant, project_id=project, at=datetime.now(timezone.utc),
        kind=kind, run_id=run, provider="google_genai", model="gemini-3.1-pro-preview", calls=1,
        input_tokens=tokens, output_tokens=0, cost=0.5,
    )


def test_team_usage_counts_only_the_teams_shared_projects(api):
    ga, ga_id = api.login("ga@example.com", teams=[("A", "group_admin")])
    ann, ann_id = api.login("ann@example.com", teams=[("A", "member"), ("B", "member")])
    gb, _ = api.login("gb@example.com", teams=[("B", "group_admin")])
    mem, _ = api.login("mem@example.com", teams=[("A", "member")])

    def project(h, team, access):
        pid = api.post("/projects", json={"brief": "SECRET BRIEF"}, headers=h).json()["project_id"]
        app_module._store.set_team(pid, team, access)
        return pid

    shared = project(ann, "A", True)
    private = project(ann, "A", False)  # owner-only: the group admin must not see its usage
    in_b = project(ann, "B", True)
    personal = project(ann, None, False)
    app_module._usage.add_many([
        _use(ann_id, shared, 1000),
        _use(ga_id, shared, 300, run="r2"),  # a different member running the shared project
        _use(ann_id, private, 7000),
        _use(ann_id, in_b, 5000),
        _use(ann_id, personal, 9000),
        _use(ann_id, None, 4000, kind="planner"),
    ])
    body = api.get("/teams/A/usage", headers=ga).json()
    assert body["team"]["name"] == "Team A"
    assert body["totals"]["input_tokens"] == 1300
    by_member = {m["email"]: m["input_tokens"] for m in body["members"]}
    assert by_member == {"ga@example.com": 300, "ann@example.com": 1000, "mem@example.com": 0}
    assert "SECRET BRIEF" not in str(body)  # project names only, never briefs
    assert api.get("/teams/A/usage", headers=gb).status_code == 404  # another team's admin
    assert api.get("/teams/A/usage", headers=mem).status_code == 404  # a plain member


def test_super_admin_reads_any_team_usage(api):
    root, _ = api.login("root@example.com", "master")
    assert api.get("/teams/B/usage", headers=root).status_code == 200
    assert api.get("/teams/NOPE/usage", headers=root).status_code == 404
