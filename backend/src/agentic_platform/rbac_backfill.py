"""Moving an existing installation onto teams (decision D1, D2, D5, D6).

There is no migration tool (document store), so this is an idempotent backfill that the
app runs at start-up and that `scripts/rbac_backfill.py` can run or undo by hand.

What it does, once:
  * creates the "Default" team;
  * makes every existing user a member (the master a group admin of it) - roles on
    `UserRecord.role` are untouched, so today's admins keep exactly what they had (D1/D2);
  * places every existing personal project in the Default team with `team_access=False`,
    which keeps it **owner-only**: belonging to the team does not expose it (D6).

"Existing" means created at or before the Default team itself. That makes a re-run harmless
(later projects and users are left alone, and a project someone has since moved is never
touched) and lets an interrupted run simply continue. The team is marked `backfill_done` at the very end, so later runs do nothing (an admin who
removes a member or moves a project is never overridden) while an interrupted run resumes.
Nothing is deleted and no role is
widened. `rollback` puts the projects back to personal and removes the team.
"""

from __future__ import annotations

import logging
from typing import Any

from .stores import ProjectStore, TeamMembership, TeamRecord, TeamStore, UserStore

logger = logging.getLogger(__name__)

DEFAULT_TEAM_ID = "default"
DEFAULT_TEAM_NAME = "Default"


def backfill(users: UserStore, projects: ProjectStore, teams: TeamStore) -> dict[str, Any]:
    team = teams.get_team(DEFAULT_TEAM_ID)
    created = team is None
    if team is None:
        team = TeamRecord(id=DEFAULT_TEAM_ID, name=DEFAULT_TEAM_NAME)
        teams.create_team(team)
    if team.backfill_done:  # ran to completion before: later removals/moves by admins stand
        return {"team_created": False, "members_added": 0, "projects_placed": 0}
    cutoff = team.created_at

    members = 0
    for user in users.list_all():
        if user.created_at > cutoff or teams.get_membership(team.id, user.id) is not None:
            continue
        role = "group_admin" if user.role == "master" else "member"
        teams.set_member(TeamMembership(team_id=team.id, user_id=user.id, role=role, added_by=None))
        members += 1

    placed = 0
    for project in projects.list_all():
        if project.team_id is None and project.created_at <= cutoff:
            projects.set_team(project.id, team.id, False)
            placed += 1

    teams.create_team(team.model_copy(update={"backfill_done": True}))  # last: an interrupted run resumes
    result = {"team_created": created, "members_added": members, "projects_placed": placed}
    if created or members or placed:
        logger.info("rbac backfill: %s", result)
    return result


def rollback(projects: ProjectStore, teams: TeamStore) -> dict[str, Any]:
    """Undo `backfill`: the Default team's projects go back to personal (owner-only), and
    the team with its memberships is removed. Users, roles and projects are kept."""
    restored = 0
    for project in projects.list_all():
        if project.team_id == DEFAULT_TEAM_ID:
            projects.set_team(project.id, None, False)
            restored += 1
    removed = teams.delete_team(DEFAULT_TEAM_ID)
    return {"team_removed": removed, "projects_restored": restored}
