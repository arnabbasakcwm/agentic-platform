# RBAC — Notes (discovery + lessons)

## Stack (Phase 0, iteration 1)
- Backend: Python, FastAPI (`backend/src/agentic_platform/app.py`, ~3,260 lines, ~72 routes), LangGraph/LangChain, Pydantic models.
- Persistence: store interfaces in `stores.py` (Protocol + `InMemory*` + `Mongo*` per store; plain CRUD only, no ORM, **no migration tool**). With `MONGODB_URI` unset the app uses in-memory stores. Contract tests in `tests/test_stores.py` run both halves (Mongo half only when a server is reachable).
- Auth: Argon2id passwords, HS256 JWT carrying only the user id (`auth.py`). `current_user` (app.py:332) loads the `UserRecord` from the store on every request, so role changes apply immediately.
- Frontend: React 19 + Vite console in `frontend/` (hash routing, no router lib), Playwright e2e with a mock API (`e2e/mock-api.js`), vitest, eslint, token audit.
- Tenancy today: `tenant_id` = owning user's id. Another user's resource is a 404.

## Commands
- Backend tests (all, offline, mocked): `cd backend && uv run pytest -q` → **baseline 564 passed (74 s)**.
- Backend has **no typecheck and no linter configured** (no mypy/ruff in pyproject). Verification = pytest. (Could add ruff later; not required.)
- Dev server: `cd backend && uv run uvicorn agentic_platform.app:app --reload`.
- Frontend: from `frontend/`: `npm run lint`, `npm test`, `npm run e2e`, `node scripts/audit-tokens.mjs` (must report zero).

## Existing admin model
- `stores.py`: `ROLES = ("user","admin","master")`, `ADMIN_ROLES`, `UserRecord.role` (+ `role_changed_by/at`).
- `app.py`: `require_admin` (~1777; non-admin → 404 NotFound), `require_master` (~1785; admin non-master → 403 MasterAdminRequired), `/admin/users`, `/admin/users/{id}/usage`, `PUT /admin/users/{id}/role` (~1883, only `user|admin` assignable; master unchangeable). `_public_user` returns role to console. `scripts/set_role.py` moves the master.
- Existing admins today: **read usage only**, never project contents. Master alone manages admins.
- Files that reference roles: `stores.py`, `app.py`, `scripts/set_role.py`, `tests/test_admin.py`, frontend `AdminPage.jsx`/`AdminUserPage.jsx`.

## Where things live
- Projects: `ProjectRecord` (stores.py:136) — `tenant_id`, `plan: AgentPlan` (agents are inside the plan, not separate records), runs in `RunStore`, conversations inside the project, usage in `UsageStore` (`usage_events`).
- Agents are `AgentSpec`s in `plan.agents`; there is **no agent table**. Sharing therefore needs a grant keyed by (project_id, agent_id) — see DECISIONS.
- Data-access scoping today: every store method takes `tenant_id`; routes pass `user.id`.

## Model-call chokepoints (must go through one gateway — P1.1)
All LLM calls are LangChain runnables obtained from `get_llm()` (`graph_builder.py:90`), then invoked in:
1. `graph_builder.py:348` `bound.invoke` (agent tool loop), `:396/:414/:418` `structured.invoke` (final structured answer + retries), `:486` `llm.invoke` (rewrite), `:808` supervisor routing `with_structured_output(...).invoke`.
2. `meta_planner_prompt.py:274/291` planner / revise / brief chat (`structured.invoke`).
3. `capabilities.py:58-65` tool-calling probe.
4. Embeddings: `get_embeddings()` (`graph_builder.py:188`) — knowledge indexing/search (estimated tokens).
5. `usage.UsageCallback` already receives provider-reported tokens per call (best effort, never fails the work).
Plan: wrap the runnable returned by `get_llm()` in a thin gateway object (same interface: `invoke`, `bind_tools`, `with_structured_output`) that runs a pre-call hook (model allowed? budget available?) and a post-call hook (ledger debit). Existing callers keep working; sub-agents and tool loops are covered because they all share `get_llm`.

