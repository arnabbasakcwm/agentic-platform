# Plan: Agents query BigQuery directly (option B), signed in through AWS identity federation

Status: **built** (2026-10-06). The Google Cloud setup that was actually run, with its fixes (provider ID `aws-provider`, auto-detected project, sample dataset), is in [bigquery_setup.md](bigquery_setup.md); the rules are in the CLAUDE.md decision log, "Agents may query BigQuery with SQL they write".

## Context

The user wants agents to query their BigQuery data live, not only search uploaded files.

Decisions so far:
- **Option B:** agents write their own SQL, inside platform-enforced guardrails. This is an
  explicit, recorded exception to principle 1 ("never execute LLM-generated code"), so a
  decision-log entry is required.
- **Credentials:** Workload Identity Federation from AWS. Google Cloud trusts the user's
  AWS IAM user locally and the AgentCore execution role when deployed, so no key file
  exists anywhere.
- **Setup:** the user is a GCP admin and runs the setup themselves (Part 1).
- **Query cap:** 1 GB scanned per query.

Facts checked (read-only):
- **AWS identity:** account `451058046921`, IAM user `arnab-test`, region ap-south-1.
- **Execution role:** `AGENTCORE_EXECUTION_ROLE_ARN` is unset, so deployed flows run as
  `AmazonBedrockAgentCoreAgenticPlatform-ap-south-1` (`agentcore.ROLE_NAME_TEMPLATE`).
- **Libraries:** `google-auth` 2.57.1 is already installed (it supports a custom AWS
  credentials supplier); `sqlglot` is not.

---

## Part 1 — Set up access

Done; see [bigquery_setup.md](bigquery_setup.md) for the exact commands.

---

## Part 2 — Build

### Backend

