"""Counting deployed runs invoked straight through AWS: log-line parsing, the CloudWatch
reader, the sync (dedupe, overlap, cursor, failures) and its endpoints — offline."""

import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from botocore.stub import Stubber
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform import usage as usage_mod
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.agentcore import AgentCoreCloud, parse_usage_line
from agentic_platform.stores import (
    Deployment,
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    MongoUsageStore,
    ProjectRecord,
    UsageRecord,
)
from agentic_platform.usage_sync import OVERLAP, sync_deployed_usage

TABLE = {"currency": "USD", "models": {"google_genai/gemini-pro": {"input_per_1m": 2.0, "output_per_1m": 12.0}}}
NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)


def _line(run_id="r1", via="direct", at=None, tokens=(1000, 100), **overrides):
    body = {
        "type": "agentic_usage", "v": 1, "run_id": run_id, "via": via,
        "at": (at or NOW - timedelta(minutes=5)).timestamp(),
        "usage": [{"kind": "run", "agent_id": "a", "provider": "google_genai", "model": "gemini-pro",
                   "calls": 2, "input_tokens": tokens[0], "output_tokens": tokens[1],
                   "long_input_tokens": 0, "long_output_tokens": 0, "estimated": False}],
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------- parsing
def test_parses_a_usage_line_and_ignores_everything_else():
    good = json.dumps(_line())
    assert parse_usage_line(good)["usage"][0]["input_tokens"] == 1000
    assert parse_usage_line("2026-10-05 INFO " + good)["run_id"] == "r1"  # a log prefix is fine
    for bad in [
        "INFO:     127.0.0.1 - \"POST /invocations HTTP/1.1\" 200 OK",
        "agentic_usage {not json",
        json.dumps({**_line(), "v": 2}),
        json.dumps({**_line(), "via": "elsewhere"}),
        json.dumps({**_line(), "run_id": "x" * 65}),
        json.dumps(_line(usage=[{"kind": "run", "provider": "p"}])),  # model missing
        json.dumps(_line(usage=[{**_line()["usage"][0], "input_tokens": -5}])),
        json.dumps(_line(usage=[{**_line()["usage"][0], "input_tokens": "lots"}])),
    ]:
        assert parse_usage_line(bad) is None, bad


# ---------------------------------------------------------------------------- CloudWatch reader
def _cloud():
    session = boto3.Session(aws_access_key_id="test", aws_secret_access_key="test", region_name="ap-south-1")
    return AgentCoreCloud("ap-south-1", session=session)


def test_reader_paginates_filters_and_skips_junk():
    cloud = _cloud()
    group = "/aws/bedrock-agentcore/runtimes/agentic_p-abc-DEFAULT"
    with Stubber(cloud.logs) as stub:
        stub.add_response("filter_log_events", {
            "events": [{"message": json.dumps(_line("r2", at=NOW - timedelta(minutes=1)))},
                       {"message": "agentic_usage but not json"}],
            "nextToken": "page2",
        }, {"logGroupName": group, "startTime": 1, "endTime": 2, "filterPattern": '"agentic_usage"'})
        stub.add_response("filter_log_events", {"events": [{"message": json.dumps(_line("r1"))}]},
                          {"logGroupName": group, "startTime": 1, "endTime": 2,
                           "filterPattern": '"agentic_usage"', "nextToken": "page2"})
        lines = cloud.usage_log_events("agentic_p-abc", 1, 2)
    assert [line["run_id"] for line in lines] == ["r1", "r2"]  # oldest first


def test_reader_treats_a_missing_log_group_as_no_lines():
    cloud = _cloud()
    with Stubber(cloud.logs) as stub:
        stub.add_client_error("filter_log_events", "ResourceNotFoundException")
        assert cloud.usage_log_events("agentic_new-xyz", 1, 2) == []


# ---------------------------------------------------------------------------- sync
class FakeCloud:
    def __init__(self, lines=(), error=None):
        self.lines, self.error, self.windows = list(lines), error, []

    def usage_log_events(self, runtime_id, since_ms, until_ms):
        self.windows.append((runtime_id, since_ms, until_ms))
        if self.error:
            raise self.error
        return [parse_usage_line(json.dumps(line)) for line in self.lines]


def _project(**deployment):
    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p",
                                       llm=LLMConfig(provider="google_genai", model="gemini-pro"))],
                     orchestration_pattern="sequential")
    fields = dict(status="ready", plan_version=1, region="ap-south-1", runtime_name="agentic_p",
                  runtime_id="agentic_p-abc", runtime_arn="arn:x", live_plan_version=1,
                  deployed_at=NOW - timedelta(days=1), reports_usage=True)
    return ProjectRecord(id="p", tenant_id="u1", brief="Travel", plan=plan,
                         deployment=Deployment(**{**fields, **deployment}))


