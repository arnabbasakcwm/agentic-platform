"""Deploying to Amazon Bedrock AgentCore Runtime — offline.

AWS is never called: the runtime app is exercised directly, the AWS wrapper is checked
against botocore's Stubber (exact request shapes), and the orchestration and API run
against a fake cloud.
"""

import io
import json
import stat
import zipfile
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from botocore.response import StreamingBody
from botocore.stub import ANY, Stubber
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.deploy as deploy
import agentic_platform.runtime_app as runtime_app
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.agentcore import AgentCoreCloud
from agentic_platform.errors import (
    DeployedRunError,
    DeployError,
    MissingProviderKeyError,
    MissingToolKeyError,
    UnknownToolError,
)
from agentic_platform.stores import Deployment, InMemoryProjectStore, InMemoryKnowledgeStore, InMemoryUsageStore, InMemoryUserStore, ProjectRecord

GEMINI = LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview")


def _plan(tools=(), llm=GEMINI):
    return AgentPlan(
        agents=[
            AgentSpec(id="a", role="worker", system_prompt="do it", llm=llm, tools=list(tools)),
            AgentSpec(id="b", role="writer", system_prompt="write it", llm=llm, depends_on=["a"]),
        ],
        orchestration_pattern="sequential",
    )


@pytest.fixture
def keys(monkeypatch):
    for name in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "TAVILY_API_KEY", "PUBMED_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")


# ------------------------------------------------------------------ runtime app (inside AgentCore)
def test_runtime_ping_and_invocations_match_the_local_run_contract(monkeypatch):
    seen = {}

    def fake_run(graph, task_input, bounds, usage=None):
        seen["input"] = task_input
        return {"outputs": {"b": {"content": "done", "data": {}}}, "errors": [], "halted": False}

    monkeypatch.setattr(runtime_app, "run_graph", fake_run)
    client = TestClient(runtime_app.create_app(_plan().model_dump()))

    ping = client.get("/ping")
    assert ping.status_code == 200
    assert ping.json()["status"] == "Healthy"

    r = client.post("/invocations", json={"input": {"q": "x"}})
    assert r.status_code == 200
    body = r.json()
    assert len(body.pop("run_id")) == 32  # made by the runtime: a direct caller sent none
    assert body == {"outputs": {"b": {"content": "done", "data": {}}}, "errors": [], "halted": False, "usage": []}
    assert seen["input"] == {"q": "x"}


def test_runtime_single_agent_and_unknown_agent(monkeypatch):
    monkeypatch.setattr(
        runtime_app, "run_single_agent",
        lambda plan, agent_id, task_input, upstream, knowledge=None, usage=None: {"outputs": {agent_id: {"content": "ok"}}},
    )
    client = TestClient(runtime_app.create_app(_plan().model_dump()))
    r = client.post("/invocations", json={"input": {}, "agent_id": "a"})
    assert r.json()["outputs"] == {"a": {"content": "ok"}}

    monkeypatch.setattr(
        runtime_app, "run_single_agent",
        lambda *a, **k: (_ for _ in ()).throw(KeyError("ghost")),
    )
    r = client.post("/invocations", json={"input": {}, "agent_id": "ghost"})
    assert r.status_code == 404
    assert r.json()["error_type"] == "AgentNotFound"


def test_runtime_rejects_a_malformed_request():
    client = TestClient(runtime_app.create_app(_plan().model_dump()))
    r = client.post("/invocations", json={"prompt": "hello"})
    assert r.status_code == 422
    assert r.json()["error_type"] == "ValidationError"


# ------------------------------------------------------------------ runtime usage log line
def _usage_lines(capsys):
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if '"agentic_usage"' in line]
    return lines


def _fake_reporting_run(text="SECRET OUTPUT"):
    def fake_run(graph, task_input, bounds, usage=None):
        usage.add(kind="run", provider="google_genai", model="gemini-3.1-pro-preview", agent_id="a",
                  input_tokens=1200, output_tokens=300)
        return {"outputs": {"a": {"content": text, "data": {}}}, "errors": [], "halted": False}

    return fake_run


