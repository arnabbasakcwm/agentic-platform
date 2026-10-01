"""Persistence behind small interfaces.

The API layer talks only to `ProjectStore` and `UserStore`, never to a database driver,
so the backing store is swappable (in-memory for tests, MongoDB for real use) without
touching a route. Every project carries the id of the tenant that owns it and a
`plan_version`; the version is what makes the application layer stateless — a process
decides whether its compiled graph is still valid by comparing versions, not by trusting
its own memory.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Iterator, Literal, Protocol

from pydantic import BaseModel, Field

from .agent_schema import AgentPlan
from .config import MONGODB_DB, MONGODB_TIMEOUT_MS, MONGODB_URI
from .errors import EmailTakenError, StoreUnavailableError

if TYPE_CHECKING:
    from pymongo.database import Database


def _now() -> datetime:
    # Millisecond precision, matching what MongoDB stores, so a record reads back equal
    # to what was written regardless of the backing store.
    now = datetime.now(timezone.utc)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


class UserRecord(BaseModel):
    id: str
    # Stored lowercased: it is the login identifier and must be unique case-insensitively.
    email: str
    # An Argon2 hash (see auth.py) — the password itself is never stored or logged.
    password_hash: str
    created_at: datetime = Field(default_factory=_now)


# A project keeps only its most recent chat messages; older ones are dropped.
CONVERSATION_LIMIT = 100


class ChatMessage(BaseModel):
    """One message in a project's planning conversation."""

    role: Literal["user", "assistant"]
    content: str
    created_at: datetime = Field(default_factory=_now)
    # For an assistant reply that changed the project: the plan_version it produced.
    plan_version: int | None = None


DEPLOY_IN_PROGRESS = ("packaging", "uploading", "provisioning")
# An in-progress deployment that hasn't moved for this long was cut off (for example by a
# server restart, since the job runs in-process) and is reported as failed.
DEPLOY_STALE_AFTER = timedelta(minutes=30)


class Deployment(BaseModel):
    """A project's deployment to Amazon Bedrock AgentCore Runtime."""

    status: Literal["packaging", "uploading", "provisioning", "ready", "failed"]
    # The plan version the latest deployment attempt is for.
    plan_version: int
    region: str
    runtime_name: str
    runtime_id: str | None = None
    runtime_arn: str | None = None
    # The plan version actually serving traffic, once a deployment has succeeded. While
    # a redeploy runs (or after one fails) the previous version keeps serving.
    live_plan_version: int | None = None
    error: str | None = None
    started_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
    deployed_at: datetime | None = None

    @property
    def in_progress(self) -> bool:
        return self.status in DEPLOY_IN_PROGRESS

    @property
    def live(self) -> bool:
        return self.runtime_arn is not None and self.live_plan_version is not None

    def effective(self, now: datetime | None = None) -> "Deployment":
        """This record as callers should see it: a stalled in-progress deployment is
        reported as failed rather than spinning forever."""
        now = now or datetime.now(timezone.utc)
        if self.in_progress and now - self.updated_at > DEPLOY_STALE_AFTER:
            return self.model_copy(
                update={
                    "status": "failed",
                    "error": "Interrupted: no progress for 30 minutes (the server may have "
                    "restarted during the deployment). Deploy again.",
                }
            )
        return self


class ProjectRecord(BaseModel):
    id: str
    # The owning user's id. Each user is their own tenant for now.
    tenant_id: str
    brief: str
    plan: AgentPlan
    # Bumped on every plan edit.
    plan_version: int = 1
    # The plan_version that was last compiled; None until the first compile. A project is
    # runnable only while this equals plan_version, so a plan edit invalidates it.
    compiled_version: int | None = None
    side_effect_tools_enabled: list[str] = Field(default_factory=list)
    conversation: list[ChatMessage] = Field(default_factory=list)
    deployment: Deployment | None = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

    @property
    def is_compiled(self) -> bool:
        return self.compiled_version == self.plan_version


class ProjectStore(Protocol):
    def create(self, record: ProjectRecord) -> None: ...

    def get(self, project_id: str) -> ProjectRecord | None: ...

    def list_for_tenant(self, tenant_id: str) -> list[ProjectRecord]:
        """Every project the tenant owns, most recently updated first."""
        ...

    def update_plan(self, project_id: str, plan: AgentPlan) -> ProjectRecord | None:
        """Replace the plan and bump plan_version. None if the project doesn't exist."""
        ...

    def mark_compiled(self, project_id: str, plan_version: int) -> bool:
        """Record that `plan_version` was compiled. False if the plan has moved on since
        (or the project is gone), so a stale compile never marks a newer plan runnable."""
        ...

    def set_deployment(self, project_id: str, deployment: Deployment | None) -> bool:
        """Replace (or with None, clear) the project's deployment record. False if the
        project is gone."""
        ...

    def record_exchange(
        self,
        project_id: str,
        expected_version: int,
        messages: list[ChatMessage],
        brief: str | None = None,
        plan: AgentPlan | None = None,
    ) -> ProjectRecord | None:
        """Append chat messages and, if given, replace the brief and plan (bumping
        plan_version) — all in one write, and only if the plan is still at
        `expected_version`. None if it has moved on or the project is gone, so a revision
        computed from a stale plan is never saved over a newer one."""
        ...