## Existing usage / cost tracking
- `usage.py` (collector, callback, `price()` from `backend/pricing.json`, floats in USD; unpriced models stay unpriced) and `UsageRecord` in `UsageStore`. Cost is float today — the RBAC ledger must use integer micro-units (see DECISIONS D3); convert from `usage.cost` at debit time.

## Constraints from CLAUDE.md to respect
- Routes never import a DB driver; every store has in-memory + Mongo impl passing the same contract tests.
- Non-found/out-of-scope → 404 (never 403) — matches the spec. `require_master` currently returns 403 for admins: keep (documented behaviour, tested).
- Uncommitted frontend work from the earlier redesign session sits in the working tree; RBAC commits must `git add` only their own paths.

## P5.3 atomic check-and-debit primitive (decided in iteration 1)
**Primitive: single-document conditional atomic update** — Mongo `find_one_and_update(filter, {"$inc": ...}, return_document=AFTER)` where the *filter* carries the condition. The store already uses this pattern (`find_one_and_update` with `$inc` on `plan_version`, stores.py ~466/514), and it is plain CRUD, so it runs on local Mongo, Atlas and DocumentDB. Never read-modify-write.
- Each budget node (user, team, sub-admin pool, org) is one document holding `remaining` (integer micro-USD, decremented on reservation) and `limit`/`period_start`.
- **Reserve** the estimated cost: `find_one_and_update({_id, remaining: {"$gte": est}}, {"$inc": {"remaining": -est, "reserved": est}})`. The `$gte` filter and the `$inc` happen atomically in one document; N parallel calls against the last credit → exactly one matches. A `None` result = limit hit → `BUDGET_EXCEEDED` with that scope.
- **Chain (user + team [+ pools])** spans several documents, which has no atomic multi-doc op without transactions (not available on standalone Mongo). So: reserve levels in a fixed order (user → team → pool → org); if any level refuses, **release** the ones already taken with a compensating `$inc` (+est). Releases are idempotent per reservation id recorded in the ledger. This can briefly under-report remaining budget (conservative), never over-spend.
- **Settle** after the call: `$inc` by (est − actual) to refund or charge the difference, then append the ledger row (append-only insert).
- **In-memory store:** same semantics under a `threading.Lock` (the existing InMemoryRunStore pattern), and the same contract tests run against both.
- Lazy period reset is also a conditional update (`period_start < new_start` → set `remaining = limit`), so two resetters can't double-reset.
- The primitive exists, so **not BLOCKED**.

## Gateway (P1.1)
- `model_gateway.py`: `gateway.before_call(ctx)` / `after_call(ctx, result)` are the enforcement points (assign callables). `get_llm()` wraps `_build_llm()`; `bind_tools`/`with_structured_output`/`bind` stay wrapped. Only `invoke` is supported; stream/batch/async raise (nothing uses them today).
- `CallContext` has provider, model and the call's run config (callbacks/configurable) — the RBAC identity (user/team/agent/project) must be put into `config["configurable"]` by the runner for later tasks. Today `graph_builder` passes `call_config` with callbacks only: P4.3 must add the identity there.
- Embeddings (`get_embeddings`) are NOT gated yet; they cost money too (knowledge indexing/search). Add a follow-up task in P5.3.
- Test lesson: `type(get_llm(...))` is now `GatewayRunnable`; the real client is `._inner` (one assertion in test_bedrock updated).

## Teams store (P1.2)
- `TeamStore` in stores.py; membership `_id` = `team:user` gives one role per team without a transaction. A membership for a missing team is silently not stored (callers must check the team first). Mongo is reachable locally in this environment, so contract tests exercise it (throwaway DB, dropped).
- Tooling lesson: long Python/heredoc patches fail in Bash here; write scripts with the Write tool into the scratchpad.
- Test lesson: build records after a sleep when ordering by `created_at` (ms precision).

## Backfill (P1.3)
- Bug caught by test: a cutoff-only backfill re-added a member an admin had removed on every restart. Fix: `TeamRecord.backfill_done` is set last; later runs no-op, interrupted runs resume.
- Backfill runs at app import (best effort, logged). `ProjectStore.list_all()` is platform-internal: never return it to a caller without scope.
- Rollback restores `team_id=None` for all projects in Default (drops any team_access an owner set since).

