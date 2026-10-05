"""Persistence behind small interfaces.

The API layer talks only to `ProjectStore`, `UserStore` and `KnowledgeStore`, never to a
database driver,
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

from .agent_schema import AgentPlan, EmbeddingConfig
from .knowledge import KnowledgeChunk
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
    # The runtime prints a usage line per invocation (runtimes deployed before that
    # didn't), and how far the platform has read those lines from CloudWatch.
    reports_usage: bool = False
    usage_synced_until: datetime | None = None

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


KNOWLEDGE_IN_PROGRESS = ("queued", "processing")
# A document still queued or processing after this long was cut off (the indexing job
# runs in-process, so a restart ends it) and is reported as failed.
KNOWLEDGE_STALE_AFTER = timedelta(minutes=30)


class KnowledgeDocument(BaseModel):
    """One uploaded file in a user's knowledge library. The file itself isn't kept — only
    the passages extracted from it (KnowledgeChunk). It is indexed once and can be attached
    to any number of the user's projects; a project's agents search only the files
    attached to it."""

    id: str
    tenant_id: str
    project_ids: list[str] = Field(default_factory=list)
    filename: str
    kind: str  # file extension, e.g. ".pdf"
    size_bytes: int
    status: Literal["queued", "processing", "ready", "failed"] = "queued"
    error: str | None = None
    chunk_count: int = 0
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

    def effective(self, now: datetime | None = None) -> "KnowledgeDocument":
        now = now or datetime.now(timezone.utc)
        if self.status in KNOWLEDGE_IN_PROGRESS and now - self.updated_at > KNOWLEDGE_STALE_AFTER:
            return self.model_copy(
                update={
                    "status": "failed",
                    "error": "Interrupted: indexing stopped making progress (the server may "
                    "have restarted). Delete the file and upload it again.",
                }
            )
        return self


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


    def delete(self, project_id: str) -> bool:
        """Remove the project. False if it didn't exist."""
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


    def delete(self, project_id: str) -> bool:
        return self._records.pop(project_id, None) is not None


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


    def delete(self, project_id: str) -> bool:
        with _mongo_errors():
            result = self._projects.delete_one({"_id": project_id})
        return result.deleted_count == 1


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


# ---------------------------------------------------------------------------- knowledge
class KnowledgeStore(Protocol):
    """Each user's knowledge library: documents, their passages, which projects each
    document is attached to, and the library's embedding model. Every method is scoped by
    tenant id, so one user can never read or change another's library."""

    def add_document(self, doc: KnowledgeDocument) -> None: ...

    def get_document(self, tenant_id: str, document_id: str) -> KnowledgeDocument | None: ...

    def list_documents(self, tenant_id: str, project_id: str | None = None) -> list[KnowledgeDocument]:
        """The library newest first, or only the documents attached to `project_id`."""
        ...

    def update_document(self, tenant_id: str, document_id: str, **changes: Any) -> bool: ...

    def attach(self, tenant_id: str, document_id: str, project_id: str) -> bool:
        """Attach a document to a project (no-op if already attached). False if no such document."""
        ...

    def detach(self, tenant_id: str, document_id: str, project_id: str) -> bool:
        """Detach a document from a project. False if it wasn't attached."""
        ...

    def detach_project(self, tenant_id: str, project_id: str) -> int:
        """Detach every document from a project (when it is deleted); returns how many."""
        ...

    def replace_chunks(self, tenant_id: str, document_id: str, chunks: list[KnowledgeChunk]) -> None:
        """Set a document's passages, replacing any it had."""
        ...

    def delete_document(self, tenant_id: str, document_id: str) -> bool:
        """Remove a document and its passages from the library. False if it didn't exist."""
        ...

    def chunks_for_documents(self, tenant_id: str, document_ids: list[str]) -> list[KnowledgeChunk]:
        """Passages of these documents, in document order."""
        ...

    def set_embeddings(self, tenant_id: str, embeddings: dict[str, list[float]]) -> None:
        """Replace the embeddings of these passages (by passage id)."""
        ...

    def get_embedding(self, tenant_id: str) -> EmbeddingConfig | None:
        """The library's embedding model, or None before the first upload."""
        ...

    def set_embedding(self, tenant_id: str, config: EmbeddingConfig) -> None: ...