class UserStore(Protocol):
    def create(self, record: UserRecord) -> None:
        """Raises EmailTakenError if the email is already registered."""
        ...

    def get(self, user_id: str) -> UserRecord | None: ...

    def get_by_email(self, email: str) -> UserRecord | None: ...


class InMemoryProjectStore:
    """Process-local store: the no-database fallback, and what the offline tests use."""

    def __init__(self) -> None:
        self._records: dict[str, ProjectRecord] = {}

    def create(self, record: ProjectRecord) -> None:
        self._records[record.id] = record.model_copy(deep=True)

    def get(self, project_id: str) -> ProjectRecord | None:
        record = self._records.get(project_id)
        return record.model_copy(deep=True) if record else None

    def list_for_tenant(self, tenant_id: str) -> list[ProjectRecord]:
        owned = [r for r in self._records.values() if r.tenant_id == tenant_id]
        owned.sort(key=lambda r: r.updated_at, reverse=True)
        return [r.model_copy(deep=True) for r in owned]

    def update_plan(self, project_id: str, plan: AgentPlan) -> ProjectRecord | None:
        record = self._records.get(project_id)
        if record is None:
            return None
        record.plan = plan.model_copy(deep=True)
        record.plan_version += 1
        record.updated_at = _now()
        return record.model_copy(deep=True)

    def mark_compiled(self, project_id: str, plan_version: int) -> bool:
        record = self._records.get(project_id)
        if record is None or record.plan_version != plan_version:
            return False
        record.compiled_version = plan_version
        record.updated_at = _now()
        return True

    def record_exchange(
        self,
        project_id: str,
        expected_version: int,
        messages: list[ChatMessage],
        brief: str | None = None,
        plan: AgentPlan | None = None,
    ) -> ProjectRecord | None:
        record = self._records.get(project_id)
        if record is None or record.plan_version != expected_version:
            return None
        if brief is not None:
            record.brief = brief
        if plan is not None:
            record.plan = plan.model_copy(deep=True)
        if brief is not None or plan is not None:
            record.plan_version += 1
        record.conversation = [*record.conversation, *messages][-CONVERSATION_LIMIT:]
        record.updated_at = _now()
        return record.model_copy(deep=True)

    def set_deployment(self, project_id: str, deployment: Deployment | None) -> bool:
        record = self._records.get(project_id)
        if record is None:
            return False
        record.deployment = deployment.model_copy() if deployment else None
        return True


@contextmanager
def _mongo_errors() -> Iterator[None]:
    """Translate driver failures into the platform's typed error. Only the exception type
    is carried over — driver messages can include the connection string."""
    from pymongo.errors import PyMongoError

    try:
        yield
    except PyMongoError as e:
        raise StoreUnavailableError(type(e).__name__) from e


class InMemoryUserStore:
    def __init__(self) -> None:
        self._records: dict[str, UserRecord] = {}

    def create(self, record: UserRecord) -> None:
        if self.get_by_email(record.email) is not None:
            raise EmailTakenError()
        self._records[record.id] = record.model_copy()

    def get(self, user_id: str) -> UserRecord | None:
        record = self._records.get(user_id)
        return record.model_copy() if record else None

    def get_by_email(self, email: str) -> UserRecord | None:
        for record in self._records.values():
            if record.email == email:
                return record.model_copy()
        return None


def mongo_database(
    uri: str, db_name: str, timeout_ms: int = MONGODB_TIMEOUT_MS
) -> "Database":
    """One client (and its connection pool) shared by every Mongo-backed store."""
    from pymongo import MongoClient

    # Constructing the client does not connect; the first operation does, bounded by the
    # server-selection timeout. tz_aware so datetimes read back as UTC-aware.
    return MongoClient(uri, serverSelectionTimeoutMS=timeout_ms, tz_aware=True)[db_name]