## By-id scope (P2.2)
- `_get_project` is the single by-id chokepoint (35 call sites). Mutating routes keep the default `project.manage`. Only `GET /projects/{id}` uses `project.view`.
- Known limits to resolve later: (1) routes that act on the *caller's* libraries (knowledge, data sources, MCP attach) still key on `user.id`, so a Group Admin/master managing someone else's project gets 404 there (fail closed). (2) Usage for a run started by a non-owner is still recorded by the existing code paths; Phase 5 must charge the runner. (3) Runs by a non-owner (after sharing, Phase 3) need run lookups by project, not owner tenant. (4) P7.2 must sweep all 72 routes.

## Run identity and revocation (P3.4)
- `model_gateway.CallIdentity(user_id, project_id, team_id, check)` travels in the run config (`configurable["identity"]`) through run_graph/run_graph_events/run_agent_events; `graph_builder._call_config` puts it (and agent_id) into every model call config, including supervisor routing. `gateway.before_call` defaults to `check_identity`, which runs `identity.check(agent_id)`. P4.3/P5.3 extend the same hook (model allowlist, budget) - do not add a second path.
- `app._call_identity` re-reads user, project, grants and teams on every model call (4 store reads); cache briefly if this shows up in profiles.
- Test fakes that stand in for run_graph / run_graph_events must accept `identity=None`.
- The call already in flight when access is revoked finishes (documented limit, same as Stop); nothing after it runs.

