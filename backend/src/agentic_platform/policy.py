"""The one place that decides who may do what (RBAC).

Routes and stores ask this module; they never re-implement a rule. Everything fails
closed: an unknown action, a missing resource or a missing record is a "no".

Roles (decisions D1/D2):
  * Super Admin  = `UserRecord.role == "master"`.
  * Sub Admin    = `role == "admin"`. Today it only reads usage; any further power comes
                   from explicit grants (`Actor.grants`, empty until later tasks add them).
  * Group Admin  = a `group_admin` membership of a team, per team, never global.
  * Member       = everyone else; a plain `member` membership gives team-level reach only.

Project visibility (decision D6/D8): the owner sees their project; the Super Admin sees
every project; a team's members see a project of that team only when its owner or an
admin set `team_access` (so projects that predate teams stay owner-only). Group admins get
no extra *visibility* beyond the team members' - they get management rights over projects
the team can see. Out-of-scope reads must be answered with 404 by the caller.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .stores import ProjectRecord, ProjectStore, TeamMembership, TeamStore, UserRecord

MASTER = "master"
ADMIN = "admin"


@dataclass(frozen=True)
class Actor:
    """Who is asking: their org-level role plus their role in each team."""

    user_id: str
    org_role: str = "user"  # "user" | "admin" | "master"
    team_roles: dict[str, str] = field(default_factory=dict)  # team_id -> "member" | "group_admin"
    grants: frozenset[str] = frozenset()  # delegated powers of a Sub Admin (none yet)

    @property
    def is_master(self) -> bool:
        return self.org_role == MASTER

    @property
    def is_sub_admin(self) -> bool:
        return self.org_role == ADMIN

    def in_team(self, team_id: str | None) -> bool:
        return team_id is not None and team_id in self.team_roles

    def admins_team(self, team_id: str | None) -> bool:
        return team_id is not None and self.team_roles.get(team_id) == "group_admin"

    @property
    def admined_teams(self) -> frozenset[str]:
        return frozenset(t for t, r in self.team_roles.items() if r == "group_admin")


def actor_for(user: UserRecord, teams: TeamStore) -> Actor:
    """Build the actor for a signed-in user from the stores (a store failure propagates:
    never fall back to a more powerful default)."""
    roles = {m.team_id: m.role for m in teams.memberships_of(user.id)}
    role = user.role if user.role in (MASTER, ADMIN) else "user"
    return Actor(user_id=user.id, org_role=role, team_roles=roles)


# ----------------------------------------------------------------------------- scope
@dataclass(frozen=True)
class Scope:
    """What an actor may see, as data a store query can use (no per-row policy calls)."""

    everything: bool  # Super Admin: all projects
    owner_id: str  # projects they own
    team_ids: frozenset[str]  # teams whose team_access projects they may see

    def includes_project(self, project: ProjectRecord) -> bool:
        if self.everything or project.tenant_id == self.owner_id:
            return True
        return bool(project.team_access and project.team_id is not None and project.team_id in self.team_ids)


def scope_for(actor: Actor) -> Scope:
    return Scope(
        everything=actor.is_master,
        owner_id=actor.user_id,
        team_ids=frozenset(actor.team_roles),
    )


def visible_projects(projects: list[ProjectRecord], actor: Actor) -> list[ProjectRecord]:
    """Filter a project list to what the actor may see."""
    scope = scope_for(actor)
    return [p for p in projects if scope.includes_project(p)]


def list_visible_projects(store: ProjectStore, actor: Actor, *, everything: bool = False) -> list[ProjectRecord]:
    """The projects an actor may list, newest first: their own, plus those their teams
    share. `everything=True` (honoured for the Super Admin only) adds every project.
    Two indexed queries, never one per row; the scope filter runs again on the result as a
    second line of defence."""
    if everything and actor.is_master:
        found = store.list_all()
    else:
        found = store.list_for_tenant(actor.user_id) + store.list_for_teams(list(actor.team_roles))
    unique = {p.id: p for p in found}
    scope = scope_for(actor)
    visible = [p for p in unique.values() if scope.includes_project(p)]
    visible.sort(key=lambda p: p.updated_at, reverse=True)
    return visible


# ------------------------------------------------------------------------------ can()
def _project_view(actor: Actor, project: ProjectRecord | None) -> bool:
    return project is not None and scope_for(actor).includes_project(project)


def _project_manage(actor: Actor, project: ProjectRecord | None) -> bool:
    """Edit, share and administer a project: the owner, the Super Admin, or a group admin
    of the project's team (for projects the team can see)."""
    if project is None:
        return False
    if actor.is_master or project.tenant_id == actor.user_id:
        return True
    return bool(project.team_access and actor.admins_team(project.team_id))


def _team_id(resource: Any) -> str | None:
    return resource if isinstance(resource, str) else getattr(resource, "team_id", None) or getattr(resource, "id", None)


def _manage_team_members(actor: Actor, team: Any) -> bool:
    team_id = _team_id(team)
    return team_id is not None and (actor.is_master or actor.admins_team(team_id))


def _revoke_group_admin(actor: Actor, resource: Any) -> bool:
    """resource = (team_id, target_user_id). The Super Admin may remove any group admin; a
    group admin may only step down themselves, so peers cannot lock each other out."""
    team_id, target_id = resource
    if actor.is_master:
        return True
    return actor.admins_team(team_id) and target_id == actor.user_id


def _see_user(actor: Actor, target: Any) -> bool:
    """Usage/profile of another user: everyone org-wide for the Super and Sub Admin, a group
    admin only for members of a team they administer, anyone for themselves."""
    target_id = target if isinstance(target, str) else getattr(target, "user_id", None)
    if target_id is None:
        return False
    if target_id == actor.user_id or actor.is_master or actor.is_sub_admin:
        return True
    return False  # team-member users need the team store: use `can_see_user_in_teams`


_ACTIONS: dict[str, Callable[[Actor, Any], bool]] = {
    "project.view": _project_view,
    "project.manage": _project_manage,
    "team.create": lambda actor, _r: actor.is_master,
    "team.view": lambda actor, r: actor.is_master or actor.in_team(_team_id(r)),
    "team.manage_members": _manage_team_members,
    "role.grant_sub_admin": lambda actor, _r: actor.is_master,
    "role.grant_group_admin": _manage_team_members,  # master, or the team's own group admin
    "role.revoke_group_admin": _revoke_group_admin,
    "user.view": _see_user,
}


def can(actor: Actor | None, action: str, resource: Any = None) -> bool:
    """Whether `actor` may perform `action` on `resource`. Unknown actions, a missing actor
    or a missing resource all answer False."""
    if actor is None:
        return False
    rule = _ACTIONS.get(action)
    if rule is None:
        return False
    try:
        return bool(rule(actor, resource))
    except Exception:  # noqa: BLE001 - a malformed resource must never turn into a "yes"
        return False


def can_see_user_in_teams(actor: Actor, target_memberships: list[TeamMembership]) -> bool:
    """A group admin may see a user who is a member of any team the admin administers."""
    admined = actor.admined_teams
    return any(m.team_id in admined for m in target_memberships)
