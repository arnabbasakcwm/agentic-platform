# RBAC Delegation — Progress
STATUS: IN_PROGRESS
Iteration: 5
Branch: feat/rbac-delegation
Baseline: backend `uv run pytest -q` = 564 passed (no backend typecheck/lint configured).

## Phase 0
- [x] P0 Discovery — see NOTES.md (stack, commands, admin checks, chokepoints, usage tracking)

## Phase 1 — Foundations
- [x] P1.1a Gateway wrapper around `get_llm()` — `model_gateway.py` (GatewayRunnable, before/after hooks, no-op); 570 passed
- [x] P1.1b Planner, probe, supervisor, agent loops all already use get_llm → gated; test forbids constructing chat models elsewhere; stream/batch/ainvoke refused (fail closed)
- [x] P1.2 `TeamRecord`, `TeamMembership`, `TeamStore` (in-memory + Mongo, one role per team+user via `_id`), `make_team_store`; 17 contract tests incl. live Mongo; 588 passed
- [x] P1.3 `rbac_backfill.py` (+ `scripts/rbac_backfill.py up|down`), `ProjectRecord.team_id/team_access`, `ProjectStore.list_all/set_team`, run at app start; idempotent, completion-marked, reversible; 12 tests memory+Mongo. The Default-team 'member cannot see another user's pre-existing project' test moves to P1.4 (needs policy)
- [x] P1.4 `policy.py`: `Actor`/`actor_for`, `Scope`/`scope_for`, `visible_projects`, `can()` (fail closed); 13 tests incl. the D6 Default-team test on memory+Mongo; 613 passed
- [ ] P1.5 Authorization test matrix scaffold (roles × actions × in/out-of-scope)

## Phase 2 — Scoping & Roles
- [ ] P2.1 Apply scope to list endpoints (projects, users, usage, runs/conversations)
- [ ] P2.2 Apply scope to by-id endpoints (404 out of scope)
- [ ] P2.3 Role APIs (grant/revoke sub_admin, group_admin) with no-escalation checks
- [ ] P2.4 Team CRUD + membership APIs
- [ ] P2.5 Audit log store + writer; wire into P2.3/P2.4

## Phase 3 — Agent Sharing
- [ ] P3.1 `agent_grants` model/store (project_id, agent_id|"*", grantee user|team, level, granted_by)
- [ ] P3.2 Share/revoke/list APIs with scope + level-ceiling checks
- [ ] P3.3 Access resolution (owner ∪ user grants ∪ team grants) for run + read paths
- [ ] P3.4 Revocation effective on next model call for live sessions

## Phase 4 — Model Privileges
- [ ] P4.1 Org catalog + team/user allowlist store + `fallback_model`
- [ ] P4.2 `effective_models(user)` = intersection; grant APIs with no-escalation
- [ ] P4.3 Enforce in gateway (MODEL_NOT_PERMITTED / fallback) incl. sub-agents & tool loops; hard-limit + unpriced model → MODEL_NOT_PERMITTED(reason=unpriced) unless per-model override (D3) — test required

## Phase 5 — Budgets
- [ ] P5.1 Budget schema (hierarchical, integer micro-USD, period, hard/soft) + append-only usage ledger
- [ ] P5.2 Allocation APIs; reject child sum > parent; no-escalation
- [ ] P5.3 Pre-call check + post-call debit in gateway, atomic; concurrency test
- [ ] P5.4 Period reset (lazy) + soft-threshold events
- [ ] P5.5 BUDGET_EXCEEDED graceful stop in agent runtime

## Phase 6 — UI
- [ ] P6.1 Admin console: users & roles, teams
- [ ] P6.2 Agent share dialog
- [ ] P6.3 Budget allocation + scoped usage views
- [ ] P6.4 Model privilege editor
- [ ] P6.5 User-facing budget/model errors; hide controls user can't use

## Phase 7 — Hardening & Verification
- [ ] P7.1 Full authorization matrix passing (spec §5)
- [ ] P7.2 Security pass: every route has a policy check; list in NOTES
- [ ] P7.3 Backfill rollback tested on a copy
- [ ] P7.4 docs/rbac.md
- [ ] P7.5 Final review vs completion condition

## Log
- Iter 1: Phase 0 done; plan written. Next: P1.1a.
- Iter 2: decisions finalized (chore commit). P1.1a+b done: gateway in place. Next: P1.2.
- Iter 3: P1.2 done. Next: P1.3 backfill.
- Iter 4: P1.3 done. Next: P1.4 policy.
- Iter 5: P1.4 done. Next: P1.5 matrix scaffold.
