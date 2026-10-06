"""Contract tests for ProjectStore and UserStore, run against every implementation.

The in-memory stores always run. The MongoDB stores run against a real server when one
is reachable (MONGODB_URI, or localhost:27017) and is skipped otherwise, so the default
suite stays runnable offline. It uses a throwaway database that is dropped afterwards.
"""

import os
import time
import uuid

import pytest

from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.errors import EmailTakenError, StoreUnavailableError
from agentic_platform.stores import (
    InMemoryProjectStore,
    InMemoryUserStore,
    MongoProjectStore,
    MongoUserStore,
    ProjectRecord,
    UserRecord,
    mongo_database,
)


def _plan(prompt="do it"):
    return AgentPlan(
        agents=[
            AgentSpec(
                id="a",
                role="worker",
                system_prompt=prompt,
                llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"),
            )
        ],
        orchestration_pattern="sequential",
    )


def _record(**overrides):
    fields = {"id": uuid.uuid4().hex, "tenant_id": "user-1", "brief": "a brief", "plan": _plan()}
    return ProjectRecord(**{**fields, **overrides})


def _user(email="ada@example.com"):
    return UserRecord(id=uuid.uuid4().hex, email=email, password_hash="$argon2id$stub")


@pytest.fixture(params=["memory", "mongo"])
def backend(request):
    """Yields None for the in-memory stores, or a throwaway MongoDB database."""
    if request.param == "memory":
        yield None
        return

    from pymongo.errors import PyMongoError

    uri = os.environ.get("MONGODB_URI") or "mongodb://localhost:27017"
    db = mongo_database(uri, f"agentic_platform_test_{uuid.uuid4().hex[:8]}", timeout_ms=500)
    try:
        db.client.admin.command("ping")
    except PyMongoError:
        db.client.close()
        pytest.skip("no MongoDB server reachable")
    try:
        yield db
    finally:
        db.client.drop_database(db.name)
        db.client.close()


@pytest.fixture
def store(backend):
    return InMemoryProjectStore() if backend is None else MongoProjectStore(backend)


@pytest.fixture
def users(backend):
    return InMemoryUserStore() if backend is None else MongoUserStore(backend)


def test_get_unknown_is_none(store):
    assert store.get("missing") is None


def test_create_then_get_round_trips_the_whole_record(store):
    record = _record(side_effect_tools_enabled=["web_search"])
    store.create(record)
    assert store.get(record.id) == record


def test_new_project_is_not_compiled(store):
    record = _record()
    store.create(record)
    got = store.get(record.id)
    assert got.plan_version == 1
    assert got.compiled_version is None
    assert got.is_compiled is False


def test_mark_compiled_makes_project_runnable(store):
    record = _record()
    store.create(record)
    assert store.mark_compiled(record.id, 1) is True
    assert store.get(record.id).is_compiled is True


def test_update_plan_bumps_version_and_invalidates_compile(store):
    record = _record()
    store.create(record)
    store.mark_compiled(record.id, 1)

    updated = store.update_plan(record.id, _plan("do it differently"))

    assert updated.plan_version == 2
    assert updated.plan.agents[0].system_prompt == "do it differently"
    assert updated.is_compiled is False
    assert store.get(record.id) == updated


def test_mark_compiled_rejects_a_stale_version(store):
    # A compile that started before a plan edit must not mark the newer plan runnable.
    record = _record()
    store.create(record)
    store.update_plan(record.id, _plan("edited"))
    assert store.mark_compiled(record.id, 1) is False
    assert store.get(record.id).is_compiled is False


def test_update_and_mark_on_unknown_project(store):
    assert store.update_plan("missing", _plan()) is None
    assert store.mark_compiled("missing", 1) is False


def test_list_for_tenant_is_scoped_and_newest_first(store):
    mine_old = _record(tenant_id="user-1", brief="old")
    mine_new = _record(tenant_id="user-1", brief="new")
    theirs = _record(tenant_id="user-2", brief="not mine")
    for record in (mine_old, mine_new, theirs):
        store.create(record)
    # An edit makes a project the most recently updated one.
    time.sleep(0.01)
    store.update_plan(mine_old.id, _plan("edited"))

    listed = store.list_for_tenant("user-1")
    assert [r.id for r in listed] == [mine_old.id, mine_new.id]
    assert store.list_for_tenant("nobody") == []


def test_returned_records_are_detached_from_the_store(store):
    record = _record()
    store.create(record)
    got = store.get(record.id)
    got.brief = "mutated by the caller"
    assert store.get(record.id).brief == "a brief"


