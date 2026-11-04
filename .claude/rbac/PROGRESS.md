# RBAC Delegation — Progress
STATUS: IN_PROGRESS
Iteration: 1
Branch: feat/rbac-delegation
Baseline: backend `uv run pytest -q` = 564 passed (no backend typecheck/lint configured).

## Phase 0
- [x] P0 Discovery — see NOTES.md (stack, commands, admin checks, chokepoints, usage tracking)

## Phase 1 — Foundations
- [ ] P1.1a Gateway wrapper around `get_llm()` (pass-through, same interface); parity tests
- [ ] P1.1b Route planner/assistant (`meta_planner_prompt.py`) and capability probe through the gateway; supervisor + agent loops already via get_llm
- [ ] P1.2 Stores + models: `TeamRecord`, `TeamMembership(role member|group_admin)`; in-memory + Mongo; contract tests
- [ ] P1.3 Backfill/mapping (D1/D2/D6): lazy, idempotent, reversible helper script; tests
- [ ] P1.4 Central policy module `policy.py`: `can(actor, action, resource)` + `scope_for(actor)`
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
- [ ] P4.3 Enforce in gateway (MODEL_NOT_PERMITTED / fallback) incl. sub-agents & tool loops

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
