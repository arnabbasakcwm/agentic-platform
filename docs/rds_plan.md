# Aurora / RDS data sources (PostgreSQL + MySQL), alongside BigQuery

> **Status (2026-10-07): saved, not started.** The user is doing the AWS setup first (Part A; see
> `docs/rds_setup.md`). Part B starts once the step 7 check in `docs/rds_setup.md`
> passes against their database.

## Context
Agents can already answer from live BigQuery data through `sql_schema` / `sql_query`. That path has
platform-enforced guardrails (`datasources.py`), keyless sign-in through federation, per-project
opt-in by attaching a source, and a deploy snapshot. The user wants the same for Amazon Aurora and
RDS. Decisions made with the user:
- **Engines:** PostgreSQL and MySQL. That covers Aurora PostgreSQL/MySQL and RDS
  PostgreSQL/MySQL/MariaDB.
- **Sign-in:** **IAM database authentication**. boto3 signs a 15-minute connect token as the IAM
  user locally, and as the AgentCore execution role when deployed. No password is ever stored.
- **Network:** the databases sit in a **private VPC**. Locally they're reached through a tunnel.
  Deployed runtimes switch to AgentCore **VPC network mode**.

This extends the existing "Agents may query BigQuery with SQL they write" exception to principle 1.
The same rule holds: every guardrail is enforced by the platform and the database, never by the
model.

## Part A: what the user does in AWS (summary; full steps in `docs/rds_setup.md`)
1. Turn on **IAM database authentication** on the cluster or instance, and require TLS
   (`rds.force_ssl=1` for PostgreSQL, `require_secure_transport=ON` for MySQL).
2. Create a **read-only database user** whose name starts with `agentic_`:
   - **PostgreSQL:** `CREATE USER agentic_reader; GRANT rds_iam TO agentic_reader;` then
     `GRANT USAGE ON SCHEMA …` and `GRANT SELECT ON <tables>`, and finally
     `ALTER ROLE agentic_reader SET default_transaction_read_only = on`.
   - **MySQL:** `CREATE USER agentic_reader IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS' REQUIRE SSL;`
     then `GRANT SELECT ON db.table TO agentic_reader`.
3. **IAM permissions:**
   - **Platform IAM user:** `rds:DescribeDBClusters`, `rds:DescribeDBInstances`, and
     `rds-db:connect` on `arn:aws:rds-db:<region>:<acct>:dbuser:<DbiResourceId>/agentic_*`.
   - **Execution role:** the platform-created role gets
     `rds-db:connect` on `arn:aws:rds-db:*:<acct>:dbuser:*/agentic_*` (`agentcore._role_policy`).
     An admin-made role needs that statement added by hand.
   - **VPC mode:** the role also needs the ENI permissions AgentCore requires.
4. **Network for deployments:**
   - Choose **private subnets with a NAT gateway**, because agents still call LLM APIs, Tavily and
     Google. As an alternative, add VPC endpoints for bedrock-runtime, logs, s3 and sts.
   - Create a security group for the runtime.
   - Allow inbound 5432/3306 on the database's security group **from that runtime SG**.
5. **Local development:** open an SSM port-forward or SSH tunnel to the endpoint. Map it in
   `backend/.env` with `RDS_LOCAL_TUNNELS=<endpoint>=127.0.0.1:<port>,…`. This mapping is
   server-only and never stored on a source.

## Part B: platform changes (vertical slice: PostgreSQL first, then MySQL)

### 1. Config model: `backend/src/agentic_platform/datasources.py`, `stores.py`
- `DataSourceConfig.kind` becomes `Literal["bigquery", "postgres", "mysql"]`. The default stays
  `"bigquery"`, so stored sources still validate.
- New optional fields, enforced by a `model_validator` according to `kind`:
  - **BigQuery** still requires `billing_project` and `service_account`.
  - **SQL databases** require `region`, `db_identifier` (cluster or instance id), `endpoint`,
    `port`, `database`, `db_user` (must match `^agentic_[a-z0-9_]{1,50}$`), `resource_id`
    (DbiResourceId, used to scope the IAM policy), and
    `vpc: {subnet_ids, security_group_ids} | None`.
- **`AllowedTable.id` per kind:**
  - BigQuery: `project.dataset.table` (unchanged).
  - PostgreSQL: `schema.table`.
  - MySQL: `database.table`.
  - The id pattern moves into the validator, because it depends on `kind`.
  - `location` applies to BigQuery only.
- **`stores.py`:** `DataSource` is unchanged; it inherits the new fields.
  - Generalize `owner_of_service_account` to `owner_of_identity(key)`, implemented in both the
    in-memory and the Mongo store. The key is the service account for BigQuery, and
    `endpoint/database/db_user` for SQL databases.
  - This keeps the "one tenant per identity" mitigation.
  - The store contract tests (`tests/test_stores.py`) cover it.

### 2. SQL check: `check_sql(sql, allowed, default, dialect="bigquery")`
- Parse with the `sqlglot` dialect `postgres` or `mysql`. Keep the existing rules: one statement,
  SELECT or set operations only, no DML or DDL, tables must be on the allow-list, and CTEs are
  allowed.
