# Plan: Usage dashboard (models, tokens, cost)

## Context

Nothing currently records which models a project used, how many tokens they consumed, or
what that cost. The user wants a **separate dashboard** showing all of it.

Decisions from the user:
- **Calls counted:**
  - agent runs (local and deployed);
  - planner and plan-assistant calls;
  - embeddings (indexing files, `knowledge_search` queries).
- **Cost:** from an **editable price table** (per 1M input/output tokens per model, filled
  from official pricing pages with source and date). Cost is shown as an estimate, and
  models without a price show tokens with "price not set".

Today agents use Gemini (`gemini-3.1-pro-preview`) both locally and on AgentCore. The
runtime calls Google's API, so model cost is billed by Google, not AWS.

## How usage is measured (accurate where possible)

- **Chat models:** LangChain 1.6's `UsageMetadataCallbackHandler` (verified installed:
  `langchain_core` 1.6.2) records the provider-reported `usage_metadata`
  (input/output/total tokens, per model) for every call. That covers tool-loop turns, the
  structured final answer, the "flattened Markdown" rewrite, retries, and the supervisor's
  routing calls. The handler is passed explicitly as `config={"callbacks": [...]}` on each
  `invoke` in `graph_builder._run_agent_once` / `_make_supervisor`. Contextvar propagation
  isn't relied on, so attribution per agent is exact, including across parallel branches.
- **Embeddings:** LangChain embedding classes don't return token counts. Usage is
  **estimated** as `ceil(characters / 4)` input tokens and flagged `estimated: true` in
  the data and the UI.
  - Indexing counts every passage embedded; re-embedding counts too.
  - `knowledge_search` counts each query: the tool receives the run's collector through
    the tool's injected `RunnableConfig`.

## Backend

### 1. Collector and pricing (new `usage.py`, pure, no I/O)
- `UsageCollector`: thread-safe; records `(agent_id | None, provider, model, kind, input,
  output, estimated)`; `snapshot()` returns per-agent and per-model totals.
- `UsageCallback(collector, agent_id, provider, model)` subclasses the LangChain handler
  and feeds the collector.
- **Pricing:** `pricing.json` in `backend/` is editable. Each entry has
  `provider/model → input_per_1m, output_per_1m, currency (USD), source_url, checked_on`.
  - `price(provider, model, input, output) → cost | None`.
  - Loaded once at startup.
  - It ships with prices only where I can confirm them on the provider's official
    pricing page during implementation, with the URL and date. Anything unconfirmed is
    left unpriced, never guessed.

### 2. Runs report their usage (same contract locally and on AgentCore)
- `run_graph` / `run_graph_events` create a `UsageCollector`. It goes into the LangGraph
  config (`configurable.usage`, next to the existing `emit`), and nodes find it the same
  way `_emitter` finds `emit`.
- Results gain `usage` (per agent: model, input, output tokens).
  - Stream events: `node_completed` and `node_failed` gain the agent's usage, and
    `run_completed` gets the totals.
  - On timeout, the usage gathered so far is kept on `RunTimeoutError` (`usage=`) and
    recorded as partial.
- `runtime_app` `/invocations` returns `usage` too, so deployed runs report tokens to the
  platform. The local and deployed JSON contracts stay in sync, per CLAUDE.md.
- **Planner and assistant:** `meta_planner_prompt._invoke_with_retries` takes an optional
  collector and passes the callback on each attempt, counting retries.
  `plan_project` / `revise_plan` return their usage alongside the plan. The planner still
  never touches storage: `app.py` records it.

