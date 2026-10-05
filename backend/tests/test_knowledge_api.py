"""Knowledge base API: upload, status, search, delete, embedding changes — offline."""

import agentic_platform.app as app_module
from agentic_platform import knowledge as kb
from agentic_platform.agent_schema import AgentOutput, AgentPlan, AgentSpec, LLMConfig, PlanRevision
from agentic_platform.graph_builder import Embedder
from agentic_platform.stores import InMemoryKnowledgeStore, InMemoryProjectStore, InMemoryUserStore
from fastapi.testclient import TestClient


def _plan():
    return AgentPlan(
        agents=[
            AgentSpec(
                id="a",
                role="worker",
                system_prompt="do it",
                llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"),
            )
        ],
        orchestration_pattern="sequential",
    )


def _revision():
    return PlanRevision(reply="ok", brief="x", plan=_plan())


def _client(monkeypatch):
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: _plan())
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    monkeypatch.setattr(app_module, "_knowledge", InMemoryKnowledgeStore())
    app_module._COMPILED.clear()
    client = TestClient(app_module.app)
    session = client.post(
        "/auth/register", json={"email": "tester@example.com", "password": "a-long-password"}
    ).json()
    client.headers["Authorization"] = f"Bearer {session['access_token']}"
    return client

TOPICS = ["flight", "hotel", "visa", "food"]


def _vector(text):
    lower = text.lower()
    return [float(lower.count(t)) + 0.01 for t in TOPICS]


def _fake_embeddings(config):
    return Embedder(lambda texts: [_vector(t) for t in texts], _vector)


GUIDE = b"# Hotels\nThe hotel cap in Delhi is INR 9,000 per night.\n\n# Food\nMeals: INR 1,500 a day for food.\n"


def _setup(monkeypatch):
    c = _client(monkeypatch)
    monkeypatch.setattr(app_module, "get_embeddings", _fake_embeddings)
    monkeypatch.setattr(app_module, "embedding_available", lambda provider: provider == "google_genai")
    pid = c.post("/projects", json={"brief": "x"}).json()["project_id"]
    return c, pid


def _upload(c, pid, *files):
    return c.post(f"/projects/{pid}/knowledge/documents", files=[("files", f) for f in files])


def test_upload_indexes_in_the_background_and_search_cites_the_file(monkeypatch):
    c, pid = _setup(monkeypatch)
    r = _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    assert r.status_code == 202
    assert r.json()["documents"][0]["status"] == "queued"

    body = c.get(f"/projects/{pid}/knowledge").json()
    assert body["embedding"] == {"provider": "google_genai", "model": "gemini-embedding-001"}
    doc = body["documents"][0]
    assert (doc["filename"], doc["status"], doc["chunk_count"]) == ("policy.md", "ready", 1)
    assert "project_id" not in doc and "tenant_id" not in doc

    results = c.post(f"/projects/{pid}/knowledge/search", json={"query": "hotel cap"}).json()["results"]
    assert results[0]["filename"] == "policy.md"
    assert "INR 9,000" in results[0]["text"]
    assert c.get(f"/projects/{pid}").json()["knowledge"]["ready"] == 1


def test_a_file_that_cant_be_read_is_reported_failed(monkeypatch):
    c, pid = _setup(monkeypatch)
    _upload(c, pid, ("scan.pdf", b"%PDF-1.4 not really", "application/pdf"))
    doc = c.get(f"/projects/{pid}/knowledge").json()["documents"][0]
    assert doc["status"] == "failed" and doc["error"]


def test_uploads_are_checked_before_anything_is_queued(monkeypatch):
    c, pid = _setup(monkeypatch)
    r = _upload(c, pid, ("ok.md", GUIDE, "text/markdown"), ("slides.pptx", b"x", "application/octet-stream"))
    assert r.status_code == 400
    assert r.json()["error_type"] == "KnowledgeRejected"
    assert c.get(f"/projects/{pid}/knowledge").json()["documents"] == []

    _upload(c, pid, ("ok.md", GUIDE, "text/markdown"))
    r = _upload(c, pid, ("OK.md", GUIDE, "text/markdown"))
    assert r.status_code == 409  # same name

    assert c.post(f"/projects/{pid}/knowledge/documents", data={"files": "text"}).status_code == 400



