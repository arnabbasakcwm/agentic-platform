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
2. **New project** — describe the task in the message box and press Enter. The planner
   designs the team and replies with a summary and a *Review plan* link. Team size, model
   and tools are optional; open them from the pill under the message box.
3. **Brief / Knowledge / Plan / Compile / Run** — each project has one page per step. The
   plan assistant beside Brief, Knowledge, Plan and Compile takes change requests in plain
   language; any change makes a new plan version that has to be compiled again.
   - **Knowledge** (optional) — add PDF, Word, text, Markdown or CSV files for the agents
     to search. Each file is indexed in the background (its status updates live). *Test
     search* shows what an agent would find. *Give agents access* asks the assistant to
     give the `knowledge_search` tool to the agents that need it; their answers then cite
     the file and page or rows. File text and search queries go to the embedding
     provider shown on the page; the files themselves aren't stored.
4. **Deploy** — after Run, the Deploy page puts the compiled plan on Amazon Bedrock
   AgentCore Runtime, lets you try the live deployment, and shows how to call it from an
   app. Needs AWS set up — see [Deploying to AWS](#deploying-to-aws-agentcore).
5. **Projects** — every project you've created, newest first; the sidebar also lists the
   most recent ones. The trash icon on a row deletes a project with its plan, conversation
   and knowledge-base files (it asks first). A project deployed on AgentCore must have its
   deployment removed on the Deploy page before it can be deleted.
6. **Knowledge** (sidebar) — every knowledge-base file across your projects in one table:
   totals, live indexing status, filters by name, project and status, upload to any
   project, and delete. Each file links to its project's Knowledge step, which is where
   test search and *Give agents access* live.

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
| `POST /projects` | Plan a new project from a brief (`agent_count` optional) |
| `GET /projects`, `GET /projects/{id}` | List your projects / fetch one with its plan and conversation |
| `POST /projects/{id}/revise` | Change the brief or plan by asking in plain language |
| `DELETE /projects/{id}` | Delete a project with its knowledge-base files (refused while it's deployed) |
| `PATCH /projects/{id}/plan` | Replace the plan with an edited one (re-validated) |
| `POST /projects/{id}/compile` | Build the runnable graph (no model calls) |
| `POST /projects/{id}/run` | Run the whole team on an input |
| `POST /projects/{id}/run/stream` | Same, streaming each agent's progress as Server-Sent Events |
| `POST /projects/{id}/agents/{agent_id}/invoke` | Run one agent on its own |
| `GET /knowledge` | Every knowledge-base file across your projects, with a summary per project |
| `GET /projects/{id}/knowledge` | Knowledge base: files with indexing status, embedding model, limits |
| `POST /projects/{id}/knowledge/documents` | Upload files (multipart field `files`); indexed in the background |
| `DELETE /projects/{id}/knowledge/documents/{doc_id}` | Remove a file and its passages |
| `PUT /projects/{id}/knowledge/embedding` | Change the embedding model (re-embeds every passage) |
| `POST /projects/{id}/knowledge/search` | Search the knowledge base the way `knowledge_search` does |
| `POST /projects/{id}/deploy` | Deploy the compiled plan to AgentCore (runs in the background) |
| `GET /projects/{id}/deployment` | Deployment status, and whether this server can deploy |
| `POST /projects/{id}/deployment/invoke` | Run the deployed flow on AgentCore (same body as `/run`) |
| `DELETE /projects/{id}/deployment` | Remove the deployment |

---

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
