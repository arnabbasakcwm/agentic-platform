"""Authorization matrix: roles x actions x in-scope / out-of-scope.

One declarative table is the contract. Later RBAC tasks add rows (and API-level checks
that out-of-scope ids answer 404) rather than writing ad-hoc tests. A guard test fails if
a policy action is added without a row here, so no action ships unreviewed.

Fixture world: team A (ga = group admin, ma = member), team B (mb = member; ga is also a
plain member of B). `own` is owned by ma. Resources are projects placed in A or B.
"""

import uuid

import pytest

from agentic_platform import policy
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.policy import Actor, can
from agentic_platform.stores import ProjectRecord


def _project(owner, team_id=None, team_access=False):
    plan = AgentPlan(
        agents=[AgentSpec(id="a", role="w", system_prompt="p", llm=LLMConfig(provider="google_genai", model="m"))],
        orchestration_pattern="sequential",
    )
    return ProjectRecord(id=uuid.uuid4().hex, tenant_id=owner, brief="b", plan=plan, team_id=team_id, team_access=team_access)


ACTORS = {
    "super": Actor("super", "master"),
    "sub": Actor("sub", "admin"),
    "ga_a": Actor("ga", "user", {"A": "group_admin", "B": "member"}),
    "member_a": Actor("ma", "user", {"A": "member"}),
    "member_b": Actor("mb", "user", {"B": "member"}),
    "outsider": Actor("zz", "user", {}),
}

RESOURCES = {
    "own_personal": _project("ma"),  # owned by member_a, no team
    "a_shared": _project("ma", "A", True),  # team A, visible to the team
    "a_private": _project("ma", "A", False),  # team A but owner-only
    "b_shared": _project("mb", "B", True),  # the other team
    "stranger": _project("someone-else"),
}

# (action, resource key or literal) -> the set of actors that are ALLOWED. Everyone else is denied.
ALL = set(ACTORS)
MATRIX = {
    ("project.view", "own_personal"): {"super", "member_a"},
    ("project.view", "a_shared"): {"super", "member_a", "ga_a"},
    ("project.view", "a_private"): {"super", "member_a"},
    ("project.view", "b_shared"): {"super", "member_b", "ga_a"},  # ga_a is a member of B
    ("project.view", "stranger"): {"super"},
    ("project.manage", "own_personal"): {"super", "member_a"},
    ("project.manage", "a_shared"): {"super", "member_a", "ga_a"},
    ("project.manage", "a_private"): {"super", "member_a"},
    ("project.manage", "b_shared"): {"super", "member_b"},  # ga_a: member-only in B
    ("project.manage", "stranger"): {"super"},
    ("team.create", None): {"super"},
    ("team.view", "A"): {"super", "ga_a", "member_a"},
    ("team.view", "B"): {"super", "ga_a", "member_b"},
    ("audit.view", "A"): {"super", "sub", "ga_a"},  # org-wide for admins, own team for its group admin
    ("audit.view", "B"): {"super", "sub"},  # ga_a is only a member of B
    ("audit.view", None): {"super", "sub"},
    ("team.add_member", "A"): {"super"},  # choosing from all users needs org-wide sight
    ("team.delete", "A"): {"super"},
    ("team.manage_members", "A"): {"super", "ga_a"},
    ("team.manage_members", "B"): {"super"},  # ga_a is only a member of B
    ("role.grant_sub_admin", None): {"super"},
    ("role.grant_group_admin", "A"): {"super", "ga_a"},
    ("role.grant_group_admin", "B"): {"super"},
    ("role.revoke_group_admin", ("A", "ga")): {"super", "ga_a"},  # stepping down yourself
    ("role.revoke_group_admin", ("A", "ma")): {"super"},  # a peer cannot remove another admin
    ("role.revoke_group_admin", ("B", "ga")): {"super"},  # ga_a is only a member of B
    # user.view is org-level only; a group admin seeing their team's users goes through
    # policy.can_see_user_in_teams (needs memberships) and is covered in test_policy.py.
    ("user.view", "ma"): {"super", "sub", "member_a"},
    ("user.view", "mb"): {"super", "sub", "member_b"},
}


def _resource(key):
    return RESOURCES.get(key, key)


CASES = [(action, key, actor) for (action, key), allowed in MATRIX.items() for actor in ACTORS]


@pytest.mark.parametrize("action,key,actor", CASES, ids=[f"{a}|{k}|{w}" for a, k, w in CASES])
def test_matrix(action, key, actor):
    allowed = actor in MATRIX[(action, key)]
    assert can(ACTORS[actor], action, _resource(key)) is allowed


def test_every_policy_action_has_matrix_rows():
    covered = {action for action, _ in MATRIX}
    assert covered == set(policy._ACTIONS), "add matrix rows for: " + ", ".join(sorted(set(policy._ACTIONS) ^ covered))


def test_a_sub_admin_never_gets_project_access_without_a_share():
    for key in RESOURCES:
        assert not can(ACTORS["sub"], "project.view", RESOURCES[key])


def test_unknown_resources_and_actions_are_denied_for_everyone():
    for actor in ACTORS.values():
        assert not can(actor, "project.view", None)
        assert not can(actor, "nope", RESOURCES["own_personal"])
