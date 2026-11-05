# RBAC Delegation — Progress
STATUS: IN_PROGRESS
Iteration: 23
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
- [x] P1.5 `tests/test_authz_matrix.py`: 6 actors x 20 (action, resource) rows = 123 tests; guard fails if a policy action has no row. Later tasks extend MATRIX and add API-level 404 checks

## Phase 2 — Scoping & Roles
- [x] P2.1 `GET /projects` scoped via `policy.list_visible_projects` (own + team-shared; master `?scope=all` only; others ignored); `ProjectStore.list_for_teams` (memory+Mongo); summaries gain mine/team_id/team_access. Users/usage list scoping for Group Admins lands with P2.4 (team endpoints); `/usage` stays self-only, `/admin/*` stays admin-only; knowledge/data/MCP libraries are per-user (unchanged)
- [x] P2.2 `_get_project(id, user, action)` now goes through `policy.can` (default `project.manage`, so every mutating/running route is owner/master/team-admin only; `GET /projects/{id}` uses `project.view` and strips chat/resources for view-only members); out-of-scope = 404; run lookups keyed by project owner's tenant; 15 API tests; 751 passed
- [x] P2.3 `PUT/DELETE /teams/{id}/admins/{user}` (Super Admin or that team's group admin; revoke: master any, group admin self only; target must be a member -> 409; all else 404); `require_master` now uses `policy.can(role.grant_sub_admin)`; no-escalation tests (Sub Admin 403, master unassignable 422, org role untouched); 778 passed
- [x] P2.4 Teams API: POST/GET/PATCH/DELETE /teams, GET /teams/{id}/members, PUT/DELETE /teams/{id}/members/{user}, GET /teams/{id}/usage (group-admin scoped, team-shared projects only, no briefs); Default team undeletable; deleting a team makes its projects personal; 802 passed
- [x] P2.5 Append-only audit log: AuditEntry/AuditStore (memory+Mongo, no update/delete, insert-only), audit.record (write after success, failure logged not fatal), wired into role/team/membership/group-admin actions (no entry on no-ops or refusals), GET /audit (master+sub org-wide, group admin own teams); 12 tests. Phase 2 complete

## Phase 3 — Agent Sharing
- [x] P3.1 `AgentGrant` (levels view<use<edit<manage, cumulative; agent_id or '*'), `AgentGrantStore` memory+Mongo, 12 contract tests
- [x] P3.2 share/list/revoke APIs (`PUT|GET /projects/{id}/grants`, `DELETE .../grants/{gid}`): needs manage, level ceiling, grantee must be in sharer's scope (else one 404), manage-grantees touch only their own grants, audit entries, cleanup on project/team delete; `policy.access_rank/may_share/sharing_teams`; 14 tests
- [x] P3.3 access resolution: `policy.access_rank/any_access` (owner ∪ user grants ∪ team grants ∪ team view), `_project_at(level)` on run/read/compile/plan-edit routes; shared projects listed with access_level; runs carry started_by and runners see/stop only their own runs and pay for them; agent-level shares redact brief and other agents; 12 tests (D11/D12)
- [x] P3.4 live-run revocation: `CallIdentity` + `gateway.before_call=check_identity` re-validates access before every model call (agents, tool loops, supervisor); `AccessRevokedError` (a RunStoppedError, never retried); covers revoked share, downgrade below use, team removal, deleted project; owner unaffected; 9 tests

## Phase 4 — Model Privileges
- [x] P4.1 model privileges schema: `OrgModelSettings` (catalog, fallback_model), `ModelAllowlist` (team/user, empty list = no model), `AgentFallback`, refs `provider/model` or `provider/*`, `ModelPolicyStore` memory+Mongo; 11 tests
- [x] P4.2 model privileges APIs: org catalog+fallback (Super Admin), team/user allowlists (Super Admin), member limits (group admin, only from their own effective set), GET /me/models; `model_policy` intersection/escalations/decide; 18 tests (D13)
- [x] P4.3 gateway enforces model privileges on every run call (agents, tool loops, supervisor): MODEL_NOT_PERMITTED (never retried, audited), org/agent fallback via Redirect replay + usage relabel, per-agent fallback API; 16 tests. D3 unpriced rule moved into P5.3

## Phase 5 — Budgets
- [x] P5.1 budget tree + ledger stores: `BudgetNode` (integer micro-USD, org>pool>team>user, remaining/unallocated counters, period, hard/soft, thresholds), `BudgetStore` with single-document conditional atomic reserve/settle/release/resize/create/delete/reset/mark_notified (+ compensation across levels), append-only `LedgerStore`; 40 tests incl. parallel last-credit on memory and Mongo
- [x] P5.2 budget allocation APIs: `PUT|DELETE /budgets/{scope}/{id}`, `GET /budgets`, `GET /me/budget`; allocate only from a parent you hold (Super Admin any, Sub Admin own pool+below, Group Admin own team to its members), children never exceed parent (atomic), no shrink below spent/handed-on, fixed parent, audited; `budget_policy`; 16 tests
- [x] P5.3 gateway charges every run call to the budget chain (user, project team, parents, always the org pool): atomic pre-call reservation, settle to provider-reported cost (integer micro-USD, `usage.cost_micro`), append-only ledger, BUDGET_EXCEEDED (402, names the scope, never retried), soft limits warn only, failed calls refunded; D3: unpriced model under a hard budget -> MODEL_NOT_PERMITTED(unpriced) unless an org override; fallbacks priced as the model that ran; lazy period reset on first use; 21 tests incl. 20 parallel calls on the last credit -> 1 provider call
- [x] P5.4 periods + thresholds: lazy reset on first use (monthly/weekly Monday/one_time never), injectable clock, Mongo reset guarded by amount; threshold warnings (80/100 by default) announced once per budget per period as `budget.threshold` audit entries by system, team-scoped, even under 20 parallel calls; /me/budget shows percent_used + thresholds_reached; 10 tests
- [x] P5.5 BUDGET_EXCEEDED graceful stop proven end to end: the run keeps finished agents' answers, ends run_failed BUDGET_EXCEEDED naming the scope, never retried, nothing left reserved; same typed error as 402 on /run, /invoke and the SSE stream; one person's empty budget does not stop a sharer who pays from their own; 7 tests. ALSO test isolation fix: conftest now forces an in-memory, throwaway-named database before the app is imported and gives every test fresh RBAC stores (the suite had been writing into the real MongoDB)

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
- Iter 6: Phase 1 complete. Next: P2.1 scope list endpoints.
- Iter 7: P2.1 done (744 tests). Next: P2.2 by-id scope.
- Iter 8: P2.2 done. Next: P2.3 role APIs.
- Iter 9: P2.3 done. Next: P2.4 team CRUD + membership.
- Iter 10: P2.4 done. Next: P2.5 audit log.
- Iter 11: P2.5 done; Phase 2 complete. Next: P3.1 agent grants.
- Iter 12: P3.1 done.
- Iter 13: P3.2 done.
- Iter 14: P3.3 done.
- Iter 15: P3.4 done.
- Iter 16: P4.1 done.
- Iter 17: P4.2 done.
- Iter 18: P4.3 done.
- Iter 19: P5.1 done.
- Iter 20: P5.2 done.
- Iter 21: P5.3 done.
- Iter 22: P5.4 done.
- Iter 23: P5.5 done.