- **Name qualifying per dialect:**
  - PostgreSQL needs `schema.table`, and any `catalog` given must equal the source's database.
  - MySQL needs `db.table`.
- **Refuse in addition:**
  - `pg_catalog` and `information_schema` (agents use `sql_schema` instead), and
    `SELECT … INTO` / `INTO OUTFILE`.
  - Locking clauses (`FOR UPDATE`/`FOR SHARE`).
  - A deny-list of side-effect and abuse functions: `pg_sleep*`, `pg_read_*`, `pg_ls_dir`, `lo_*`,
    `dblink*`, `set_config`, `nextval`/`setval`, `pg_terminate_backend`/`pg_cancel_backend`,
    `pg_advisory*`, `sleep`, `benchmark`, `load_file`, `get_lock`.
- Refusals still return to the agent as the tool result, so it can fix its own SQL.

### 3. Client: new module `backend/src/agentic_platform/sqldb.py`
Like `datasources.py`, it is imported by deployed runtimes and never touches the platform database.
- **`iam_token(source)`:** `boto3.client("rds").generate_db_auth_token(...)`. Signing happens
  locally, with no network call. Cache the token for 10 minutes.
- **`SqlDbClient(source, connect=None)`:** `connect` is injectable for tests.
  - PostgreSQL uses `psycopg` 3: `sslmode=verify-full`, verified against the RDS global CA bundle
    vendored at `agentic_platform/certs/rds-global-bundle.pem`.
  - MySQL uses `PyMySQL` with `ssl={"ca": …}`, which enables the cleartext plugin that IAM auth
    needs.
  - If `RDS_LOCAL_TUNNELS` maps the endpoint, connect to the tunnel but verify the certificate
    against the real hostname. This works with psycopg through `host` plus `hostaddr`, and with
    PyMySQL through `server_hostname`.
  - Each query uses a short-lived connection. A pool is out of scope.
- **`query(sql, max_rows, timeout_s)`:**
  - **PostgreSQL:** `BEGIN READ ONLY`, then `SET LOCAL statement_timeout`, then a
    **cost dry run** with `EXPLAIN (FORMAT JSON)`. Refuse when `Total Cost > SQLDB_MAX_COST` or
    `Plan Rows` is huge, with a message telling the agent to filter or aggregate.
  - Then execute and `fetchmany(max_rows + 1)`, then `ROLLBACK`.
  - **MySQL:** `START TRANSACTION READ ONLY`, `SET SESSION MAX_EXECUTION_TIME`, and
    `EXPLAIN FORMAT=JSON` for the `query_cost` dry run.
  - Returns the existing `QueryResult`. `bytes_*` are 0, and a new `engine` field is added.
- **`describe_table(id)`:** reads `information_schema.columns`, `pg_class.reltuples` or
  `information_schema.tables.table_rows`, and column comments. This is platform-written SQL, not
  model-written. Output uses the same Markdown shape as the BigQuery `describe_table`.
- **`list_tables()`:** feeds the console's table picker.
- **`describe_db(region, identifier)`:** platform-side RDS API call that returns the endpoint,
  port, engine, DbiResourceId, `IAMDatabaseAuthenticationEnabled`, and the database's subnets and
  security groups. These prefill the VPC fields.
- **`check_connection`:** reports each step, the way the BigQuery check does:
  1. Find the database and confirm IAM auth is on.
  2. Sign the token.
  3. Connect with TLS.
  4. Confirm the session is read-only, using `SHOW transaction_read_only` and the grants.
  5. List tables.

### 4. DataContext dispatch (`datasources.py`)
- `DataContext.query` branches on `source.kind`. The BigQuery path is unchanged. The SQL-database
  path runs `check_sql(dialect)` and then `SqlDbClient.query`.
- `client_for` returns either client. `config_context` builds the right one per source.
- **`schema()`:** heads each source with its name and dialect ("PostgreSQL — write `schema.table`").
- **`sql_query` source argument (`tools.py`):** gains an optional `source` argument (a source
  name). It is needed only when more than one attached source has the same table ids. Without it,
  the tool uses the first source whose allow-list covers the query, as today.
- **Tool wording (`tools.py`):** docstrings and `TOOL_DESCRIPTIONS` become dialect-neutral
  ("BigQuery, PostgreSQL or MySQL; follow the dialect sql_schema names").
- **Usage:** record `kind="sql_query"` with `provider=<engine>` and `model=<db_identifier>`, and no
  price. The database is the user's own, and per the pricing rule nothing is guessed.

### 5. Routes: `backend/src/agentic_platform/app.py`
- **`POST /datasources`:**
  - Accepts `kind`. For a SQL database it takes `region`, `db_identifier`, `database`, `db_user`
    and an optional `vpc`. The server resolves the endpoint and resource id with `describe_db`, so
    the client never supplies them.
  - Runs `check_connection` and returns 422 `DataSourceConnectionFailed` naming the step that
    failed.
  - Returns 409 when the identity is already claimed.
- **`_require_configured`** becomes per kind. A SQL database needs AWS credentials only, not
  `GCP_WIF_AUDIENCE`.
