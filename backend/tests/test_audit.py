"""The audit log: append-only, exactly one correct entry per privileged change, scoped reads (P2.5)."""

import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform import audit
from agentic_platform.rbac_backfill import DEFAULT_TEAM_ID
from agentic_platform.stores import (
    AuditEntry,
    InMemoryAuditStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    MongoAuditStore,
    TeamMembership,
    TeamRecord,
)

from .test_stores import backend  # noqa: F401


# ------------------------------------------------------------------------- the store contract
@pytest.fixture
def store(backend):  # noqa: F811
    return InMemoryAuditStore() if backend is None else MongoAuditStore(backend)


def _entry(action="team.created", team_id="A", at=None, **kw):
    return AuditEntry(id=uuid.uuid4().hex, actor_id="root", action=action, target_type="team", target_id="t",
                      team_id=team_id, at=at or datetime.now(timezone.utc), **kw)


def test_entries_round_trip_newest_first(store):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    old = _entry(at=now - timedelta(minutes=5), before={"name": "x"}, after={"name": "y"}, details={"n": 1})
    new = _entry(action="team.renamed", at=now)
    store.append(old)
    store.append(new)
    got = store.list()
    assert [e.id for e in got] == [new.id, old.id]
    assert got[1] == old  # before/after/details survive
    assert [e.id for e in store.list(limit=1)] == [new.id]
    assert [e.id for e in store.list(before=now)] == [old.id]


def test_filters_by_team_and_action(store):
    a, b, none = _entry(team_id="A"), _entry(team_id="B", action="team.renamed"), _entry(team_id=None)
    for e in (a, b, none):
        store.append(e)
    assert {e.id for e in store.list(team_id="A")} == {a.id}
    assert {e.id for e in store.list(team_ids=["A", "B"])} == {a.id, b.id}  # org-level entries are not a team's
    assert {e.id for e in store.list(team_ids=[])} == set()
    assert {e.id for e in store.list(action="team.renamed")} == {b.id}


def test_the_store_offers_no_way_to_change_or_remove_an_entry(store):
    for name in ("update", "delete", "remove", "clear", "set", "replace", "update_entry", "delete_entry"):
        assert not hasattr(store, name), name


def test_appending_the_same_id_twice_never_rewrites_history(backend):  # noqa: F811
    if backend is None:
        pytest.skip("Mongo-specific: _id is unique there")
    from pymongo.errors import DuplicateKeyError

    s = MongoAuditStore(backend)
    e = _entry()
    s.append(e)
    with pytest.raises(Exception) as exc:
        s.append(e.model_copy(update={"action": "tampered"}))
    assert isinstance(exc.value, DuplicateKeyError) or "uplicate" in str(exc.value) or "unavailable" in str(exc.value).lower()
    assert s.list()[0].action == "team.created"


# ------------------------------------------------------------------------------- the API
@pytest.fixture
def api(monkeypatch):
    for name, s in [
        ("_store", InMemoryProjectStore()),
        ("_users", InMemoryUserStore()),
        ("_usage", InMemoryUsageStore()),
        ("_teams", InMemoryTeamStore()),
        ("_audit", InMemoryAuditStore()),
    ]:
        monkeypatch.setattr(app_module, name, s)
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


def entries():
    return app_module._audit.list(limit=500)


def only(action):
    found = [e for e in entries() if e.action == action]
    assert len(found) == 1, [e.action for e in entries()]
    return found[0]


def test_creating_renaming_and_deleting_a_team_each_write_one_entry(api):
    root, root_id = api.login("root@example.com", "master")
    tid = api.post("/teams", json={"name": "Growth"}, headers=root).json()["team"]["id"]
    e = only("team.created")
    assert (e.actor_id, e.target_type, e.target_id, e.team_id, e.after) == (root_id, "team", tid, tid, {"name": "Growth"})
    api.patch(f"/teams/{tid}", json={"name": "Growth"}, headers=root)  # same name: nothing changed
    assert not [x for x in entries() if x.action == "team.renamed"]
    api.patch(f"/teams/{tid}", json={"name": "Revenue"}, headers=root)
    e = only("team.renamed")
    assert (e.before, e.after, e.team_id) == ({"name": "Growth"}, {"name": "Revenue"}, tid)
    api.delete(f"/teams/{tid}", headers=root)
    e = only("team.deleted")
    assert e.before == {"name": "Revenue"} and e.details == {"projects_made_personal": 0}
    assert len(entries()) == 3