## Model enforcement (P4.3)
- `app._model_gateway_hook` is installed as `model_gateway.before_call`: identity/access check first, then `model_policy.decide` (limits for the runner in the project's team context; the Super Admin only by the org catalog). Blocked -> `ModelNotPermittedError` (code MODEL_NOT_PERMITTED, a RunStoppedError so never retried; run_failed carries the code). Fallback (agent's own, then org's; only if offered AND allowed for the person) -> `Redirect`; `GatewayRunnable` replays its recorded derivations (bind_tools, with_structured_output) on a rebuilt model and relabels UsageCallback to the model that ran.
- Only runs carry an identity, so planner/assistant/brief calls and capability probes are NOT model-limited (they use the platform's own planner model). Budgets (P5) must still charge them.
- Fallback audit entries are deduplicated per person/project/agent/model pair for 10 minutes (a tool loop calls the model many times); the log line is per call.
- `_offered_cached` (30 s) avoids re-reading the Bedrock catalog per call.

## Security pass (P7.2)
Every route was classified (generated from the live route table; `tests/test_route_security.py` re-checks it on every run, so a new route cannot ship without sign-in and a scope check):
- **Sign-in:** every route answers 401 without a token, except the five public ones: `GET /health`, `GET /providers`, `GET /tools` (platform metadata, no user data), `POST /auth/login`, `POST /auth/register`.
- **Project routes:** each calls `_get_project` (owner / Super Admin / team admin), `_project_at(level)` (shared access: view < use < edit < manage), `_shareable_project` (sharing) or `_get_run` (own runs unless full rank). An out-of-scope id is the same 404 as a missing one.
- **Team routes:** `_visible_team(action)` or `_team_member_target`. **Admin routes:** `require_admin` / `require_master`. **Budgets / audit / models:** the policy actor plus `budget_policy` / `model_policy`.
- **Audit:** every state-changing route that touches roles, teams, shares, budgets or model limits writes an audit entry (checked by the test).
- Routes on the caller's own libraries (knowledge, data sources, MCP) are scoped by tenant = user id, unchanged; they do not accept another user's ids.
- **Findings during the pass:** none unprotected. One route (`POST /projects/{id}/knowledge/documents`) delegates its project check to `_queue_uploads`, which calls `_get_project` before attaching anything - the test knows this on purpose.
- **Residual items** (also in the follow-ups): embeddings and planner/assistant calls are not budgeted or model-limited (they carry no run identity); `edit`/`manage` grantees cannot yet use routes that rely on the owner's own libraries (PUT /agents, revise, attach); a Sub Admin has no project access by design (D8).

| Route | Sign-in | Scope check |
|---|---|---|
| `GET /admin/models` | admin | admin role |
| `PUT /admin/models/org` | master | admin role |
| `GET /admin/users` | admin | admin role |
| `PUT /admin/users/{user_id}/role` | master | admin role |
| `GET /admin/users/{user_id}/usage` | admin | admin role |
| `GET /audit` | user | audit scope |
| `POST /auth/login` | public | - |
| `GET /auth/me` | user | caller's own data (tenant = user id) |
| `POST /auth/register` | public | - |
| `POST /brief/chat` | user | caller's own data (tenant = user id) |
| `GET /budgets` | user | budget tree |
| `DELETE /budgets/{scope_type}/{scope_id}` | user | budget tree |
| `PUT /budgets/{scope_type}/{scope_id}` | user | budget tree |
| `GET /datasources` | user | caller's own data (tenant = user id) |
| `POST /datasources` | user | caller's own data (tenant = user id) |
| `DELETE /datasources/{source_id}` | user | caller's own data (tenant = user id) |
| `GET /datasources/{source_id}/browse` | user | caller's own data (tenant = user id) |
| `PUT /datasources/{source_id}/projects` | user | caller's own data (tenant = user id) |
| `POST /datasources/{source_id}/query` | user | caller's own data (tenant = user id) |
| `PUT /datasources/{source_id}/tables` | user | caller's own data (tenant = user id) |
| `GET /health` | public | - |
| `GET /knowledge` | user | caller's own data (tenant = user id) |
| `POST /knowledge/documents` | user | caller's own data (tenant = user id) |
| `DELETE /knowledge/documents/{document_id}` | user | caller's own data (tenant = user id) |
| `PUT /knowledge/documents/{document_id}/embedding` | user | caller's own data (tenant = user id) |
| `PUT /knowledge/documents/{document_id}/projects` | user | caller's own data (tenant = user id) |
| `PUT /knowledge/embedding` | user | caller's own data (tenant = user id) |
| `POST /knowledge/search` | user | caller's own data (tenant = user id) |
| `GET /mcp` | user | caller's own data (tenant = user id) |
| `POST /mcp` | user | caller's own data (tenant = user id) |
| `DELETE /mcp/{server_id}` | user | caller's own data (tenant = user id) |
| `PATCH /mcp/{server_id}` | user | caller's own data (tenant = user id) |
| `PUT /mcp/{server_id}/projects` | user | caller's own data (tenant = user id) |
| `POST /mcp/{server_id}/refresh` | user | caller's own data (tenant = user id) |
| `PUT /mcp/{server_id}/secret` | user | caller's own data (tenant = user id) |
| `POST /mcp/{server_id}/test` | user | caller's own data (tenant = user id) |
| `PUT /mcp/{server_id}/tools` | user | caller's own data (tenant = user id) |
| `GET /me/budget` | user | budget tree |
| `GET /me/models` | user | caller's own data (tenant = user id) |
| `POST /models/check` | user | caller's own data (tenant = user id) |
| `GET /projects` | user | caller's own data (tenant = user id) |
| `POST /projects` | user | caller's own data (tenant = user id) |
| `DELETE /projects/{project_id}` | user | project: owner/manage (_get_project) |
| `GET /projects/{project_id}` | user | project: level view |
| `PATCH /projects/{project_id}` | user | project: owner/manage (_get_project) |
| `PUT /projects/{project_id}/agents` | user | project: owner/manage (_get_project) |
| `DELETE /projects/{project_id}/agents/{agent_id}/fallback` | user | project: owner/manage (_get_project) |
| `PUT /projects/{project_id}/agents/{agent_id}/fallback` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/agents/{agent_id}/invoke` | user | project: level use |
| `POST /projects/{project_id}/compile` | user | project: level edit |
| `GET /projects/{project_id}/datasources` | user | project: owner/manage (_get_project) |
| `DELETE /projects/{project_id}/datasources/{source_id}` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/datasources/{source_id}` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/deploy` | user | project: owner/manage (_get_project) |
| `DELETE /projects/{project_id}/deployment` | user | project: owner/manage (_get_project) |
| `GET /projects/{project_id}/deployment` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/deployment/invoke` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/deployment/runs` | user | project: owner/manage (_get_project) |
| `GET /projects/{project_id}/grants` | user | project: share scope |
| `PUT /projects/{project_id}/grants` | user | project: share scope |
| `DELETE /projects/{project_id}/grants/{grant_id}` | user | project: share scope |
| `GET /projects/{project_id}/knowledge` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/knowledge/documents` | user | project: via helper |
| `DELETE /projects/{project_id}/knowledge/documents/{document_id}` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/knowledge/documents/{document_id}` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/knowledge/search` | user | project: owner/manage (_get_project) |
| `GET /projects/{project_id}/mcp` | user | project: owner/manage (_get_project) |
| `DELETE /projects/{project_id}/mcp/{server_id}` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/mcp/{server_id}` | user | project: owner/manage (_get_project) |
| `PATCH /projects/{project_id}/plan` | user | project: level edit |
| `POST /projects/{project_id}/revise` | user | project: owner/manage (_get_project) |
| `POST /projects/{project_id}/run` | user | project: level use |
| `POST /projects/{project_id}/run/stream` | user | project: level use |
| `GET /projects/{project_id}/runs` | user | project: level use |
| `POST /projects/{project_id}/runs` | user | project: level agent |
| `GET /projects/{project_id}/runs/{run_id}` | user | project: run scope (_get_run) |
| `POST /projects/{project_id}/runs/{run_id}/email` | user | project: level use |
| `GET /projects/{project_id}/runs/{run_id}/export` | user | project: level use |
| `POST /projects/{project_id}/runs/{run_id}/stop` | user | project: level use |
| `GET /projects/{project_id}/runs/{run_id}/stream` | user | project: run scope (_get_run) |
| `GET /projects/{project_id}/share-targets` | user | project: share scope |
| `GET /providers` | public | - |
| `GET /teams` | user | caller's own data (tenant = user id) |
| `POST /teams` | user | caller's own data (tenant = user id) |
| `DELETE /teams/{team_id}` | user | team scope |
| `GET /teams/{team_id}` | user | team scope |
| `PATCH /teams/{team_id}` | user | team scope |
| `DELETE /teams/{team_id}/admins/{user_id}` | user | team scope |
| `PUT /teams/{team_id}/admins/{user_id}` | user | team scope |
| `GET /teams/{team_id}/members` | user | team scope |
| `DELETE /teams/{team_id}/members/{member_id}/models` | user | team scope |
| `PUT /teams/{team_id}/members/{member_id}/models` | user | team scope |
| `DELETE /teams/{team_id}/members/{user_id}` | user | team scope |
| `PUT /teams/{team_id}/members/{user_id}` | user | team scope |
| `DELETE /teams/{team_id}/models` | user | team scope |
| `GET /teams/{team_id}/models` | user | team scope |
| `PUT /teams/{team_id}/models` | user | team scope |
| `GET /teams/{team_id}/usage` | user | team scope |
| `GET /tools` | public | - |
| `GET /usage` | user | caller's own data (tenant = user id) |
| `GET /usage/pricing` | user | caller's own data (tenant = user id) |
| `POST /usage/sync` | user | caller's own data (tenant = user id) |
| `DELETE /users/{target_id}/models` | user | policy action (Super Admin only) |
| `PUT /users/{target_id}/models` | user | policy action (Super Admin only) |

104 routes


## Spec section 5 coverage (P7.1)
| Required test | Where |
|---|---|
| Authorization matrix (roles x actions, in/out of scope, 404 for out of scope) | `test_authz_matrix.py` (policy), `test_authz_api_matrix.py` (API, 35 actions x 6 roles; `test_out_of_scope_looks_exactly_like_missing`) |
| Sub Admin cannot grant super_admin | `test_roles_api.py::test_nobody_can_grant_super_admin_through_the_api`, `::test_only_the_super_admin_can_make_a_sub_admin` |
| No one can allocate more budget than they hold | `test_budgets_api.py::test_over_allocation_is_rejected_at_every_level`, `test_budget_store.py::test_concurrent_allocations_never_exceed_the_parent` |
| No one can grant a model they don't have | `test_models_api.py::test_a_group_admin_limits_members_but_never_beyond_their_own_set`, `test_model_policy.py::test_escalation_check_*` |
| A Group Admin cannot touch another team | `test_teams_api.py`, `test_roles_api.py`, `test_budgets_api.py::test_a_group_admin_splits_their_team_among_its_members_only`, `test_models_api.py::test_a_group_admin_cannot_reach_another_team_or_a_stranger` |
| Group Admin of A who is a member of B: admin in A, member in B | `test_policy.py::test_group_admin_has_admin_powers_in_a_but_member_powers_only_in_b`, `test_authz_api_matrix.py::test_a_group_admin_has_admin_powers_in_a_and_member_powers_in_b`, `test_scoping_api.py` |
| Sharing: the grantee's own limits apply | `test_model_enforcement.py::test_each_layer_blocks_and_names_itself` (runner is a grantee), `test_budget_gateway.py::test_the_runner_pays_not_the_owner`, `test_budget_runtime.py::test_one_persons_empty_budget_does_not_stop_anyone_else` |
| Sharing: revoking blocks the next call | `test_revocation.py` (mid-run, before first call, downgrade, team removal, deleted project), `test_access_api.py::test_revoking_takes_effect_on_the_next_request` |
| Sharing: re-sharing is capped at the sharer's level | `test_sharing_api.py::test_a_manage_grantee_reshares_up_to_their_level_within_their_own_scope`, `::test_a_sub_admin_and_plain_viewers_cannot_share`, `test_policy.py::test_access_rank_*` |
| Models: intersection | `test_model_policy.py::test_the_result_is_the_intersection_of_every_layer`, `test_models_api.py::test_my_models_*` |
| Models: MODEL_NOT_PERMITTED | `test_model_enforcement.py::test_a_blocked_model_stops_the_agent_with_a_typed_error_*`, `::test_a_blocked_model_is_a_403_*` |
| Models: fallback works when enabled | `test_model_enforcement.py::test_the_org_fallback_replaces_*`, `::test_an_agents_own_fallback_wins_*`, `::test_a_redirect_replays_*` |
| Models: sub-agent calls enforced | `test_model_enforcement.py::test_a_later_agent_on_a_blocked_model_*`, `::test_tool_loops_and_derived_models_are_gated_too` |
| Budgets: over-allocation rejected | see above |
| Budgets: hard limit stops, soft warns | `test_budget_gateway.py::test_a_hard_budget_stops_*`, `::test_a_soft_budget_never_blocks_*`; `test_budget_periods.py::test_thresholds_*`, `::test_a_hard_budget_warns_at_80_*` |
| **N parallel calls against the last credit -> at most one succeeds** | `test_budget_store.py::test_n_parallel_calls_against_the_last_credit_let_exactly_one_through` (memory and MongoDB), `test_budget_gateway.py::test_n_parallel_calls_against_the_last_credit_run_exactly_one_model_call` (through the gateway: 20 threads, 1 provider call) |
| Budgets: periods reset correctly | `test_budget_periods.py` (monthly, weekly from Monday, one-time, parallel first calls), `test_budget_store.py::test_reset_*` |
| Audit: each privileged action writes exactly one correct entry | `test_audit.py` (teams, members, group admins, roles, refusals write none, no secrets), plus entries asserted in `test_sharing_api.py`, `test_budgets_api.py`, `test_models_api.py`, `test_model_enforcement.py`; `test_route_security.py::test_every_state_changing_privileged_route_writes_to_the_audit_log` |
| Unpriced model under a hard limit (decision D3) | `test_budget_gateway.py::test_an_unpriced_model_is_refused_under_a_hard_budget`, `::test_an_admin_override_*` |