def test_every_invocation_logs_one_usage_line_without_content(monkeypatch, capsys):
    monkeypatch.setattr(runtime_app, "run_graph", _fake_reporting_run())
    client = TestClient(runtime_app.create_app(_plan().model_dump()))
    capsys.readouterr()

    direct = client.post("/invocations", json={"input": {"q": "SECRET INPUT"}}).json()
    platform = client.post("/invocations", json={"input": {"q": "x"}, "run_id": "platform-run-1"}).json()
    out = capsys.readouterr().out
    lines = [json.loads(line) for line in out.splitlines() if '"agentic_usage"' in line]

    assert len(lines) == 2
    first, second = lines
    assert first["type"] == "agentic_usage" and first["v"] == 1
    assert (first["via"], first["run_id"]) == ("direct", direct["run_id"])
    assert (second["via"], second["run_id"]) == ("platform", "platform-run-1")
    assert platform["run_id"] == "platform-run-1"
    entry = first["usage"][0]
    assert (entry["agent_id"], entry["model"], entry["input_tokens"], entry["output_tokens"]) == (
        "a", "gemini-3.1-pro-preview", 1200, 300)
    assert direct["usage"] == first["usage"]  # the same numbers the caller gets back
    assert "SECRET" not in out  # never the task input or the agents' output


def test_a_timed_out_run_still_logs_what_it_used(monkeypatch, capsys):
    def too_slow(graph, task_input, bounds, usage=None):
        usage.add(kind="run", provider="google_genai", model="m", agent_id="a", input_tokens=50, output_tokens=5)
        raise TimeoutError("the run exceeded its 300s time limit")

    monkeypatch.setattr(runtime_app, "run_graph", too_slow)
    client = TestClient(runtime_app.create_app(_plan().model_dump()))
    capsys.readouterr()
    r = client.post("/invocations", json={"input": {}})
    assert r.status_code == 504
    (line,) = _usage_lines(capsys)
    assert line["usage"][0]["input_tokens"] == 50


