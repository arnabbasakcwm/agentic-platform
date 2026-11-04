"""Contract tests for TeamStore, run against the in-memory and (when reachable) MongoDB stores."""

import time
import uuid

import pytest
from pydantic import ValidationError

from agentic_platform.stores import (
    InMemoryTeamStore,
    MongoTeamStore,
    TeamMembership,
    TeamRecord,
)

from .test_stores import backend  # noqa: F401  (fixture: None = memory, else a throwaway Mongo db)


@pytest.fixture
def teams(backend):  # noqa: F811
    return InMemoryTeamStore() if backend is None else MongoTeamStore(backend)


def _team(name="Sales"):
    return TeamRecord(id=uuid.uuid4().hex, name=name)


def test_create_get_list_round_trip(teams):
    a = _team("A")
    teams.create_team(a)
    time.sleep(0.01)
    b = _team("B")  # built after the pause, so its created_at is later
    teams.create_team(b)
    assert teams.get_team(a.id) == a
    assert teams.get_team("missing") is None
    assert [t.id for t in teams.list_teams()] == [a.id, b.id]


def test_rename_validates_and_missing_team_is_none(teams):
    t = _team()
    teams.create_team(t)
    assert teams.rename_team(t.id, "Support").name == "Support"
    assert teams.get_team(t.id).name == "Support"
    assert teams.rename_team("missing", "x") is None
    with pytest.raises(ValidationError):
        teams.rename_team(t.id, "")


def test_one_row_per_team_and_user_role_change_replaces(teams):
    t = _team()
    teams.create_team(t)
    teams.set_member(TeamMembership(team_id=t.id, user_id="u1", role="member"))
    teams.set_member(TeamMembership(team_id=t.id, user_id="u1", role="group_admin", added_by="root"))
    members = teams.list_members(t.id)
    assert len(members) == 1 and members[0].role == "group_admin" and members[0].added_by == "root"
    assert teams.get_membership(t.id, "u1").role == "group_admin"
    assert teams.get_membership(t.id, "nobody") is None


def test_a_user_has_a_different_role_in_each_team(teams):
    a, b = _team("A"), _team("B")
    teams.create_team(a)
    teams.create_team(b)
    teams.set_member(TeamMembership(team_id=a.id, user_id="u1", role="group_admin"))
    teams.set_member(TeamMembership(team_id=b.id, user_id="u1", role="member"))
    roles = {m.team_id: m.role for m in teams.memberships_of("u1")}
    assert roles == {a.id: "group_admin", b.id: "member"}
    assert teams.memberships_of("someone-else") == []


def test_members_of_one_team_are_not_listed_for_another(teams):
    a, b = _team("A"), _team("B")
    teams.create_team(a)
    teams.create_team(b)
    teams.set_member(TeamMembership(team_id=a.id, user_id="u1"))
    assert teams.list_members(b.id) == []


def test_remove_member(teams):
    t = _team()
    teams.create_team(t)
    teams.set_member(TeamMembership(team_id=t.id, user_id="u1"))
    assert teams.remove_member(t.id, "u1") is True
    assert teams.remove_member(t.id, "u1") is False
    assert teams.memberships_of("u1") == []


def test_deleting_a_team_removes_its_memberships_only(teams):
    a, b = _team("A"), _team("B")
    teams.create_team(a)
    teams.create_team(b)
    teams.set_member(TeamMembership(team_id=a.id, user_id="u1"))
    teams.set_member(TeamMembership(team_id=b.id, user_id="u1"))
    assert teams.delete_team(a.id) is True
    assert teams.delete_team(a.id) is False
    assert [m.team_id for m in teams.memberships_of("u1")] == [b.id]


def test_a_membership_for_a_missing_team_is_not_stored(teams):
    teams.set_member(TeamMembership(team_id="ghost", user_id="u1"))
    assert teams.memberships_of("u1") == []


def test_invalid_role_is_rejected():
    with pytest.raises(ValidationError):
        TeamMembership(team_id="t", user_id="u", role="owner")
