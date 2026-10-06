"""BigQuery data sources: the SQL guardrails, the REST client, the agent tools, usage,
the API and deployments — offline (a fake HTTP session stands in for Google)."""

import json

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.datasources as ds
import agentic_platform.deploy as deploy
from agentic_platform import usage as usage_mod
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.errors import DataSourceUnavailableError, QueryRefusedError
from agentic_platform.graph_builder import compile_graph
from agentic_platform.stores import (
    InMemoryDataSourceStore,
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
)
from agentic_platform.tools import default_tool_names, get_tools

PROJECT = "agenticdb-510807"
SA = "agentic-bq-reader@agenticdb-510807.iam.gserviceaccount.com"
TRIPS = f"{PROJECT}.mydata.trips"
STATIONS = f"{PROJECT}.mydata.stations"
ALLOWED = {TRIPS, STATIONS}


# ---------------------------------------------------------------------------- the SQL check
@pytest.mark.parametrize("sql", [
    f"SELECT start_station_name, COUNT(*) n FROM `{TRIPS}` GROUP BY 1 ORDER BY 2 DESC LIMIT 5",
    "SELECT * FROM mydata.trips t JOIN mydata.stations s ON t.start_station_id = s.station_id",
    "WITH top AS (SELECT start_station_id FROM mydata.trips) SELECT * FROM top",
    "SELECT a FROM mydata.trips UNION ALL SELECT a FROM mydata.stations",
    "SELECT n FROM mydata.trips, UNNEST([1, 2]) AS n",
])
def test_read_only_queries_over_allowed_tables_pass(sql):
    assert set(ds.check_sql(sql, ALLOWED, PROJECT)) <= ALLOWED


@pytest.mark.parametrize("sql, reason", [
    ("DELETE FROM mydata.trips WHERE TRUE", "only SELECT"),
    ("INSERT INTO mydata.trips SELECT * FROM mydata.trips", "only SELECT"),
    ("UPDATE mydata.trips SET a = 1 WHERE TRUE", "only SELECT"),
    ("MERGE mydata.trips USING mydata.stations ON TRUE WHEN MATCHED THEN DELETE", "only SELECT"),
    ("DROP TABLE mydata.trips", "only SELECT"),
    ("CREATE TABLE mydata.copy AS SELECT * FROM mydata.trips", "only SELECT"),
    ("EXPORT DATA OPTIONS(uri='gs://x/*') AS SELECT * FROM mydata.trips", "only SELECT"),
    ("CALL mydata.proc()", "only SELECT"),
    ("SELECT 1; SELECT 2", "exactly one"),
    ("DECLARE x INT64; SELECT x", "exactly one"),
    ("SELECT * FROM mydata.secrets", "isn't one of the tables"),
    ("SELECT * FROM `other-project.mydata.trips`", "isn't one of the tables"),
    ("SELECT * FROM mydata.INFORMATION_SCHEMA.TABLES", "INFORMATION_SCHEMA"),
    ("SELECT * FROM `mydata.INFORMATION_SCHEMA.COLUMNS`", "INFORMATION_SCHEMA"),
    ("SELECT * FROM trips", "in full"),
    ("SELECT * FROM mydata.events_*", "isn't one of the tables"),
    ("SELECT 1", "reads no allowed table"),
    ("SELEC * FRM", "only SELECT"),
    ("SELECT * FROM (", "doesn.t parse"),
    ("", "empty"),
])
def test_everything_else_is_refused_with_a_reason(sql, reason):
    with pytest.raises(QueryRefusedError, match=reason):
        ds.check_sql(sql, ALLOWED, PROJECT)


# ---------------------------------------------------------------------------- a fake Google
class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


