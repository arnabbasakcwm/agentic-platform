# Agentic Platform

Natural-language multi-agent builder: a user describes a task (optionally with an agent
count), a meta-planner LLM turns that into a structured `AgentPlan`, a fixed compiler
turns the plan into a runnable LangGraph graph, and a deployment layer exposes it as live
API endpoints (one per agent, plus an optional combined/synthesis endpoint).

Status: the MVP loop is built and tested — schema, planner, compiler (sequential,
parallel, supervisor), tool registry, FastAPI serving layer, project persistence
(MongoDB), user accounts with JWT sign-in, plan revision by conversation, deployment
to Bedrock AgentCore Runtime (not yet exercised against a real AWS account), project
knowledge bases (uploaded documents agents search with `knowledge_search`), and a
React console. Not yet built: run history, background workers, per-project API keys,
rate limiting, and observability. Full architecture
reference lives in `docs/systemDescription.md`; `README.md` is the quick start; this file
is the operating contract for whoever (human or AI) writes code here. Decisions that
changed or extended this contract are recorded, with their reasons, in the
**Architecture decision log** near the end of this file.

## Non-negotiable architecture principles

1. **Config-driven, never code-generation.** The planning LLM emits only structured data
   (a validated schema). A fixed, well-tested compiler interprets it. Never execute
   LLM-generated code against user input — that's an RCE surface, full stop.
2. **Multi-provider LLM support behind one interface.** Every agent's model — provider +
   model + params — is chosen independently through a single factory function
   (`get_llm()` in `graph_builder.py`). Adding a provider must never touch orchestration
   or compiler code. Provider quirks that don't fit the generic schema (e.g. Kimi K3's
   always-on reasoning and locked sampling params) go through `LLMConfig.extra_params`,
   not a bespoke field bolted onto every config.
3. **Structured output everywhere an LLM's output feeds another component** — the plan
   itself, every agent's final output, the synthesized combined response. Free-text
   parsing between components is a bug, not a fallback.
4. **Sequential, parallel, and supervisor/routing orchestration are all first-class**,
   chosen automatically by the planner based on the task — never hardcoded to one pattern.
5. **Tools are a closed, vetted registry.** Agents select tools by name from it; they
   never get implicit network, filesystem, or shell access.
6. **Every agent run is bounded** — max steps/iterations, timeouts, token budgets —
   enforced by the platform, not left to model good behavior.
7. **Treat all user-provided natural language as untrusted, including planner output.**
   Validate structured planner output server-side before it's compiled or executed; never
   trust the model's own claim that its output is well-formed.

## Runtime error-recovery loop (build into every compiled agent node)

- On a tool-call error or structured-output schema-validation failure, feed the actual
  error back into that agent's own context (not a generic "try again") and retry —
  don't restart the graph or other agents.
- Cap retries per agent (default: 3), short backoff between attempts.
- After the ceiling, surface a structured failure into shared state (which agent, which
  error, how many attempts) so a supervisor node or the deployment layer can react —
  never let a silent exception collapse the whole run, never let an agent retry forever.
- Log every retry with the triggering error — tracing should show what was tried, what
  broke, and what changed before it succeeded.

## Scalability & reliability

- Stateless application layer; plans, project metadata, and run history live in external
  stores (MongoDB/Redis), not process memory. All database access goes through the
  store interfaces in `stores.py` — routes never import a database driver.
- Compilation and long-running agent executions are async background jobs — queue them,
  don't block request handlers.
- Cache compiled graphs per project; invalidate on plan edits, not on a timer. A
  compiled graph is closures, not data, so the cache is per-process and keyed by the
  stored `plan_version`; the store's `compiled_version` is the source of truth for
  whether a project is runnable, and any process rebuilds the graph on demand
  (compiling makes no LLM calls).
- Multi-tenancy from day one — every resource keyed by project/tenant id, even while
  running as a single shared process.
- Architecture must allow promoting a tenant to isolated infrastructure later without a
  rewrite — the concrete target is a dedicated Amazon Bedrock AgentCore runtime (with its
  own execution role) per promoted tenant.

## Deployment (Bedrock AgentCore)