def test_single_agent_and_failed_invocations_log_a_line_too(monkeypatch, capsys):
    def one_agent(plan, agent_id, task_input, upstream, knowledge=None, usage=None):
        usage.add(kind="run", provider="google_genai", model="m", agent_id=agent_id, input_tokens=10, output_tokens=1)
        return {"outputs": {agent_id: {"content": "ok"}}}

    monkeypatch.setattr(runtime_app, "run_single_agent", one_agent)
    client = TestClient(runtime_app.create_app(_plan().model_dump()), raise_server_exceptions=False)
    capsys.readouterr()
    r = client.post("/invocations", json={"input": {}, "agent_id": "a"})
    assert r.json()["usage"][0]["agent_id"] == "a"

    monkeypatch.setattr(runtime_app, "run_graph", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    assert client.post("/invocations", json={"input": {}}).status_code == 500
    lines = _usage_lines(capsys)
    assert len(lines) == 2 and lines[1]["usage"] == []


def test_a_malformed_run_id_is_rejected():
    client = TestClient(runtime_app.create_app(_plan().model_dump()))
    assert client.post("/invocations", json={"input": {}, "run_id": "bad id with spaces"}).status_code == 422


def test_runtime_refuses_to_start_with_an_invalid_plan():
    # Compiling at startup means a bad package fails its health check, not a user's call.
    bad = _plan(tools=["ghost_tool"]).model_dump()
    with pytest.raises(UnknownToolError):
        runtime_app.create_app(bad)


# ------------------------------------------------------------------ runtime environment
def test_environment_holds_only_the_keys_the_plan_uses(keys):
    env = deploy.runtime_environment(_plan())
    assert env == {"GEMINI_API_KEY": "gemini-secret"}  # no OpenAI key: no agent uses it


def test_environment_includes_tool_keys_required_and_optional(keys, monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "tavily-secret")
    monkeypatch.setenv("PUBMED_API_KEY", "pubmed-secret")
    env = deploy.runtime_environment(_plan(tools=["web_search", "pubmed"]))
    assert env["TAVILY_API_KEY"] == "tavily-secret"
    assert env["PUBMED_API_KEY"] == "pubmed-secret"


def test_environment_missing_keys_fail_before_anything_is_deployed(keys, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY")
    with pytest.raises(MissingProviderKeyError):
        deploy.runtime_environment(_plan())
    monkeypatch.setenv("GEMINI_API_KEY", "x")
    with pytest.raises(MissingToolKeyError):
        deploy.runtime_environment(_plan(tools=["web_search"]))
    # pubmed's key is optional
    assert "PUBMED_API_KEY" not in deploy.runtime_environment(_plan(tools=["pubmed"]))


def test_local_only_models_cannot_be_deployed(keys):
    with pytest.raises(DeployError, match="ollama"):
        deploy.runtime_environment(_plan(llm=LLMConfig(provider="ollama", model="llama3.1")))


# ------------------------------------------------------------------ package
def test_package_has_entrypoint_plan_and_code_with_linux_permissions(tmp_path, monkeypatch):
    deps = tmp_path / "deps"
    (deps / "somelib").mkdir(parents=True)
    (deps / "somelib" / "__init__.py").write_text("VALUE = 1\n")
    (deps / "somelib" / "__pycache__").mkdir()
    (deps / "somelib" / "__pycache__" / "x.pyc").write_bytes(b"junk")

    out = tmp_path / "package.zip"
    sizes = deploy.build_package(_plan(), out, dependencies=lambda: deps)

    with zipfile.ZipFile(out) as zf:
        names = set(zf.namelist())
        assert {"main.py", "plan.json", "somelib/__init__.py"} <= names
        assert "agentic_platform/runtime_app.py" in names
        assert "agentic_platform/graph_builder.py" in names
        # Platform-only code (accounts, database, AWS) never ships in a runtime.
        assert not {"agentic_platform/app.py", "agentic_platform/auth.py",
                    "agentic_platform/stores.py", "agentic_platform/deploy.py"} & names
        assert not any("__pycache__" in n or n.endswith(".pyc") for n in names)
        assert AgentPlan.model_validate(json.loads(zf.read("plan.json"))) == _plan()
        assert b"create_app" in zf.read("main.py")
        for info in zf.infolist():
            assert info.create_system == 3  # Unix entries, whatever OS built the zip
            assert stat.S_IMODE(info.external_attr >> 16) == 0o644
    assert sizes["zipped"] == out.stat().st_size


def test_package_over_agentcore_limits_is_rejected(tmp_path, monkeypatch):
    deps = tmp_path / "deps"
    deps.mkdir()
    (deps / "big.bin").write_bytes(b"x" * 4096)
    monkeypatch.setattr(deploy, "MAX_UNZIPPED_BYTES", 1024)
    with pytest.raises(DeployError, match="750 MB"):
        deploy.build_package(_plan(), tmp_path / "p.zip", dependencies=lambda: deps)


# ------------------------------------------------------------------ AWS wrapper (stubbed)
def _cloud(**kwargs):
    session = boto3.Session(
        aws_access_key_id="test", aws_secret_access_key="test", region_name="ap-south-1"
    )
    cloud = AgentCoreCloud("ap-south-1", session=session, **kwargs)
    cloud._account = "123456789012"
    return cloud


def test_create_runtime_request_shape():
    cloud = _cloud()
    with Stubber(cloud.control) as stub:
        stub.add_response(
            "create_agent_runtime",
            {
                "agentRuntimeArn": "arn:aws:bedrock-agentcore:ap-south-1:123456789012:runtime/agentic_p1-abcdefghij",
                "agentRuntimeId": "agentic_p1-abcdefghij",
                "agentRuntimeVersion": "1",
                "createdAt": datetime(2026, 10, 1),
                "status": "CREATING",
            },
            {
                "agentRuntimeName": "agentic_p1",
                "agentRuntimeArtifact": {
                    "codeConfiguration": {
                        "code": {
                            "s3": {
                                "bucket": "bedrock-agentcore-agentic-platform-123456789012-ap-south-1",
                                "prefix": "agentic_p1/v1.zip",
                            }
                        },
                        "runtime": "PYTHON_3_11",
                        "entryPoint": ["main.py"],
                    }
                },
                "roleArn": "arn:aws:iam::123456789012:role/r",
                "networkConfiguration": {"networkMode": "PUBLIC"},
                "environmentVariables": {"GEMINI_API_KEY": "k"},
                "description": "d",
            },
        )
        runtime_id, arn = cloud.deploy_runtime(
            "agentic_p1", "agentic_p1/v1.zip", {"GEMINI_API_KEY": "k"},
            "arn:aws:iam::123456789012:role/r", description="d",
        )
    assert runtime_id == "agentic_p1-abcdefghij"
    assert arn.endswith("runtime/agentic_p1-abcdefghij")


def test_existing_runtime_is_updated_not_recreated():
    cloud = _cloud()
    with Stubber(cloud.control) as stub:
        stub.add_response(
            "update_agent_runtime",
            {
                "agentRuntimeArn": "arn:aws:bedrock-agentcore:ap-south-1:123456789012:runtime/agentic_p1-abcdefghij",
                "agentRuntimeId": "agentic_p1-abcdefghij",
                "agentRuntimeVersion": "2",
                "createdAt": datetime(2026, 10, 1),
                "lastUpdatedAt": datetime(2026, 10, 1),
                "status": "UPDATING",
            },
            {
                "agentRuntimeId": "agentic_p1-abcdefghij",
                "agentRuntimeArtifact": ANY,
                "roleArn": ANY,
                "networkConfiguration": ANY,
                "environmentVariables": ANY,
            },
        )
        cloud.deploy_runtime("agentic_p1", "k.zip", {}, "arn:aws:iam::123456789012:role/r",
                             existing_runtime_id="agentic_p1-abcdefghij")


def _runtime_status(status, reason=None):
    body = {
        "agentRuntimeArn": "arn:aws:bedrock-agentcore:ap-south-1:123456789012:runtime/agentic_p1-abcdefghij",
        "agentRuntimeName": "agentic_p1",
        "agentRuntimeId": "agentic_p1-abcdefghij",
        "agentRuntimeVersion": "1",
        "createdAt": datetime(2026, 10, 1),
        "lastUpdatedAt": datetime(2026, 10, 1),
        "roleArn": "arn:aws:iam::123456789012:role/r",
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "status": status,
        "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 900, "maxLifetime": 28800},
    }
    if reason:
        body["failureReason"] = reason
    return body


def test_wait_until_ready_polls_then_succeeds_or_reports_the_failure():
    cloud = _cloud()
    with Stubber(cloud.control) as stub:
        stub.add_response("get_agent_runtime", _runtime_status("CREATING"))
        stub.add_response("get_agent_runtime", _runtime_status("READY"))
        cloud.wait_until_ready("agentic_p1-abcdefghij", poll_s=0)

    with Stubber(cloud.control) as stub:
        stub.add_response("get_agent_runtime", _runtime_status("CREATE_FAILED", "bad package"))
        with pytest.raises(DeployError, match="CREATE_FAILED: bad package"):
            cloud.wait_until_ready("agentic_p1-abcdefghij", poll_s=0)


def _invoke_response(body: dict, status=200):
    raw = json.dumps(body).encode()
    return {
        "response": StreamingBody(io.BytesIO(raw), len(raw)),
        "contentType": "application/json",
        "runtimeSessionId": "s" * 64,
        "statusCode": status,
    }


def test_invoke_sends_the_task_and_returns_the_runtime_json():
    cloud = _cloud()
    with Stubber(cloud._invoke_client(360)) as stub:  # the default run limit + grace
        stub.add_response(
            "invoke_agent_runtime",
            _invoke_response({"outputs": {"b": {"content": "hi"}}, "errors": [], "halted": False}),
            {
                "agentRuntimeArn": "arn:x",
                "runtimeSessionId": ANY,
                "payload": json.dumps({"input": {"q": "x"}}).encode(),
                "contentType": "application/json",
                "accept": "application/json",
                "qualifier": "DEFAULT",
            },
        )
        assert cloud.invoke("arn:x", {"input": {"q": "x"}})["outputs"]["b"]["content"] == "hi"


def test_invoke_surfaces_the_runtimes_typed_error():
    cloud = _cloud()
    with Stubber(cloud._invoke_client(360)) as stub:  # the default run limit + grace
        stub.add_response(
            "invoke_agent_runtime",
            _invoke_response({"error_type": "RunTimeout", "message": "too slow", "details": None}, 504),
        )
        with pytest.raises(DeployedRunError) as exc:
            cloud.invoke("arn:x", {"input": {}})
    assert exc.value.error_type == "RunTimeout"
    assert exc.value.status == 504


# ------------------------------------------------------------------ orchestration (fake cloud)
class FakeCloud:
    region = "ap-south-1"

    def __init__(self, fail_at=None):
        self.fail_at = fail_at
        self.calls = []
        self.environment = None
        self.invocations = []

    def _step(self, name):
        self.calls.append(name)
        if name == self.fail_at:
            raise DeployError(f"{name} broke")

    def ensure_bucket(self):
        self._step("ensure_bucket")

    def upload(self, path, key):
        self._step("upload")
        self.key = key

    def ensure_role(self):
        self._step("ensure_role")
        return "arn:aws:iam::123456789012:role/r"

    def deploy_runtime(self, name, code_key, environment, role_arn, existing_runtime_id=None, description=""):
        self._step("update_runtime" if existing_runtime_id else "create_runtime")
        self.environment = environment
        return "agentic_p-abcdefghij", "arn:aws:bedrock-agentcore:ap-south-1:123456789012:runtime/agentic_p-abcdefghij"

    def wait_until_ready(self, runtime_id):
        self._step("wait_until_ready")

    def delete_runtime(self, runtime_id):
        self._step("delete_runtime")

    def delete_code(self, prefix):
        self._step("delete_code")

    def invoke(self, runtime_arn, payload, timeout_s=None):
        self.invoke_timeout = timeout_s
        self.invocations.append(payload)
        return {"outputs": {"b": {"content": "from AgentCore"}}, "errors": [], "halted": False}


def _fake_packager(plan, path):
    path.write_bytes(b"zip")


def _store_with_deployment(**deployment):
    store = InMemoryProjectStore()
    store.create(ProjectRecord(id="p", tenant_id="u", brief="b", plan=_plan(), compiled_version=1))
    store.set_deployment("p", Deployment(status="packaging", plan_version=1, region="ap-south-1",
                                         runtime_name="agentic_p", **deployment))
    return store


def test_successful_deployment_records_the_live_runtime(keys):
    store, cloud = _store_with_deployment(), FakeCloud()
    deploy.run_deployment("p", store, cloud, _fake_packager)
    d = store.get("p").deployment
    assert d.status == "ready"
    assert d.live and d.live_plan_version == 1
    assert d.runtime_arn.endswith("agentic_p-abcdefghij")
    assert cloud.calls == ["ensure_bucket", "upload", "ensure_role", "create_runtime", "wait_until_ready"]
    assert cloud.key.startswith("agentic_p/v1-")
    assert cloud.environment == {"GEMINI_API_KEY": "gemini-secret"}


def test_failed_deployment_is_recorded_and_never_leaks_keys(keys):
    store, cloud = _store_with_deployment(), FakeCloud(fail_at="wait_until_ready")
    deploy.run_deployment("p", store, cloud, _fake_packager)
    d = store.get("p").deployment
    assert d.status == "failed"
    assert "wait_until_ready broke" in d.error
    assert "gemini-secret" not in d.model_dump_json()


def test_redeploy_updates_the_existing_runtime(keys):
    store = _store_with_deployment(runtime_id="agentic_p-abcdefghij", runtime_arn="arn:old", live_plan_version=1)
    cloud = FakeCloud()
    deploy.run_deployment("p", store, cloud, _fake_packager)
    assert "update_runtime" in cloud.calls and "create_runtime" not in cloud.calls


def test_stalled_deployment_is_reported_as_failed():
    d = Deployment(status="uploading", plan_version=1, region="r", runtime_name="n",
                   updated_at=datetime.now(timezone.utc) - timedelta(hours=1))
    assert d.effective().status == "failed"
    assert "Interrupted" in d.effective().error
    fresh = d.model_copy(update={"updated_at": datetime.now(timezone.utc)})
    assert fresh.effective().status == "uploading"


# ------------------------------------------------------------------ API
@pytest.fixture
def api(monkeypatch, keys):
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: _plan())
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    monkeypatch.setattr(app_module, "_knowledge", InMemoryKnowledgeStore())
    monkeypatch.setattr(app_module, "_usage", InMemoryUsageStore())
    monkeypatch.setattr(app_module, "_package_builder", _fake_packager)
    cloud = FakeCloud()
    monkeypatch.setattr(app_module, "_make_cloud", lambda: cloud)
    app_module._COMPILED.clear()
    client = TestClient(app_module.app)

    def login(email):
        token = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}

    client.cloud = cloud
    client.login = login
    return client