class InMemoryKnowledgeStore:
    def __init__(self) -> None:
        self._docs: dict[str, KnowledgeDocument] = {}
        self._chunks: dict[str, KnowledgeChunk] = {}
        self._embeddings: dict[str, EmbeddingConfig] = {}

    def _own(self, tenant_id: str, document_id: str) -> KnowledgeDocument | None:
        doc = self._docs.get(document_id)
        return doc if doc is not None and doc.tenant_id == tenant_id else None

    def add_document(self, doc: KnowledgeDocument) -> None:
        self._docs[doc.id] = doc.model_copy(deep=True)

    def get_document(self, tenant_id: str, document_id: str) -> KnowledgeDocument | None:
        doc = self._own(tenant_id, document_id)
        return doc.model_copy(deep=True) if doc else None

    def list_documents(self, tenant_id: str, project_id: str | None = None) -> list[KnowledgeDocument]:
        docs = [
            d for d in self._docs.values()
            if d.tenant_id == tenant_id and (project_id is None or project_id in d.project_ids)
        ]
        return [d.model_copy(deep=True) for d in sorted(docs, key=lambda d: d.created_at, reverse=True)]

    def update_document(self, tenant_id: str, document_id: str, **changes: Any) -> bool:
        doc = self._own(tenant_id, document_id)
        if doc is None:
            return False
        self._docs[document_id] = doc.model_copy(update={**changes, "updated_at": _now()})
        return True

    def attach(self, tenant_id: str, document_id: str, project_id: str) -> bool:
        doc = self._own(tenant_id, document_id)
        if doc is None:
            return False
        if project_id not in doc.project_ids:
            doc.project_ids = [*doc.project_ids, project_id]
        return True

    def detach(self, tenant_id: str, document_id: str, project_id: str) -> bool:
        doc = self._own(tenant_id, document_id)
        if doc is None or project_id not in doc.project_ids:
            return False
        doc.project_ids = [p for p in doc.project_ids if p != project_id]
        return True

    def detach_project(self, tenant_id: str, project_id: str) -> int:
        count = 0
        for doc in self._docs.values():
            if doc.tenant_id == tenant_id and project_id in doc.project_ids:
                doc.project_ids = [p for p in doc.project_ids if p != project_id]
                count += 1
        return count

    def replace_chunks(self, tenant_id: str, document_id: str, chunks: list[KnowledgeChunk]) -> None:
        for cid in [c.id for c in self._chunks.values() if c.tenant_id == tenant_id and c.document_id == document_id]:
            del self._chunks[cid]
        for c in chunks:
            self._chunks[c.id] = c.model_copy()

    def delete_document(self, tenant_id: str, document_id: str) -> bool:
        if self._own(tenant_id, document_id) is None:
            return False
        del self._docs[document_id]
        self.replace_chunks(tenant_id, document_id, [])
        return True

    def chunks_for_documents(self, tenant_id: str, document_ids: list[str]) -> list[KnowledgeChunk]:
        wanted = set(document_ids)
        chunks = [c for c in self._chunks.values() if c.tenant_id == tenant_id and c.document_id in wanted]
        return [c.model_copy() for c in sorted(chunks, key=lambda c: (c.document_id, c.ordinal))]

    def set_embeddings(self, tenant_id: str, embeddings: dict[str, list[float]]) -> None:
        for cid, vector in embeddings.items():
            chunk = self._chunks.get(cid)
            if chunk is not None and chunk.tenant_id == tenant_id:
                self._chunks[cid] = chunk.model_copy(update={"embedding": list(vector)})

    def get_embedding(self, tenant_id: str) -> EmbeddingConfig | None:
        config = self._embeddings.get(tenant_id)
        return config.model_copy() if config else None

    def set_embedding(self, tenant_id: str, config: EmbeddingConfig) -> None:
        self._embeddings[tenant_id] = config.model_copy()