class FakeBigQuery:
    """Just enough of the BigQuery REST API, recording every request."""

    def __init__(self, scanned=23_000_000, rows=3, complete=True):
        self.calls = []
        self.scanned = scanned
        self.rows = rows
        self.complete = complete

    def request(self, method, url, timeout=None, params=None, json=None):
        self.calls.append((method, url.replace(ds.API, ""), params, json))
        path = url.replace(ds.API, "")
        if path.endswith("/datasets"):
            return FakeResponse(200, {"datasets": [{"datasetReference": {"datasetId": "mydata"}}]})
        if path.endswith("/tables"):
            return FakeResponse(200, {"tables": [{"tableReference": {"tableId": t}} for t in ("trips", "stations")]})
        if "/tables/" in path:
            if path.endswith("/secret"):
                return FakeResponse(403, {"error": {"message": "Access Denied: Table secret"}})
            return FakeResponse(200, {
                "location": "US", "numRows": "1070615", "numBytes": "230000000", "description": "Bike trips",
                "schema": {"fields": [
                    {"name": "start_station_name", "type": "STRING", "description": "where it began"},
                    {"name": "duration_minutes", "type": "INTEGER"},
                    {"name": "tags", "type": "RECORD", "mode": "REPEATED", "fields": [{"name": "k", "type": "STRING"}]},
                ]},
            })
        if path.endswith("/queries"):
            if json["dryRun"]:
                return FakeResponse(200, {"totalBytesProcessed": str(self.scanned)})
            if not self.complete:
                return FakeResponse(200, {"jobComplete": False, "jobReference": {"jobId": "j1"}})
            rows = [{"f": [{"v": f"Station {i}"}, {"v": str(100 - i)}]} for i in range(self.rows)]
            return FakeResponse(200, {
                "jobComplete": True, "totalRows": str(self.rows),
                "schema": {"fields": [{"name": "station", "type": "STRING"}, {"name": "trips", "type": "INTEGER"}]},
                "rows": rows, "totalBytesProcessed": str(self.scanned), "totalBytesBilled": "24117248",
            })
        if path.endswith("/cancel"):
            return FakeResponse(200, {})
        return FakeResponse(404, {"error": {"message": "not found"}})


def _config(**overrides):
    fields = dict(id="s1", name="Warehouse", billing_project=PROJECT, service_account=SA,
                  tables=[ds.AllowedTable(id=TRIPS), ds.AllowedTable(id=STATIONS)])
    return ds.DataSourceConfig(**{**fields, **overrides})


def _context(fake, sources=None):
    client = ds.BigQueryClient(PROJECT, SA, http=fake)
    return ds.DataContext(lambda: sources if sources is not None else [_config()], lambda s: client,
                          labels={"agentic_project": "p1"})


# ---------------------------------------------------------------------------- running queries
def test_a_query_is_checked_dry_run_then_run_with_bigquerys_own_byte_cap():
    fake = FakeBigQuery()
    result = _context(fake).query(f"SELECT * FROM `{TRIPS}`", agent_id="Analyst 1")
    dry, real = [c[3] for c in fake.calls if c[1].endswith("/queries")]
    assert dry["dryRun"] is True and real["dryRun"] is False
    assert real["maximumBytesBilled"] == str(ds.BIGQUERY_MAX_BYTES)  # Google enforces the cap too
    assert real["location"] == "US" and real["useLegacySql"] is False
    assert real["labels"] == {"agentic_project": "p1", "agentic_agent": "analyst-1"}
    assert result.columns == ["station", "trips"] and result.rows[0] == ["Station 0", "100"]
    assert (result.bytes_processed, result.bytes_billed) == (23_000_000, 24_117_248)


def test_a_query_over_the_byte_limit_never_runs():
    fake = FakeBigQuery(scanned=5_000_000_000)
    with pytest.raises(QueryRefusedError, match="would scan 5.00 GB"):
        _context(fake).query(f"SELECT * FROM `{TRIPS}`")
    assert [c[3]["dryRun"] for c in fake.calls if c[1].endswith("/queries")] == [True]


def test_refused_sql_never_reaches_google():
    fake = FakeBigQuery()
    with pytest.raises(QueryRefusedError):
        _context(fake).query("DELETE FROM mydata.trips WHERE TRUE")
    assert fake.calls == []


def test_a_slow_query_is_cancelled():
    fake = FakeBigQuery(complete=False)
    with pytest.raises(QueryRefusedError, match="didn't finish"):
        _context(fake).query(f"SELECT * FROM `{TRIPS}`")
    assert fake.calls[-1][1].endswith("/jobs/j1/cancel")


def test_tables_in_two_locations_cant_be_joined():
    source = _config(tables=[ds.AllowedTable(id=TRIPS, location="US"), ds.AllowedTable(id=STATIONS, location="EU")])
    with pytest.raises(QueryRefusedError, match="different locations"):
        _context(FakeBigQuery(), [source]).query("SELECT * FROM mydata.trips, mydata.stations")


