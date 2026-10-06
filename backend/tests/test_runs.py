"""Saved runs: background runs, the replayable stream, the last-5 limit, privacy,
interrupted runs, the existing run endpoints saving too, and deployed Try-it — offline."""

import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    Deployment,
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    RunRecord,
)


def _plan():
    return AgentPlan(
        agents=[AgentSpec(id="analyst", role="r", system_prompt="p",
                          llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
        orchestration_pattern="sequential",
    )


def _fake_events(graph, task_input, bounds, usage=None):
    """What run_graph_events yields for a one-agent run, with a model call counted."""
    usage.add(kind="run", provider="google_genai", model="gemini-3.1-pro-preview", agent_id="analyst",
              input_tokens=100, output_tokens=20)
    yield "run_started", {"at": 1.0, "timeout_s": bounds.timeout_s}
    yield "node_started", {"node": "analyst", "at": 1.1}
    output = {"content": f"## Answer\nfor {task_input.get('q')}", "data": {}}
    yield "node_completed", {"node": "analyst", "at": 1.5, "output": output, "attempts": 1, "usage": []}
    yield "run_completed", {"at": 1.6, "duration_ms": 600, "outputs": {"analyst": output}, "errors": [],
                            "halted": False, "usage": usage.entries()}


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: _plan())
    for name, store in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()),
                        ("_knowledge", InMemoryKnowledgeStore()), ("_usage", InMemoryUsageStore())]:
        monkeypatch.setattr(app_module, name, store)
    monkeypatch.setattr(app_module, "_compiled_graph", lambda project: object())
    monkeypatch.setattr(app_module, "run_graph_events", _fake_events)
    monkeypatch.setattr(app_module, "FLUSH_EVERY_S", 0)
    client = TestClient(app_module.app)

    def login(email):
        token = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}

    client.login = login
    return client


def _project(api, h):
    pid = api.post("/projects", json={"brief": "bikes"}, headers=h).json()["project_id"]
    app_module._store.mark_compiled(pid, app_module._store.get(pid).plan_version)
    return pid


def _wait(api, h, pid, run_id):
    for _ in range(100):
        run = api.get(f"/projects/{pid}/runs/{run_id}", headers=h).json()["run"]
        if run["status"] != "running":
            return run
        time.sleep(0.05)
    raise AssertionError("run never finished")


def _sse(text):
    events = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and not line.startswith(":"))
        if "event" in lines:
            events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_a_background_run_is_saved_as_it_happens(api):
    h = api.login("ada@example.com")
    pid = _project(api, h)
    r = api.post(f"/projects/{pid}/runs", json={"input": {"q": "busiest station"}}, headers=h)
    assert r.status_code == 202 and r.json()["run"]["status"] == "running"
    run = _wait(api, h, pid, r.json()["run"]["id"])
    assert run["status"] == "completed" and run["input"] == {"q": "busiest station"}
    assert run["outputs"]["analyst"]["content"].startswith("## Answer")
    assert [e["event"] for e in run["events"]] == ["run_started", "node_started", "node_completed", "run_completed"]
    assert "output" not in run["events"][2]  # kept once, in outputs
    assert run["usage"]["input_tokens"] == 100
    # Usage is recorded against this run.
    user_id = api.get("/auth/me", headers=h).json()["id"]
    records = app_module._usage.list(user_id, datetime(2000, 1, 1, tzinfo=timezone.utc))
    assert {r.run_id for r in records if r.kind == "run"} == {run["id"]}


def test_the_stream_replays_and_resumes(api):
    h = api.login("ada@example.com")
    pid = _project(api, h)
    run_id = api.post(f"/projects/{pid}/runs", json={"input": {"q": "x"}}, headers=h).json()["run"]["id"]
    _wait(api, h, pid, run_id)
    events = _sse(api.get(f"/projects/{pid}/runs/{run_id}/stream", headers=h).text)
    assert [e for e, _ in events] == ["run_started", "node_started", "node_completed", "run_completed"]
    assert events[2][1]["output"]["content"].startswith("## Answer")  # put back on replay
    resumed = _sse(api.get(f"/projects/{pid}/runs/{run_id}/stream?after=2", headers=h).text)
    assert [e for e, _ in resumed] == ["node_completed", "run_completed"]


def test_only_the_last_five_runs_are_kept(api):
    h = api.login("ada@example.com")
    pid = _project(api, h)
    ids = []
    for i in range(6):
        ids.append(api.post(f"/projects/{pid}/runs", json={"input": {"q": str(i)}}, headers=h).json()["run"]["id"])
        _wait(api, h, pid, ids[-1])
    listed = api.get(f"/projects/{pid}/runs", headers=h).json()["runs"]
    assert [r["id"] for r in listed] == list(reversed(ids[1:]))
    assert "events" not in listed[0] and listed[0]["agents_done"] == 1
    assert api.get(f"/projects/{pid}/runs/{ids[0]}", headers=h).status_code == 404


