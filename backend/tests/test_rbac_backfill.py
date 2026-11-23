"""The teams backfill: idempotent, never widens access, reversible (decisions D1, D2, D6)."""

import time
import uuid

import pytest

from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.rbac_backfill import DEFAULT_TEAM_ID, backfill, rollback
from agentic_platform.stores import (
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUserStore,
    MongoProjectStore,
    MongoTeamStore,
    MongoUserStore,
    ProjectRecord,
    UserRecord,
)

from .test_stores import backend  # noqa: F401


@pytest.fixture
def stores(backend):  # noqa: F811
    if backend is None:
        return InMemoryUserStore(), InMemoryProjectStore(), InMemoryTeamStore()
    return MongoUserStore(backend), MongoProjectStore(backend), MongoTeamStore(backend)


def _plan():
    return AgentPlan(
        agents=[AgentSpec(id="a", role="w", system_prompt="p", llm=LLMConfig(provider="google_genai", model="m"))],
        orchestration_pattern="sequential",
    )


def _user(users, email, role="user"):
    u = UserRecord(id=uuid.uuid4().hex, email=email, password_hash="$argon2id$stub", role=role)
    users.create(u)
    return u


def _project(projects, owner):
    r = ProjectRecord(id=uuid.uuid4().hex, tenant_id=owner.id, brief="b", plan=_plan())
    projects.create(r)
    return r


def _world(stores):
    users, projects, teams = stores
    master = _user(users, "root@example.com", "master")
    admin = _user(users, "admin@example.com", "admin")
    ann = _user(users, "ann@example.com")
    bob = _user(users, "bob@example.com")
    pa, pb = _project(projects, ann), _project(projects, bob)
    time.sleep(0.01)  # everything above predates the team
    return master, admin, ann, bob, pa, pb


def test_existing_users_and_projects_move_into_the_default_team(stores):
    users, projects, teams = stores
    master, admin, ann, bob, pa, pb = _world(stores)
    result = backfill(users, projects, teams)
    assert result == {"team_created": True, "members_added": 4, "projects_placed": 2}
    assert teams.get_team(DEFAULT_TEAM_ID).name == "Default"
    roles = {m.user_id: m.role for m in teams.list_members(DEFAULT_TEAM_ID)}
    assert roles == {master.id: "group_admin", admin.id: "member", ann.id: "member", bob.id: "member"}
    for p in (pa, pb):
        got = projects.get(p.id)
        assert got.team_id == DEFAULT_TEAM_ID and got.team_access is False


def test_backfill_is_idempotent_and_leaves_later_data_alone(stores):
    users, projects, teams = stores
    _master, _admin, ann, bob, pa, pb = _world(stores)
    backfill(users, projects, teams)
    teams.remove_member(DEFAULT_TEAM_ID, bob.id)  # an admin's later change must stick
    newcomer = _user(users, "late@example.com")
    late = _project(projects, newcomer)
    assert backfill(users, projects, teams) == {"team_created": False, "members_added": 0, "projects_placed": 0}
    assert teams.get_membership(DEFAULT_TEAM_ID, bob.id) is None
    assert teams.get_membership(DEFAULT_TEAM_ID, newcomer.id) is None
    assert projects.get(late.id).team_id is None  # created after the team: stays personal


def test_a_project_someone_moved_is_not_touched(stores):
    users, projects, teams = stores
    _master, _admin, ann, bob, pa, pb = _world(stores)
    projects.set_team(pa.id, "other-team", True)
    backfill(users, projects, teams)
    got = projects.get(pa.id)
    assert got.team_id == "other-team" and got.team_access is True


def test_backfill_changes_no_role_and_widens_nothing(stores):
    users, projects, teams = stores
    master, admin, ann, bob, pa, pb = _world(stores)
    before = {u.id: u.role for u in users.list_all()}
    backfill(users, projects, teams)
    assert {u.id: u.role for u in users.list_all()} == before
    assert teams.get_membership(DEFAULT_TEAM_ID, admin.id).role == "member"  # D1: no new power


def test_rollback_restores_personal_projects_and_removes_the_team(stores):
    users, projects, teams = stores
    _master, _admin, ann, bob, pa, pb = _world(stores)
    backfill(users, projects, teams)
    assert rollback(projects, teams) == {"team_removed": True, "projects_restored": 2}
    assert teams.get_team(DEFAULT_TEAM_ID) is None
    assert teams.memberships_of(ann.id) == []
    for p in (pa, pb):
        got = projects.get(p.id)
        assert got.team_id is None and got.team_access is False
        assert got.brief == "b" and got.plan == p.plan  # nothing else changed
    assert len(users.list_all()) == 4
    # and it can be applied again
    assert backfill(users, projects, teams)["projects_placed"] == 2


def test_old_project_documents_without_team_fields_read_as_personal(stores):
    users, projects, teams = stores
    owner = _user(users, "o@example.com")
    r = _project(projects, owner)
    got = projects.get(r.id)
    assert got.team_id is None and got.team_access is False


def _snapshot(users, projects):
    """What a copy of the installation holds: the documents the backfill can touch."""
    return (
        {u.id: u.model_dump() for u in users.list_all()},
        {p.id: p.model_dump() for p in projects.list_all()},
    )


def test_rollback_on_a_copy_matches_the_original_and_leaves_the_source_alone(stores):
    """P7.3: apply the backfill to a copy, undo it there, and compare with the pre-backfill state."""
    from agentic_platform import policy

    users, projects, teams = stores
    _master, _admin, ann, bob, pa, pb = _world(stores)
    before = _snapshot(users, projects)
    seen_before = {
        u.id: sorted(p.id for p in policy.visible_projects(projects.list_all(), policy.actor_for(u, teams)))
        for u in users.list_all()
    }

    # the "copy": in-memory stores loaded with the same documents (never the live ones)
    copy_users, copy_projects, copy_teams = InMemoryUserStore(), InMemoryProjectStore(), InMemoryTeamStore()
    for u in users.list_all():
        copy_users.create(u)
    for p in projects.list_all():
        copy_projects.create(p)

    time.sleep(0.01)
    backfill(copy_users, copy_projects, copy_teams)
    assert _snapshot(copy_users, copy_projects) != before  # the copy really changed
    rollback(copy_projects, copy_teams)

    assert _snapshot(copy_users, copy_projects) == before  # byte-for-byte what it was
    assert copy_teams.get_team(DEFAULT_TEAM_ID) is None
    seen_after = {
        u.id: sorted(p.id for p in policy.visible_projects(copy_projects.list_all(), policy.actor_for(u, copy_teams)))
        for u in copy_users.list_all()
    }
    assert seen_after == seen_before  # nobody sees more or less than before
    assert _snapshot(users, projects) == before  # the source was never touched
    assert teams.get_team(DEFAULT_TEAM_ID) is None