def test_results_are_capped_fenced_and_say_what_was_cut():
    fake = FakeBigQuery(rows=ds.BIGQUERY_MAX_ROWS + 1)
    result = _context(fake).query(f"SELECT * FROM `{TRIPS}`")
    assert len(result.rows) == ds.BIGQUERY_MAX_ROWS and result.truncated
    text = ds.format_result(result)
    assert text.startswith(ds.RESULTS_OPEN) and text.endswith(ds.RESULTS_CLOSE)
    assert "| station | trips |" in text and "more matched" in text and "23.0 MB scanned" in text
    short = ds.format_result(result, max_chars=80)
    assert short.count("| Station") == 2 and "more matched" in short


def test_the_schema_lists_columns_and_is_cached():
    fake = FakeBigQuery()
    context = _context(fake)
    text = context.schema()
    assert f"`{TRIPS}` — 1,070,615 rows" in text
    assert "- `start_station_name` STRING — where it began" in text and "- `tags.k` STRING" in text
    context.schema()
    assert len([c for c in fake.calls if "/tables/" in c[1]]) == 2  # two tables, read once each


# ---------------------------------------------------------------------------- the tools
def test_data_tools_need_a_context_and_are_never_default():
    assert not {"sql_schema", "sql_query"} & set(default_tool_names())
    with pytest.raises(DataSourceUnavailableError):
        get_tools(["sql_query"])
    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p", tools=["sql_query"],
                                       llm=LLMConfig(provider="google_genai", model="m"))],
                     orchestration_pattern="sequential")
    with pytest.raises(DataSourceUnavailableError):
        compile_graph(plan)


def test_sql_query_returns_refusals_to_the_agent_and_counts_billed_bytes():
    fake = FakeBigQuery()
    schema_tool, query_tool = get_tools(["sql_schema", "sql_query"], data=_context(fake))
    assert TRIPS in schema_tool.invoke({})
    collector = usage_mod.UsageCollector()
    config = {"configurable": {"usage": collector, "agent_id": "analyst"}}
    refused = query_tool.invoke({"sql": "DROP TABLE mydata.trips"}, config=config)
    assert refused.startswith("Query refused: only SELECT")
    rows = query_tool.invoke({"sql": f"SELECT * FROM `{TRIPS}`"}, config=config)
    assert "Station 0" in rows
    (entry,) = collector.entries()
    assert (entry["kind"], entry["provider"], entry["bytes_billed"], entry["agent_id"]) == (
        "bigquery_query", "bigquery", 24_117_248, "analyst")


def test_billed_bytes_are_costed_per_tib():
    table = {"currency": "USD", "models": {"bigquery/on-demand": {"per_tib": 6.25}}}
    entry = {"provider": "bigquery", "model": "on-demand", "input_tokens": 0, "output_tokens": 0,
             "bytes_billed": 2**40 // 4}
    assert usage_mod.cost(entry, table) == pytest.approx(6.25 / 4)


# ---------------------------------------------------------------------------- credentials
def test_credentials_federate_the_boto_session(monkeypatch):
    monkeypatch.undo()  # the real gcp_credentials (the suite-wide guard replaces it); builds no token

    class Frozen:
        access_key, secret_key, token = "AKIA", "secret", None

    class Session:
        def get_credentials(self):
            return type("C", (), {"get_frozen_credentials": lambda self: Frozen()})()

    creds = ds.gcp_credentials(
        SA, audience="//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws-provider",
        session_factory=Session, region="ap-south-1",
    )
    supplier = creds._aws_security_credentials_supplier
    got = supplier.get_aws_security_credentials(None, None)
    assert (got.access_key_id, got.secret_access_key) == ("AKIA", "secret")
    assert supplier.get_aws_region(None, None) == "ap-south-1"
    assert creds.service_account_email == SA
    monkeypatch.setattr(ds, "GCP_WIF_AUDIENCE", None)
    with pytest.raises(ds.DataSourceError, match="GCP_WIF_AUDIENCE"):
        ds.gcp_credentials(SA)


# ---------------------------------------------------------------------------- API
@pytest.fixture
def api(monkeypatch):
    plan = AgentPlan(agents=[AgentSpec(id="analyst", role="r", system_prompt="p",
                                       llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
                     orchestration_pattern="sequential")
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    for name, store in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()),
                        ("_knowledge", InMemoryKnowledgeStore()), ("_usage", InMemoryUsageStore()),
                        ("_datasources", InMemoryDataSourceStore())]:
        monkeypatch.setattr(app_module, name, store)
    monkeypatch.setattr(app_module, "GCP_WIF_AUDIENCE", "//iam.googleapis.com/projects/1/x")
    monkeypatch.setattr(app_module, "BIGQUERY_PROJECT", PROJECT)
    monkeypatch.setattr(app_module, "GCP_SERVICE_ACCOUNT", SA)
    fake = FakeBigQuery()
    monkeypatch.setattr(app_module, "_bq_client", lambda source: ds.BigQueryClient(PROJECT, SA, http=fake))
    app_module._COMPILED.clear()
    client = TestClient(app_module.app)
    client.fake = fake

    def login(email):
        token = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}

    client.login = login
    return client


