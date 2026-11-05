"""Contract tests for AgentGrantStore (P3.1), in-memory and MongoDB."""

import time

import pytest
from pydantic import ValidationError

from agentic_platform.stores import (
    GRANT_LEVELS,
    WHOLE_PROJECT,
    AgentGrant,
    InMemoryAgentGrantStore,
    MongoAgentGrantStore,
    level_rank,
)

from .test_stores import backend  # noqa: F401


@pytest.fixture
def grants(backend):  # noqa: F811
    return InMemoryAgentGrantStore() if backend is None else MongoAgentGrantStore(backend)


def grant(project="p1", agent=WHOLE_PROJECT, gtype="user", gid="u1", level="use", by="owner"):
    return AgentGrant(
        id=AgentGrant.make_id(project, agent, gtype, gid), project_id=project, agent_id=agent,
        grantee_type=gtype, grantee_id=gid, level=level, granted_by=by,
    )


def test_levels_are_cumulative_and_unknown_levels_rank_lowest():
    assert GRANT_LEVELS == ("view", "use", "edit", "manage")
    assert level_rank("view") < level_rank("use") < level_rank("edit") < level_rank("manage")
    assert level_rank("root") == 0 and level_rank("") == 0 and level_rank("view") > 0


def test_invalid_level_or_grantee_type_is_rejected():
    with pytest.raises(ValidationError):
        grant(level="owner")
    with pytest.raises(ValidationError):
        AgentGrant(id="x", project_id="p", grantee_type="group", grantee_id="g", level="use", granted_by="o")


def test_upsert_get_and_changing_the_level_keeps_one_grant(grants):
    g = grant(level="use")
    grants.upsert(g)
    assert grants.get(g.id) == g
    grants.upsert(grant(level="edit", by="admin"))
    assert len(grants.list_for_project("p1")) == 1
    got = grants.get(g.id)
    assert got.level == "edit" and got.granted_by == "admin"
    assert grants.get("missing") is None


def test_different_agents_and_grantees_are_separate_grants(grants):
    for g in (grant(agent="a"), grant(agent="b"), grant(gid="u2"), grant(gtype="team", gid="u1")):
        grants.upsert(g)
    assert len(grants.list_for_project("p1")) == 4
    assert grants.list_for_project("other") == []


def test_revoke_removes_only_that_grant(grants):
    a, b = grant(gid="u1"), grant(gid="u2")
    grants.upsert(a)
    grants.upsert(b)
    assert grants.revoke(a.id) is True and grants.revoke(a.id) is False
    assert [g.grantee_id for g in grants.list_for_project("p1")] == ["u2"]


def test_list_for_grantee_reaches_user_and_team_grants_only(grants):
    mine = grant(gid="u1")
    via_team = grant(project="p2", gtype="team", gid="A")
    other_user = grant(project="p3", gid="u2")
    other_team = grant(project="p4", gtype="team", gid="B")
    for g in (mine, via_team, other_user, other_team):
        grants.upsert(g)
    assert {g.id for g in grants.list_for_grantee("u1", ["A"])} == {mine.id, via_team.id}
    assert {g.id for g in grants.list_for_grantee("u1", [])} == {mine.id}
    assert grants.list_for_grantee("nobody", []) == []
    # a team id is never mistaken for a user id of the same value
    assert grants.list_for_grantee("A", []) == []


def test_delete_for_project_and_for_grantee(grants):
    for g in (grant(), grant(gid="u2"), grant(project="p2"), grant(project="p3", gtype="team", gid="A")):
        grants.upsert(g)
    assert grants.delete_for_project("p1") == 2
    assert grants.list_for_project("p1") == [] and len(grants.list_for_project("p2")) == 1
    assert grants.delete_for_grantee("team", "A") == 1
    assert grants.delete_for_grantee("user", "u1") == 1
    assert grants.delete_for_grantee("user", "u1") == 0
