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