class MongoKnowledgeStore:
    """`knowledge_documents` (one per file), `knowledge_chunks` (one per passage) and
    `knowledge_settings` (one per user: the library's embedding model), each keyed by
    tenant."""

    def __init__(self, db: "Database"):
        self._db = db
        self._docs = db["knowledge_documents"]
        self._chunks = db["knowledge_chunks"]
        self._settings = db["knowledge_settings"]
        self._ready = False

    def _ensure_ready(self) -> None:
        if self._ready:
            return
        self._migrate_project_scoped()
        self._docs.create_index([("tenant_id", 1), ("created_at", -1)])
        self._docs.create_index([("tenant_id", 1), ("project_ids", 1)])
        self._chunks.create_index([("tenant_id", 1), ("document_id", 1), ("ordinal", 1)])
        self._ready = True

    def _migrate_project_scoped(self) -> None:
        """One-time upgrade of knowledge stored before libraries existed, when each file
        belonged to one project: the file joins its owner's library attached to that
        project, its passages are keyed by owner, and the owner's library takes the
        embedding model the project used. Idempotent; a no-op once nothing is left."""
        for doc in self._docs.find({"project_id": {"$exists": True}}):
            project_id, tenant_id = doc["project_id"], doc["tenant_id"]
            self._docs.update_one(
                {"_id": doc["_id"]},
                {"$set": {"project_ids": [project_id]}, "$unset": {"project_id": ""}},
            )
            self._chunks.update_many(
                {"document_id": doc["_id"]},
                {"$set": {"tenant_id": tenant_id}, "$unset": {"project_id": ""}},
            )
            if self._settings.find_one({"_id": tenant_id}) is None:
                project = self._db["projects"].find_one({"_id": project_id}, {"knowledge_embedding": 1})
                embedding = (project or {}).get("knowledge_embedding")
                if embedding:
                    self._settings.update_one(
                        {"_id": tenant_id}, {"$setOnInsert": {"embedding": embedding}}, upsert=True
                    )

    @staticmethod
    def _out(model, doc: dict[str, Any]):
        doc = dict(doc)
        doc["id"] = doc.pop("_id")
        return model.model_validate(doc)

    @staticmethod
    def _in(model: BaseModel) -> dict[str, Any]:
        body = model.model_dump()
        body["_id"] = body.pop("id")
        return body

    def add_document(self, doc: KnowledgeDocument) -> None:
        with _mongo_errors():
            self._ensure_ready()
            self._docs.insert_one(self._in(doc))

    def get_document(self, tenant_id: str, document_id: str) -> KnowledgeDocument | None:
        with _mongo_errors():
            self._ensure_ready()
            doc = self._docs.find_one({"_id": document_id, "tenant_id": tenant_id})
        return self._out(KnowledgeDocument, doc) if doc else None

    def list_documents(self, tenant_id: str, project_id: str | None = None) -> list[KnowledgeDocument]:
        query: dict[str, Any] = {"tenant_id": tenant_id}
        if project_id is not None:
            query["project_ids"] = project_id
        with _mongo_errors():
            self._ensure_ready()
            docs = list(self._docs.find(query).sort("created_at", -1))
        return [self._out(KnowledgeDocument, d) for d in docs]

    def update_document(self, tenant_id: str, document_id: str, **changes: Any) -> bool:
        with _mongo_errors():
            result = self._docs.update_one(
                {"_id": document_id, "tenant_id": tenant_id},
                {"$set": {**changes, "updated_at": _now()}},
            )
        return result.matched_count == 1

    def attach(self, tenant_id: str, document_id: str, project_id: str) -> bool:
        with _mongo_errors():
            result = self._docs.update_one(
                {"_id": document_id, "tenant_id": tenant_id}, {"$addToSet": {"project_ids": project_id}}
            )
        return result.matched_count == 1

    def detach(self, tenant_id: str, document_id: str, project_id: str) -> bool:
        with _mongo_errors():
            result = self._docs.update_one(
                {"_id": document_id, "tenant_id": tenant_id, "project_ids": project_id},
                {"$pull": {"project_ids": project_id}},
            )
        return result.matched_count == 1

    def detach_project(self, tenant_id: str, project_id: str) -> int:
        with _mongo_errors():
            result = self._docs.update_many(
                {"tenant_id": tenant_id, "project_ids": project_id}, {"$pull": {"project_ids": project_id}}
            )
        return result.modified_count

    def replace_chunks(self, tenant_id: str, document_id: str, chunks: list[KnowledgeChunk]) -> None:
        with _mongo_errors():
            self._ensure_ready()
            self._chunks.delete_many({"tenant_id": tenant_id, "document_id": document_id})
            if chunks:
                self._chunks.insert_many([self._in(c) for c in chunks], ordered=False)

    def delete_document(self, tenant_id: str, document_id: str) -> bool:
        with _mongo_errors():
            result = self._docs.delete_one({"_id": document_id, "tenant_id": tenant_id})
            if result.deleted_count:
                self._chunks.delete_many({"tenant_id": tenant_id, "document_id": document_id})
        return result.deleted_count == 1

    def chunks_for_documents(self, tenant_id: str, document_ids: list[str]) -> list[KnowledgeChunk]:
        if not document_ids:
            return []
        with _mongo_errors():
            self._ensure_ready()
            docs = list(
                self._chunks.find({"tenant_id": tenant_id, "document_id": {"$in": document_ids}})
                .sort([("document_id", 1), ("ordinal", 1)])
            )
        return [self._out(KnowledgeChunk, d) for d in docs]

    def set_embeddings(self, tenant_id: str, embeddings: dict[str, list[float]]) -> None:
        from pymongo import UpdateOne

        ops = [
            UpdateOne({"_id": cid, "tenant_id": tenant_id}, {"$set": {"embedding": vector}})
            for cid, vector in embeddings.items()
        ]
        if ops:
            with _mongo_errors():
                self._chunks.bulk_write(ops, ordered=False)

    def get_embedding(self, tenant_id: str) -> EmbeddingConfig | None:
        with _mongo_errors():
            self._ensure_ready()
            doc = self._settings.find_one({"_id": tenant_id})
        return EmbeddingConfig.model_validate(doc["embedding"]) if doc and doc.get("embedding") else None

    def set_embedding(self, tenant_id: str, config: EmbeddingConfig) -> None:
        with _mongo_errors():
            self._settings.update_one(
                {"_id": tenant_id}, {"$set": {"embedding": config.model_dump()}}, upsert=True
            )


