"""The central policy: scope, visibility, fail-closed behaviour (P1.4)."""

import time
import uuid

import pytest

from agentic_platform import policy
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.policy import Actor, can, can_see_user_in_teams, scope_for, visible_projects
from agentic_platform.rbac_backfill import DEFAULT_TEAM_ID, backfill
from agentic_platform.stores import (
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUserStore,
    MongoProjectStore,
    MongoTeamStore,
    MongoUserStore,
    ProjectRecord,
    TeamMembership,
    TeamRecord,
    UserRecord,
)

from .test_stores import backend  # noqa: F401


def _plan():
    return AgentPlan(
        agents=[AgentSpec(id="a", role="w", system_prompt="p", llm=LLMConfig(provider="google_genai", model="m"))],
        orchestration_pattern="sequential",
    )


def project(owner, team_id=None, team_access=False):
    return ProjectRecord(id=uuid.uuid4().hex, tenant_id=owner, brief="b", plan=_plan(), team_id=team_id, team_access=team_access)


# actors used throughout: team A and team B
SUPER = Actor("super", "master")
SUB = Actor("sub", "admin")
GA_A = Actor("ga", "user", {"A": "group_admin", "B": "member"})  # group admin of A, plain member of B
MEM_A = Actor("ma", "user", {"A": "member"})
MEM_B = Actor("mb", "user", {"B": "member"})
OWNER = Actor("owner", "user", {"A": "member"})


def test_owner_sees_and_manages_their_own_project_everyone_else_does_not():
    p = project("owner")
    assert can(OWNER, "project.view", p) and can(OWNER, "project.manage", p)
    for other in (MEM_A, MEM_B, GA_A, SUB):
        assert not can(other, "project.view", p), other
        assert not can(other, "project.manage", p), other


def test_super_admin_sees_and_manages_everything():
    for p in (project("owner"), project("owner", "A", False), project("owner", "A", True)):
        assert can(SUPER, "project.view", p) and can(SUPER, "project.manage", p)


def test_team_members_see_team_projects_only_with_team_access():
    shared = project("owner", "A", True)
    private = project("owner", "A", False)
    assert can(MEM_A, "project.view", shared)
    assert not can(MEM_A, "project.view", private)
    assert not can(MEM_B, "project.view", shared)  # other team: out of scope


def test_group_admin_has_admin_powers_in_a_but_member_powers_only_in_b():
    in_a = project("owner", "A", True)
    in_b = project("owner", "B", True)
    assert can(GA_A, "project.view", in_a) and can(GA_A, "project.manage", in_a)
    assert can(GA_A, "project.view", in_b) and not can(GA_A, "project.manage", in_b)
    assert can(GA_A, "team.manage_members", "A") and not can(GA_A, "team.manage_members", "B")
    # and no reach into a team they are not in at all
    assert not can(GA_A, "project.view", project("owner", "C", True))


def test_group_admin_cannot_manage_an_owner_only_project_of_their_team():
    private = project("owner", "A", False)
    assert not can(GA_A, "project.view", private)
    assert not can(GA_A, "project.manage", private)


def test_team_and_role_actions():
    assert can(SUPER, "team.create") and not any(can(a, "team.create") for a in (SUB, GA_A, MEM_A))
    assert can(SUPER, "role.grant_sub_admin") and not any(can(a, "role.grant_sub_admin") for a in (SUB, GA_A, MEM_A))
    assert can(GA_A, "role.grant_group_admin", "A") and not can(GA_A, "role.grant_group_admin", "B")
    assert can(MEM_A, "team.view", "A") and not can(MEM_A, "team.view", "B")
    assert not can(MEM_A, "team.manage_members", "A")


def test_user_visibility():
    assert can(MEM_A, "user.view", "ma")  # themselves
    assert not can(MEM_A, "user.view", "mb")
    assert can(SUPER, "user.view", "mb") and can(SUB, "user.view", "mb")
    assert not can(GA_A, "user.view", "mb")  # team-based visibility goes through the memberships
    assert can_see_user_in_teams(GA_A, [TeamMembership(team_id="A", user_id="x")])
    assert not can_see_user_in_teams(GA_A, [TeamMembership(team_id="B", user_id="x")])  # member-only in B
    assert not can_see_user_in_teams(MEM_A, [TeamMembership(team_id="A", user_id="x")])


def test_fails_closed():
    p = project("owner")
    assert not can(None, "project.view", p)
    assert not can(SUPER, "no.such.action", p)
    assert not can(SUPER, "project.view", None)
    assert not can(SUPER, "project.manage", None)
    assert not can(GA_A, "team.manage_members", None)
    assert not can(GA_A, "team.manage_members", 123)  # malformed resource
    assert not can(Actor("x", "weird-role"), "team.create")  # an unknown org role is no role


def test_visible_projects_filters_a_list_in_one_place():
    mine = project("owner")
    shared_a = project("someone", "A", True)
    private_a = project("someone", "A", False)
    shared_b = project("someone", "B", True)
    stranger = project("stranger")
    everything = [mine, shared_a, private_a, shared_b, stranger]
    assert {p.id for p in visible_projects(everything, OWNER)} == {mine.id, shared_a.id}
    assert {p.id for p in visible_projects(everything, MEM_B)} == {shared_b.id}
    assert len(visible_projects(everything, SUPER)) == 5
    assert visible_projects(everything, Actor("nobody")) == []
    assert scope_for(OWNER).team_ids == {"A"}