### 3. Storing usage (`stores.py`, behind an interface)
- `UsageRecord`: `id, tenant_id, project_id | None, at, kind`
  (`run | deployed_run | planner | assistant | embedding_index | embedding_query`), plus:
  - `run_id` (groups one run's records), `agent_id`, `provider`, `model`;
  - `input_tokens`, `output_tokens`, `estimated`;
  - `cost | None`, `currency`, and the `price` used. That snapshot is kept so history
    doesn't change when the table is edited.
- `UsageStore` with `add_many(records)` and `list(tenant_id, since, project_id=None)`,
  in-memory and MongoDB (collection `usage_events`, index `(tenant_id, at)`), plus
  contract tests. It stays plain CRUD per the MongoDB decision: aggregation is done in
  Python over the requested range (fine at this scale; noted in the decision log).
- Recording is **best effort**: a failed write is logged and never fails a run or a plan.

### 4. API (`app.py`, owner-scoped)
- Every place a model is called records its usage:
  - `create_project`, `revise_project`;
  - `/run` and `/run/stream` (when the stream finishes, including timeouts);
  - `/agents/{id}/invoke`;
  - `/deployment/invoke` (the runtime's returned `usage`, kind `deployed_run`);
  - indexing and re-embedding jobs;
  - `knowledge_search` queries (from the run's collector);
  - the knowledge test-search endpoints (kind `embedding_query`).
- `GET /usage?days=30&project_id=` returns:
  - **totals:** cost, input/output tokens, runs, model calls, how much is estimated or
    unpriced;
  - **by day** (cost and tokens);
  - **by model** (provider, model, calls, tokens, cost, priced?);
  - **by project** (brief, runs, tokens, cost);
  - **by kind**;
  - **recent runs** (latest 50, each with per-agent rows).
  Projects that no longer exist show as "Deleted project".
- `GET /usage/pricing` returns the price table, plus models seen in your usage that have
  no price, so it's clear what to fill in.

## Frontend
- **Sidebar:** a new **Usage** item under Workspace (`#/usage`), with an icon and route
  added in `router.js`, `App.jsx` and `Sidebar.jsx`.
- **New `pages/UsagePage.jsx`:**
  - **Header:** a range picker (7 / 30 / 90 days) and a project filter.
  - **Stat cards:** estimated cost, input tokens, output tokens, runs, model calls. They
    reuse the `.kstats` styling from the Knowledge page.
  - **Cost per day:** a small inline-SVG bar chart. No chart library is added, per the
    "no heavy dependencies" rule. I'll load the `dataviz` skill before building it, then
    make it accessible with a table fallback and readable in both themes.
  - **Tables:** by model, by project (linking to the project), and by activity (runs,
    planner, assistant, embeddings).
  - **Recent runs:** expandable to per-agent model, tokens and cost; deployed runs are
    tagged.
  - **Notes:**
    - Costs are estimates from list prices.
    - Embedding tokens are estimated.
    - Runs called directly through AWS (not through this platform) aren't counted.
    - Plus a "price not set" callout listing unpriced models and the file to edit.
- **Run page and Deploy "Try it":** a one-line summary under the result, e.g.
  "12,340 tokens · ~$0.04", linking to Usage.
- `lib/api.js`: `usage(days, projectId)`, `usagePricing()`. Pure helpers for formatting,
  with Vitest tests in `lib/usage.js`.

## Critical files
- **New:** `backend/src/agentic_platform/usage.py`, `backend/pricing.json`,
  `backend/tests/test_usage.py`, `frontend/src/pages/UsagePage.jsx`,
  `frontend/src/lib/usage.js` (+ test), `frontend/e2e/usage.spec.js`.
- **Modified:**
  - backend: `graph_builder.py` (callbacks, collector), `meta_planner_prompt.py`,
    `knowledge.py` / `tools.py` (embedding counts), `runtime_app.py`, `stores.py`,
    `app.py`, `config.py`;
  - frontend: `App.jsx`, `Sidebar.jsx`, `router.js`, `api.js`, `RunStep.jsx`,
    `DeployStep.jsx`, `styles.css`, `e2e/mock-api.js`;
  - docs.
- **Reused:** the `_emitter` pattern for passing per-run objects through LangGraph
  config; `stores.py` store pattern and contract-test fixtures; `.kstats`, `Panel`,
  `StatusBadge`, `Pill`; `useAction`; the mock-API reset pattern.

## Verification
1. **Unit tests:**
   - collector totals across retries and parallel agents;
   - a fake chat model that reports `usage_metadata`, flowing through a compiled graph
     (all three patterns) into `usage`;
   - the planner's usage across a retry;
   - embedding estimates;
   - pricing (priced, unpriced, price snapshot);
   - `UsageStore` contract tests, in memory and MongoDB;
   - `/usage` aggregation and owner scoping (another user sees nothing).
2. **Live, with Gemini and MongoDB on a spare port:**
   - create a project, revise it, upload a file, compile and run;
   - `/usage` shows planner, assistant, embedding and run rows with real Gemini token
     counts that match `usage_metadata`, and costs that match the table by hand.
3. **Deployed:** after a redeploy (the runtime must return `usage`), Try it records a
   `deployed_run` with tokens.
4. **Frontend:** lint, Vitest, build, and Playwright for the Usage page: stats, chart,
   tables, filters, expand a run. Plus axe in light and dark, and screenshots reviewed.
5. Docs: decision-log entry (what is counted, estimates, pricing file, no-retry
   recording), README, and systemDescription.
6. Commits: backend measurement, storage+API, frontend, docs.