- The managed serving target for a compiled graph is **Amazon Bedrock AgentCore Runtime**,
  not self-managed servers. An AgentCore agent is an ARM64 container exposing
  `POST /invocations` (task input in, result out; streaming supported) and `GET /ping`
  (health) — wrap `compile_graph`/`run_graph` behind that contract, via the
  `bedrock-agentcore` SDK `@entrypoint` (starter toolkit) or by implementing the two
  endpoints directly. Clients reach it through the `InvokeAgentRuntime` API.
- The local FastAPI app (`app.py`) stays the dev/MVP serving path and the source of the
  same JSON task-input contract — AgentCore changes the serving envelope, not the
  compiler or runtime code. Keep them in sync so a graph runs identically both ways.
- Decide project→runtime mapping explicitly (runtime-per-project for strong isolation, or
  a shared runtime routing by project id in the payload) — don't leave it implicit.
- Provider keys go through KMS / Secrets Manager (or AgentCore Identity), never baked into
  the image or logged.

## Security requirements

- Every project route requires a signed-in user (JWT bearer token) and is scoped to
  that user's own projects — another user's project is a 404, never a 403. Passwords
  are stored only as Argon2id hashes; neither a password nor its hash ever appears in
  a response, an error body, or a log. Login failures never reveal whether an email is
  registered.
- User-supplied (BYOK) API keys: encrypted at rest, decrypted only in-memory at call
  time — never logged, never stored on a plan object.
- Rate-limit and budget-cap both planning calls and agent execution calls per tenant.
- Any tool with real-world side effects (external data egress, third-party API calls)
  requires explicit per-project opt-in — the planner never auto-attaches it.

## Default tech stack (deviate only with a clear reason)

| Layer | Choice |
|---|---|
| Orchestration | LangGraph |
| Agent/tool abstraction | LangChain |
| API layer | FastAPI (async); OpenAPI docs are a real deliverable |
| Primary datastore | MongoDB (`pymongo`) — chosen over the original PostgreSQL default because a project is one JSON plan document; stick to basic CRUD so it stays portable to Atlas / DocumentDB |
| Cache/queue | Redis |
| Background workers | Celery / RQ |
| Observability | LangSmith (or equivalent) — every run and every retry must be traceable |
| Deployment / serving | Amazon Bedrock AgentCore Runtime (ARM64 container, `/invocations` + `/ping`); FastAPI in-process for local/MVP |

LLM providers: Amazon Bedrock via `langchain-aws` `ChatBedrockConverse` (IAM, no key — see
the decision log); OpenAI, Anthropic, Google, Groq via LangChain's native
`init_chat_model`. Moonshot (Kimi) via a direct `ChatOpenAI` client against Moonshot's
OpenAI-compatible endpoint (not a native `init_chat_model` provider) — confirm current
base URL and `reasoning_effort` support against Moonshot's docs before relying on it,
this has moved fast. Prefer boring, well-supported infra; complexity should live in the
planning/compilation logic, not exotic infrastructure choices.

## Repository layout

Backend and frontend are separate projects with their own manifests and dependencies.
The backend uses a `src/` layout and is installed (`uv sync`), so tests and scripts import
`agentic_platform.*` rather than manipulating `sys.path`.

```
backend/
  src/agentic_platform/
    agent_schema.py         # Pydantic contracts: LLMConfig, AgentSpec, AgentPlan
    meta_planner_prompt.py  # Meta-planner system prompt + structured-output planner call
    graph_builder.py        # get_llm() factory + compiles an AgentPlan into a LangGraph graph
    tools.py                # Closed, vetted tool registry + side-effect opt-in rules
    config.py               # Env loading, provider/model defaults
    errors.py               # Typed platform errors
    stores.py               # ProjectStore/UserStore/KnowledgeStore interfaces + in-memory and MongoDB implementations
    knowledge.py            # Knowledge libraries: extract/chunk documents, index, search, deploy snapshot
    usage.py                # Usage accounting: token collector, LangChain callback, pricing, dashboard totals
    auth.py                 # Password hashing (Argon2id) + JWT access tokens
    runtime_app.py          # The /ping + /invocations app a deployed project runs on AgentCore
    deploy.py               # Packaging (arm64 zip) + background deploy/remove jobs
    agentcore.py            # AWS wrapper: S3, IAM role, AgentCore runtime create/update/invoke
    bedrock_catalog.py      # Live, cached list of the account's Bedrock chat models / inference profiles
    datasources.py          # BigQuery data sources: federation sign-in, SQL guardrails, sql_schema/sql_query context
    app.py                  # FastAPI serving layer
  tests/                    # Offline, fully mocked suite
  scripts/                  # Real-API smoke checks
  pyproject.toml            # Backend deps; .env lives here too
frontend/                   # React + Vite operator console (own package.json)
docs/                       # systemDescription.md (architecture), SYSTEM_PROMPT.md
```

