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

import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Iterator, Literal, Protocol

from pydantic import BaseModel, Field, model_validator

from .agent_schema import AgentPlan, EmbeddingConfig
from .datasources import DataSourceConfig
from .knowledge import KnowledgeChunk
from .mcp_client import McpToolDef
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


PROJECT_NAME_MAX = 100
TITLE_MAX = 72


def brief_title(brief: str, limit: int = TITLE_MAX) -> str:
    """A project without a name is called by its brief's first line (as the console does)."""
    first = (brief or "").strip().split("\n")[0].strip()
    if not first:
        return "Untitled project"
    return first if len(first) <= limit else first[: limit - 1].rstrip() + "…"


class ProjectRecord(BaseModel):
    id: str
    # The owning user's id. Each user is their own tenant for now.
    tenant_id: str
    brief: str
    plan: AgentPlan
    # The name the user gave the project; None until they do (display_name falls back to
    # the brief's first line).
    name: str | None = Field(default=None, max_length=PROJECT_NAME_MAX)
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

    @property
    def display_name(self) -> str:
        return self.name or brief_title(self.brief)


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
    # The model the file is indexed with. None for files indexed before each file had
    # its own model: those use the library default (knowledge.effective_embedding).
    embedding: EmbeddingConfig | None = None
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

    def update_plan(
        self, project_id: str, plan: AgentPlan, side_effect_tools_enabled: list[str] | None = None
    ) -> ProjectRecord | None:
        """Replace the plan and bump plan_version — and, if given, the project's external-tool
        opt-ins, in the same write. None if the project doesn't exist."""
        ...

    def mark_compiled(self, project_id: str, plan_version: int) -> bool:
        """Record that `plan_version` was compiled. False if the plan has moved on since
        (or the project is gone), so a stale compile never marks a newer plan runnable."""
        ...

    def set_deployment(self, project_id: str, deployment: Deployment | None) -> bool:
        """Replace (or with None, clear) the project's deployment record. False if the
        project is gone."""
        ...

    def rename(self, project_id: str, name: str | None) -> ProjectRecord | None:
        """Set (or with None, clear) the project's name. Doesn't change the plan or its
        version. None if the project is gone."""
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

    def update_plan(
        self, project_id: str, plan: AgentPlan, side_effect_tools_enabled: list[str] | None = None
    ) -> ProjectRecord | None:
        record = self._records.get(project_id)
        if record is None:
            return None
        if side_effect_tools_enabled is not None:
            record.side_effect_tools_enabled = list(side_effect_tools_enabled)
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

    def rename(self, project_id: str, name: str | None) -> ProjectRecord | None:
        record = self._records.get(project_id)
        if record is None:
            return None
        record.name = name
        record.updated_at = _now()
        return record.model_copy(deep=True)


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

    def update_plan(
        self, project_id: str, plan: AgentPlan, side_effect_tools_enabled: list[str] | None = None
    ) -> ProjectRecord | None:
        from pymongo import ReturnDocument

        changes: dict[str, Any] = {"plan": plan.model_dump(), "updated_at": _now()}
        if side_effect_tools_enabled is not None:
            changes["side_effect_tools_enabled"] = list(side_effect_tools_enabled)
        with _mongo_errors():
            doc = self._projects.find_one_and_update(
                {"_id": project_id},
                {
                    "$set": changes,
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

    def rename(self, project_id: str, name: str | None) -> ProjectRecord | None:
        from pymongo import ReturnDocument

        with _mongo_errors():
            doc = self._projects.find_one_and_update(
                {"_id": project_id},
                {"$set": {"name": name, "updated_at": _now()}},
                return_document=ReturnDocument.AFTER,
            )
        return self._from_doc(doc) if doc else None


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
        """The library's default embedding model for new uploads, or None before the first."""
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
                {"$set": {
                    **{k: v.model_dump() if isinstance(v, BaseModel) else v for k, v in changes.items()},
                    "updated_at": _now(),
                }},
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
UsageKind = Literal[
    "run", "deployed_run", "planner", "assistant", "embedding_index", "embedding_query", "bigquery_query", "mcp_call",
    "model_check",
]


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
    bytes_billed: int = 0  # data queries (BigQuery): bytes the query was billed for
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


# ---------------------------------------------------------------------------- data sources
class DataSource(DataSourceConfig):
    """A user's connection to BigQuery: one service account, the tables agents may query,
    and the projects whose agents may use it (attaching is the per-project opt-in)."""

    tenant_id: str
    project_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

    def config(self) -> DataSourceConfig:
        return DataSourceConfig.model_validate(self.model_dump(include=set(DataSourceConfig.model_fields)))


class DataSourceStore(Protocol):
    """Users' data sources. Every method is scoped by tenant."""

    def add(self, source: DataSource) -> None: ...

    def get(self, tenant_id: str, source_id: str) -> DataSource | None: ...

    def list(self, tenant_id: str, project_id: str | None = None) -> list[DataSource]:
        """The tenant's sources, newest first; with `project_id`, those attached to it."""
        ...

    def update(self, tenant_id: str, source_id: str, **changes: Any) -> DataSource | None: ...

    def delete(self, tenant_id: str, source_id: str) -> bool: ...

    def detach_project(self, tenant_id: str, project_id: str) -> int: ...

    def owner_of_service_account(self, service_account: str) -> str | None:
        """The tenant that registered this service account, if any (one tenant each)."""
        ...


class InMemoryDataSourceStore:
    def __init__(self) -> None:
        self._sources: dict[str, DataSource] = {}

    def add(self, source: DataSource) -> None:
        self._sources[source.id] = source.model_copy(deep=True)

    def get(self, tenant_id: str, source_id: str) -> DataSource | None:
        s = self._sources.get(source_id)
        return s.model_copy(deep=True) if s and s.tenant_id == tenant_id else None

    def list(self, tenant_id: str, project_id: str | None = None) -> list[DataSource]:
        found = [
            s for s in self._sources.values()
            if s.tenant_id == tenant_id and (project_id is None or project_id in s.project_ids)
        ]
        return [s.model_copy(deep=True) for s in sorted(found, key=lambda s: s.created_at, reverse=True)]

    def update(self, tenant_id: str, source_id: str, **changes: Any) -> DataSource | None:
        s = self._sources.get(source_id)
        if s is None or s.tenant_id != tenant_id:
            return None
        updated = DataSource.model_validate({**s.model_dump(), **_plain(changes), "updated_at": _now()})
        self._sources[source_id] = updated
        return updated.model_copy(deep=True)

    def delete(self, tenant_id: str, source_id: str) -> bool:
        s = self._sources.get(source_id)
        if s is None or s.tenant_id != tenant_id:
            return False
        del self._sources[source_id]
        return True

    def detach_project(self, tenant_id: str, project_id: str) -> int:
        count = 0
        for s in self._sources.values():
            if s.tenant_id == tenant_id and project_id in s.project_ids:
                s.project_ids = [p for p in s.project_ids if p != project_id]
                count += 1
        return count

    def owner_of_service_account(self, service_account: str) -> str | None:
        return next((s.tenant_id for s in self._sources.values() if s.service_account == service_account), None)


def _plain(changes: dict[str, Any]) -> dict[str, Any]:
    def dump(v: Any) -> Any:
        if isinstance(v, BaseModel):
            return v.model_dump()
        if isinstance(v, list):
            return [dump(x) for x in v]
        return v

    return {k: dump(v) for k, v in changes.items()}


class MongoDataSourceStore:
    """`data_sources`, one document per source, keyed by tenant."""

    def __init__(self, db: "Database"):
        self._sources = db["data_sources"]
        self._ready = False

    def _ensure_ready(self) -> None:
        if not self._ready:
            self._sources.create_index([("tenant_id", 1), ("created_at", -1)])
            self._sources.create_index([("service_account", 1)])
            self._ready = True

    @staticmethod
    def _out(doc: dict[str, Any]) -> DataSource:
        doc = dict(doc)
        doc["id"] = doc.pop("_id")
        return DataSource.model_validate(doc)

    def add(self, source: DataSource) -> None:
        body = source.model_dump()
        body["_id"] = body.pop("id")
        with _mongo_errors():
            self._ensure_ready()
            self._sources.insert_one(body)

    def get(self, tenant_id: str, source_id: str) -> DataSource | None:
        with _mongo_errors():
            self._ensure_ready()
            doc = self._sources.find_one({"_id": source_id, "tenant_id": tenant_id})
        return self._out(doc) if doc else None

    def list(self, tenant_id: str, project_id: str | None = None) -> list[DataSource]:
        query: dict[str, Any] = {"tenant_id": tenant_id}
        if project_id is not None:
            query["project_ids"] = project_id
        with _mongo_errors():
            self._ensure_ready()
            docs = list(self._sources.find(query).sort("created_at", -1))
        return [self._out(d) for d in docs]

    def update(self, tenant_id: str, source_id: str, **changes: Any) -> DataSource | None:
        with _mongo_errors():
            self._ensure_ready()
            result = self._sources.update_one(
                {"_id": source_id, "tenant_id": tenant_id},
                {"$set": {**_plain(changes), "updated_at": _now()}},
            )
        return self.get(tenant_id, source_id) if result.matched_count == 1 else None

    def delete(self, tenant_id: str, source_id: str) -> bool:
        with _mongo_errors():
            result = self._sources.delete_one({"_id": source_id, "tenant_id": tenant_id})
        return result.deleted_count == 1

    def detach_project(self, tenant_id: str, project_id: str) -> int:
        with _mongo_errors():
            result = self._sources.update_many(
                {"tenant_id": tenant_id, "project_ids": project_id}, {"$pull": {"project_ids": project_id}}
            )
        return result.modified_count

    def owner_of_service_account(self, service_account: str) -> str | None:
        with _mongo_errors():
            self._ensure_ready()
            doc = self._sources.find_one({"service_account": service_account}, {"tenant_id": 1})
        return doc["tenant_id"] if doc else None


# ---------------------------------------------------------------------------- MCP servers
class McpTool(McpToolDef):
    """A server's tool and whether agents may use it. Approval pins the definition: if
    the server changes the tool, it is held back (`changed`) until approved again."""

    approved: bool = False
    approved_hash: str | None = None
    changed: bool = False

    def usable(self) -> bool:
        return self.approved and not self.changed and self.approved_hash == self.definition_hash()


McpAuthKind = Literal["none", "token", "header", "url", "custom"]


class McpServer(BaseModel):
    """A user's connection to a remote MCP server. The URL and header values live only in
    `secret` (encrypted; see secrets_box), because a URL can carry the server's key;
    `display_url` is the masked form that is safe to show."""

    id: str
    tenant_id: str
    name: str = Field(min_length=1, max_length=100)
    slug: str = Field(pattern=r"^[a-z0-9]{1,16}$")
    display_url: str = Field(max_length=2_048)
    host: str = Field(max_length=255)
    transport: Literal["http", "sse"] = "http"
    preset: str | None = Field(default=None, max_length=40)
    # How the server is signed in to, as the user chose it in the console. Display only:
    # it never changes what is sent or checked.
    auth: McpAuthKind | None = None
    header_names: list[str] = Field(default_factory=list, max_length=20)
    secret: str
    server_name: str = ""
    server_version: str = ""
    status: Literal["ok", "auth_failed", "unreachable"] = "ok"
    status_message: str | None = None
    tools: list[McpTool] = Field(default_factory=list, max_length=200)
    project_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
    checked_at: datetime = Field(default_factory=_now)

    def usable_tools(self) -> list[McpTool]:
        return [t for t in self.tools if t.usable()]

    @model_validator(mode="after")
    def _default_auth(self) -> "McpServer":
        # Servers saved before `auth` existed: headers mean custom headers, else none.
        if self.auth is None:
            self.auth = "custom" if self.header_names else "none"
        return self


class McpServerStore(Protocol):
    """Users' MCP servers. Every method is scoped by tenant."""

    def add(self, server: McpServer) -> None: ...

    def get(self, tenant_id: str, server_id: str) -> McpServer | None: ...

    def list(self, tenant_id: str, project_id: str | None = None) -> list[McpServer]:
        """The tenant's servers, newest first; with `project_id`, those attached to it."""
        ...

    def update(self, tenant_id: str, server_id: str, **changes: Any) -> McpServer | None: ...

    def delete(self, tenant_id: str, server_id: str) -> bool: ...

    def detach_project(self, tenant_id: str, project_id: str) -> int: ...


class InMemoryMcpServerStore:
    def __init__(self) -> None:
        self._servers: dict[str, McpServer] = {}

    def add(self, server: McpServer) -> None:
        self._servers[server.id] = server.model_copy(deep=True)

    def get(self, tenant_id: str, server_id: str) -> McpServer | None:
        s = self._servers.get(server_id)
        return s.model_copy(deep=True) if s and s.tenant_id == tenant_id else None

    def list(self, tenant_id: str, project_id: str | None = None) -> list[McpServer]:
        found = [
            s for s in self._servers.values()
            if s.tenant_id == tenant_id and (project_id is None or project_id in s.project_ids)
        ]
        return [s.model_copy(deep=True) for s in sorted(found, key=lambda s: s.created_at, reverse=True)]

    def update(self, tenant_id: str, server_id: str, **changes: Any) -> McpServer | None:
        s = self._servers.get(server_id)
        if s is None or s.tenant_id != tenant_id:
            return None
        updated = McpServer.model_validate({**s.model_dump(), **_plain(changes), "updated_at": _now()})
        self._servers[server_id] = updated
        return updated.model_copy(deep=True)

    def delete(self, tenant_id: str, server_id: str) -> bool:
        s = self._servers.get(server_id)
        if s is None or s.tenant_id != tenant_id:
            return False
        del self._servers[server_id]
        return True

    def detach_project(self, tenant_id: str, project_id: str) -> int:
        count = 0
        for s in self._servers.values():
            if s.tenant_id == tenant_id and project_id in s.project_ids:
                s.project_ids = [p for p in s.project_ids if p != project_id]
                count += 1
        return count


class MongoMcpServerStore:
    """`mcp_servers`, one document per server, keyed by tenant."""

    def __init__(self, db: "Database"):
        self._servers = db["mcp_servers"]
        self._ready = False

    def _ensure_ready(self) -> None:
        if not self._ready:
            self._servers.create_index([("tenant_id", 1), ("created_at", -1)])
            self._ready = True

    @staticmethod
    def _out(doc: dict[str, Any]) -> McpServer:
        doc = dict(doc)
        doc["id"] = doc.pop("_id")
        return McpServer.model_validate(doc)

    def add(self, server: McpServer) -> None:
        body = server.model_dump()
        body["_id"] = body.pop("id")
        with _mongo_errors():
            self._ensure_ready()
            self._servers.insert_one(body)

    def get(self, tenant_id: str, server_id: str) -> McpServer | None:
        with _mongo_errors():
            self._ensure_ready()
            doc = self._servers.find_one({"_id": server_id, "tenant_id": tenant_id})
        return self._out(doc) if doc else None

    def list(self, tenant_id: str, project_id: str | None = None) -> list[McpServer]:
        query: dict[str, Any] = {"tenant_id": tenant_id}
        if project_id is not None:
            query["project_ids"] = project_id
        with _mongo_errors():
            self._ensure_ready()
            docs = list(self._servers.find(query).sort("created_at", -1))
        return [self._out(d) for d in docs]

    def update(self, tenant_id: str, server_id: str, **changes: Any) -> McpServer | None:
        with _mongo_errors():
            self._ensure_ready()
            result = self._servers.update_one(
                {"_id": server_id, "tenant_id": tenant_id},
                {"$set": {**_plain(changes), "updated_at": _now()}},
            )
        return self.get(tenant_id, server_id) if result.matched_count == 1 else None

    def delete(self, tenant_id: str, server_id: str) -> bool:
        with _mongo_errors():
            result = self._servers.delete_one({"_id": server_id, "tenant_id": tenant_id})
        return result.deleted_count == 1

    def detach_project(self, tenant_id: str, project_id: str) -> int:
        with _mongo_errors():
            result = self._servers.update_many(
                {"tenant_id": tenant_id, "project_ids": project_id}, {"$pull": {"project_ids": project_id}}
            )
        return result.modified_count


# ---------------------------------------------------------------------------- runs
RUNS_KEPT = 10  # per project and kind
# A run asked to stop ends within seconds; one still "running" this long after was orphaned.
RUN_STOP_GRACE_S = 30


class RunRecord(BaseModel):
    """One run of a project — on this server ("local") or on its deployment ("deployed") —
    saved as it happens, so leaving the page, refreshing or switching browsers never loses
    it. Events are what the run stream sends, without each node's output (kept once, in
    `outputs`, and put back on replay)."""

    id: str
    tenant_id: str
    project_id: str
    kind: Literal["local", "deployed"] = "local"
    mode: Literal["graph", "agent"] = "graph"
    agent_id: str | None = None
    plan_version: int | None = None
    status: Literal["running", "completed", "failed"] = "running"
    input: dict[str, Any] = Field(default_factory=dict)
    events: list[dict[str, Any]] = Field(default_factory=list)
    outputs: dict[str, Any] = Field(default_factory=dict)
    errors: list[dict[str, Any]] = Field(default_factory=list)
    halted: bool = False
    error: dict[str, Any] | None = None  # why the whole run failed (timeout, not deployed, …)
    usage: dict[str, Any] | None = None
    timeout_s: float = 300
    stop_requested: bool = False  # the user pressed Stop; the process running it ends it
    started_at: datetime = Field(default_factory=_now)
    finished_at: datetime | None = None
    updated_at: datetime = Field(default_factory=_now)

    def effective(self, now: datetime | None = None) -> "RunRecord":
        """A run still marked running long after its time limit was cut off (the server
        restarted mid-run): reported as failed, not running forever."""
        now = now or datetime.now(timezone.utc)
        updated = self.updated_at if self.updated_at.tzinfo else self.updated_at.replace(tzinfo=timezone.utc)
        if self.status == "running" and self.stop_requested and (now - updated).total_seconds() > RUN_STOP_GRACE_S:
            # Asked to stop, and the process running it never ended it (it had already died).
            return self.model_copy(update={
                "status": "failed",
                "error": {"error_type": "RunStopped", "message": "you stopped this run"},
            })
        if self.status == "running" and (now - updated).total_seconds() > self.timeout_s + 120:
            return self.model_copy(update={
                "status": "failed",
                "error": {"error_type": "RunInterrupted",
                          "message": "Interrupted: the server stopped before this run finished. Run it again."},
            })
        return self

    def summary(self) -> dict[str, Any]:
        run = self.effective()
        body = run.model_dump(exclude={"tenant_id", "events", "outputs", "input"})
        body["agents_done"] = len(run.outputs)
        return body


class RunStore(Protocol):
    """Saved runs, scoped by tenant and project."""

    def create(self, run: RunRecord) -> None: ...

    def update(self, tenant_id: str, run_id: str, *, new_events: list[dict[str, Any]] | None = None,
               **changes: Any) -> None:
        """Append events (in order) and set fields."""
        ...

    def get(self, tenant_id: str, project_id: str, run_id: str) -> RunRecord | None: ...

    def list(self, tenant_id: str, project_id: str, kind: str, limit: int = RUNS_KEPT) -> list[RunRecord]:
        """Newest first."""
        ...

    def prune(self, tenant_id: str, project_id: str, kind: str, keep: int = RUNS_KEPT) -> int: ...

    def delete_for_project(self, tenant_id: str, project_id: str) -> int: ...


class InMemoryRunStore:
    def __init__(self) -> None:
        self._runs: dict[str, RunRecord] = {}
        self._lock = threading.Lock()

    def create(self, run: RunRecord) -> None:
        with self._lock:
            self._runs[run.id] = run.model_copy(deep=True)

    def update(self, tenant_id: str, run_id: str, *, new_events: list[dict[str, Any]] | None = None,
               **changes: Any) -> None:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None or run.tenant_id != tenant_id:
                return
            fields = {**changes, "updated_at": _now()}
            if new_events:
                fields["events"] = [*run.events, *new_events]
            self._runs[run_id] = run.model_copy(update=fields, deep=True)

    def get(self, tenant_id: str, project_id: str, run_id: str) -> RunRecord | None:
        with self._lock:
            run = self._runs.get(run_id)
            ok = run is not None and run.tenant_id == tenant_id and run.project_id == project_id
            return run.model_copy(deep=True) if ok else None

    def list(self, tenant_id: str, project_id: str, kind: str, limit: int = RUNS_KEPT) -> list[RunRecord]:
        with self._lock:
            found = [r for r in self._runs.values()
                     if r.tenant_id == tenant_id and r.project_id == project_id and r.kind == kind]
            found.sort(key=lambda r: r.started_at, reverse=True)
            return [r.model_copy(deep=True) for r in found[:limit]]

    def prune(self, tenant_id: str, project_id: str, kind: str, keep: int = RUNS_KEPT) -> int:
        with self._lock:
            found = sorted(
                (r for r in self._runs.values()
                 if r.tenant_id == tenant_id and r.project_id == project_id and r.kind == kind),
                key=lambda r: r.started_at, reverse=True,
            )
            for r in found[keep:]:
                del self._runs[r.id]
            return max(len(found) - keep, 0)

    def delete_for_project(self, tenant_id: str, project_id: str) -> int:
        with self._lock:
            ids = [i for i, r in self._runs.items() if r.tenant_id == tenant_id and r.project_id == project_id]
            for i in ids:
                del self._runs[i]
            return len(ids)


class MongoRunStore:
    """`runs`, one document per run (`_id` = run id), indexed by tenant, project, kind, time."""

    def __init__(self, db: "Database"):
        self._runs = db["runs"]
        self._ready = False

    def _ensure_ready(self) -> None:
        if not self._ready:
            self._runs.create_index([("tenant_id", 1), ("project_id", 1), ("kind", 1), ("started_at", -1)])
            self._ready = True

    @staticmethod
    def _out(doc: dict[str, Any]) -> RunRecord:
        doc = dict(doc)
        doc["id"] = doc.pop("_id")
        return RunRecord.model_validate(doc)

    def create(self, run: RunRecord) -> None:
        body = run.model_dump()
        body["_id"] = body.pop("id")
        with _mongo_errors():
            self._ensure_ready()
            self._runs.insert_one(body)

    def update(self, tenant_id: str, run_id: str, *, new_events: list[dict[str, Any]] | None = None,
               **changes: Any) -> None:
        operation: dict[str, Any] = {"$set": {**changes, "updated_at": _now()}}
        if new_events:
            operation["$push"] = {"events": {"$each": list(new_events)}}
        with _mongo_errors():
            self._runs.update_one({"_id": run_id, "tenant_id": tenant_id}, operation)

    def get(self, tenant_id: str, project_id: str, run_id: str) -> RunRecord | None:
        with _mongo_errors():
            self._ensure_ready()
            doc = self._runs.find_one({"_id": run_id, "tenant_id": tenant_id, "project_id": project_id})
        return self._out(doc) if doc else None

    def list(self, tenant_id: str, project_id: str, kind: str, limit: int = RUNS_KEPT) -> list[RunRecord]:
        with _mongo_errors():
            self._ensure_ready()
            docs = list(self._runs.find({"tenant_id": tenant_id, "project_id": project_id, "kind": kind})
                        .sort("started_at", -1).limit(limit))
        return [self._out(d) for d in docs]

    def prune(self, tenant_id: str, project_id: str, kind: str, keep: int = RUNS_KEPT) -> int:
        query = {"tenant_id": tenant_id, "project_id": project_id, "kind": kind}
        with _mongo_errors():
            self._ensure_ready()
            old = [d["_id"] for d in self._runs.find(query, {"_id": 1}).sort("started_at", -1).skip(keep)]
            if not old:
                return 0
            return self._runs.delete_many({"_id": {"$in": old}, "tenant_id": tenant_id}).deleted_count

    def delete_for_project(self, tenant_id: str, project_id: str) -> int:
        with _mongo_errors():
            return self._runs.delete_many({"tenant_id": tenant_id, "project_id": project_id}).deleted_count


def make_run_store() -> RunStore:
    if MONGODB_URI:
        return MongoRunStore(mongo_database(MONGODB_URI, MONGODB_DB))
    return InMemoryRunStore()


# ---------------------------------------------------------------------------- model capabilities
class ModelCapability(BaseModel):
    """What the platform measured about a model. Platform-wide: a model's abilities are
    the same for every user."""

    key: str  # provider/model
    tool_calling: bool
    checked_at: datetime = Field(default_factory=_now)
    source: Literal["probe", "run"] = "probe"


class ModelCapabilityStore(Protocol):
    def get(self, key: str) -> ModelCapability | None: ...

    def set(self, capability: ModelCapability) -> None: ...

    def all(self) -> list[ModelCapability]: ...


class InMemoryModelCapabilityStore:
    def __init__(self) -> None:
        self._items: dict[str, ModelCapability] = {}

    def get(self, key: str) -> ModelCapability | None:
        item = self._items.get(key)
        return item.model_copy() if item else None

    def set(self, capability: ModelCapability) -> None:
        self._items[capability.key] = capability.model_copy()

    def all(self) -> list[ModelCapability]:
        return [i.model_copy() for i in self._items.values()]


class MongoModelCapabilityStore:
    """`model_capabilities`, one document per model (`_id` = provider/model)."""

    def __init__(self, db: "Database"):
        self._items = db["model_capabilities"]

    def get(self, key: str) -> ModelCapability | None:
        with _mongo_errors():
            doc = self._items.find_one({"_id": key})
        if not doc:
            return None
        doc["key"] = doc.pop("_id")
        return ModelCapability.model_validate(doc)

    def set(self, capability: ModelCapability) -> None:
        body = capability.model_dump()
        key = body.pop("key")
        with _mongo_errors():
            self._items.replace_one({"_id": key}, body, upsert=True)

    def all(self) -> list[ModelCapability]:
        with _mongo_errors():
            docs = list(self._items.find({}))
        out = []
        for d in docs:
            d["key"] = d.pop("_id")
            out.append(ModelCapability.model_validate(d))
        return out


def make_capability_store() -> ModelCapabilityStore:
    if MONGODB_URI:
        return MongoModelCapabilityStore(mongo_database(MONGODB_URI, MONGODB_DB))
    return InMemoryModelCapabilityStore()


def make_datasource_store() -> DataSourceStore:
    if MONGODB_URI:
        return MongoDataSourceStore(mongo_database(MONGODB_URI, MONGODB_DB))
    return InMemoryDataSourceStore()


def make_mcp_store() -> McpServerStore:
    if MONGODB_URI:
        return MongoMcpServerStore(mongo_database(MONGODB_URI, MONGODB_DB))
    return InMemoryMcpServerStore()


def make_stores() -> tuple[ProjectStore, UserStore, KnowledgeStore, UsageStore]:
    """MongoDB when MONGODB_URI is configured, otherwise the in-memory fallback."""
    if MONGODB_URI:
        db = mongo_database(MONGODB_URI, MONGODB_DB)
        return MongoProjectStore(db), MongoUserStore(db), MongoKnowledgeStore(db), MongoUsageStore(db)
    return InMemoryProjectStore(), InMemoryUserStore(), InMemoryKnowledgeStore(), InMemoryUsageStore()