def _compiled_project(api, headers):
    pid = api.post("/projects", json={"brief": "x"}, headers=headers).json()["project_id"]
    api.post(f"/projects/{pid}/compile", headers=headers)
    return pid


def test_deploy_then_invoke_then_remove(api):
    h = api.login("ada@example.com")
    pid = _compiled_project(api, h)

    status = api.get(f"/projects/{pid}/deployment", headers=h).json()
    assert status == {"available": True, "region": "ap-south-1", "deployment": None}

    r = api.post(f"/projects/{pid}/deploy", headers=h)
    assert r.status_code == 202
    # The background job ran (TestClient runs it before returning).
    d = api.get(f"/projects/{pid}/deployment", headers=h).json()["deployment"]
    assert d["status"] == "ready" and d["live"] is True and d["outdated"] is False
    assert api.get(f"/projects/{pid}", headers=h).json()["deployment"]["status"] == "ready"

    r = api.post(f"/projects/{pid}/deployment/invoke", json={"input": {"q": "x"}}, headers=h)
    assert r.status_code == 200
    assert r.json()["outputs"]["b"]["content"] == "from AgentCore"
    # The platform tags its own call, so the runtime's usage log line can be matched to it.
    (sent,) = api.cloud.invocations
    assert sent["input"] == {"q": "x"} and len(sent["run_id"]) == 32

    assert api.delete(f"/projects/{pid}/deployment", headers=h).json() == {"deployment": None}
    assert api.get(f"/projects/{pid}/deployment", headers=h).json()["deployment"] is None


