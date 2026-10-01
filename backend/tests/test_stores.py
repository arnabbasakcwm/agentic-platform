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
