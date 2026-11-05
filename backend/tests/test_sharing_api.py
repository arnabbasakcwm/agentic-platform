"""Sharing agents: grants, scope and the level ceiling (P3.2)."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    AgentGrant,
    InMemoryAgentGrantStore,
    InMemoryAuditStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    TeamMembership,
    TeamRecord,
)


@pytest.fixture
def world(monkeypatch):
    for name, s in [
        ("_store", InMemoryProjectStore()),
        ("_users", InMemoryUserStore()),
        ("_usage", InMemoryUsageStore()),
        ("_teams", InMemoryTeamStore()),
        ("_audit", InMemoryAuditStore()),
        ("_grants", InMemoryAgentGrantStore()),
    ]:
        monkeypatch.setattr(app_module, name, s)
    plan = AgentPlan(
        agents=[AgentSpec(id="a", role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview")),
                AgentSpec(id="b", role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
        orchestration_pattern="sequential",
    )
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    client = TestClient(app_module.app)
    for t in ("A", "B"):
        app_module._teams.create_team(TeamRecord(id=t, name=f"Team {t}"))

    class W:
        c = client
        h = {}
        ids = {}

        @classmethod
        def user(cls, name, role=None, teams=()):
            r = client.post("/auth/register", json={"email": f"{name}@example.com", "password": "a-long-password"}).json()
            uid = r["user"]["id"]
            if role:
                app_module._users.set_role(uid, role, by="t")
            for team, tr in teams:
                app_module._teams.set_member(TeamMembership(team_id=team, user_id=uid, role=tr))
            cls.h[name], cls.ids[name] = {"Authorization": f"Bearer {r['access_token']}"}, uid
            return uid

    W.user("root", "master")
    W.user("sub", "admin")
    W.user("ann", teams=[("A", "member")])  # the owner
    W.user("ga", teams=[("A", "group_admin"), ("B", "member")])
    W.user("mem", teams=[("A", "member")])
    W.user("mem2", teams=[("A", "member")])
    W.user("bob", teams=[("B", "member")])
    W.user("out")
    pid = client.post("/projects", json={"brief": "x"}, headers=W.h["ann"]).json()["project_id"]
    app_module._store.set_team(pid, "A", True)
    W.pid = pid
    return W


def share(w, who, grantee, level="use", gtype="user", agent="*", pid=None):
    gid = w.ids.get(grantee, grantee) if gtype == "user" else grantee
    return w.c.put(f"/projects/{pid or w.pid}/grants", headers=w.h[who],
                   json={"agent_id": agent, "grantee_type": gtype, "grantee_id": gid, "level": level})


def actions(prefix="agent."):
    return [e.action for e in app_module._audit.list(limit=100) if e.action.startswith(prefix)]


def test_owner_shares_with_a_user_and_a_team_and_lists_it(world):
    w = world
    r = share(w, "ann", "mem", "use")
    assert r.status_code == 200 and r.json()["grant"]["level"] == "use" and r.json()["grant"]["granted_by"] == w.ids["ann"]
    assert share(w, "ann", "A", "view", gtype="team").status_code == 200
    got = w.c.get(f"/projects/{w.pid}/grants", headers=w.h["ann"]).json()["grants"]
    assert {(g["grantee_type"], g["level"]) for g in got} == {("user", "use"), ("team", "view")}
    assert actions() == ["agent.shared", "agent.shared"]


def test_sharing_records_one_entry_per_real_change(world):
    w = world
    share(w, "ann", "mem", "use")
    share(w, "ann", "mem", "use")  # same level: nothing changed
    share(w, "ann", "mem", "edit")  # level changed
    entries = [e for e in app_module._audit.list(limit=50) if e.action == "agent.shared"]
    assert len(entries) == 2
    assert entries[0].before == {"level": "use"} and entries[0].after == {"level": "edit"}
    gid = AgentGrant.make_id(w.pid, "*", "user", w.ids["mem"])
    w.c.delete(f"/projects/{w.pid}/grants/{gid}", headers=w.h["ann"])
    revoked = [e for e in app_module._audit.list(limit=50) if e.action == "agent.share_revoked"]
    assert len(revoked) == 1 and revoked[0].before == {"level": "edit"} and revoked[0].team_id == "A"


def test_a_single_agent_can_be_shared_and_must_exist(world):
    w = world
    assert share(w, "ann", "mem", "use", agent="b").status_code == 200
    r = share(w, "ann", "mem", "use", agent="nope")
    assert r.status_code == 422 and r.json()["error_type"] == "ShareRefused"


def test_sharing_stays_inside_the_sharers_scope(world):
    w = world
    # bob is only in team B; ann only in team A: bob does not exist as far as ann can tell
    r = share(w, "ann", "bob")
    assert r.status_code == 404
    assert share(w, "ann", "no-such-user-id").status_code == 404
    assert r.json() == share(w, "ann", "no-such-user-id").json()  # the two cases look identical
    assert share(w, "ann", "B", gtype="team").status_code == 404  # ann is not in team B
    assert share(w, "ann", "NOPE", gtype="team").status_code == 404
    assert share(w, "ann", "out").status_code == 404  # in no team
    assert share(w, "ann", "mem").status_code == 200  # teammate
    assert share(w, "ann", "A", gtype="team").status_code == 200


def test_you_cannot_share_with_yourself_or_the_owner(world):
    w = world
    assert share(w, "ann", "ann").status_code == 422
    assert share(w, "root", "ann").status_code == 422  # the owner already has everything


def test_super_admin_shares_with_anyone_who_exists(world):
    w = world
    assert share(w, "root", "bob", "manage").status_code == 200
    assert share(w, "root", "out", "use").status_code == 200
    assert share(w, "root", "B", gtype="team").status_code == 200
    assert share(w, "root", "ghost").status_code == 404


def test_group_admin_shares_only_within_the_teams_they_administer(world):
    w = world
    assert share(w, "ga", "mem2", "use").status_code == 200  # member of A
    assert share(w, "ga", "A", "view", gtype="team").status_code == 200
    assert share(w, "ga", "bob").status_code == 404  # bob is in B only; ga is a mere member there
    assert share(w, "ga", "B", gtype="team").status_code == 404
    assert share(w, "ga", "out").status_code == 404
    # a project of team B, where ga is only a member, is not theirs to share
    bobs = w.c.post("/projects", json={"brief": "y"}, headers=w.h["bob"]).json()["project_id"]
    app_module._store.set_team(bobs, "B", True)
    assert share(w, "ga", "mem2", pid=bobs).status_code == 404


def test_a_sub_admin_and_plain_viewers_cannot_share(world):
    w = world
    assert share(w, "sub", "mem").status_code == 404
    assert share(w, "mem", "mem2").status_code == 404  # a team member can view, not share
    assert share(w, "out", "mem").status_code == 404
    share(w, "ann", "mem", "edit")
    assert share(w, "mem", "mem2", "view").status_code == 404  # edit is below manage
    assert app_module._grants.list_for_project(w.pid)[0].grantee_id == w.ids["mem"]
    assert len(app_module._grants.list_for_project(w.pid)) == 1


def test_a_manage_grantee_reshares_up_to_their_level_within_their_own_scope(world):
    w = world
    share(w, "ann", "mem", "manage")
    r = share(w, "mem", "mem2", "manage")  # equal to their own level: allowed
    assert r.status_code == 200 and r.json()["grant"]["granted_by"] == w.ids["mem"]
    assert share(w, "mem", "out").status_code == 404  # not in their teams
    assert share(w, "mem", "B", gtype="team").status_code == 404
    # they can only touch what they granted
    owners = share(w, "ann", "ga", "use")
    assert owners.status_code == 200
    assert share(w, "mem", "ga", "view").status_code == 404
    assert app_module._grants.get(owners.json()["grant"]["id"]).level == "use"
    gid = owners.json()["grant"]["id"]
    assert w.c.delete(f"/projects/{w.pid}/grants/{gid}", headers=w.h["mem"]).status_code == 404
    mine = AgentGrant.make_id(w.pid, "*", "user", w.ids["mem2"])
    assert w.c.delete(f"/projects/{w.pid}/grants/{mine}", headers=w.h["mem"]).status_code == 200


def test_a_grant_on_one_agent_does_not_let_you_share_the_whole_project(world):
    w = world
    share(w, "ann", "mem", "manage", agent="a")
    assert share(w, "mem", "mem2", "use", agent="a").status_code == 200
    assert share(w, "mem", "mem2", "use", agent="b").status_code == 404
    assert share(w, "mem", "mem2", "use", agent="*").status_code == 404


def test_grant_lists_are_for_managers_only(world):
    w = world
    share(w, "ann", "mem", "use")
    share(w, "ann", "mem2", "manage")
    assert w.c.get(f"/projects/{w.pid}/grants", headers=w.h["mem"]).status_code == 404
    assert w.c.get(f"/projects/{w.pid}/grants", headers=w.h["out"]).status_code == 404
    assert w.c.get(f"/projects/{w.pid}/grants", headers=w.h["mem2"]).status_code == 200
    assert w.c.get(f"/projects/{w.pid}/grants", headers=w.h["ga"]).status_code == 200
    assert w.c.get(f"/projects/{w.pid}/grants").status_code == 401


def test_revoking_removes_the_grant_and_missing_or_foreign_ones_are_404(world):
    w = world
    g = share(w, "ann", "mem", "use").json()["grant"]["id"]
    other = w.c.post("/projects", json={"brief": "z"}, headers=w.h["mem"]).json()["project_id"]
    assert w.c.delete(f"/projects/{other}/grants/{g}", headers=w.h["mem"]).status_code == 404  # wrong project
    assert w.c.delete(f"/projects/{w.pid}/grants/{g}", headers=w.h["out"]).status_code == 404
    assert w.c.delete(f"/projects/{w.pid}/grants/{g}", headers=w.h["ann"]).status_code == 200
    assert w.c.delete(f"/projects/{w.pid}/grants/{g}", headers=w.h["ann"]).status_code == 404
    assert app_module._grants.list_for_project(w.pid) == []


def test_grants_disappear_with_their_project_and_with_a_deleted_team(world):
    w = world
    share(w, "ann", "mem", "use")
    share(w, "ann", "A", "view", gtype="team")
    assert w.c.delete("/teams/A", headers=w.h["root"]).status_code == 200
    assert [g.grantee_type for g in app_module._grants.list_for_project(w.pid)] == ["user"]
    assert w.c.delete(f"/projects/{w.pid}", headers=w.h["ann"]).status_code == 200
    assert app_module._grants.list_for_project(w.pid) == []


def test_refused_shares_write_no_audit_entry(world):
    w = world
    share(w, "sub", "mem")
    share(w, "ann", "bob")
    share(w, "ann", "mem", agent="nope")
    share(w, "ann", "ann")
    assert actions() == []
