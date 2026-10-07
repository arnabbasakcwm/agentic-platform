# Agentic Platform

**Natural-language multi-agent builder.** Describe a task in plain English, and get back
live, callable API endpoints for a compiled multi-agent system — ready to wire into your
own website, app, or pipeline. The planner decides how many agents the task needs (or you
can set the number), and you can keep reshaping the team by simply asking for changes.

> Full architecture, the reasoning behind every dependency, error model, and deployment
> design: see [systemDescription.md](docs/systemDescription.md). This file is a quick-start.

---

## Overview

### Problem

Building a multi-agent AI system today means hand-writing orchestration logic, wiring up
tools, choosing and configuring models, and standing up infrastructure to serve it — even
for people who know exactly *what* they want the agents to do but don't want to own the
engineering behind *how* it runs.

### What it does

1. The user describes their task in natural language — in a chat-style console, or
   through the API.
2. The planning layer turns that description into a structured, validated plan: how many
   agents, each agent's job, how they're wired together (sequential, parallel, or
   supervised/routed), what tools each needs, and which LLM powers each one.
3. The user reviews the plan and can change it — by asking the plan assistant in plain
   language ("run these in parallel", "add a reviewer") or by editing the JSON — before
   anything is built.
4. The platform compiles the plan into a running multi-agent graph and serves it —
   locally via FastAPI, and with one click on Amazon Bedrock AgentCore Runtime.
5. The user takes the resulting endpoints and builds whatever they want on top, without
   touching orchestration code themselves.

### Non-goals (for now)

- Not a general no-code app builder — the output is API endpoints, not a UI.
- Not a training or fine-tuning platform — it composes and serves existing foundation models.
- Not aiming for full arbitrary-code agents — agents are LLM calls plus a fixed, vetted
  set of tools, never sandboxed code-execution environments.

---

## Project structure

Backend and frontend are separate, independently runnable projects.

```
.
├── backend/                        # Python API + agent runtime
│   ├── src/agentic_platform/       # Installable package
│   │   ├── agent_schema.py         # Pydantic contracts: LLMConfig, AgentSpec, AgentPlan
│   │   ├── meta_planner_prompt.py  # Meta-planner: brief -> AgentPlan; plan revisions
│   │   ├── graph_builder.py        # LLM factory + AgentPlan -> LangGraph compiler
│   │   ├── tools.py                # Closed, vetted tool registry
│   │   ├── config.py               # Env loading, provider/model defaults
│   │   ├── errors.py               # Typed platform errors
│   │   ├── stores.py               # Project, user and knowledge persistence (in-memory or MongoDB)
│   │   ├── knowledge.py            # Knowledge bases: document parsing, indexing, search
│   │   ├── auth.py                 # Password hashing + JWT access tokens
│   │   ├── runtime_app.py          # What a deployed project runs on AgentCore
│   │   ├── deploy.py               # Packaging + deploy jobs
│   │   ├── agentcore.py            # AWS calls (S3, IAM, AgentCore)
│   │   └── app.py                  # FastAPI serving layer (local/MVP)
│   ├── tests/                      # Offline, fully mocked test suite
│   ├── scripts/smoke_e2e.py        # Real-API end-to-end smoke script
│   ├── .env.example
│   └── pyproject.toml
├── frontend/                       # React + Vite web console
│   ├── src/
│   │   ├── pages/                  # Projects list, new project, per-step project pages
│   │   ├── components/             # Sidebar, top bar, stepper, shared UI
│   │   └── lib/                    # API client, hash router
│   └── package.json
├── docs/
│   ├── systemDescription.md        # Full architecture, flow diagrams, dependency rationale
│   └── SYSTEM_PROMPT.md            # Original builder system prompt
├── CLAUDE.md                       # Operating contract for whoever builds this
└── README.md
```

---

## Getting started