# ------------------------------------------------------------- actor_for and the backfill (D6)
@pytest.fixture
def stores(backend):  # noqa: F811
    if backend is None:
        return InMemoryUserStore(), InMemoryProjectStore(), InMemoryTeamStore()
    return MongoUserStore(backend), MongoProjectStore(backend), MongoTeamStore(backend)


def _user(users, email, role="user"):
    u = UserRecord(id=uuid.uuid4().hex, email=email, password_hash="$argon2id$stub", role=role)
    users.create(u)
    return u


def test_actor_for_reads_roles_from_the_stores(stores):
    users, _projects, teams = stores
    u = _user(users, "u@example.com", "admin")
    teams.create_team(TeamRecord(id="A", name="A"))
    teams.create_team(TeamRecord(id="B", name="B"))
    teams.set_member(TeamMembership(team_id="A", user_id=u.id, role="group_admin"))
    teams.set_member(TeamMembership(team_id="B", user_id=u.id, role="member"))
    actor = policy.actor_for(u, teams)
    assert actor.is_sub_admin and actor.team_roles == {"A": "group_admin", "B": "member"}
    assert actor.admined_teams == {"A"}


def test_a_default_team_member_cannot_see_another_users_pre_existing_project(stores):
    """D6: the backfill puts old projects in the Default team, owner-only."""
    users, projects, teams = stores
    master = _user(users, "root@example.com", "master")
    ann = _user(users, "ann@example.com")
    bob = _user(users, "bob@example.com")
    sub = _user(users, "sub@example.com", "admin")
    old = project(ann.id)
    projects.create(old)
    time.sleep(0.01)
    backfill(users, projects, teams)

    stored = projects.get(old.id)
    assert stored.team_id == DEFAULT_TEAM_ID and stored.team_access is False
    as_actor = lambda u: policy.actor_for(u, teams)  # noqa: E731
    assert can(as_actor(ann), "project.view", stored)
    assert not can(as_actor(bob), "project.view", stored)  # a Default-team member
    assert not can(as_actor(sub), "project.view", stored)  # Sub Admin: no blanket access
    assert can(as_actor(master), "project.view", stored)
    assert visible_projects(projects.list_all(), as_actor(bob)) == []
    assert [p.id for p in visible_projects(projects.list_all(), as_actor(ann))] == [old.id]


# ------------------------------------------------------------------- access rank (sharing)
def _grant(project, gtype, gid, level, agent="*"):
    from agentic_platform.stores import AgentGrant

    return AgentGrant(id=AgentGrant.make_id(project.id, agent, gtype, gid), project_id=project.id, agent_id=agent,
                      grantee_type=gtype, grantee_id=gid, level=level, granted_by="owner")


def test_access_rank_owner_admin_grants_and_team_view():
    from agentic_platform.policy import OWNER_RANK, access_rank, any_access, may_share
    from agentic_platform.stores import level_rank

    p = project("owner", "A", True)
    private = project("owner", "A", False)
    assert access_rank(OWNER, p, None, []) == OWNER_RANK
    assert access_rank(SUPER, private, None, []) == OWNER_RANK
    assert access_rank(GA_A, p, None, []) == OWNER_RANK and access_rank(GA_A, private, None, []) == 0
    assert access_rank(MEM_A, p, None, []) == level_rank("view")  # team members of a shared project
    assert access_rank(MEM_A, private, None, []) == 0 and access_rank(MEM_B, p, None, []) == 0
    assert access_rank(None, p, None, []) == 0 and access_rank(OWNER, None, None, []) == 0

    g_user = _grant(private, "user", "ma", "edit")
    g_team = _grant(private, "team", "A", "use")
    g_agent = _grant(private, "user", "mb", "manage", agent="x")
    assert access_rank(MEM_A, private, None, [g_user, g_team]) == level_rank("edit")  # highest wins
    assert access_rank(MEM_A, private, None, [g_team]) == level_rank("use")
    assert access_rank(GA_A, private, None, [g_team]) == level_rank("use")  # via team A membership
    assert access_rank(MEM_B, private, "x", [g_agent]) == level_rank("manage")
    assert access_rank(MEM_B, private, "y", [g_agent]) == 0  # another agent
    assert access_rank(MEM_B, private, None, [g_agent]) == 0  # not the whole project...
    assert any_access(MEM_B, private, [g_agent]) is True  # ...but they can see that it exists
    assert not any_access(MEM_B, private, [g_user, g_team])
    # a grant on a different project never counts
    other = project("owner", "A", False)
    assert access_rank(MEM_A, other, None, [g_user, g_team]) == 0

    assert may_share(OWNER, private, "*", "manage", []) and may_share(SUPER, private, "x", "view", [])
    assert not may_share(MEM_A, private, "*", "view", [g_user])  # edit is below manage
    manage = _grant(private, "user", "ma", "manage")
    assert may_share(MEM_A, private, "*", "manage", [manage]) and may_share(MEM_A, private, "*", "use", [manage])
    assert not may_share(MEM_A, private, "*", "not-a-level", [manage])