def test_another_users_project_knowledge_is_a_404(monkeypatch):
    c, pid = _setup(monkeypatch)
    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    doc_id = c.get(f"/projects/{pid}/knowledge").json()["documents"][0]["id"]

    other = TestClient(app_module.app)
    token = other.post(
        "/auth/register", json={"email": "other@example.com", "password": "a-long-password"}
    ).json()["access_token"]
    other.headers["Authorization"] = f"Bearer {token}"
    assert other.get(f"/projects/{pid}/knowledge").status_code == 404
    assert _upload(other, pid, ("x.md", GUIDE, "text/markdown")).status_code == 404
    assert other.post(f"/projects/{pid}/knowledge/search", json={"query": "hotel"}).status_code == 404
    assert other.delete(f"/projects/{pid}/knowledge/documents/{doc_id}").status_code == 404
    assert c.get(f"/projects/{pid}/knowledge").json()["documents"][0]["id"] == doc_id


def test_deleting_a_file_removes_its_passages(monkeypatch):
    c, pid = _setup(monkeypatch)
    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    doc_id = c.get(f"/projects/{pid}/knowledge").json()["documents"][0]["id"]
    assert c.delete(f"/projects/{pid}/knowledge/documents/{doc_id}").status_code == 200
    assert c.post(f"/projects/{pid}/knowledge/search", json={"query": "hotel"}).json()["results"] == []
    r = c.delete(f"/projects/{pid}/knowledge/documents/{doc_id}")
    assert r.status_code == 404 and r.json()["error_type"] == "DocumentNotFound"


def test_no_embedding_key_is_a_clear_503(monkeypatch):
    c, pid = _setup(monkeypatch)
    monkeypatch.setattr(app_module, "embedding_available", lambda provider: False)
    r = _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    assert r.status_code == 503 and "embedding" in r.json()["message"]



def test_knowledge_search_is_offered_only_once_documents_are_ready(monkeypatch):
    c, pid = _setup(monkeypatch)
    seen = {}

    def spy(**kw):
        seen.update(kw)
        return _revision()

    monkeypatch.setattr(app_module, "revise_plan", spy)
    c.post(f"/projects/{pid}/revise", json={"message": "use my files"})
    assert "knowledge_search" not in seen["available_tools"]

    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    c.post(f"/projects/{pid}/revise", json={"message": "use my files"})
    assert "knowledge_search" in seen["available_tools"]


def test_a_new_project_never_gets_knowledge_search(monkeypatch):
    c = _client(monkeypatch)
    seen = {}
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: seen.update(kw) or _plan())
    c.post("/projects", json={"brief": "x", "available_tools": ["lookup", "knowledge_search"]})
    assert seen["available_tools"] == ["lookup"]


def _plan_with_knowledge():
    plan = _plan()
    agent = plan.agents[0].model_copy(update={"tools": ["knowledge_search"]})
    return plan.model_copy(update={"agents": [agent]})


def test_compile_needs_documents_when_an_agent_uses_knowledge_search(monkeypatch):
    c, pid = _setup(monkeypatch)
    c.patch(f"/projects/{pid}/plan", json=_plan_with_knowledge().model_dump())
    r = c.post(f"/projects/{pid}/compile")
    assert r.status_code == 409 and r.json()["error_type"] == "KnowledgeUnavailable"

    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    assert c.post(f"/projects/{pid}/compile").status_code == 200
    assert c.get(f"/projects/{pid}/knowledge").json()["used_by"] == ["a"]


def test_a_run_searches_the_projects_documents(monkeypatch):
    import agentic_platform.graph_builder as gb

    c, pid = _setup(monkeypatch)
    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    c.patch(f"/projects/{pid}/plan", json=_plan_with_knowledge().model_dump())
    seen = []

    class Message:
        def __init__(self, tool_calls):
            self.tool_calls = tool_calls

    class FakeLLM:
        def bind_tools(self, tools):
            return self

        def invoke(self, messages):
            seen.append(messages[-1])
            if len(seen) == 1:
                return Message([{"name": "knowledge_search", "args": {"query": "hotel cap"}, "id": "c1"}])
            return Message([])

        def with_structured_output(self, schema):
            class S:
                def invoke(self, messages):
                    return AgentOutput(content="The cap is INR 9,000 [policy.md].")

            return S()

    monkeypatch.setattr(gb, "get_llm", lambda cfg: FakeLLM())
    c.post(f"/projects/{pid}/compile")
    r = c.post(f"/projects/{pid}/run", json={"input": {"q": "hotel cap?"}})
    assert r.status_code == 200 and r.json()["errors"] == []
    assert "[policy.md — section \"Hotels\"" in seen[1].content and "INR 9,000" in seen[1].content