def test_unreachable_mongo_raises_typed_error_without_leaking_the_uri():
    # Port 1 is never a MongoDB server, so this fails fast without needing one.
    db = mongo_database(
        "mongodb://user:s3cret@127.0.0.1:1", "agentic_platform_test", timeout_ms=200
    )
    with pytest.raises(StoreUnavailableError) as exc:
        MongoProjectStore(db).get("anything")
    assert "s3cret" not in str(exc.value)
    with pytest.raises(StoreUnavailableError):
        MongoUserStore(db).create(_user())
    db.client.close()


# ------------------------------------------------------------------ UserStore
def test_unknown_user_is_none(users):
    assert users.get("missing") is None
    assert users.get_by_email("nobody@example.com") is None


def test_user_round_trips_by_id_and_by_email(users):
    user = _user()
    users.create(user)
    assert users.get(user.id) == user
    assert users.get_by_email("ada@example.com") == user


def test_second_account_with_the_same_email_is_rejected(users):
    first = _user()
    users.create(first)
    with pytest.raises(EmailTakenError):
        users.create(_user())
    # The original account is untouched.
    assert users.get_by_email("ada@example.com") == first


def test_different_emails_coexist(users):
    users.create(_user("ada@example.com"))
    users.create(_user("bob@example.com"))
    assert users.get_by_email("bob@example.com").email == "bob@example.com"


# ------------------------------------------------------------------ conversation / revisions
def _msg(role, content):
    from agentic_platform.stores import ChatMessage

    return ChatMessage(role=role, content=content)


def test_exchange_with_changes_bumps_version_and_keeps_messages(store):
    record = _record()
    store.create(record)
    store.mark_compiled(record.id, 1)

    updated = store.record_exchange(
        record.id, 1, [_msg("user", "make it 2 agents"), _msg("assistant", "Done.")],
        brief="new brief", plan=_plan("revised"),
    )
    assert updated.plan_version == 2
    assert updated.brief == "new brief"
    assert updated.plan.agents[0].system_prompt == "revised"
    assert updated.is_compiled is False
    assert [m.content for m in updated.conversation] == ["make it 2 agents", "Done."]
    assert store.get(record.id) == updated


def test_exchange_without_changes_only_appends(store):
    record = _record()
    store.create(record)
    store.mark_compiled(record.id, 1)
    updated = store.record_exchange(record.id, 1, [_msg("user", "why?"), _msg("assistant", "Because.")])
    assert updated.plan_version == 1
    assert updated.is_compiled is True
    assert len(updated.conversation) == 2


def test_exchange_against_a_stale_version_is_rejected(store):
    record = _record()
    store.create(record)
    store.update_plan(record.id, _plan("someone else's edit"))  # now at version 2
    assert store.record_exchange(record.id, 1, [_msg("user", "x")], plan=_plan("mine")) is None
    current = store.get(record.id)
    assert current.plan.agents[0].system_prompt == "someone else's edit"
    assert current.conversation == []


def test_conversation_keeps_only_the_most_recent_messages(store):
    from agentic_platform.stores import CONVERSATION_LIMIT

    record = _record()
    store.create(record)
    batch = [_msg("user", f"m{i}") for i in range(CONVERSATION_LIMIT + 5)]
    updated = store.record_exchange(record.id, 1, batch)
    assert len(updated.conversation) == CONVERSATION_LIMIT
    assert updated.conversation[-1].content == f"m{CONVERSATION_LIMIT + 4}"


# ------------------------------------------------------------------ KnowledgeStore (libraries)
@pytest.fixture
def knowledge(backend):
    from agentic_platform.stores import InMemoryKnowledgeStore, MongoKnowledgeStore

    return InMemoryKnowledgeStore() if backend is None else MongoKnowledgeStore(backend)


def _kdoc(doc_id="d1", tenant_id="u1", project_ids=(), **overrides):
    from agentic_platform.stores import KnowledgeDocument

    fields = dict(id=doc_id, tenant_id=tenant_id, project_ids=list(project_ids), filename=f"{doc_id}.pdf",
                  kind=".pdf", size_bytes=10)
    return KnowledgeDocument(**{**fields, **overrides})


def _kchunk(chunk_id, doc_id="d1", tenant_id="u1", ordinal=0, embedding=None):
    from agentic_platform.stores import KnowledgeChunk

    return KnowledgeChunk(
        id=chunk_id, tenant_id=tenant_id, document_id=doc_id, ordinal=ordinal,
        text=f"text {chunk_id}", source="page 1", embedding=embedding or [0.1, 0.2],
    )


def test_libraries_are_scoped_to_their_owner(knowledge):
    knowledge.add_document(_kdoc("d1", "u1"))
    knowledge.add_document(_kdoc("d2", "u2"))
    assert [d.id for d in knowledge.list_documents("u1")] == ["d1"]
    assert knowledge.get_document("u2", "d1") is None  # another user's id
    assert knowledge.update_document("u2", "d1", status="ready") is False
    assert knowledge.attach("u2", "d1", "p1") is False
    assert knowledge.delete_document("u2", "d1") is False


