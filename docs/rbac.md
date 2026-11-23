# Roles, teams, sharing, model limits and budgets

This is the reference for the delegation system: who can see and do what, how sharing
works, how model limits and budgets are enforced, and how to adopt or undo it on an
existing installation. Decisions and their reasons live in `.claude/rbac/DECISIONS.md`;
the route-by-route security table is in `.claude/rbac/NOTES.md`.

## Roles

| Role | Stored as | Can |
|---|---|---|
| Super Admin | `UserRecord.role = "master"` (exactly one) | everything: all projects, all teams, org model catalog, org budget, appoint Sub Admins and Group Admins |
| Sub Admin | `role = "admin"` | read usage; reach beyond that only through budget pools and grants the Super Admin gives. No blanket project access |
| Group Admin | a `group_admin` membership of one team | manage that team: rename, remove members, appoint other group admins, see team usage, set member model limits, allocate the team's budget to its members |
| Member | everyone else | own projects, plus whatever is shared with them |

Roles on the user record are never rewritten by the team backfill, so existing admins keep
exactly what they had. Out-of-scope resources are always a **404**, never a 403, so nobody
can probe what exists. The one exception is `require_master`, which answers an admin with
403 `MasterAdminRequired`.

## Teams and visibility

- Teams are created by the Super Admin. Only the Super Admin adds people to a team (a Group
  Admin sees only their own team and must not be able to enumerate accounts).
- A project belongs to one team or none. It is visible to team members only when its
  `team_access` is on; the owner, the Super Admin and explicit grants always see it.
- Existing installations get a **Default** team on first start (see Migration). Existing
  projects land in it with `team_access = false`, so nothing becomes visible to anyone new.
- Deleting a team turns its projects personal. The Default team cannot be deleted.

## Sharing

A share is a grant on `(project, agent)`; `agent = "*"` shares the whole project. Levels are
cumulative:

| Level | Opens |
|---|---|
| view | read the plan (an agent-only share shows just those agents, no brief) |
| use | run the project or that agent; see and stop only your own runs |
| edit | also compile and edit the plan |
| manage | also share onward (never above your own level) |

You can share only with people who share a team with you, or with teams you belong to; an
unknown and an out-of-scope user give the same 404. Deploy, rename, delete, resource
attachment and agent/model edits stay with the owner, Super Admin and team group admin.
Revoking a share, removing a member or deleting the project stops a run that is already going
before its next model call.

## Model limits

Effective models for a run = offered by the platform ∩ organisation catalog ∩ the project's
team list ∩ the person's member limit ∩ their user limit. Layers only narrow. Every model
call of a run passes through one gateway (`model_gateway.py`), so agents, tool loops and
supervisor routing are all covered. A blocked call fails the run with `MODEL_NOT_PERMITTED`
(never retried). An agent's own fallback, then the organisation fallback, is used only if it
is offered **and** allowed for the person running. Planner, assistant and capability probes
carry no run identity and are not model-limited.

## Budgets

- A tree: organisation → Sub Admin pool → team → member. Amounts are integer micro-USD
  (1 USD = 1,000,000), never floats. Children can never exceed their parent; you cannot
  shrink below what is spent or handed on.
- Every model call reserves its estimated cost atomically along the chain before it runs,
  then settles to the provider-reported cost and writes an append-only ledger row. Parallel
  calls against the last credit let exactly one through. A failed call is refunded.
- Hard budgets stop with `BUDGET_EXCEEDED` (HTTP 402, names the scope, never retried); the
  run keeps the answers already produced. Soft budgets warn only.
- A model with no price fails closed under a hard budget (`MODEL_NOT_PERMITTED`, reason
  `unpriced`) unless the Super Admin sets an explicit exception.
- Periods (monthly, weekly, one-time) reset lazily on first use; 80% and 100% warnings are
  recorded once per budget per period.
- Not yet charged: embeddings and planner/assistant calls.

## Audit

`GET /audit` is append-only (no update or delete exists). It records role, team,
membership, share, budget and model-limit changes, written after the change succeeds. The
Super Admin and Sub Admins see it org-wide, a Group Admin only for their teams.

## Migration

There is no migration tool. On first start the app runs `rbac_backfill.backfill` (idempotent,
best effort, logged): create the Default team, add every existing user as a member (the
Super Admin as its group admin), and place existing projects in it owner-only. It marks the
team `backfill_done` last, so an interrupted run resumes and later runs never override an
admin's changes.

Manual control, from `backend/`, against the database in `MONGODB_URI`:

```
uv run python scripts/rbac_backfill.py up     # same as the start-up run
uv run python scripts/rbac_backfill.py down   # projects personal again, Default team removed
```

Rollback keeps every user, role and project; it drops team memberships, and any
`team_access` an owner set on Default-team projects since the backfill. It is tested on a
copied store: afterwards every user and project document equals its pre-backfill state and
nobody sees more or fewer projects. Take a database dump before running it on production.

## Verifying

- `tests/test_authz_matrix.py`: policy decisions, 6 roles × 25 actions.
- `tests/test_authz_api_matrix.py`: the same through the API, plus unauthenticated calls and
  404-looks-like-missing.
- `tests/test_route_security.py`: every route needs sign-in (except five public ones) and
  calls its scope guard; a new route cannot ship without it.
- Console: `frontend/e2e/{teams,sharing,budgets,models-access,access-ux}.spec.js`.

## Known limits

- `edit`/`manage` grantees cannot yet use routes that rely on the owner's own libraries.
- The call in flight when access is revoked finishes; nothing after it runs.
- A Group Admin or Super Admin managing someone else's project cannot attach that owner's
  knowledge, data or MCP libraries (fails closed).