Every `uv` command runs from `backend/`. Serve the API with
`uv run uvicorn agentic_platform.app:app --reload`; run the console with `npm run dev`
from `frontend/`.

Keep the planner and compiler cleanly separated: the planner never talks to
infrastructure, the compiler never talks to an LLM for planning decisions.

## Architecture decision log

Each entry: what was decided, why, and the rule it leaves for future code. Add an entry
whenever a change departs from or extends the contract above — don't silently diverge.

### 2026-09-30 — MongoDB is the primary datastore, not PostgreSQL
- **Why:** a project is essentially one JSON document (the plan plus a little metadata),
  so a document store fits without an ORM or migrations; the team chose MongoDB and runs
  it locally in Docker (`docker run … mongo:8`), with Atlas or Amazon DocumentDB as the AWS
  path.
- **Rule:** use plain CRUD only (find, insert, conditional update, simple indexes) so the
  same code runs on a local server, Atlas and DocumentDB. Usage/billing queries will be
  harder than in SQL — revisit if those become central.

### 2026-09-30 — All persistence goes through store interfaces
- **Why:** routes must not depend on a database driver, the offline test suite must run
  without a database, and the backing store should be swappable without touching routes.
- **Rule:** `ProjectStore` / `UserStore` in `stores.py`, each with an in-memory and a
  MongoDB implementation that pass the same contract tests (`tests/test_stores.py`; the
  MongoDB half runs whenever a server is reachable). With `MONGODB_URI` unset the app
  falls back to in-memory. Store reads re-validate documents into Pydantic models —
  stored data is not trusted to still be valid.

### 2026-09-30 — Compiled graphs are cached per process, keyed by plan version
- **Why:** a compiled LangGraph graph is built from closures and can't be serialized, so
  it can't live in Redis or the database; compiling makes no LLM calls, so rebuilding is
  cheap.
- **Rule:** every project has a `plan_version` (bumped on any plan change) and a
  `compiled_version`; a project is runnable only while they are equal. That stored pair
  is the source of truth — any process rebuilds the graph on demand, so restarts and
  multiple workers behave the same.

### 2026-09-30 — Users sign in with email + password; JWT bearer tokens
- **Why:** the API had no authentication, so anyone who could reach it could spend the
  provider keys. Email/password with short-lived stateless tokens is the smallest secure
  baseline that needs no extra infrastructure.
- **Rule:** passwords are Argon2id hashes only; tokens are HS256 JWTs (`JWT_SECRET`, 60 min
  default) carrying just the user id, verified with the algorithm pinned and `exp`
  required. Every project route takes `current_user`; each user is their own tenant
  (`tenant_id` = user id) and another user's project is a 404. Login failures are
  indistinguishable (unknown email still runs a full hash check). Request-validation
  errors use the typed error shape and never echo the submitted value, because that
  value can be a password. Not yet done: refresh tokens, login rate limiting, email
  verification, password reset, per-project API keys for machine clients.

### 2026-10-01 — The planner chooses the team size unless the user sets one
- **Why:** users often don't know how many agents a task needs; asking first added
  friction and invited oversized teams.
- **Rule:** `agent_count` is optional. Given, it is a hard ceiling; omitted, the planner
  picks the smallest team that does the task. Either way `MAX_AGENTS` (10) is enforced in
  `_semantic_check`, server-side, and an oversized plan goes back to the model with the
  actual error — the prompt asking for a size is never trusted on its own.