def test_library_lists_newest_first_and_filters_by_project(knowledge):
    from datetime import timedelta

    from agentic_platform.stores import _now

    t = _now()
    knowledge.add_document(_kdoc("d1", project_ids=["p1"], created_at=t - timedelta(minutes=2)))
    knowledge.add_document(_kdoc("d2", project_ids=["p1", "p2"], created_at=t - timedelta(minutes=1)))
    knowledge.add_document(_kdoc("d3", created_at=t))  # in no project yet
    assert [d.id for d in knowledge.list_documents("u1")] == ["d3", "d2", "d1"]
    assert [d.id for d in knowledge.list_documents("u1", "p1")] == ["d2", "d1"]
    assert [d.id for d in knowledge.list_documents("u1", "p2")] == ["d2"]


def test_attach_and_detach(knowledge):
    knowledge.add_document(_kdoc("d1"))
    assert knowledge.attach("u1", "d1", "p1") and knowledge.attach("u1", "d1", "p1")  # idempotent
    assert knowledge.attach("u1", "d1", "p2")
    assert knowledge.get_document("u1", "d1").project_ids == ["p1", "p2"]
    assert knowledge.detach("u1", "d1", "p1") is True
    assert knowledge.detach("u1", "d1", "p1") is False
    assert knowledge.get_document("u1", "d1").project_ids == ["p2"]
    assert knowledge.attach("u1", "missing", "p1") is False


def test_deleting_a_project_detaches_without_deleting_files(knowledge):
    knowledge.add_document(_kdoc("d1", project_ids=["p1", "p2"]))
    knowledge.add_document(_kdoc("d2", project_ids=["p1"]))
    knowledge.add_document(_kdoc("d3", project_ids=["p2"]))
    assert knowledge.detach_project("u1", "p1") == 2
    assert {d.id: d.project_ids for d in knowledge.list_documents("u1")} == {"d1": ["p2"], "d2": [], "d3": ["p2"]}


def test_document_status_updates(knowledge):
    knowledge.add_document(_kdoc())
    assert knowledge.update_document("u1", "d1", status="ready", chunk_count=3)
    doc = knowledge.get_document("u1", "d1")
    assert (doc.status, doc.chunk_count) == ("ready", 3)


def test_a_documents_embedding_model_round_trips(knowledge):
    from agentic_platform.agent_schema import EmbeddingConfig

    knowledge.add_document(_kdoc("d1"))  # a file from before per-file models
    assert knowledge.get_document("u1", "d1").embedding is None
    titan = EmbeddingConfig(provider="bedrock", model="amazon.titan-embed-text-v2:0")
    knowledge.add_document(_kdoc("d2", embedding=titan))
    assert knowledge.get_document("u1", "d2").embedding == titan
    openai = EmbeddingConfig(provider="openai", model="text-embedding-3-small")
    assert knowledge.update_document("u1", "d1", embedding=openai)
    assert knowledge.get_document("u1", "d1").embedding == openai


def test_chunks_replace_filter_and_delete_with_their_document(knowledge):
    knowledge.add_document(_kdoc("d1"))
    knowledge.add_document(_kdoc("d2"))
    knowledge.replace_chunks("u1", "d1", [_kchunk("c1", ordinal=0), _kchunk("c2", ordinal=1)])
    knowledge.replace_chunks("u1", "d2", [_kchunk("c3", doc_id="d2")])
    knowledge.replace_chunks("u1", "d1", [_kchunk("c4")])  # replaces c1, c2
    assert sorted(c.id for c in knowledge.chunks_for_documents("u1", ["d1", "d2"])) == ["c3", "c4"]
    assert [c.id for c in knowledge.chunks_for_documents("u1", ["d2"])] == ["c3"]
    assert knowledge.chunks_for_documents("u2", ["d1", "d2"]) == []  # never another user's
    assert knowledge.chunks_for_documents("u1", []) == []
    assert knowledge.delete_document("u1", "d1") is True
    assert [c.id for c in knowledge.chunks_for_documents("u1", ["d1", "d2"])] == ["c3"]


def test_embeddings_can_be_replaced(knowledge):
    knowledge.add_document(_kdoc())
    knowledge.replace_chunks("u1", "d1", [_kchunk("c1")])
    knowledge.set_embeddings("u2", {"c1": [9.0]})  # another user: ignored
    knowledge.set_embeddings("u1", {"c1": [1.0, 0.0, 0.0]})
    assert knowledge.chunks_for_documents("u1", ["d1"])[0].embedding == [1.0, 0.0, 0.0]