class MongoProjectStore:
    """MongoDB-backed store: one document per project in the `projects` collection,
    with the project id as `_id`."""

    def __init__(self, db: "Database"):
        self._projects = db["projects"]
        self._index_ready = False

    @staticmethod
    def _to_doc(record: ProjectRecord) -> dict[str, Any]:
        doc = record.model_dump()
        doc["_id"] = doc.pop("id")
        return doc

    @staticmethod
    def _from_doc(doc: dict[str, Any]) -> ProjectRecord:
        # Re-validated on the way out: stored data is not trusted to still be a valid
        # plan just because it was one when written.
        doc = dict(doc)
        doc["id"] = doc.pop("_id")
        return ProjectRecord.model_validate(doc)

    def create(self, record: ProjectRecord) -> None:
        with _mongo_errors():
            self._projects.insert_one(self._to_doc(record))

    def get(self, project_id: str) -> ProjectRecord | None:
        with _mongo_errors():
            doc = self._projects.find_one({"_id": project_id})
        return self._from_doc(doc) if doc else None

    def list_for_tenant(self, tenant_id: str) -> list[ProjectRecord]:
        with _mongo_errors():
            if not self._index_ready:
                self._projects.create_index([("tenant_id", 1), ("updated_at", -1)])
                self._index_ready = True
            docs = list(
                self._projects.find({"tenant_id": tenant_id}).sort("updated_at", -1)
            )
        return [self._from_doc(doc) for doc in docs]

    def update_plan(self, project_id: str, plan: AgentPlan) -> ProjectRecord | None:
        from pymongo import ReturnDocument

        with _mongo_errors():
            doc = self._projects.find_one_and_update(
                {"_id": project_id},
                {
                    "$set": {"plan": plan.model_dump(), "updated_at": _now()},
                    "$inc": {"plan_version": 1},
                },
                return_document=ReturnDocument.AFTER,
            )
        return self._from_doc(doc) if doc else None

    def mark_compiled(self, project_id: str, plan_version: int) -> bool:
        with _mongo_errors():
            result = self._projects.update_one(
                {"_id": project_id, "plan_version": plan_version},
                {"$set": {"compiled_version": plan_version, "updated_at": _now()}},
            )
        return result.matched_count == 1

    def record_exchange(
        self,
        project_id: str,
        expected_version: int,
        messages: list[ChatMessage],
        brief: str | None = None,
        plan: AgentPlan | None = None,
    ) -> ProjectRecord | None:
        from pymongo import ReturnDocument

        changes: dict[str, Any] = {"updated_at": _now()}
        if brief is not None:
            changes["brief"] = brief
        if plan is not None:
            changes["plan"] = plan.model_dump()
        update: dict[str, Any] = {
            "$set": changes,
            "$push": {
                "conversation": {
                    "$each": [m.model_dump() for m in messages],
                    "$slice": -CONVERSATION_LIMIT,
                }
            },
        }
        if brief is not None or plan is not None:
            update["$inc"] = {"plan_version": 1}
        with _mongo_errors():
            doc = self._projects.find_one_and_update(
                {"_id": project_id, "plan_version": expected_version},
                update,
                return_document=ReturnDocument.AFTER,
            )
        return self._from_doc(doc) if doc else None

    def set_deployment(self, project_id: str, deployment: Deployment | None) -> bool:
        value = deployment.model_dump() if deployment else None
        with _mongo_errors():
            result = self._projects.update_one(
                {"_id": project_id}, {"$set": {"deployment": value}}
            )
        return result.matched_count == 1


class MongoUserStore:
    """One document per user in the `users` collection, user id as `_id`. A unique index
    on `email` is what actually guarantees one account per address — a check-then-insert
    would let two simultaneous registrations both succeed."""

    def __init__(self, db: "Database"):
        self._users = db["users"]
        self._index_ready = False

    @staticmethod
    def _from_doc(doc: dict[str, Any]) -> UserRecord:
        doc = dict(doc)
        doc["id"] = doc.pop("_id")
        return UserRecord.model_validate(doc)

    def create(self, record: UserRecord) -> None:
        from pymongo.errors import DuplicateKeyError

        doc = record.model_dump()
        doc["_id"] = doc.pop("id")
        with _mongo_errors():
            if not self._index_ready:
                self._users.create_index("email", unique=True)
                self._index_ready = True
            try:
                self._users.insert_one(doc)
            except DuplicateKeyError:
                raise EmailTakenError() from None

    def get(self, user_id: str) -> UserRecord | None:
        with _mongo_errors():
            doc = self._users.find_one({"_id": user_id})
        return self._from_doc(doc) if doc else None

    def get_by_email(self, email: str) -> UserRecord | None:
        with _mongo_errors():
            doc = self._users.find_one({"email": email})
        return self._from_doc(doc) if doc else None


def make_stores() -> tuple[ProjectStore, UserStore]:
    """MongoDB when MONGODB_URI is configured, otherwise the in-memory fallback."""
    if MONGODB_URI:
        db = mongo_database(MONGODB_URI, MONGODB_DB)
        return MongoProjectStore(db), MongoUserStore(db)
    return InMemoryProjectStore(), InMemoryUserStore()