def test_deploy_needs_a_compiled_plan(api):
    h = api.login("ada@example.com")
    pid = api.post("/projects", json={"brief": "x"}, headers=h).json()["project_id"]
    r = api.post(f"/projects/{pid}/deploy", headers=h)
    assert r.status_code == 409
    assert r.json()["error_type"] == "NotCompiled"


def test_deploy_without_aws_credentials_says_so(api, monkeypatch):
    monkeypatch.setattr(app_module, "_make_cloud", lambda: None)
    h = api.login("ada@example.com")
    pid = _compiled_project(api, h)
    assert api.get(f"/projects/{pid}/deployment", headers=h).json()["available"] is False
    r = api.post(f"/projects/{pid}/deploy", headers=h)
    assert r.status_code == 503
    assert r.json()["error_type"] == "DeployNotConfigured"


def test_deploy_with_a_missing_provider_key_fails_up_front(api, monkeypatch):
    h = api.login("ada@example.com")
    pid = _compiled_project(api, h)
    monkeypatch.delenv("GEMINI_API_KEY")
    r = api.post(f"/projects/{pid}/deploy", headers=h)
    assert r.json()["error_type"] == "MissingProviderKey"
    assert api.get(f"/projects/{pid}/deployment", headers=h).json()["deployment"] is None
    assert api.cloud.calls == []