def test_membership_and_group_admin_changes_write_exactly_one_entry_each(api):
    root, root_id = api.login("root@example.com", "master")
    _, ann = api.login("ann@example.com")
    api.put(f"/teams/A/members/{ann}", headers=root)
    api.put(f"/teams/A/members/{ann}", headers=root)  # already a member: no change, no entry
    e = only("team.member_added")
    assert (e.actor_id, e.target_id, e.team_id, e.after) == (root_id, ann, "A", {"role": "member"})
    api.put(f"/teams/A/admins/{ann}", headers=root)
    api.put(f"/teams/A/admins/{ann}", headers=root)  # idempotent
    e = only("team.group_admin_granted")
    assert (e.before, e.after, e.team_id) == ({"role": "member"}, {"role": "group_admin"}, "A")
    api.delete(f"/teams/A/admins/{ann}", headers=root)
    api.delete(f"/teams/A/admins/{ann}", headers=root)
    e = only("team.group_admin_revoked")
    assert (e.before, e.after) == ({"role": "group_admin"}, {"role": "member"})
    api.delete(f"/teams/A/members/{ann}", headers=root)
    e = only("team.member_removed")
    assert e.before == {"role": "member"} and e.target_id == ann
    assert len(entries()) == 4


def test_org_role_changes_are_recorded_with_before_and_after(api):
    root, root_id = api.login("root@example.com", "master")
    _, ann = api.login("ann@example.com")
    api.put(f"/admin/users/{ann}/role", json={"role": "admin"}, headers=root)
    api.put(f"/admin/users/{ann}/role", json={"role": "admin"}, headers=root)  # no change
    e = only("user.role_changed")
    assert (e.actor_id, e.target_id, e.team_id, e.before, e.after) == (root_id, ann, None, {"role": "user"}, {"role": "admin"})
    api.put(f"/admin/users/{ann}/role", json={"role": "user"}, headers=root)
    assert [x.after for x in entries() if x.action == "user.role_changed"] == [{"role": "user"}, {"role": "admin"}]


def test_refused_attempts_write_nothing(api):
    root, _ = api.login("root@example.com", "master")
    mem, mem_id = api.login("mem@example.com", teams=[("A", "member")])
    sub, _ = api.login("sub@example.com", "admin")
    _, ann = api.login("ann@example.com", teams=[("A", "member")])
    attempts = [
        api.put(f"/teams/A/admins/{ann}", headers=mem),
        api.put(f"/admin/users/{ann}/role", json={"role": "admin"}, headers=sub),
        api.post("/teams", json={"name": "x"}, headers=mem),
        api.delete("/teams/A", headers=mem),
        api.delete(f"/teams/{DEFAULT_TEAM_ID}", headers=root),  # protected
        api.put("/teams/A/admins/nobody", headers=root),
        api.put(f"/teams/A/admins/{uuid.uuid4().hex}", headers=root),
    ]
    assert all(r.status_code >= 400 for r in attempts)
    assert entries() == []


def test_entries_never_carry_secrets_or_emails(api):
    root, _ = api.login("root@example.com", "master")
    _, ann = api.login("ann@example.com")
    api.put(f"/teams/A/members/{ann}", headers=root)
    api.put(f"/admin/users/{ann}/role", json={"role": "admin"}, headers=root)
    blob = str([e.model_dump() for e in entries()])
    for needle in ("password", "argon2", "a-long-password", "@example.com"):
        assert needle not in blob


def test_a_failing_audit_write_is_logged_not_fatal(api, monkeypatch, caplog):
    root, _ = api.login("root@example.com", "master")

    def boom(entry):
        raise RuntimeError("db down")

    monkeypatch.setattr(app_module._audit, "append", boom)
    with caplog.at_level("ERROR"):
        r = api.post("/teams", json={"name": "Still created"}, headers=root)
    assert r.status_code == 201
    assert any("AUDIT WRITE FAILED" in m and "team.created" in m for m in caplog.messages)


# ------------------------------------------------------------------------------ who may read
def test_who_reads_what(api):
    root, _ = api.login("root@example.com", "master")
    sub, _ = api.login("sub@example.com", "admin")
    ga, _ = api.login("ga@example.com", teams=[("A", "group_admin"), ("B", "member")])
    mem, mem_id = api.login("mem@example.com", teams=[("A", "member")])
    out, _ = api.login("out@example.com")
    api.patch("/teams/A", json={"name": "Alpha"}, headers=root)
    api.patch("/teams/B", json={"name": "Beta"}, headers=root)
    api.put(f"/admin/users/{mem_id}/role", json={"role": "admin"}, headers=root)  # org-level (no team)
    api.put(f"/admin/users/{mem_id}/role", json={"role": "user"}, headers=root)

    def actions(h, **params):
        r = api.get("/audit", params=params, headers=h)
        assert r.status_code == 200, r.text
        return [e["action"] for e in r.json()["entries"]]

    assert len(actions(root)) == 4 and len(actions(sub)) == 4  # org-wide, including org-level entries
    assert actions(root, team_id="B") == ["team.renamed"]
    assert actions(ga) == ["team.renamed"]  # only team A: not B (member there), not org-level
    assert actions(ga, team_id="A") == ["team.renamed"]
    assert api.get("/audit", params={"team_id": "B"}, headers=ga).status_code == 404
    assert api.get("/audit", headers=mem).status_code == 404
    assert api.get("/audit", headers=out).status_code == 404
    assert api.get("/audit").status_code == 401
    assert actions(root, limit=1) == ["user.role_changed"]
    assert actions(root, action="team.renamed") == ["team.renamed", "team.renamed"]