# ---------------------------------------------------------------------------- usage
UsageKind = Literal["run", "deployed_run", "planner", "assistant", "embedding_index", "embedding_query"]


class UsageRecord(BaseModel):
    """Tokens one model used for one piece of work, with the cost estimated when it was
    recorded (the price is kept, so later edits to the price table don't rewrite history)."""

    id: str
    tenant_id: str
    project_id: str | None = None
    at: datetime = Field(default_factory=_now)
    kind: UsageKind
    run_id: str | None = None  # groups the records of one run / planner call / indexing job
    agent_id: str | None = None
    provider: str
    model: str
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    estimated: bool = False  # tokens estimated, not reported by the provider (embeddings)
    cost: float | None = None  # None: the model has no price in pricing.json
    currency: str = "USD"
    price: dict[str, Any] | None = None
    # For deployed runs: invoked through this platform, or straight through AWS.
    via: Literal["platform", "direct"] | None = None


class UsageStore(Protocol):
    """Usage history, per tenant. Append-only."""

    def add_many(self, records: list[UsageRecord]) -> None: ...

    def list(self, tenant_id: str, since: datetime, project_id: str | None = None) -> list[UsageRecord]:
        """The tenant's records since `since`, oldest first."""
        ...

    def existing_run_ids(self, tenant_id: str, run_ids: list[str]) -> set[str]:
        """Which of these run ids already have records (so a sync never counts twice)."""
        ...


class InMemoryUsageStore:
    def __init__(self) -> None:
        self._records: list[UsageRecord] = []

    def add_many(self, records: list[UsageRecord]) -> None:
        self._records.extend(r.model_copy() for r in records)

    def list(self, tenant_id: str, since: datetime, project_id: str | None = None) -> list[UsageRecord]:
        found = [
            r for r in self._records
            if r.tenant_id == tenant_id and r.at >= since and (project_id is None or r.project_id == project_id)
        ]
        return [r.model_copy() for r in sorted(found, key=lambda r: r.at)]

    def existing_run_ids(self, tenant_id: str, run_ids: list[str]) -> set[str]:
        wanted = set(run_ids)
        return {r.run_id for r in self._records if r.tenant_id == tenant_id and r.run_id in wanted}


class MongoUsageStore:
    """`usage_events`, one document per record, indexed by tenant and time. Totals are
    computed in Python over the requested range (plain CRUD, portable to DocumentDB)."""

    def __init__(self, db: "Database"):
        self._events = db["usage_events"]
        self._index_ready = False

    def _ensure_index(self) -> None:
        if not self._index_ready:
            self._events.create_index([("tenant_id", 1), ("at", 1)])
            self._events.create_index([("tenant_id", 1), ("run_id", 1)])
            self._index_ready = True

    def add_many(self, records: list[UsageRecord]) -> None:
        if not records:
            return
        docs = []
        for r in records:
            body = r.model_dump()
            body["_id"] = body.pop("id")
            docs.append(body)
        with _mongo_errors():
            self._ensure_index()
            self._events.insert_many(docs, ordered=False)

    def list(self, tenant_id: str, since: datetime, project_id: str | None = None) -> list[UsageRecord]:
        query: dict[str, Any] = {"tenant_id": tenant_id, "at": {"$gte": since}}
        if project_id is not None:
            query["project_id"] = project_id
        with _mongo_errors():
            self._ensure_index()
            docs = list(self._events.find(query).sort("at", 1))
        out = []
        for d in docs:
            d["id"] = d.pop("_id")
            out.append(UsageRecord.model_validate(d))
        return out

    def existing_run_ids(self, tenant_id: str, run_ids: list[str]) -> set[str]:
        if not run_ids:
            return set()
        with _mongo_errors():
            self._ensure_index()
            found = self._events.distinct("run_id", {"tenant_id": tenant_id, "run_id": {"$in": list(run_ids)}})
        return set(found)


def make_stores() -> tuple[ProjectStore, UserStore, KnowledgeStore, UsageStore]:
    """MongoDB when MONGODB_URI is configured, otherwise the in-memory fallback."""
    if MONGODB_URI:
        db = mongo_database(MONGODB_URI, MONGODB_DB)
        return MongoProjectStore(db), MongoUserStore(db), MongoKnowledgeStore(db), MongoUsageStore(db)
    return InMemoryProjectStore(), InMemoryUserStore(), InMemoryKnowledgeStore(), InMemoryUsageStore()