def test_second_deploy_while_one_runs_is_rejected(api):
    h = api.login("ada@example.com")
    pid = _compiled_project(api, h)
    app_module._store.set_deployment(pid, Deployment(status="uploading", plan_version=1,
                                                     region="ap-south-1", runtime_name="n"))
    r = api.post(f"/projects/{pid}/deploy", headers=h)
    assert r.status_code == 409
    assert r.json()["error_type"] == "DeployInProgress"


def test_invoke_without_a_live_deployment_is_rejected(api):
    h = api.login("ada@example.com")
    pid = _compiled_project(api, h)
    r = api.post(f"/projects/{pid}/deployment/invoke", json={"input": {}}, headers=h)
    assert r.status_code == 409
    assert r.json()["error_type"] == "NotDeployed"


def test_plan_change_marks_the_deployment_outdated_but_keeps_it_live(api):
    h = api.login("ada@example.com")
    pid = _compiled_project(api, h)
    api.post(f"/projects/{pid}/deploy", headers=h)
    api.patch(f"/projects/{pid}/plan", json=_plan().model_dump(), headers=h)
    d = api.get(f"/projects/{pid}/deployment", headers=h).json()["deployment"]
    assert d["live"] is True
    assert d["outdated"] is True
    assert d["live_plan_version"] == 1