def test_runs_are_private(api):
    ada, bob = api.login("ada@example.com"), api.login("bob@example.com")
    pid = _project(api, ada)
    run_id = api.post(f"/projects/{pid}/runs", json={"input": {}}, headers=ada).json()["run"]["id"]
    _wait(api, ada, pid, run_id)
    for r in (api.get(f"/projects/{pid}/runs", headers=bob),
              api.get(f"/projects/{pid}/runs/{run_id}", headers=bob),
              api.get(f"/projects/{pid}/runs/{run_id}/stream", headers=bob),
              api.post(f"/projects/{pid}/runs", json={"input": {}}, headers=bob)):
        assert r.status_code == 404


def test_an_interrupted_run_says_so(api):
    h = api.login("ada@example.com")
    pid = _project(api, h)
    user_id = api.get("/auth/me", headers=h).json()["id"]
    stale = datetime.now(timezone.utc) - timedelta(hours=1)
    app_module._runs.create(RunRecord(id="old", tenant_id=user_id, project_id=pid, timeout_s=300,
                                      events=[{"event": "run_started", "at": 1}], started_at=stale, updated_at=stale))
    run = api.get(f"/projects/{pid}/runs/old", headers=h).json()["run"]
    assert run["status"] == "failed" and run["error"]["error_type"] == "RunInterrupted"
    events = _sse(api.get(f"/projects/{pid}/runs/old/stream", headers=h).text)
    assert events[-1][0] == "run_failed" and events[-1][1]["error_type"] == "RunInterrupted"


def test_the_existing_run_endpoints_save_runs_too(api, monkeypatch):
    h = api.login("ada@example.com")
    pid = _project(api, h)
    events = _sse(api.post(f"/projects/{pid}/run/stream", json={"input": {"q": "x"}}, headers=h).text)
    assert events[-1][0] == "run_completed"  # same stream as before
    monkeypatch.setattr(app_module, "run_graph", lambda graph, task_input, bounds, usage=None: {
        "outputs": {"analyst": {"content": "done", "data": {}}}, "errors": [], "halted": False})
    body = api.post(f"/projects/{pid}/run", json={"input": {"q": "y"}}, headers=h).json()
    assert body["outputs"]["analyst"]["content"] == "done"  # same response as before
    monkeypatch.setattr(app_module, "run_single_agent", lambda *a, **k: {"outputs": {"analyst": {"content": "solo"}}})
    r = api.post(f"/projects/{pid}/agents/analyst/invoke", json={"input": {"q": "z"}}, headers=h)
    assert r.json()["result"]["outputs"]["analyst"]["content"] == "solo"
    assert api.post(f"/projects/{pid}/agents/ghost/invoke", json={"input": {}}, headers=h).status_code == 404
    runs = api.get(f"/projects/{pid}/runs", headers=h).json()["runs"]
    assert [(r["mode"], r["status"]) for r in runs] == [("agent", "completed"), ("graph", "completed"), ("graph", "completed")]


class FakeCloud:
    region = "ap-south-1"

    def __init__(self):
        self.payloads = []

    def invoke(self, runtime_arn, payload, timeout_s):
        self.payloads.append(payload)
        return {"outputs": {"analyst": {"content": "from AWS"}}, "errors": [], "halted": False,
                "usage": [{"kind": "run", "provider": "google_genai", "model": "gemini-3.1-pro-preview",
                           "agent_id": "analyst", "calls": 1, "input_tokens": 50, "output_tokens": 5}]}


def test_try_it_on_a_deployment_runs_in_the_background_and_is_saved(api, monkeypatch):
    h = api.login("ada@example.com")
    pid = _project(api, h)
    assert api.post(f"/projects/{pid}/deployment/runs", json={"input": {}}, headers=h).status_code == 409
    cloud = FakeCloud()
    monkeypatch.setattr(app_module, "_make_cloud", lambda: cloud)
    app_module._store.set_deployment(pid, Deployment(
        status="ready", plan_version=1, region="ap-south-1", runtime_name="agentic_x",
        runtime_arn="arn:aws:bedrock-agentcore:ap-south-1:1:runtime/x", live_plan_version=1))
    r = api.post(f"/projects/{pid}/deployment/runs", json={"input": {"q": "deployed"}}, headers=h)
    assert r.status_code == 202
    run = _wait(api, h, pid, r.json()["run"]["id"])
    assert run["kind"] == "deployed" and run["outputs"]["analyst"]["content"] == "from AWS"
    assert cloud.payloads[0]["run_id"] == run["id"]  # matches the runtime's usage log line
    assert [x["id"] for x in api.get(f"/projects/{pid}/runs?kind=deployed", headers=h).json()["runs"]] == [run["id"]]
    assert api.get(f"/projects/{pid}/runs", headers=h).json()["runs"] == []  # kept separately


def test_deleting_a_project_deletes_its_runs(api):
    h = api.login("ada@example.com")
    pid = _project(api, h)
    run_id = api.post(f"/projects/{pid}/runs", json={"input": {}}, headers=h).json()["run"]["id"]
    _wait(api, h, pid, run_id)
    user_id = api.get("/auth/me", headers=h).json()["id"]
    api.delete(f"/projects/{pid}", headers=h)
    assert app_module._runs.list(user_id, pid, "local") == []