@pytest.fixture
def stores(monkeypatch):
    monkeypatch.setattr(usage_mod, "_PRICES", TABLE)
    projects, usage = InMemoryProjectStore(), InMemoryUsageStore()
    return projects, usage


def test_sync_records_direct_runs_once_and_skips_platform_runs(stores):
    projects, usage = stores
    project = _project()
    projects.create(project)
    # The platform already recorded the run it made itself, under the same id.
    usage.add_many([UsageRecord(id="x", tenant_id="u1", project_id="p", kind="deployed_run", run_id="from-platform",
                                provider="google_genai", model="gemini-pro", calls=1, input_tokens=1, via="platform")])
    cloud = FakeCloud([_line("direct-1"), _line("from-platform", via="platform"), _line("direct-2", tokens=(500, 50))])

    result = sync_deployed_usage(project, cloud, usage, projects, now=NOW)
    assert (result.status, result.added) == ("synced", 2)
    records = [r for r in usage.list("u1", NOW - timedelta(days=2)) if r.via == "direct"]
    assert sorted(r.run_id for r in records) == ["direct-1", "direct-2"]
    one = next(r for r in records if r.run_id == "direct-1")
    assert (one.kind, one.input_tokens, one.calls) == ("deployed_run", 1000, 2)
    assert one.cost == pytest.approx((1000 * 2 + 100 * 12) / 1_000_000)
    assert one.at == NOW - timedelta(minutes=5)  # when the run happened, not when it was synced

    # The cursor moved, and a re-read of an overlapping window adds nothing.
    assert projects.get("p").deployment.usage_synced_until == NOW
    again = sync_deployed_usage(projects.get("p"), cloud, usage, projects, now=NOW + timedelta(minutes=3))
    assert (again.status, again.added) == ("synced", 0)
    assert len(usage.list("u1", NOW - timedelta(days=2))) == 3


def test_sync_reads_from_the_cursor_minus_an_overlap(stores):
    projects, usage = stores
    cursor = NOW - timedelta(hours=1)
    project = _project(usage_synced_until=cursor)
    projects.create(project)
    cloud = FakeCloud()
    sync_deployed_usage(project, cloud, usage, projects, now=NOW)
    (_, since_ms, until_ms), = cloud.windows
    assert since_ms == int((cursor - OVERLAP).timestamp() * 1000)
    assert until_ms == int(NOW.timestamp() * 1000)


def test_sync_skips_runtimes_that_dont_report_usage_and_reports_failures(stores):
    projects, usage = stores
    old = _project(reports_usage=False)
    assert sync_deployed_usage(old, FakeCloud([_line()]), usage, projects, now=NOW).detail.startswith("redeploy")

    project = _project()
    projects.create(project)
    failed = sync_deployed_usage(project, FakeCloud(error=RuntimeError("AccessDenied: logs")), usage, projects, now=NOW)
    assert failed.status == "failed" and "AccessDenied" in failed.detail
    assert projects.get("p").deployment.usage_synced_until is None  # the cursor doesn't move on failure