def test_library_embedding_setting_round_trips(knowledge):
    from agentic_platform.agent_schema import EmbeddingConfig

    assert knowledge.get_embedding("u1") is None
    config = EmbeddingConfig(provider="google_genai", model="gemini-embedding-001")
    knowledge.set_embedding("u1", config)
    knowledge.set_embedding("u1", config)
    assert knowledge.get_embedding("u1") == config
    assert knowledge.get_embedding("u2") is None


def test_stalled_indexing_is_reported_as_failed():
    from datetime import datetime, timedelta, timezone

    stale = _kdoc(status="processing", updated_at=datetime.now(timezone.utc) - timedelta(hours=1))
    assert stale.effective().status == "failed"
    assert _kdoc(status="processing").effective().status == "processing"


def test_projects_can_be_deleted(store):
    record = _record()
    store.create(record)
    assert store.delete(record.id) is True
    assert store.get(record.id) is None
    assert store.delete(record.id) is False


def test_project_scoped_knowledge_is_migrated_into_libraries():
    """Knowledge stored before libraries (one project per file) joins its owner's library,
    attached to that project, with the project's embedding model."""
    from pymongo.errors import PyMongoError

    from agentic_platform.agent_schema import EmbeddingConfig
    from agentic_platform.stores import MongoKnowledgeStore, _now

    uri = os.environ.get("MONGODB_URI") or "mongodb://localhost:27017"
    db = mongo_database(uri, f"agentic_platform_test_{uuid.uuid4().hex[:8]}", timeout_ms=500)
    try:
        db.client.admin.command("ping")
    except PyMongoError:
        db.client.close()
        pytest.skip("no MongoDB server reachable")
    try:
        embedding = {"provider": "google_genai", "model": "gemini-embedding-001"}
        db["projects"].insert_one({"_id": "p1", "knowledge_embedding": embedding})
        db["knowledge_documents"].insert_one({
            "_id": "d1", "project_id": "p1", "tenant_id": "u1", "filename": "old.pdf", "kind": ".pdf",
            "size_bytes": 5, "status": "ready", "chunk_count": 1, "error": None,
            "created_at": _now(), "updated_at": _now(),
        })
        db["knowledge_chunks"].insert_one({
            "_id": "c1", "project_id": "p1", "document_id": "d1", "ordinal": 0, "text": "t",
            "source": "page 1", "embedding": [1.0],
        })
        knowledge = MongoKnowledgeStore(db)
        assert [(d.id, d.project_ids) for d in knowledge.list_documents("u1")] == [("d1", ["p1"])]
        assert [c.id for c in knowledge.chunks_for_documents("u1", ["d1"])] == ["c1"]
        assert knowledge.get_embedding("u1") == EmbeddingConfig(**embedding)
        assert db["knowledge_documents"].count_documents({"project_id": {"$exists": True}}) == 0
        assert db["knowledge_chunks"].count_documents({"project_id": {"$exists": True}}) == 0
    finally:
        db.client.drop_database(db.name)
        db.client.close()


# ------------------------------------------------------------------ data sources
@pytest.fixture
def sources(backend):
    from agentic_platform.stores import InMemoryDataSourceStore, MongoDataSourceStore

    return InMemoryDataSourceStore() if backend is None else MongoDataSourceStore(backend)


def _source(source_id="s1", tenant_id="u1", **overrides):
    from agentic_platform.stores import DataSource

    fields = dict(id=source_id, tenant_id=tenant_id, name="Warehouse", billing_project="agenticdb-510807",
                  service_account="reader@agenticdb-510807.iam.gserviceaccount.com")
    return DataSource(**{**fields, **overrides})


def test_data_sources_are_scoped_and_updatable(sources):
    from agentic_platform.datasources import AllowedTable

    sources.add(_source())
    sources.add(_source("s2", tenant_id="u2", service_account="other@p-12345.iam.gserviceaccount.com"))
    assert [s.id for s in sources.list("u1")] == ["s1"]
    assert sources.get("u2", "s1") is None  # never another tenant's
    table = AllowedTable(id="agenticdb-510807.mydata.trips", location="US")
    updated = sources.update("u1", "s1", tables=[table], project_ids=["p1"])
    assert updated.tables == [table] and updated.project_ids == ["p1"]
    assert sources.update("u2", "s1", project_ids=[]) is None
    assert [s.id for s in sources.list("u1", "p1")] == ["s1"] and sources.list("u1", "p2") == []
    assert sources.get("u1", "s1").config().table_ids() == {"agenticdb-510807.mydata.trips"}
    assert sources.owner_of_service_account("reader@agenticdb-510807.iam.gserviceaccount.com") == "u1"
    assert sources.owner_of_service_account("nobody@x-12345.iam.gserviceaccount.com") is None
    assert sources.detach_project("u1", "p1") == 1 and sources.get("u1", "s1").project_ids == []
    assert sources.delete("u2", "s1") is False and sources.delete("u1", "s1") is True
    assert sources.list("u1") == []