def test_another_users_project_cant_be_deleted(monkeypatch):
    c, pid = _setup(monkeypatch)
    other = TestClient(app_module.app)
    token = other.post(
        "/auth/register", json={"email": "other@example.com", "password": "a-long-password"}
    ).json()["access_token"]
    other.headers["Authorization"] = f"Bearer {token}"
    r = other.delete(f"/projects/{pid}")
    assert r.status_code == 404 and r.json()["error_type"] == "ProjectNotFound"
    assert c.get(f"/projects/{pid}").status_code == 200


def test_a_deployed_project_must_be_undeployed_first(monkeypatch):
    from agentic_platform.stores import Deployment

    c, pid = _setup(monkeypatch)
    live = Deployment(status="ready", plan_version=1, region="ap-south-1", runtime_name="agentic_x",
                      runtime_id="agentic_x-abc", runtime_arn="arn:x", live_plan_version=1)
    app_module._store.set_deployment(pid, live)
    r = c.delete(f"/projects/{pid}")
    assert r.status_code == 409 and r.json()["error_type"] == "ProjectDeployed"
    assert c.get(f"/projects/{pid}").status_code == 200

    # A deploy that failed before creating a runtime leaves nothing in AWS to orphan.
    app_module._store.set_deployment(pid, live.model_copy(update={"status": "failed", "runtime_id": None}))
    assert c.delete(f"/projects/{pid}").status_code == 200


def _library_upload(c, *files):
    return c.post("/knowledge/documents", files=[("files", f) for f in files])


def _other_user():
    other = TestClient(app_module.app)
    token = other.post(
        "/auth/register", json={"email": "other@example.com", "password": "a-long-password"}
    ).json()["access_token"]
    other.headers["Authorization"] = f"Bearer {token}"
    return other


def test_files_can_be_uploaded_to_the_library_without_a_project(monkeypatch):
    c, pid = _setup(monkeypatch)
    r = _library_upload(c, ("policy.md", GUIDE, "text/markdown"))
    assert r.status_code == 202
    assert r.json()["documents"][0]["project_ids"] == []

    body = c.get("/knowledge").json()
    doc = body["documents"][0]
    assert (doc["filename"], doc["status"], doc["project_ids"]) == ("policy.md", "ready", [])
    assert "tenant_id" not in doc
    assert body["embedding"] == {"provider": "google_genai", "model": "gemini-embedding-001"}
    assert body["passages"] == 1
    # Searchable in the library, but no project has it yet.
    assert c.post("/knowledge/search", json={"query": "hotel"}).json()["results"][0]["filename"] == "policy.md"
    assert c.post(f"/projects/{pid}/knowledge/search", json={"query": "hotel"}).json()["results"] == []
    project_view = c.get(f"/projects/{pid}/knowledge").json()
    assert project_view["documents"] == []
    assert [d["filename"] for d in project_view["available"]] == ["policy.md"]


def test_one_file_can_be_attached_to_several_projects_and_detached(monkeypatch):
    c, pid = _setup(monkeypatch)
    second = c.post("/projects", json={"brief": "second"}).json()["project_id"]
    doc_id = _library_upload(c, ("policy.md", GUIDE, "text/markdown")).json()["documents"][0]["id"]

    assert c.post(f"/projects/{pid}/knowledge/documents/{doc_id}").status_code == 200
    r = c.put(f"/knowledge/documents/{doc_id}/projects", json={"project_ids": [pid, second]})
    assert sorted(r.json()["document"]["project_ids"]) == sorted([pid, second])
    for project_id in (pid, second):
        hits = c.post(f"/projects/{project_id}/knowledge/search", json={"query": "hotel"}).json()["results"]
        assert hits[0]["filename"] == "policy.md"
    summary = {p["project_id"]: p for p in c.get("/knowledge").json()["projects"]}
    assert summary[pid]["documents"] == 1 and summary[second]["ready"] == 1

    # Detaching from one project leaves it in the library and in the other project.
    assert c.delete(f"/projects/{pid}/knowledge/documents/{doc_id}").status_code == 200
    assert c.get(f"/projects/{pid}/knowledge").json()["documents"] == []
    assert [d["id"] for d in c.get(f"/projects/{second}/knowledge").json()["documents"]] == [doc_id]
    assert c.delete(f"/projects/{pid}/knowledge/documents/{doc_id}").status_code == 404

    # Setting the list replaces it entirely.
    r = c.put(f"/knowledge/documents/{doc_id}/projects", json={"project_ids": []})
    assert r.json()["document"]["project_ids"] == []