def _connected(api, h):
    source = api.post("/datasources", json={"name": "Warehouse"}, headers=h).json()["source"]
    api.put(f"/datasources/{source['id']}/tables", json={"tables": [TRIPS, STATIONS]}, headers=h)
    return source["id"]


def test_connect_browse_allow_tables_and_test_a_query(api):
    h = api.login("ada@example.com")
    body = api.get("/datasources", headers=h).json()
    assert body["configured"] is True and body["defaults"] == {"billing_project": PROJECT, "service_account": SA}
    r = api.post("/datasources", json={"name": "Warehouse"}, headers=h)
    assert r.status_code == 201 and r.json()["check"]["ok"] and r.json()["check"]["datasets"] == ["mydata"]
    source_id = r.json()["source"]["id"]
    browse = api.get(f"/datasources/{source_id}/browse", headers=h).json()
    assert browse["datasets"] == [{"id": "mydata", "tables": ["stations", "trips"]}]
    r = api.put(f"/datasources/{source_id}/tables", json={"tables": [TRIPS, f"{PROJECT}.mydata.secret"]}, headers=h)
    assert r.status_code == 422 and "can't read" in r.json()["message"]
    r = api.put(f"/datasources/{source_id}/tables", json={"tables": [TRIPS, "bigquery-public-data.samples.shakespeare"]}, headers=h)
    assert [t["id"] for t in r.json()["source"]["tables"]] == [TRIPS, "bigquery-public-data.samples.shakespeare"]
    assert r.json()["source"]["tables"][0]["location"] == "US"
    r = api.post(f"/datasources/{source_id}/query", json={"sql": f"SELECT * FROM `{TRIPS}`"}, headers=h)
    assert r.status_code == 200 and r.json()["rows"][0] == ["Station 0", "100"]
    r = api.post(f"/datasources/{source_id}/query", json={"sql": "DELETE FROM mydata.trips WHERE TRUE"}, headers=h)
    assert r.status_code == 422 and r.json()["error_type"] == "QueryRefused"
    records = [r.model_dump() for r in app_module._usage.list(api.get("/auth/me", headers=h).json()["id"],
                                                                __import__("datetime").datetime(2000, 1, 1, tzinfo=__import__("datetime").timezone.utc))]
    assert [(r["kind"], r["bytes_billed"]) for r in records] == [("bigquery_query", 24_117_248)]


def test_sources_are_private_and_service_accounts_belong_to_one_account(api):
    ada, bob = api.login("ada@example.com"), api.login("bob@example.com")
    source_id = _connected(api, ada)
    for r in (
        api.get(f"/datasources/{source_id}/browse", headers=bob),
        api.put(f"/datasources/{source_id}/tables", json={"tables": []}, headers=bob),
        api.put(f"/datasources/{source_id}/projects", json={"project_ids": []}, headers=bob),
        api.post(f"/datasources/{source_id}/query", json={"sql": "SELECT 1"}, headers=bob),
        api.delete(f"/datasources/{source_id}", headers=bob),
    ):
        assert r.status_code == 404 and r.json()["error_type"] == "DataSourceNotFound"
    assert api.get("/datasources", headers=bob).json()["sources"] == []
    r = api.post("/datasources", json={"name": "Mine now"}, headers=bob)
    assert r.status_code == 409


def test_not_configured_and_failed_connections_say_why(api, monkeypatch):
    h = api.login("ada@example.com")
    monkeypatch.setattr(app_module, "GCP_WIF_AUDIENCE", None)
    r = api.post("/datasources", json={"name": "Warehouse"}, headers=h)
    assert r.status_code == 503 and r.json()["error_type"] == "DataSourceNotConfigured"
    monkeypatch.setattr(app_module, "GCP_WIF_AUDIENCE", "//x")

    class Denied(FakeBigQuery):
        def request(self, *a, **k):
            return FakeResponse(403, {"error": {"message": "Permission 'iam.serviceAccounts.getAccessToken' denied"}})

    monkeypatch.setattr(app_module, "_bq_client", lambda s: ds.BigQueryClient(PROJECT, SA, http=Denied()))
    r = api.post("/datasources", json={"name": "Warehouse"}, headers=h)
    assert r.status_code == 422 and r.json()["error_type"] == "DataSourceConnectionFailed"
    assert "workloadIdentityUser" in r.json()["details"]["steps"][0]["step"]
    assert api.post("/datasources", json={"name": "W", "service_account": "not-an-email"}, headers=h).status_code == 422