### 2026-10-01 — Plans can be changed by conversation
- **Why:** reviewing a plan usually means wanting small changes ("run these in
  parallel", "add a reviewer", "change the task to …"); hand-editing JSON is slow and
  error-prone.
- **Rule:** `revise_plan()` returns a structured `PlanRevision` (reply, brief, plan) and
  goes through the same retry loop (`_invoke_with_retries`) and `_semantic_check` as
  `plan_project()` — one validation path for every plan. A chat message is **not** an
  opt-in: revisions may use built-in tools but only external tools the project already
  opted into. The write is conditional on the `plan_version` the revision was based on
  (otherwise 409 `PlanConflict`, nothing saved), so no change is lost to a race. The
  conversation is stored on the project (last 100 messages) so it survives reloads; only
  the last 10 are sent to the model, to bound prompt size and cost.

### 2026-10-01 — Run limits belong to the platform, not the planner model
- **Why:** the planner model filled in `bounds` itself and gave a web-searching travel
  project a 60 s limit; real runs took ~80 s, and the unhandled timeout surfaced as a bare
  500. The timeout also fired late, because `run_graph` waited for the worker thread.
- **Rule:** `plan_project` replaces whatever bounds the model returns with `RunBounds()`
  defaults, and `revise_plan` keeps the project's existing bounds — only an explicit plan
  edit changes them. `run_graph` returns as soon as the limit passes (the abandoned run
  finishes in the background, its result dropped), and a timed-out run is a typed
  `504 RunTimeout` that says how to raise the limit.

### 2026-10-01 — Known deviation: planning calls are synchronous
- **Why:** background workers (Redis + Celery/RQ) aren't built yet.
- **Rule:** `POST /projects` and `POST /projects/{id}/revise` block on an LLM call (often
  10–60 s). Accepted for now; move both to the job queue when it exists, as the
  Scalability section requires.

### 2026-10-01 — Console structure
- **Why:** the single-page console put brief, plan, compile and run on one screen,
  which was cluttered and hard to follow.
- **Rule:** a collapsible sidebar lists only destinations that exist (no placeholder
  menu items); each project step (Brief, Plan, Compile, Run, Deploy) is its own page; new
  projects are created through a chat-style page whose settings are optional. Routing
  is hash-based with no router dependency. The console holds no business rules: tool
  descriptions and defaults come from the API, and any limit it mirrors for convenience
  (such as the 1–10 agent range) is enforced again by the API.

### 2026-10-01 — Deploying to AgentCore: direct code, one runtime per project
- **Why:** users need a hosted endpoint for a finished flow. AgentCore's direct-code
  deployment takes a zip from S3, so there's no Docker build or container registry to
  manage; one runtime per project keeps projects isolated and lets the runtime work
  without database access (the plan is baked into its package).
- **Rule:** the runtime app (`runtime_app.py`) wraps the same compile/run functions as the
  local API with the same input/output JSON — keep them in sync. The package contains
  only what serving needs: platform-only modules and packages (accounts, database, AWS SDK)
  stay out. Dependencies are built as `aarch64-manylinux_2_28` wheels (numpy has no
  manylinux2014 arm64 wheels; AWS's sample measured the runtime as AL2023 / glibc 2.34).
  All AWS calls go through `agentcore.AgentCoreCloud` so they can be tested without AWS.
  Callers invoke deployments through the platform's API with their sign-in token; the
  platform holds the AWS credentials.

### 2026-10-01 — Known deviation: provider keys reach deployments as environment variables
- **Why:** chosen for simplicity over Secrets Manager for the first version.
- **Rule:** only the keys the plan's providers and tools need are passed; a missing key
  fails the deploy request before any AWS call; keys are never logged, stored on a record
  or returned. Anyone with read access to the runtime's configuration in the AWS account
  can see them — move to Secrets Manager / AgentCore Identity before multi-tenant use, as
  the Deployment section requires.

### 2026-10-01 — Known deviation: deploys run in-process
- **Why:** no job queue yet, and a deploy takes minutes.
- **Rule:** the deploy runs as a FastAPI background task and records each step on the
  project; the request returns 202 at once. A deploy cut off by a restart shows as failed
  after 30 minutes without progress. Move it to the job queue when one exists.

### 2026-10-01 — Run page: live events, readable output, frontend checks
- **Why:** agent answers showed raw Markdown run together on one line, the Run page
  mixed stale results with fresh inputs, and there was no way to watch a run happen.
- **Rule:** an agent's `content` is GitHub-flavored Markdown with real line breaks — the
  schema and final instruction say so, and the backend normalises or sends back flattened
  answers; the console renders it as Markdown, never as HTML. Full runs stream per-agent
  events (`POST /projects/{id}/run/stream`, Server-Sent Events) through a per-run `emit`
  in LangGraph config; `/run` stays the non-streaming contract. The diagram shows only
  states the server reported — never simulated progress. Frontend changes must pass
  `npm run lint`, `npm test` and `npm run e2e` (Playwright + axe, light and dark).
  Working log: `docs/run-page-audit.md`.

### 2026-10-01 — Project knowledge bases: documents agents search with a tool
- **Why:** agents could only use the task input and the public tools; users need them to
  work from their own documents (policies, price lists, notes).
- **Rule:**
  - **Scope:** one knowledge base per project. PDF, .docx, .txt/.md and .csv are
    extracted and chunked on the platform (`knowledge.py`); each passage keeps its source
    (page, section, table, CSV rows).
  - **Storage:** original files are not stored. Only the passages and their embeddings
    are kept (`KnowledgeStore`: `knowledge_documents` / `knowledge_chunks`), which is all
    re-embedding needs, and less of the user's data to hold.
  - **Embeddings:** `get_embeddings()` sits beside `get_llm()` as the only place an
    embedding provider is chosen. The default follows the project's provider (Gemini or
    OpenAI, both at 768 dimensions), else the first with a key; changing it re-embeds
    every passage.
  - **Access:** agents reach documents only through the `knowledge_search` tool, bound to
    their own project's `KnowledgeContext`. It searches at call time, so new uploads need
    no recompile. Its output is fenced as reference material, not instructions, and cites
    `[file — source]`.
  - **Opt-in:** uploading is the per-project opt-in for sending text to the embedding
    provider, and the page says so. `knowledge_search` is never in the default tool set
    and is offered to the planner/assistant only once a document is ready. Compiling a
    plan that uses it without documents fails with `KnowledgeUnavailable`.
  - **Limits, enforced server-side:** 20 MB per file, 10 per request, 50 files and 20,000
    passages per project, extension allow-list, zip-bomb and page caps, and nothing
    queued unless every file in a request passes.
  - **Deploys:** a plan that uses the tool carries a snapshot (`knowledge.json` +
    `knowledge_vectors.npy`) and gets the embedding key. The runtime never parses files.

### 2026-10-01 — Known deviation: knowledge indexing runs in-process; search is brute force
- **Why:** no job queue or vector index yet; at ≤20,000 passages per project a numpy
  cosine scan is milliseconds.
- **Rule:** indexing is a FastAPI background task that records `queued → processing →
  ready/failed` per file. A file stuck for 30 minutes is reported failed. Embedding
  batches retry 3 times with backoff, and a failed file leaves no partial passages.
  Move indexing to the job queue when it exists, and to Atlas Vector Search (or another
  vector index) if per-project limits grow. A deployed snapshot reflects the knowledge
  base at deploy time; redeploy after changing files.

### 2026-10-05 — Knowledge has a workspace page as well as a project step
- **Why:** with several projects there was no single place to see which files were
  uploaded, which were still indexing or had failed, or to tidy them up.
- **Rule:** the sidebar's Workspace section has Projects and Knowledge. The Knowledge page
  (`GET /knowledge`) is a cross-project *view* — files still belong to exactly one project,
  uploads name the project, and agent access, test search and the embedding model stay on
  the project's Knowledge step. Both pages share `components/KnowledgeUpload.jsx`; the
  overview never lists files of projects the user doesn't own.

### 2026-10-05 — Projects can be deleted, but never out from under a deployment
- **Why:** users need to clear out old projects; a project record is also what tracks its
  AgentCore runtime.
- **Rule:** `DELETE /projects/{id}` (owner-scoped; someone else's project is a 404) removes
  the project and its compiled-graph cache entry, and detaches its knowledge files (they
  stay in the owner's library). The project record goes first, so a failure part-way
  leaves only attachments to a project that no listing shows.
  A project with a deployment in progress or a runtime in AWS is refused with
  `409 ProjectDeployed` — remove the deployment first, so no runtime is left running with
  nothing pointing at it.

### 2026-10-05 — Knowledge is a per-user library; files are attached to projects
- **Why:** users wanted to upload documents before (or without) choosing a project, and
  to use one document in several projects without uploading and indexing it again.
- **Rule:** this supersedes the "one knowledge base per project" scope above. A file
  belongs to its owner's library (`KnowledgeDocument.tenant_id`) and is attached to any
  number of that user's projects (`project_ids`); it is indexed once, with the library's
  single embedding model (`knowledge_settings`), whatever LLM a project's agents use.
  `knowledge_search`, the project's test search and a deployment snapshot see only the
  files attached to that project. Every store method is scoped by tenant; attaching
  checks that both the project and the file are the caller's (404 otherwise). Detaching
  and deleting a project never delete files — only deleting from the library does. Limits
  are per library (100 files, 20,000 passages). Existing project-scoped data is migrated
  in place on first use, idempotently.

### 2026-10-05 — Every model call is counted; cost is an estimate from a price table
- **Why:** there was no way to see which models a project used, how many tokens it
  consumed, or what it cost.
- **Rule:**
  - **Counting chat models:** every chat-model call passes a `usage.UsageCallback`
    explicitly (`config={"callbacks": …}`). That covers agents' tool turns, structured
    answers, rewrites and retries, supervisor routing, and the planner and assistant
    including retries. Tokens are the provider-reported `usage_metadata`; Gemini's
    thinking tokens count as output.
  - **Counting embeddings:** these don't report tokens, so indexing and
    `knowledge_search` queries are estimated at ~4 characters per token and flagged
    `estimated`.
  - **Reporting:** a run's collector travels in LangGraph config like `emit`. Runs return
    `usage` locally and from AgentCore runtimes (the same contract).
  - **Storing:** `app.py` stores `UsageRecord`s through `UsageStore` (`usage_events`).
    Recording is **best effort**: it never fails the work it measures, and usage up to a
    timeout or a client disconnect is still recorded.
  - **Cost:** comes only from `backend/pricing.json`. Every price there carries its
    official source URL and the date it was checked; a model without a confirmed price
    stays unpriced (tokens shown, "price not set"), never guessed. Each record keeps the
    price it was costed with, so editing the table doesn't rewrite history.
  - **Totals:** computed in Python over the requested range (plain CRUD, per the MongoDB
    decision).
  - **Not counted:** tool API costs such as Tavily.

### 2026-10-05 — Deployed runs invoked straight through AWS are counted from runtime logs
- **Why:** a runtime called with `InvokeAgentRuntime` directly (not through the platform)
  spent tokens without any record: the runtime has no database and no channel back.
- **Rule:**
  - **The log line:** every runtime invocation, on every path, prints one JSON line
    (`{"type": "agentic_usage", "v": 1, run_id, via, at, usage}`) to stdout, which
    AgentCore ships to CloudWatch. It holds only ids, labels and token counts — never
    task input, output, document text or keys — and needs no prompt changes.
  - **Matching platform calls:** the platform sends its own `run_id` with each call, so
    its immediate record and the log line match.
  - **The sync:** `usage_sync` reads each deployment's log group from a per-deployment
    cursor (`usage_synced_until`), re-reading 10 minutes of overlap because delivery can
    lag. It validates lines as untrusted input, skips run ids already stored, and records
    the rest as `deployed_run` with `via="direct"`, dated when the run happened. Re-reading
    is harmless.
  - **Old runtimes:** runtimes deployed before this don't print the line; their
    deployments carry `reports_usage=False` and the UI asks for a redeploy.
  - **Known deviation:** with no job queue, the sync runs on demand — in the background
    when the Usage page loads (at most every two minutes per project) and via
    `POST /usage/sync`. Move it to the job queue when one exists.

### 2026-10-05 — Landing page, per-agent model/tool edits, files in the new-project chat
- **Why:** describing a task is the first thing users do; changing a model or tool
  shouldn't need plan JSON; and users want to give a new project its documents up front.
- **Rule:**
  - **Landing page:** signing in (or an empty route) lands on New project.
  - **`PUT /projects/{id}/agents`:**
    - **Models:** each agent's model comes from the platform's list or the model it
      already has. Provider-specific `extra_params` are dropped when the model changes.
    - **Tools:** from the registry, with `knowledge_search` only when files are attached.
    - **Opt-in:** an external tool switched on there is an explicit user action, so it
      becomes the project's opt-in. It's saved with the plan in one `update_plan` write,
      and the result goes through the same plan validation and makes a new version.
    - (A chat message still is not an opt-in.)
  - **Files on create:** `POST /projects` takes `document_ids` from the caller's own
    library. The planner gets `knowledge_search` and the files' **names** only, never
    their content, and the files are attached once the project exists.

### 2026-10-06 — Amazon Bedrock models through IAM (chat and embeddings)
- **Why:** provider API keys bring per-provider limits (Groq's on-demand tier capped a
  search-heavy agent at 8,000 tokens/minute) and put keys in deployments' environment;
  the user already has an IAM identity with Bedrock access.
- **Rule:**
  - **Chat:** `provider="bedrock"` in `get_llm()` only (`ChatBedrockConverse`,
    `BEDROCK_REGION`, default ap-south-1). Credentials are the AWS chain — the user's IAM
    keys locally, a deployment's **execution role** in AgentCore — so no model key is
    stored or passed.
  - **Model IDs:** a model id or an **inference-profile id**. Claude is only reachable
    through a profile (`in.` / `apac.` / `global.`).
  - **Catalog:** `bedrock_catalog` lists the account's chat models and profiles live
    (cached 10 minutes; a stale list is served while it refreshes in the background, and
    a failed refresh keeps the last good list), dropping embedding, image, speech and
    guard models, and keeping one profile per model (in-country, then regional, then
    global). It lists only models the account can invoke: `GetFoundationModelAvailability`
    must report agreement, authorization, entitlement and region all available (a model
    whose access can't be read is kept). Entries carry a clean `vendor`, `name` and
    `scope`. Bedrock ids are accepted only if they're in that list (create, `/agents`);
    the assistant may use the recommended ones.
  - **Console:** model menus are `components/ModelPicker.jsx`, a searchable listbox
    grouped into platform models, recommended Bedrock models and one section per vendor,
    with the region as a tag. Not a native `<select>`, which can't be styled or searched.
  - **Embeddings:** each option in `config.EMBEDDING_OPTIONS` carries its vector size
    (Gemini/OpenAI 768; Bedrock Titan v2 and Cohere v4 1024). Each model's vectors are
    kept and searched in their own matrix (see the per-file decision below).
  - **Permissions:** the IAM user and the execution role need `bedrock:InvokeModel` (and
    `InvokeModelWithResponseStream`) on `arn:aws:bedrock:*::foundation-model/*` and
    `arn:aws:bedrock:*:<account>:inference-profile/*`. Platform-created roles get this;
    an admin-made role needs it added. `boto3` now ships in runtime packages.
  - **Tests:** the offline suite must not call AWS: `tests/conftest.py` stubs the catalog
    for every test.

### 2026-10-06 — Each knowledge file has its own embedding model
- **Why:** the user wants to choose the embedding model per file, from the file's row on
  the Knowledge page, rather than one model for the whole library. This supersedes the
  "single embedding model" part of the per-user library decision.
- **Rule:**
  - **Data:** `KnowledgeDocument.embedding` is the model a file is indexed with, set at
    upload from the library default. Files from before this have none and read as the
    library default (`knowledge.effective_embedding`); changing the default first pins
    them to the model they were really indexed with. No migration write.
  - **Default:** `PUT /knowledge/embedding` sets the model for **new uploads only** and
    re-indexes nothing.
  - **One file:** `PUT /knowledge/documents/{id}/embedding` (owner-scoped; 422 for an
    unknown model, 409 `KnowledgeBusy` while the file is indexing) re-embeds that file's
    stored passages in the background. On failure the file is `failed` and keeps its old
    vectors and model.
  - **Search across models:** vectors from different models live in different spaces (and
    sizes), so passages are grouped by model, one matrix each; the query is embedded once
    per model in use, each group is ranked by cosine similarity, and the rankings are
    merged with reciprocal rank fusion (1 / (60 + rank)). Scores are never compared
    across models. With one model the results are exactly that model's ranking.
  - **Cost:** a search costs one query embedding per distinct model among the files
    searched; each is recorded as its own `embedding_query` usage entry.
  - **Embedders** are chosen at search time, so the compiled-graph cache is keyed by
    `plan_version` only.
  - **Deploys:** the snapshot holds one matrix per model (`knowledge_vectors.npz`), and
    the runtime gets the key of every embedding provider its files use. Old one-model
    snapshots still load.
  - **Console:** the Knowledge page has no side panel. The upload area is centred above
    the table, with no card around it, and uploads to the library only; files are
    attached to projects from their rows. Each row has a model select that confirms
    inline before re-indexing. The page has no default-model control: the default is
    set by the API (first upload, or `PUT /knowledge/embedding`).

### 2026-10-06 — Agents may query BigQuery with SQL they write
- **Why:** the user wants agents to answer from live data in BigQuery, not only from
  uploaded files. Fixed, pre-written queries couldn't answer open questions.
- **Rule:** this is a deliberate, bounded exception to principle 1 ("never execute
  LLM-generated code"). Model-written SQL runs only through `datasources.DataContext.query`,
  and every guardrail below is enforced by the platform, never left to the model:
  - **Read-only access:** the service account has `roles/bigquery.dataViewer` on shared
    datasets and `roles/bigquery.jobUser`, nothing else.
  - **The check (`check_sql`):** `sqlglot` (BigQuery dialect) accepts exactly one
    `SELECT` (CTEs and set operations allowed). It rejects DML, DDL, `MERGE`, `CALL`,
    `EXPORT`, scripting and `INFORMATION_SCHEMA`. Every table must resolve to the source's
    allow-list (`project.dataset.table`, public datasets allowed). Refused SQL never
    reaches Google, and the refusal goes back to the agent as the tool result, so it can
    fix its own query.
  - **Cost:** a free dry run must estimate ≤ `BIGQUERY_MAX_BYTES` (1 GB), and the real job
    carries `maximumBytesBilled` at the same cap, so BigQuery refuses anything larger too.
    Results are capped at `BIGQUERY_MAX_ROWS` (200) rows and 12,000 characters, fenced as
    data, not instructions; a job that runs past the timeout is cancelled.
  - **Credentials:** Workload Identity Federation from AWS, so no Google key exists. Google
    trusts the platform's IAM user locally and the AgentCore execution role when deployed.
    `gcp_credentials` feeds boto3's credentials to google-auth through a custom
    `AwsSecurityCredentialsSupplier`, because google-auth's own AWS source only reads env
    vars and EC2 metadata. Setup: `docs/bigquery_setup.md`.
  - **Opt-in:** `sql_schema` / `sql_query` are never default tools. Attaching a source to a
    project on the Data sources page is that project's opt-in to sending query results
    to its agents' model provider; only then are the tools offered (planner, assistant,
    Brief editor).
  - **Usage:** each query records `kind="bigquery_query"` with `bytes_billed`. Cost uses a
    `per_tib` price from `pricing.json`, which stays unset until confirmed on Google's
    pricing page.
  - **Deploys:** the package carries `datasources.json` (the attached sources' non-secret
    config), and the runtime gets `GCP_WIF_AUDIENCE`.
  - **Tests:** the offline suite can't reach Google: `tests/conftest.py` replaces
    `gcp_credentials` for every test.
  - **Known deviation:** federation trusts the platform's AWS identity, not the user, so
    any platform user who registers a service account that trusts the pool could query
    as it. Mitigation now: a service account belongs to one tenant (409 if already
    claimed). Before multi-tenant use, move to a per-tenant AWS role (or a per-tenant
    pool) so Google can tell tenants apart.

## Working style — verify-and-retry, always

Never mark something done because the code looks right.

1. Implement the smallest testable unit (a schema, a single node, one endpoint).
2. Actually execute it — run the function, hit the endpoint, invoke the graph. Reading
   the code back is not verification.
3. On failure: capture the full error, form a specific hypothesis from that error (not a
   guess), apply one targeted fix, re-run.
4. Repeat until it passes or you hit a retry ceiling (default: 5 attempts on the same
   unit).
5. Still failing after the ceiling: stop. Report exactly what failed, the full error
   text, and what was already tried. Never fabricate a passing result, silently skip the
   failing piece, or keep retrying the same fix expecting a different outcome.
6. Same discipline at every layer: a single Pydantic validation, a planner
   structured-output call, a compiled graph execution, a live endpoint smoke test.

Build in vertical slices (e.g. "brief in, one working sequential 2-agent deployment
out") before broadening to every pattern and provider — breadth-first architecture,
depth-first delivery. Write tests alongside each component, especially plan-validation
and graph-compilation — silent bugs there become security or cost incidents. Document
architectural decisions in-repo as they're made.