def test_uploading_from_a_project_attaches_the_file_to_it(monkeypatch):
    c, pid = _setup(monkeypatch)
    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    doc = c.get("/knowledge").json()["documents"][0]
    assert doc["project_ids"] == [pid]


def test_attachments_are_limited_to_your_own_projects_and_files(monkeypatch):
    c, pid = _setup(monkeypatch)
    doc_id = _library_upload(c, ("policy.md", GUIDE, "text/markdown")).json()["documents"][0]["id"]
    other = _other_user()
    other_pid = other.post("/projects", json={"brief": "theirs"}).json()["project_id"]

    # Their project with my file, my project with their (unknown) ids: all 404, nothing changes.
    assert c.post(f"/projects/{other_pid}/knowledge/documents/{doc_id}").status_code == 404
    assert c.put(f"/knowledge/documents/{doc_id}/projects", json={"project_ids": [pid, other_pid]}).status_code == 404
    assert other.post(f"/projects/{other_pid}/knowledge/documents/{doc_id}").status_code == 404
    assert other.delete(f"/knowledge/documents/{doc_id}").status_code == 404
    assert other.get("/knowledge").json()["documents"] == []
    assert c.get("/knowledge").json()["documents"][0]["project_ids"] == []
    assert TestClient(app_module.app).get("/knowledge").status_code == 401


def test_deleting_from_the_library_detaches_everywhere(monkeypatch):
    c, pid = _setup(monkeypatch)
    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    doc_id = c.get("/knowledge").json()["documents"][0]["id"]
    assert c.delete(f"/knowledge/documents/{doc_id}").status_code == 200
    assert c.get("/knowledge").json()["documents"] == []
    assert c.post(f"/projects/{pid}/knowledge/search", json={"query": "hotel"}).json()["results"] == []
    r = c.delete(f"/knowledge/documents/{doc_id}")
    assert r.status_code == 404 and r.json()["error_type"] == "DocumentNotFound"


def test_library_file_size_count_and_name_limits(monkeypatch):
    c, pid = _setup(monkeypatch)
    monkeypatch.setattr(kb, "MAX_FILE_BYTES", 100)
    assert _library_upload(c, ("big.txt", b"x" * 101, "text/plain")).status_code == 413

    monkeypatch.setattr(kb, "MAX_FILES_PER_LIBRARY", 2)
    r = _library_upload(c, *[(f"f{i}.txt", b"hotel", "text/plain") for i in range(3)])
    assert r.status_code == 400 and "at most 2" in r.json()["message"]

    _library_upload(c, ("a.txt", b"hotel", "text/plain"))
    r = _upload(c, pid, ("A.TXT", b"hotel", "text/plain"))  # same name, from a project
    assert r.status_code == 409 and "attach" in r.json()["message"]


def test_changing_the_library_embedding_model_reembeds_everything(monkeypatch):
    c, pid = _setup(monkeypatch)
    monkeypatch.setattr(app_module, "embedding_available", lambda provider: True)
    _library_upload(c, ("policy.md", GUIDE, "text/markdown"))
    r = c.put("/knowledge/embedding", json={"provider": "openai", "model": "text-embedding-3-small"})
    assert r.status_code == 202
    body = c.get("/knowledge").json()
    assert body["embedding"]["provider"] == "openai"
    assert body["documents"][0]["status"] == "ready"
    assert c.get(f"/projects/{pid}").json()["knowledge"]["embedding"]["provider"] == "openai"
    assert c.put("/knowledge/embedding", json={"provider": "openai", "model": "gpt-4o"}).status_code == 422


def test_deleting_a_project_keeps_its_files_in_the_library(monkeypatch):
    c, pid = _setup(monkeypatch)
    keep = c.post("/projects", json={"brief": "keep me"}).json()["project_id"]
    _upload(c, pid, ("policy.md", GUIDE, "text/markdown"))
    doc_id = c.get("/knowledge").json()["documents"][0]["id"]
    c.put(f"/knowledge/documents/{doc_id}/projects", json={"project_ids": [pid, keep]})
    c.post(f"/projects/{pid}/compile")

    r = c.delete(f"/projects/{pid}")
    assert r.status_code == 200
    assert r.json() == {"deleted": pid, "knowledge_documents_detached": 1}
    assert c.get(f"/projects/{pid}").status_code == 404
    assert pid not in app_module._COMPILED
    assert [p["project_id"] for p in c.get("/projects").json()["projects"]] == [keep]
    assert c.get("/knowledge").json()["documents"][0]["project_ids"] == [keep]
    assert c.delete(f"/projects/{pid}").status_code == 404