Requires Python 3.11 with [uv](https://docs.astral.sh/uv/), Node for the console, and
MongoDB for storage (optional for a first try — see step 2).

**Database** — MongoDB in Docker is the simplest local setup:

```bash
docker run -d --name agentic-mongo --restart unless-stopped \
  -p 27017:27017 -v agentic-mongo-data:/data/db mongo:8
```

Any MongoDB works, including a free MongoDB Atlas cluster (use its `mongodb+srv://` URI).
On Windows with Smart App Control on, the native MongoDB Community Server may be blocked
from starting; Docker or Atlas avoid that. MongoDB Compass can browse the data at
`mongodb://localhost:27017` → `agentic_platform`.

**Backend** — first terminal:

```bash
cd backend

# 1. Install dependencies (creates backend/.venv from pyproject.toml / uv.lock)
uv sync

# 2. Configure environment
cp .env.example .env
# Fill in at least one LLM provider key (the default provider is Gemini, so
# GOOGLE_API_KEY or GEMINI_API_KEY is the easiest to start with). Knowledge bases
# also need a Gemini or OpenAI key, for embeddings.
# TAVILY_API_KEY is only needed if a project opts into the web_search tool.
# Set MONGODB_URI=mongodb://localhost:27017 to persist projects and accounts; leave it
# unset and everything is kept in memory and lost when the server stops.
# Set JWT_SECRET to a long random value so sign-ins survive a server restart:
#   python -c "import secrets; print(secrets.token_urlsafe(48))"

# 3. Run the API
uv run uvicorn agentic_platform.app:app --reload
# -> http://127.0.0.1:8000/docs for interactive OpenAPI docs
```

**Console** — second terminal:

```bash
cd frontend
npm install
npm run dev
# -> http://localhost:5173
```

Vite proxies `/api` to the backend on port 8000, so both run on one origin in the
browser. Set `VITE_API_BASE` to point the console at a different API.

### Using the console

1. **Create an account** on the sign-in screen (email and a password of 8+ characters).
2. **New project** — the page you land on after signing in. Describe the task in the
   message box and press Enter. The planner designs the team and replies with a summary
   and a *Review plan* link.
   - *Add files* attaches knowledge files: upload new ones (they also go into your
     library) or tick existing library files. The planner is told about them and gives
     the agents that need them `knowledge_search`.
   - Team size, model and tools are optional; open them from the pill under the message
     box.
3. **Brief / Knowledge / Plan / Compile / Run** (Brief also lets you change each agent's model and tools) — each project has one page per step. The
   plan assistant beside Brief, Knowledge, Plan and Compile takes change requests in plain
   language; any change makes a new plan version that has to be compiled again.
   - **Knowledge** (optional) — the files attached to this project; its agents search
     only these. Attach files from your library or add new ones (they go into your library
     too); *Detach* removes a file from this project but keeps it in the library. *Test
     search* shows what an agent would find. *Give agents access* asks the assistant to
     give the `knowledge_search` tool to the agents that need it; their answers then cite
     the file and page or rows.
4. **Deploy** — after Run, the Deploy page puts the compiled plan on Amazon Bedrock
   AgentCore Runtime, lets you try the live deployment, and shows how to call it from an
   app. Needs AWS set up — see [Deploying to AWS](#deploying-to-aws-agentcore).
5. **Projects** — every project you've created, newest first; the sidebar also lists the
   most recent ones. The trash icon on a row deletes a project with its plan and
   conversation (it asks first); its files stay in your knowledge library. A project
   deployed on AgentCore must have its deployment removed on the Deploy page before it
   can be deleted.
6. **Knowledge** (sidebar) — your knowledge library. Upload PDF, Word, text, Markdown or
   CSV files from the upload area at the top, see each file's live indexing status,
   attach any file to any number of projects from its row, filter by name, project ("not
   attached" included) and status, and delete files. Each file has its own embedding
   model, shown in its row: pick another one there and confirm to re-index that file
   (nothing is uploaded again). New uploads use the library's default model
   (`PUT /knowledge/embedding`).
   File text and agents' search queries go to each file's embedding provider; the files
   themselves aren't stored, only the text passages taken from them.
7. **Usage** (sidebar) — which models your projects used, how many tokens, and the
   estimated cost, over 7, 30 or 90 days and per project:
   - totals and a cost-per-day chart;
   - breakdowns by model, activity (agent runs, planning, plan assistant, indexing,
     knowledge searches) and project;
   - recent runs, each expandable to every agent's model and tokens.
   Finished runs on the Run page and the deployed *Try it* also show their tokens and
   cost. Costs are estimates from list prices in `backend/pricing.json` (each with its
   source and date); add a model there to price it. Embedding tokens are estimated.
   Deployed flows called straight through AWS (not through this platform) are counted
   too: each runtime logs its usage, and the page reads those logs (*Sync now*, or
   automatically when it opens). Runtimes deployed before this need a redeploy.

Try it end to end with curl:

```bash
# Create an account (or POST /auth/login with the same body once you have one)
curl -s -X POST localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "at-least-8-characters"}'
# -> {"access_token": "...", "token_type": "bearer", "expires_in": 3600, "user": {...}}
TOKEN=<access_token>

# Plan a project from a natural-language brief
curl -s -X POST localhost:8000/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"brief": "Answer a factual question, then write a one-sentence summary."}'
# agent_count is optional: omit it and the planner chooses the team size (max 10)
# -> {"project_id": "...", "plan": {...}, "side_effect_tools_enabled": []}

# Change it by asking (optional) — a change needs a new compile
curl -s -X POST localhost:8000/projects/<project_id>/revise \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Add an agent that double-checks the answer"}'
# -> {"changed": true, "reply": {...}, "project": {...}}

# Compile the plan into a runnable graph
curl -s -X POST localhost:8000/projects/<project_id>/compile \
  -H "Authorization: Bearer $TOKEN"

# Run it
curl -s -X POST localhost:8000/projects/<project_id>/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": {"question": "What is the speed of light?"}}'
```

### Tests

```bash
cd backend
uv run pytest                       # offline, LLMs mocked — no API keys or network needed
                                    # (MongoDB store tests also run if a server is reachable)
uv run python scripts/smoke_e2e.py  # real LLM + tool calls end to end (needs .env keys)
```

Console checks (from `frontend/`):

```bash
npm run lint   # ESLint
npm test       # unit tests (Vitest)
npm run e2e    # Playwright + axe against a scripted mock API; uses the installed Edge.
               # Screenshots of the Run page (idle/running/completed/failed, 3 widths,
               # light and dark) land in frontend/e2e/screenshots/
```

---

## Orchestration patterns

Chosen automatically by the planner per project, never hardcoded to one:

| Pattern | When it's used |
|---|---|
| **Sequential** | Strict pipeline — each agent's output feeds the next (research → draft → edit). |
| **Parallel** | Independent agents run concurrently on the same input and merge at a synthesis step. |
| **Supervisor** | A router agent decides at runtime which agent acts next, looping until it signals completion. |

See [systemDescription.md](docs/systemDescription.md) for how each pattern actually compiles
to a LangGraph graph.

---

## API at a glance

All `/projects` routes need `Authorization: Bearer <token>` and only ever see the
signed-in user's projects. Interactive docs: http://127.0.0.1:8000/docs.

| Endpoint | Purpose |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `GET /auth/me` | Accounts and sign-in |
| `GET /health`, `GET /tools`, `GET /providers` | Status, tool registry, model options (public) |
| `POST /projects` | Plan a new project from a brief (`agent_count` and `name` optional) |
| `GET /projects`, `GET /projects/{id}` | List your projects / fetch one with its plan and conversation |
| `PATCH /projects/{id}` | Rename a project (`{"name": "…"}`; empty goes back to the brief's first line) |
| `POST /projects/{id}/revise` | Change the brief or plan by asking in plain language |
| `DELETE /projects/{id}` | Delete a project; its files stay in your library (refused while it's deployed) |
| `PUT /projects/{id}/agents` | Change agents' model and tools (turning on an external tool is the project's opt-in) |
| `PATCH /projects/{id}/plan` | Replace the plan with an edited one (re-validated) |
| `POST /projects/{id}/compile` | Build the runnable graph (no model calls) |
| `POST /projects/{id}/run` | Run the whole team on an input |
| `POST /projects/{id}/run/stream` | Same, streaming each agent's progress as Server-Sent Events |
| `POST /projects/{id}/runs` | Start a run in the background; it's saved as it happens (202) |
| `GET /projects/{id}/runs?kind=local\|deployed` | The project's last 5 saved runs of that kind |
| `GET /projects/{id}/runs/{run_id}` | One saved run: input, events, outputs, errors, usage |
| `GET /projects/{id}/runs/{run_id}/stream?after=N` | Replay a saved run's events from N, then follow it live |
| `POST /projects/{id}/deployment/runs` | Run the deployment in the background (the console's Try it); saved like any run |
| `POST /projects/{id}/agents/{agent_id}/invoke` | Run one agent on its own |
| `GET /knowledge` | Your library: every file with the projects it's attached to and its embedding model, the default model for new uploads, limits |
| `POST /knowledge/documents` | Upload files to the library, attached to no project (multipart field `files`) |
| `PUT /knowledge/documents/{doc_id}/projects` | Set which projects a file is attached to |
| `DELETE /knowledge/documents/{doc_id}` | Delete a file from the library (and every project) |
| `PUT /knowledge/embedding` | Set the embedding model new uploads use (existing files keep theirs) |
| `PUT /knowledge/documents/{doc_id}/embedding` | Re-index one file with another embedding model (202; in the background) |
| `POST /knowledge/search` | Search the whole library |
| `GET /datasources` | Your BigQuery data sources, the projects you can attach them to, defaults and per-query limits |
| `POST /datasources` | Connect BigQuery (checks sign-in and lists datasets first) |
| `GET /datasources/{id}/browse` | Datasets and tables the service account can see |
| `PUT /datasources/{id}/tables` | Set which tables agents may query (`project.dataset.table`) |
| `PUT /datasources/{id}/projects` | Set which projects may query the source (the opt-in) |
| `POST /datasources/{id}/query` | Test a query with the same checks and limits as `sql_query` |
| `GET /projects/{id}/datasources` | The sources attached to a project, the ones that could be, and which agents can query |
| `POST` / `DELETE /projects/{id}/datasources/{source_id}` | Attach / detach a source (attaching is the opt-in) |
| `DELETE /datasources/{id}` | Remove a data source |
| `GET /usage?days=30&project_id=` | Models, tokens and estimated cost: totals, per day, per model, per project, per activity, recent runs |
| `POST /usage/sync` | Read deployed runtimes' usage logs now, counting runs invoked straight through AWS |
| `GET /usage/pricing` | The price table in use, and models you've used that have no price |
| `GET /projects/{id}/knowledge` | The files attached to a project, and the library files that could be |
| `POST /projects/{id}/knowledge/documents` | Upload files to the library and attach them to the project |
| `POST /projects/{id}/knowledge/documents/{doc_id}` | Attach a library file to the project |
| `DELETE /projects/{id}/knowledge/documents/{doc_id}` | Detach a file from the project (it stays in the library) |
| `POST /projects/{id}/knowledge/search` | Search the project's files the way `knowledge_search` does |
| `POST /projects/{id}/deploy` | Deploy the compiled plan to AgentCore (runs in the background) |
| `GET /projects/{id}/deployment` | Deployment status, and whether this server can deploy |
| `POST /projects/{id}/deployment/invoke` | Run the deployed flow on AgentCore (same body as `/run`) |
| `DELETE /projects/{id}/deployment` | Remove the deployment |

---

## Amazon Bedrock models (no API key)

If `backend/.env` has AWS credentials (the same ones used for deploying), the model menus
also list every Amazon Bedrock chat model your account can use, grouped under **Amazon
Bedrock**. That includes Claude (through inference profiles such as
`in.anthropic.claude-haiku-4-5…`), Amazon Nova, gpt-oss and Kimi. Bedrock models are
called with your IAM credentials, so there's no per-provider key, and deployed flows call
them as their AgentCore execution role. The knowledge library can also embed with Bedrock
Titan Text Embeddings v2 or Cohere Embed v4 (1024-dimension vectors).

Your IAM user, and the execution role for deployed flows, need:

```json
{"Effect": "Allow",
 "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
 "Resource": ["arn:aws:bedrock:*::foundation-model/*",
              "arn:aws:bedrock:*:<account-id>:inference-profile/*"]}
```

plus `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` and
`bedrock:GetFoundationModelAvailability` to fill the menus. Only models your account can
invoke are listed: a model whose agreement hasn't been accepted (Bedrock → Model access)
is left out. Set `BEDROCK_REGION` to use a region other than the AgentCore one (default
ap-south-1).

## BigQuery data sources (agents query your tables)

Agents can answer from live BigQuery data with two tools: `sql_schema` (which tables and
columns exist) and `sql_query` (run a query). The platform signs in to Google with your
AWS identity (Workload Identity Federation), so there's no Google key file. The one-time
Google Cloud setup is in [docs/bigquery_setup.md](docs/bigquery_setup.md); it ends with
three lines for `backend/.env` (`GCP_WIF_AUDIENCE`, `GCP_SERVICE_ACCOUNT`,
`BIGQUERY_PROJECT`).

Then, in the console's **Data sources** page:
1. **Connect:** the connection is checked step by step.
2. **Choose tables:** browse the project's datasets, or add any table by full name,
   public datasets included.
3. **Attach the source to projects.** Query results are sent to those projects' agents'
   model provider, so attaching is the opt-in.
4. **Test a query.**

You can also pick data sources when creating a project ("Add data" in the new-project
chat): the planner is told the table names and gives the right agents the SQL tools. Or
attach them on the project's **Data** step, which also offers "Give agents access" and a
test query. Otherwise, give an agent `sql_schema` and `sql_query` on the Brief page.

Every query is checked by the platform before Google sees it:
- one `SELECT`, over your chosen tables only; no writes or scripts;
- at most 1 GB scanned (a free dry run first, and BigQuery enforces the cap too);
- at most 200 rows returned.

Check the connection from a terminal with `uv run python scripts/bigquery_check.py`.

## Models that can't call tools

Some Bedrock models (Gemma 3, for example) answer in prose when asked to call a tool. The
first time anyone picks a Bedrock model, the platform checks with one tiny test call, a
fraction of a cent, counted on the Usage page as "Model checks", and remembers the result
for 30 days. Models that can't call tools are tagged **No tool calling** in the model menus:
- **Agents with tools, and supervisors:** can't use them; the menu says why.
- **Agents without tools:** can; they give their answer as checked JSON.

## Deploying to AWS (AgentCore)

Each project deploys as its own Amazon Bedrock AgentCore runtime. The platform builds a
zip (the plan, the runtime code, and dependencies built for Linux arm64), uploads it to
S3, and creates or updates the runtime — no Docker image involved.

1. **Install the AWS CLI** and sign in: `aws configure` (access keys) or `aws sso login`.
   The account needs permission to use Amazon Bedrock AgentCore, S3 and IAM — AWS's
   [AgentCore permissions guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html)
   lists them; the bucket (`bedrock-agentcore-agentic-platform-…`) and role
   (`AmazonBedrockAgentCoreAgenticPlatform-…`) names match its suggested patterns.
2. **Region:** deployments go to `ap-south-1` (Mumbai) unless `AGENTCORE_REGION` is set in
   `backend/.env`. Optionally set `AGENTCORE_EXECUTION_ROLE_ARN` / `AGENTCORE_CODE_BUCKET`
   to use an existing role or bucket.
3. **Restart the API.** The Deploy page now enables the Deploy button.

The first deploy builds the arm64 dependencies (about 30 s) and caches them in
`backend/.deploy-cache/`; AgentCore then takes a few minutes to start the runtime.
The provider keys the plan uses are passed to the runtime as environment variables.

---

## Recent changes and why

The architecture decision log in [CLAUDE.md](CLAUDE.md) records each of these with the
rules it sets for future code; this is the short version.

| Change | Why |
|---|---|
| **Projects and accounts are stored in MongoDB** (in-memory fallback when `MONGODB_URI` is unset) | Everything was lost on every restart. A project is one JSON document, so a document store fits; plain CRUD keeps it portable to Atlas or Amazon DocumentDB. |
| **Storage sits behind small store interfaces** (`stores.py`) | Routes never touch a database driver, tests run without a database, and the store can be swapped without rewriting the API. |
| **Compiled state is tracked by plan version** | Compiled graphs can't be saved to a database, but compiling is cheap — so a project stays "compiled" across restarts and is rebuilt on demand, and any plan change reliably un-compiles it. |
| **Email/password accounts with JWT sign-in; every user sees only their own projects** | The API was open to anyone who could reach it, spending your provider keys. Passwords are Argon2id-hashed; another user's project looks exactly like one that doesn't exist. |
| **The planner chooses the team size by default** | Most people don't know how many agents a task needs. You can still set a number; the 10-agent maximum is enforced by the server either way. |
| **Plan assistant: change the brief or plan by asking** | Small changes ("run these in parallel", "add a reviewer") shouldn't require editing JSON. Revised plans pass exactly the same validation as new ones, can't switch on external tools the project didn't opt into, and are never saved over a plan that changed in the meantime. |
| **Deploy to Amazon Bedrock AgentCore** — one runtime per project, built from a zip (no Docker) | A finished flow needs a hosted endpoint apps can call. The deployed runtime runs the same compiler and runtime code with the same input/output as local runs, so behaviour matches. |
| **Project knowledge bases** — upload PDF, Word, text, Markdown or CSV files; agents search them with the `knowledge_search` tool and cite the file and page | Agents could only use the task input and public tools. Files are indexed into cited passages (originals aren't kept); only projects with documents are offered the tool, and a deployment carries a snapshot so it answers the same way. |
| **Redesigned console** — collapsible sidebar, Projects page, chat-style New project page, separate Brief / Plan / Compile / Run pages | The old single page mixed planning, compiling and running and became cluttered; you also had no way to find earlier projects. |

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **MVP** | Meta-planner + schema, compiler (all 3 patterns), FastAPI serving, real `web_search` tool + opt-in enforcement | **Done** |
| **V1** | Project persistence in MongoDB (**done**); user accounts with JWT sign-in (**done**); plan-review/edit UX incl. plan assistant (**done**); run history and Redis-backed jobs; per-project API keys; synthesis (aggregate) endpoint; deploy a compiled project to Bedrock AgentCore Runtime (**built**; first real AWS deploy pending); project knowledge bases (**done**) | In progress |
| **V2** | Dedicated AgentCore runtime per heavy/isolated tenant; AgentCore Observability + LangSmith; expanded tool registry; rate limiting and billing | Not started |

---

## Security notes (summary)

- No model-generated code is ever executed — only model-generated configuration,
  interpreted by a fixed compiler.
- Every agent run is bounded — enforced max steps, timeouts, and error retries.
- Tools with real-world side effects require explicit per-project opt-in; the planner
  never auto-attaches them, and the plan assistant can't switch them on either.
- Every project route requires a signed-in user and is scoped to that user's projects.
  Passwords are stored only as Argon2id hashes and never appear in responses or errors.
- Not yet in place: rate limiting (including on sign-in attempts), refresh tokens, and
  per-project API keys for machine clients.

Full security model, secrets handling, and the AgentCore deployment design:
see [systemDescription.md](docs/systemDescription.md).
