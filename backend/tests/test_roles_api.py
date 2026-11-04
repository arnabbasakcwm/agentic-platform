"""Role APIs and the no-escalation rule (P2.3)."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.stores import (
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    TeamMembership,
    TeamRecord,
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
        app_module._teams.create_team(TeamRecord(id=t, name=t))
    return client


def role_in(team, uid):
    m = app_module._teams.get_membership(team, uid)
    return m.role if m else None


def test_super_admin_grants_and_revokes_group_admin(api):
    root, _ = api.login("root@example.com", "master")
    _, ann = api.login("ann@example.com", teams=[("A", "member")])
    r = api.put(f"/teams/A/admins/{ann}", headers=root)
    assert r.status_code == 200 and r.json()["membership"] == {"team_id": "A", "user_id": ann, "role": "group_admin"}
    assert api.put(f"/teams/A/admins/{ann}", headers=root).status_code == 200  # idempotent
    assert api.delete(f"/teams/A/admins/{ann}", headers=root).json()["membership"]["role"] == "member"
    assert role_in("A", ann) == "member"  # still in the team
    assert api.delete(f"/teams/A/admins/{ann}", headers=root).status_code == 200  # idempotent


def test_group_admin_can_appoint_within_their_team_only(api):
    ga, _ = api.login("ga@example.com", teams=[("A", "group_admin"), ("B", "member")])
    _, ann = api.login("ann@example.com", teams=[("A", "member"), ("B", "member")])
    assert api.put(f"/teams/A/admins/{ann}", headers=ga).status_code == 200
    assert role_in("A", ann) == "group_admin"
    # team B: ga is only a member there -> indistinguishable from a team that is not there
    assert api.put(f"/teams/B/admins/{ann}", headers=ga).status_code == 404
    assert role_in("B", ann) == "member"


def test_nobody_else_can_appoint(api):
    _, ann = api.login("ann@example.com", teams=[("A", "member")])
    for who, kw in [
        ("mem", dict(teams=[("A", "member")])),
        ("out", dict()),
        ("sub", dict(role="admin")),  # a Sub Admin has no team powers
        ("gb", dict(teams=[("B", "group_admin")])),  # admin of ANOTHER team
    ]:
        h, _ = api.login(f"{who}@example.com", **kw)
        assert api.put(f"/teams/A/admins/{ann}", headers=h).status_code == 404, who
    assert role_in("A", ann) == "member"
    assert api.put(f"/teams/A/admins/{ann}").status_code == 401


def test_the_target_must_exist_and_already_be_a_member(api):
    root, _ = api.login("root@example.com", "master")
    _, outsider = api.login("out@example.com")
    r = api.put(f"/teams/A/admins/{outsider}", headers=root)
    assert r.status_code == 409 and r.json()["error_type"] == "NotATeamMember"
    assert role_in("A", outsider) is None  # nothing was created
    assert api.put("/teams/A/admins/nobody", headers=root).status_code == 404
    assert api.put(f"/teams/NOPE/admins/{outsider}", headers=root).status_code == 404


def test_a_group_admin_can_step_down_but_not_remove_a_peer(api):
    ga1, id1 = api.login("g1@example.com", teams=[("A", "group_admin")])
    _, id2 = api.login("g2@example.com", teams=[("A", "group_admin")])
    assert api.delete(f"/teams/A/admins/{id2}", headers=ga1).status_code == 404
    assert role_in("A", id2) == "group_admin"
    assert api.delete(f"/teams/A/admins/{id1}", headers=ga1).status_code == 200
    assert role_in("A", id1) == "member"
    # having stepped down, they can no longer appoint anyone
    assert api.put(f"/teams/A/admins/{id2}", headers=ga1).status_code == 404


def test_group_admin_role_never_changes_an_org_role(api):
    root, _ = api.login("root@example.com", "master")
    _, ann = api.login("ann@example.com", teams=[("A", "member")])
    api.put(f"/teams/A/admins/{ann}", headers=root)
    assert app_module._users.get(ann).role == "user"  # a team role is not an org role


# ---------------------------------------------------- Sub Admin / Super Admin (no escalation)
def test_only_the_super_admin_can_make_a_sub_admin(api):
    root, _ = api.login("root@example.com", "master")
    sub, sub_id = api.login("sub@example.com", "admin")
    _, ann = api.login("ann@example.com")
    assert api.put(f"/admin/users/{ann}/role", json={"role": "admin"}, headers=root).status_code == 200
    assert app_module._users.get(ann).role == "admin"
    assert api.put(f"/admin/users/{ann}/role", json={"role": "user"}, headers=root).status_code == 200
    # a Sub Admin cannot create another Sub Admin, nor promote themselves, nor demote the master
    r = api.put(f"/admin/users/{ann}/role", json={"role": "admin"}, headers=sub)
    assert r.status_code == 403 and r.json()["error_type"] == "MasterAdminRequired"
    assert api.put(f"/admin/users/{sub_id}/role", json={"role": "admin"}, headers=sub).status_code == 403
    assert app_module._users.get(ann).role == "user"


def test_nobody_can_grant_super_admin_through_the_api(api):
    root, root_id = api.login("root@example.com", "master")
    sub, _ = api.login("sub@example.com", "admin")
    _, ann = api.login("ann@example.com")
    # the master is refused by validation (no such assignable role); a Sub Admin never gets that far
    r = api.put(f"/admin/users/{ann}/role", json={"role": "master"}, headers=root)
    assert r.status_code == 422
    r = api.put(f"/admin/users/{ann}/role", json={"role": "master"}, headers=sub)
    assert r.status_code == 403
    assert app_module._users.get(ann).role == "user"
    # and the master's own role can't be changed here either
    r = api.put(f"/admin/users/{root_id}/role", json={"role": "user"}, headers=root)
    assert r.status_code == 409 and r.json()["error_type"] == "MasterAdmin"


def test_plain_users_do_not_even_see_the_admin_role_route(api):
    h, uid = api.login("bob@example.com", teams=[("A", "group_admin")])
    assert api.put(f"/admin/users/{uid}/role", json={"role": "admin"}, headers=h).status_code == 404
    assert app_module._users.get(uid).role == "user"