- **`GET /datasources`** reports `configured: {bigquery: bool, rds: bool}` and the RDS limits.
- **`browse` and `PUT …/tables`:** use `list_tables` and `describe_table` for SQL databases.
- **`PATCH /datasources/{id}`:** new, to edit `vpc` only.
- **`_bq_client` cache:** becomes `_source_client`, keyed per identity.

### 6. Deploy: `deploy.py`, `agentcore.py`, `runtime_app.py`
- **Network mode:** when the plan uses data and any attached source is a SQL database,
  `deploy_runtime` gets
  `networkConfiguration={"networkMode": "VPC", "networkModeConfig": {"subnets": […], "securityGroups": […]}}`.
  Check these field names against the current `bedrock-agentcore-control` CreateAgentRuntime
  docs before relying on them.
- **Deploy refusals:** a `DeployError`, before any AWS call, when:
  - a SQL database source has no `vpc`;
  - two sources disagree on the VPC (a runtime has one network).
- **Environment:** pass `AWS_REGION` for the token signer. There is no secret, because the
  execution role signs.
- **Package:** `datasources.json` already carries the non-secret config; it now includes the new
  fields. Add `psycopg[binary]`, `PyMySQL` and the CA bundle to the arm64 package. psycopg has
  `aarch64` manylinux wheels; confirm this with the existing wheel build.
- **`runtime_app.py`:** needs no change beyond `config_context` choosing the client.

### 7. Console: `frontend/src/pages/DataSourcesPage.jsx`, `lib/datasources.js`
- **ConnectForm:** an engine choice (BigQuery / PostgreSQL / MySQL).
  - SQL database fields: name, region, cluster or instance id, database, database user (hint:
    must start with `agentic_`), and an optional "Network for deployments" section (subnets,
    security groups, prefilled from the database).
  - Shows the step list on failure, using the existing `Steps` component.
- **SourcePanel:** the subtitle depends on kind (`aurora-pg-prod · orders_db · agentic_reader`).
- **Hints:** TablePicker and TestQuery show the table-name format for the dialect.
- **Deploy step:** shows "Runs in your VPC" when it applies, and explains a missing-VPC refusal.

### 8. Config and dependencies
- **`config.py`:** add `RDS_LOCAL_TUNNELS`, `SQLDB_MAX_ROWS` (200), `SQLDB_TIMEOUT_S` (30) and
  `SQLDB_MAX_COST`.
- **`pyproject.toml`:** add `psycopg[binary]` and `PyMySQL`, via `uv add`.

### 9. Docs
- Add `docs/rds_setup.md` (Part A).
- Add a CLAUDE.md decision-log entry, "Agents may query Aurora/RDS (PostgreSQL, MySQL) with SQL
  they write". It records:
  - the guardrails;
  - IAM auth;
  - the `agentic_*` user rule;
  - VPC mode and its NAT requirement;
  - the same known deviation: IAM trusts the platform's identity, not the tenant. It's mitigated
    by one tenant per identity and goes away with per-tenant roles.
- Update the layout list (`sqldb.py`) and the README.

## Reused, not rebuilt
- `format_result`, `QueryResult`, `RESULTS_OPEN/CLOSE` fencing, and the structure of `DataContext`
  and `config_context`.
- `check_connection`'s step shape.
- `DataSourceStore` and the attach/detach routes, unchanged.
- `uses_data` / `DATA_TOOLS` opt-in gating, `snapshot` / `load_snapshot`, and
  `UsageCallback` / `usage.add`.
- The console's `Steps`, `TablePicker`, `ProjectChecklist` and `TestQuery` components.

## Verification
1. **Unit tests** (`uv run pytest` from `backend/`). Extend `tests/test_datasources.py`:
   - `check_sql` for postgres/mysql: writes, DDL, `INTO OUTFILE`, `FOR UPDATE`, denied
     functions, catalog tables and unqualified names are all refused, and joins of allowed tables
     pass.
   - Config validation per kind; `agentic_` user names.
   - `DataContext` dispatch with a fake `connect`: a read-only transaction is opened, an
     over-cost EXPLAIN is refused, and rows are capped.
   - The routes, with `describe_db` stubbed in `tests/conftest.py`, so the offline suite never
     calls AWS.
   - Deploy: VPC networkConfiguration, missing or mismatched VPC refused, and the role policy has
     `rds-db:connect`.
2. **Frontend:** `npm run lint`, `npm test`, and `npm run e2e`. The mock API gains a
   postgres-source fixture. Add `e2e/datasources-rds.spec.js` (connect form, failure steps,
   table picker), checked in light and dark with axe.
3. **Live smoke** (`backend/scripts/rds_smoke.py`), against a real Aurora PostgreSQL through a
   tunnel. It uses a throwaway `MONGODB_DB`, per the live-checks memory. It connects, browses,
   runs a test query, confirms an `INSERT` and `pg_sleep` are refused, then runs a 1-agent plan
   that answers from the table.
4. **Deployed check:** deploy that plan in VPC mode and run Try-it. Confirm the answer, and that
   the usage line arrives through CloudWatch.