def test_deployments_are_private_to_their_owner(api):
    ada, bob = api.login("ada@example.com"), api.login("bob@example.com")
    pid = _compiled_project(api, ada)
    api.post(f"/projects/{pid}/deploy", headers=ada)
    for r in (
        api.get(f"/projects/{pid}/deployment", headers=bob),
        api.post(f"/projects/{pid}/deploy", headers=bob),
        api.post(f"/projects/{pid}/deployment/invoke", json={"input": {}}, headers=bob),
        api.delete(f"/projects/{pid}/deployment", headers=bob),
    ):
        assert r.status_code == 404
    assert api.get(f"/projects/{pid}/deployment", headers=ada).json()["deployment"]["live"] is True


# ------------------------------------------------------------------ knowledge base snapshot
def _knowledge_store():
    from agentic_platform.agent_schema import EmbeddingConfig
    from agentic_platform.stores import KnowledgeChunk, KnowledgeDocument

    store = InMemoryKnowledgeStore()
    store.add_document(KnowledgeDocument(id="d1", project_ids=["p"], tenant_id="u", filename="policy.pdf",
                                         kind=".pdf", size_bytes=1, status="ready", chunk_count=2))
    store.replace_chunks("u", "d1", [
        KnowledgeChunk(id="c1", tenant_id="u", document_id="d1", ordinal=0, text="Hotel cap INR 9,000.",
                       source="page 2", embedding=[0.0, 1.0]),
        KnowledgeChunk(id="c2", tenant_id="u", document_id="d1", ordinal=1, text="Flights: economy.",
                       source="page 1", embedding=[1.0, 0.0]),
    ])
    return store, EmbeddingConfig(provider="openai", model="text-embedding-3-small")


def test_runtime_searches_its_knowledge_snapshot(tmp_path, monkeypatch):
    from agentic_platform import knowledge as kb
    from agentic_platform.graph_builder import Embedder

    store, embedding = _knowledge_store()
    meta, vectors = kb.build_snapshot(store, "u", "p", embedding)
    (tmp_path / kb.SNAPSHOT_FILE).write_bytes(meta)
    (tmp_path / kb.SNAPSHOT_VECTORS_FILE).write_bytes(vectors)

    used = {}
    monkeypatch.setattr(runtime_app, "get_embeddings",
                        lambda cfg: used.setdefault("cfg", cfg) and Embedder(None, lambda q: [0.1, 0.9]))
    captured = {}

    def fake_compile(plan, knowledge=None):
        captured["knowledge"] = knowledge
        return object()

    monkeypatch.setattr(runtime_app, "compile_graph", fake_compile)
    runtime_app.create_app(_plan(tools=["knowledge_search"]).model_dump(), knowledge_dir=tmp_path)
    hits = captured["knowledge"].search("hotel limit", k=1)
    assert used["cfg"] == embedding  # the query is embedded with the files' own model
    assert (hits[0].filename, hits[0].source, hits[0].text) == ("policy.pdf", "page 2", "Hotel cap INR 9,000.")


def test_runtime_without_a_snapshot_cant_start_a_plan_that_searches_documents(tmp_path):
    from agentic_platform.errors import KnowledgeUnavailableError

    with pytest.raises(KnowledgeUnavailableError):
        runtime_app.create_app(_plan(tools=["knowledge_search"]).model_dump(), knowledge_dir=tmp_path)


def test_environment_adds_the_embedding_key_only_when_documents_are_searched(keys):
    _, embedding = _knowledge_store()
    assert deploy.runtime_environment(_plan(), embedding) == {"GEMINI_API_KEY": "gemini-secret"}
    env = deploy.runtime_environment(_plan(tools=["knowledge_search"]), embedding)
    assert env == {"GEMINI_API_KEY": "gemini-secret", "OPENAI_API_KEY": "openai-secret"}
    # Files on several models: every embedding provider's key (none for Bedrock).
    from agentic_platform.agent_schema import EmbeddingConfig

    titan = EmbeddingConfig(provider="bedrock", model="amazon.titan-embed-text-v2:0")
    env = deploy.runtime_environment(_plan(tools=["knowledge_search"]), [embedding, titan])
    assert env == {"GEMINI_API_KEY": "gemini-secret", "OPENAI_API_KEY": "openai-secret"}