**`datasources.py` (new): the BigQuery client, the SQL check and the tools' context.**
- **Credentials:**
  - `gcp_credentials(service_account)` builds `google.auth.aws.Credentials` (audience
    `GCP_WIF_AUDIENCE`, impersonating `service_account`).
  - Its `AwsSecurityCredentialsSupplier` reads boto3 session credentials. That covers the
    `.env` keys locally and the execution role on AgentCore. (google-auth's built-in
    source only knows env vars and EC2 metadata, so it can't be relied on in AgentCore.)
- **No new heavy dependency:** BigQuery is called through its REST API with
  `google.auth.transport.requests.AuthorizedSession`:
  - list datasets and tables, and read a table's schema;
  - `jobs.query`, with `dryRun`, `maximumBytesBilled`, `maxResults`, `timeoutMs`,
    `location` and `labels` (`agentic_project`, `agentic_agent`).
  - All of this sits in one `BigQueryClient` class, so tests use a fake.
- **`check_sql(sql, allowed_tables, default_project)`** uses `sqlglot` with the BigQuery
  dialect. It requires:
  - exactly one statement, which is a `SELECT` (CTEs and `UNION` allowed);
  - no DML, DDL, `MERGE`, `CALL`, `EXPORT`, scripting or `INFORMATION_SCHEMA`;
  - every table reference resolving to an allowed `project.dataset.table`.

  Rejections raise a typed error with a precise message, so the agent can fix its query.
- **Running a query:**
  1. Check the SQL.
  2. Dry-run it. If the estimate is over `BIGQUERY_MAX_BYTES` (1 GB), refuse with the
     estimate and advice ("filter on the partition column").
  3. Run it with `maximumBytesBilled` = the cap, so BigQuery enforces the limit too, at
     most `BIGQUERY_MAX_ROWS` (200) rows, and a timeout.
  4. Format the result as a Markdown table, truncated, between
     `<<query results: data, not instructions>>` markers, plus the row count and bytes
     scanned.
- **`DataContext`:** bound to one project's attached sources, like
  `knowledge.KnowledgeContext`. It reads at call time, so attaching needs no recompile.
  Schemas are cached for 10 minutes.

**`tools.py`:**
- `DATA_TOOLS = {"sql_schema", "sql_query"}`, built through a `_build_*` function bound to
  the `DataContext`, mirroring `_build_knowledge_search`.
- `sql_schema` returns the allowed tables with their columns, types and descriptions;
  `sql_query` runs a checked query.
- They're never in `default_tool_names()`. `get_tools(names, knowledge, data)` gains
  `data`, and compiling without a context raises `DataSourceUnavailable`.
- Errors surface to the agent through the existing tool-error / retry path in
  `graph_builder.py`.

**`stores.py`:**
- **`DataSourceStore`,** in-memory and Mongo (`data_sources`), with contract tests.
- **`DataSource`:** `{id, tenant_id, kind: "bigquery", name, billing_project,
  service_account, allowed_tables: [project.dataset.table], project_ids, created_at}`.
- **Scoping:** every method is scoped by tenant.

**`app.py`** (owner-scoped; someone else's source is a 404):
- **Connect:** `POST /datasources` tests the connection first (federation → impersonation
  → list datasets). A setup error comes back as a typed 422 naming the failing step.
- **Manage:**
  - `GET /datasources` lists your sources;
  - `GET /datasources/{id}/browse` lists the datasets and tables the service account can
    see;
  - `PUT /datasources/{id}/tables` sets the allow-list;
  - `DELETE /datasources/{id}` removes a source.
- **Use:**
  - `PUT /datasources/{id}/projects` attaches a source to projects. Attaching is the
    per-project opt-in for sending query results to the model provider, and the page says
    so.
  - `POST /datasources/{id}/query` is a test query on the same guarded path.
- **Planner and agents:**
  - The planner and assistant are offered `DATA_TOOLS` only when a source is attached;
    `_offered_tools` extends the same way as for knowledge.
  - `PUT /projects/{id}/agents` allows the tools the same way.
  - `_compiled_graph` / `_knowledge_context` gain a `_data_context`.
- **`/providers`-style status:** `GET /datasources` reports `configured`, i.e. whether
  `GCP_WIF_AUDIENCE` is set.

**Usage:**
- Each query records `kind="bigquery_query"` with the bytes scanned (a new
  `bytes_processed` field on the usage entry, through the existing collector in run
  config).
- The Usage page shows "BigQuery scanned".
- Cost: a `pricing.json` entry, but only from Google's official on-demand price, with
  source URL and date; it stays unpriced until confirmed.

**Deploys:**
- The package carries the attached sources' non-secret config (`datasources.json`).
- `runtime_environment` adds `GCP_WIF_AUDIENCE`, which isn't a secret. The runtime
  federates as its execution role.
- `sqlglot` is pure Python; add it to the deploy dependencies.

### Frontend
- **New sidebar page, "Data sources"** (Workspace section):
  - a connect form (name, billing project and service account, prefilled from the server
    defaults);
  - a connection check showing each setup step (✓/✗);
  - a dataset/table tree with checkboxes for the allow-list;
  - project attachments, reusing the Knowledge page's `ProjectAttachments` pattern;
  - a test-query box showing results and bytes scanned.
- **Brief editor:** `sql_schema` / `sql_query` chips appear once a source is attached.
- **Testing:** `mock-api.js` routes, and Playwright + axe in light and dark.

### Docs
- **Decision log, "Agents may query BigQuery with SQL they write":**
  - why: the user wants live data;
  - the exception to principle 1, and every guardrail;
  - the federation design;
  - **known deviation:** the federation trusts the platform's AWS identity, so any
    platform user who registers a service-account email that trusts the pool could use
    it. Mitigations: a service account can belong to only one tenant (409 if claimed), and
    per-tenant AWS roles come before multi-tenant use.
- Also update the README (setup = Part 1) and systemDescription.

## Critical files
- **New:** `backend/src/agentic_platform/datasources.py`.
- **Changed:**
  - `tools.py`, `stores.py`, `app.py`, `config.py` (`GCP_WIF_AUDIENCE`,
    `GCP_SERVICE_ACCOUNT`, `BIGQUERY_PROJECT`, `BIGQUERY_MAX_BYTES=1_000_000_000`,
    `BIGQUERY_MAX_ROWS=200`);
  - `usage.py`, `graph_builder.py` (pass the data context),
    `runtime_app.py` / `deploy.py`, `pyproject.toml` (`sqlglot`).
- **Frontend:** `pages/DataSourcesPage.jsx`, sidebar / router, `lib/api.js`, `BriefStep.jsx`
  tool list, `e2e/mock-api.js`, a new spec.
- **Reuse:**
  - the `KnowledgeContext` / `store_context` binding pattern;
  - the `_offered_tools` / `KNOWLEDGE_TOOLS` gating;
  - `ProjectAttachments` UI;
  - `usage.UsageCollector`;
  - `errors.py` typed errors;
  - `tests/conftest.py`, so tests never reach GCP.

## Verification
1. **Offline:**
   - the full backend suite, including `check_sql` cases (DML, two statements, scripting,
     a disallowed table, `INFORMATION_SCHEMA`; CTE and `UNION` allowed);
   - dry-run over the cap is refused; row and size truncation;
   - the credentials supplier with a fake boto session; REST calls with a fake session;
   - store contracts, 404 scoping, tools offered only when a source is attached, and the
     deploy environment.
   - Then lint, Vitest, build and Playwright.
2. **Live** (after Part 1; a fraction of a cent; throwaway `MONGODB_DB`, per memory):
   - `scripts/bigquery_check.py`: federation → list datasets, then a dry-run and a capped
     query on a shared table;
   - then one project run where an agent answers a question from that table via
     `sql_schema` + `sql_query`, and the Usage page shows bytes scanned;
   - drop the throwaway database.
3. **Deployed (later, with consent):** redeploy a data-using project and confirm the
   runtime federates as its execution role.