# ---------------------------------------------------------------------------- store contract
@pytest.fixture(params=["memory", "mongo"])
def usage_store(request):
    if request.param == "memory":
        yield InMemoryUsageStore()
        return
    from pymongo.errors import PyMongoError

    from agentic_platform.stores import mongo_database

    db = mongo_database(os.environ.get("MONGODB_URI") or "mongodb://localhost:27017",
                        f"agentic_platform_test_{uuid.uuid4().hex[:8]}", timeout_ms=500)
    try:
        db.client.admin.command("ping")
    except PyMongoError:
        db.client.close()
        pytest.skip("no MongoDB server reachable")
    try:
        yield MongoUsageStore(db)
    finally:
        db.client.drop_database(db.name)
        db.client.close()


def test_existing_run_ids_is_scoped_by_tenant(usage_store):
    rec = lambda tenant, run: UsageRecord(id=uuid.uuid4().hex, tenant_id=tenant, kind="run", run_id=run,  # noqa: E731
                                          provider="p", model="m", via=None)
    usage_store.add_many([rec("u1", "a"), rec("u1", "b"), rec("u2", "c")])
    assert usage_store.existing_run_ids("u1", ["a", "c", "zz"]) == {"a"}
    assert usage_store.existing_run_ids("u1", []) == set()


# ---------------------------------------------------------------------------- endpoints
@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    monkeypatch.setattr(app_module, "_knowledge", InMemoryKnowledgeStore())
    monkeypatch.setattr(app_module, "_usage", InMemoryUsageStore())
    monkeypatch.setattr(usage_mod, "_PRICES", TABLE)
    app_module._LAST_SYNC.clear()
    app_module._SYNC_STATUS.clear()
    client = TestClient(app_module.app)

    def login(email):
        session = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()
        return {"Authorization": f"Bearer {session['access_token']}"}, session["user"]["id"]

    client.login = login
    return client


def _deployed_project_for(tenant_id):
    project = _project()
    project = project.model_copy(update={"id": uuid.uuid4().hex, "tenant_id": tenant_id})
    app_module._store.create(project)
    return project


def test_sync_now_counts_direct_runs_and_the_dashboard_shows_them(api, monkeypatch):
    headers, user_id = api.login("ada@example.com")
    project = _deployed_project_for(user_id)
    recent = datetime.now(timezone.utc) - timedelta(minutes=2)
    monkeypatch.setattr(app_module, "_make_cloud", lambda: FakeCloud([_line("direct-1", at=recent)]))

    r = api.post("/usage/sync", headers=headers).json()
    assert r["results"][0] == {"project_id": project.id, "status": "synced", "added": 1, "detail": None}
    d = api.get("/usage", headers=headers).json()
    assert d["recent_runs"][0]["via"] == "direct" and d["recent_runs"][0]["deployed"] is True
    assert {k["kind"] for k in d["by_kind"]} == {"deployed_run_direct"}
    status = d["deployments"][0]
    assert status["reports_usage"] is True and status["synced_until"] is not None
    assert status["last_sync"]["status"] == "synced"


def test_opening_the_dashboard_syncs_in_the_background_at_most_every_two_minutes(api, monkeypatch):
    headers, user_id = api.login("ada@example.com")
    _deployed_project_for(user_id)
    cloud = FakeCloud()
    monkeypatch.setattr(app_module, "_make_cloud", lambda: cloud)
    api.get("/usage", headers=headers)
    api.get("/usage", headers=headers)
    assert len(cloud.windows) == 1  # throttled
    api.post("/usage/sync", headers=headers)
    assert len(cloud.windows) == 2  # "Sync now" always runs


def test_sync_only_reads_your_own_deployments(api, monkeypatch):
    headers, user_id = api.login("ada@example.com")
    _deployed_project_for(user_id)
    other_headers, other_id = api.login("eve@example.com")
    cloud = FakeCloud()
    monkeypatch.setattr(app_module, "_make_cloud", lambda: cloud)
    assert api.post("/usage/sync", headers=other_headers).json() == {"results": [], "deployments": []}
    assert cloud.windows == []
    assert api.post("/usage/sync").status_code == 401