def test_data_tools_are_offered_only_to_projects_with_a_source(api):
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "bike trips analyst"}, headers=h).json()["project_id"]
    change = {"agents": [{"id": "analyst", "provider": "google_genai", "model": "gemini-3.1-pro-preview",
                          "tools": ["sql_schema", "sql_query"]}]}
    r = api.put(f"/projects/{pid}/agents", json=change, headers=h)
    assert r.status_code == 422 and "data source" in r.json()["message"]
    project = app_module._store.get(pid)
    assert not {"sql_schema", "sql_query"} & set(app_module._offered_tools(project))

    source_id = _connected(api, h)
    assert api.put(f"/datasources/{source_id}/projects", json={"project_ids": ["nope"]}, headers=h).status_code == 404
    api.put(f"/datasources/{source_id}/projects", json={"project_ids": [pid]}, headers=h)
    assert {"sql_schema", "sql_query"} <= set(app_module._offered_tools(app_module._store.get(pid)))
    r = api.put(f"/projects/{pid}/agents", json=change, headers=h)
    assert r.status_code == 200 and r.json()["data_sources"] == {"sources": 1, "tables": 2}
    assert api.post(f"/projects/{pid}/compile", headers=h).status_code == 200

    # Deleting the project detaches the source; the source stays.
    api.delete(f"/projects/{pid}", headers=h)
    (source,) = api.get("/datasources", headers=h).json()["sources"]
    assert source["project_ids"] == []


# ---------------------------------------------------------------------------- deployments
def test_a_deployment_carries_the_sources_config_and_the_audience(monkeypatch, tmp_path):
    import zipfile

    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p", tools=["sql_query"],
                                       llm=LLMConfig(provider="bedrock", model="m"))],
                     orchestration_pattern="sequential")
    monkeypatch.setattr("agentic_platform.config.GCP_WIF_AUDIENCE", "//iam.googleapis.com/projects/1/x")
    assert deploy.runtime_environment(plan) == {"GCP_WIF_AUDIENCE": "//iam.googleapis.com/projects/1/x"}
    monkeypatch.setattr("agentic_platform.config.GCP_WIF_AUDIENCE", None)
    with pytest.raises(deploy.DeployError, match="GCP_WIF_AUDIENCE"):
        deploy.runtime_environment(plan)

    deps = tmp_path / "deps"
    deps.mkdir()
    out = tmp_path / "package.zip"
    snapshot = ds.snapshot([_config()])
    deploy.build_package(plan, out, dependencies=lambda: deps, datasources=snapshot)
    with zipfile.ZipFile(out) as zf:
        (tmp_path / "unpacked").mkdir()
        (tmp_path / "unpacked" / ds.DATASOURCES_FILE).write_bytes(zf.read(ds.DATASOURCES_FILE))
    (loaded,) = ds.load_snapshot(tmp_path / "unpacked")
    assert loaded.table_ids() == ALLOWED and loaded.service_account == SA
    assert "secret" not in snapshot.decode() and "tenant_id" not in snapshot.decode()


def test_the_runtime_builds_a_data_context_from_its_snapshot(monkeypatch, tmp_path):
    from agentic_platform import runtime_app

    (tmp_path / ds.DATASOURCES_FILE).write_bytes(ds.snapshot([_config()]))
    captured = {}

    def fake_compile(plan, knowledge=None, data=None):
        captured["data"] = data
        return object()

    monkeypatch.setattr(runtime_app, "compile_graph", fake_compile)
    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p", tools=["sql_query"],
                                       llm=LLMConfig(provider="bedrock", model="m"))],
                     orchestration_pattern="sequential")
    runtime_app.create_app(plan.model_dump(), knowledge_dir=tmp_path)
    assert captured["data"].load_sources()[0].table_ids() == ALLOWED