def test_package_includes_the_snapshot(tmp_path):
    deps = tmp_path / "deps"
    deps.mkdir()
    out = tmp_path / "package.zip"
    deploy.build_package(_plan(), out, dependencies=lambda: deps, knowledge=(b'{"x": 1}', b"vectors"))
    with zipfile.ZipFile(out) as zf:
        assert zf.read("knowledge.json") == b'{"x": 1}'
        assert zf.read("knowledge_vectors.npz") == b"vectors"
    assert "pypdf" in deploy.PLATFORM_ONLY_PACKAGES and "python-docx" in deploy.PLATFORM_ONLY_PACKAGES


def test_deploy_bakes_in_the_knowledge_base_its_agents_search(api, monkeypatch):
    from agentic_platform import knowledge as kb

    store, embedding = _knowledge_store()
    packaged = {}

    def packager(plan, path, knowledge=None):
        packaged["knowledge"] = knowledge
        path.write_bytes(b"zip")

    monkeypatch.setattr(app_module, "_package_builder", packager)
    monkeypatch.setattr(app_module, "_knowledge_context", lambda project: None)
    h = api.login("kb@example.com")
    pid = _compiled_project(api, h)
    plan = _plan(tools=["knowledge_search"])
    project = app_module._store.get(pid)
    app_module._store.update_plan(pid, plan)
    app_module._store.mark_compiled(pid, project.plan_version + 1)

    r = api.post(f"/projects/{pid}/deploy", headers=h)
    assert r.status_code == 409 and r.json()["error_type"] == "KnowledgeUnavailable"

    user_id = api.get("/auth/me", headers=h).json()["id"]
    for doc in store.list_documents("u"):
        app_module._knowledge.add_document(doc.model_copy(update={"tenant_id": user_id, "project_ids": [pid]}))
        app_module._knowledge.replace_chunks(user_id, doc.id, [
            c.model_copy(update={"tenant_id": user_id}) for c in store.chunks_for_documents("u", [doc.id])
        ])
    app_module._knowledge.set_embedding(user_id, embedding)
    r = api.post(f"/projects/{pid}/deploy", headers=h)
    assert r.status_code == 202
    assert api.get(f"/projects/{pid}/deployment", headers=h).json()["deployment"]["status"] == "ready"
    meta = json.loads(packaged["knowledge"][0])
    assert meta["documents"] == {"d1": "policy.pdf"} and len(meta["groups"][0]["passages"]) == 2
    assert api.cloud.environment["OPENAI_API_KEY"] == "openai-secret"


# ------------------------------------------------------------------ invoke timeouts
def test_invoke_waits_for_the_runs_own_limit_and_never_retries():
    from agentic_platform.agentcore import MAX_INVOKE_WAIT_S, invoke_read_timeout

    assert invoke_read_timeout(300) == 360  # the default run limit plus a grace period
    assert invoke_read_timeout(None) == 360
    assert invoke_read_timeout(5000) == MAX_INVOKE_WAIT_S  # AgentCore's 15-minute ceiling

    cloud = AgentCoreCloud("ap-south-1", session=boto3.Session(
        aws_access_key_id="x", aws_secret_access_key="y", region_name="ap-south-1"))
    config = cloud._invoke_client(360).meta.config
    assert config.read_timeout == 360
    assert config.retries["total_max_attempts"] == 1  # a slow run is never started twice
    assert cloud._invoke_client(360) is cloud._invoke_client(360)


def test_a_slow_deployed_run_is_a_clear_504_not_a_raw_aws_error():
    from botocore.exceptions import ReadTimeoutError

    cloud = AgentCoreCloud("ap-south-1", session=boto3.Session(
        aws_access_key_id="x", aws_secret_access_key="y", region_name="ap-south-1"))

    class Slow:
        def invoke_agent_runtime(self, **kw):
            raise ReadTimeoutError(endpoint_url="https://bedrock-agentcore.ap-south-1.amazonaws.com")

    cloud._invoke_clients[360] = Slow()
    with pytest.raises(DeployedRunError) as caught:
        cloud.invoke("arn:runtime", {"input": {}}, timeout_s=300)
    assert caught.value.status == 504 and caught.value.error_type == "RunTimeout"
    assert "360 seconds" in str(caught.value)


def test_platform_invoke_passes_the_plans_time_limit(api):
    h = api.login("slow@example.com")
    pid = _compiled_project(api, h)
    api.post(f"/projects/{pid}/deploy", headers=h)
    api.post(f"/projects/{pid}/deployment/invoke", json={"input": {"q": "x"}}, headers=h)
    assert api.cloud.invoke_timeout == 300