# ---------------------------------------------------------------------------- in the project flow
def test_a_new_project_can_start_with_data_sources(api, monkeypatch):
    h = api.login("ada@example.com")
    source_id = _connected(api, h)
    seen = {}
    plan = AgentPlan(agents=[AgentSpec(id="analyst", role="r", system_prompt="p", tools=["sql_schema", "sql_query"],
                                       llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
                     orchestration_pattern="sequential")

    def planner(**kw):
        seen.update(kw)
        return plan

    monkeypatch.setattr(app_module, "plan_project", planner)
    r = api.post("/projects", json={"brief": "bike analyst", "datasource_ids": [source_id]}, headers=h)
    assert r.status_code == 201
    pid = r.json()["project_id"]
    # The planner gets the SQL tools and the table names, never data.
    assert {"sql_schema", "sql_query"} <= set(seen["available_tools"])
    assert seen["data_tables"] == [TRIPS, STATIONS]
    (source,) = api.get("/datasources", headers=h).json()["sources"]
    assert source["project_ids"] == [pid]
    assert api.post(f"/projects/{pid}/compile", headers=h).status_code == 200

    # Without sources, no SQL tools; someone else's source is a 404.
    api.post("/projects", json={"brief": "no data"}, headers=h)
    assert not {"sql_schema", "sql_query"} & set(seen["available_tools"]) and not seen["data_tables"]
    bob = api.login("bob@example.com")
    assert api.post("/projects", json={"brief": "x", "datasource_ids": [source_id]}, headers=bob).status_code == 404


def test_the_projects_data_step_attaches_and_detaches(api, monkeypatch):
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "bike analyst"}, headers=h).json()["project_id"]
    source_id = _connected(api, h)
    body = api.get(f"/projects/{pid}/datasources", headers=h).json()
    assert body["configured"] and body["attached"] == [] and [s["id"] for s in body["available"]] == [source_id]

    r = api.post(f"/projects/{pid}/datasources/{source_id}", headers=h)
    assert r.status_code == 200 and r.json()["source"]["project_ids"] == [pid]
    assert api.post(f"/projects/{pid}/datasources/{source_id}", headers=h).json()["source"]["project_ids"] == [pid]
    body = api.get(f"/projects/{pid}/datasources", headers=h).json()
    assert [s["id"] for s in body["attached"]] == [source_id] and body["available"] == []

    # The assistant is told the attached tables when revising.
    seen = {}

    def revise(**kw):
        seen.update(kw)
        from agentic_platform.agent_schema import PlanRevision

        return PlanRevision(reply="ok", brief=kw["brief"], plan=kw["plan"])

    monkeypatch.setattr(app_module, "revise_plan", revise)
    api.post(f"/projects/{pid}/revise", json={"message": "give the analyst sql_query"}, headers=h)
    assert seen["data_tables"] == [TRIPS, STATIONS] and "sql_query" in seen["available_tools"]

    bob = api.login("bob@example.com")
    assert api.post(f"/projects/{pid}/datasources/{source_id}", headers=bob).status_code == 404
    assert api.delete(f"/projects/{pid}/datasources/{source_id}", headers=h).json()["source"]["project_ids"] == []


def test_the_planner_sees_table_names_only():
    from agentic_platform.meta_planner_prompt import _build_user_message

    message = _build_user_message("analyse bikes", None, ["sql_query"], [], None, None, [TRIPS])
    assert f"DATA TABLES attached to this project (BigQuery, read-only): `{TRIPS}`" in message
    assert "DATA TABLES" not in _build_user_message("x", None, [], [], None, None, None)


def test_the_usage_dashboard_counts_billed_bytes():
    from datetime import date, datetime, timezone

    at = datetime(2026, 10, 6, 11, tzinfo=timezone.utc)
    base = {"project_id": "p1", "at": at, "run_id": "r1", "agent_id": "analyst", "estimated": False, "via": None,
            "calls": 1, "output_tokens": 0}
    records = [
        {**base, "kind": "run", "provider": "google_genai", "model": "gemini", "input_tokens": 100, "cost": 0.01},
        {**base, "kind": "bigquery_query", "provider": "bigquery", "model": "on-demand", "input_tokens": 0,
         "bytes_billed": 23_068_672, "cost": None},
    ]
    body = usage_mod.dashboard(records, start=date(2026, 10, 6), days=1, project_names={"p1": "Bikes"})
    assert body["totals"]["bytes_billed"] == 23_068_672 and body["totals"]["unpriced_bytes"] == 23_068_672
    (bq,) = [m for m in body["by_model"] if m["provider"] == "bigquery"]
    assert bq["bytes_billed"] == 23_068_672 and bq["priced"] is False
    (run,) = body["recent_runs"]
    assert [a["bytes_billed"] for a in run["agents"]] == [0, 23_068_672]
