"""FastAPI deployment layer.

Exposes the pipeline as HTTP: brief -> plan -> (edit) -> compile -> invoke/run. Projects
live in a `ProjectStore` (MongoDB when configured, in-memory otherwise), so this layer
holds no state of its own beyond a per-process cache of compiled graphs. Project routes
require a signed-in user (a JWT bearer token from /auth/login) and only ever see that
user's own projects. Every typed platform error is translated to a stable JSON error shape by a single handler per
type, so clients never see a raw stack trace.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import BackgroundTasks, Depends, FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field, ValidationError

from . import knowledge as kb
from . import usage as usage_mod
from .agent_schema import AgentPlan, EmbeddingConfig, LLMConfig, RunBounds
from .auth import create_access_token, decode_access_token, hash_password, verify_password
from .agentcore import make_cloud
from .config import (
    AGENTCORE_CODE_BUCKET,
    AGENTCORE_EXECUTION_ROLE_ARN,
    AGENTCORE_REGION,
    DEFAULT_MODELS,
    DEFAULT_PROVIDER,
    EMBEDDING_MODELS,
    EMBEDDING_OPTIONS,
    PROVIDER_ENV_VARS,
    embedding_option,
    JWT_EXPIRES_MINUTES,
    MAX_AGENTS,
)
from .deploy import build_package, remove_deployment, run_deployment, runtime_environment, runtime_name
from .errors import (
    AuthenticationError,
    EmailTakenError,
    MissingProviderKeyError,
    DeployedRunError,
    DeployError,
    DeployInProgressError,
    DeployNotConfiguredError,
    DocumentNotFoundError,
    KnowledgeBusyError,
    KnowledgeError,
    KnowledgeUnavailableError,
    NotDeployedError,
    PlanConflictError,
    ProjectDeployedError,
    RunTimeoutError,
    MissingToolKeyError,
    PlannerError,
    PlatformError,
    StoreUnavailableError,
    UnknownToolError,
    UnsupportedProviderError,
)
from .bedrock_catalog import bedrock_models, is_bedrock_model, recommended_bedrock_models
from .graph_builder import (
    aws_credentials_available,
    compile_graph,
    embedding_available,
    get_embeddings,
    run_graph,
    run_graph_events,
    run_single_agent,
)
from .meta_planner_prompt import plan_project, revise_plan
from .stores import (
    ChatMessage,
    Deployment,
    KnowledgeDocument,
    ProjectRecord,
    UsageRecord,
    UserRecord,
    make_stores,
)
from .usage import UsageCollector
from .usage_sync import make_records, sync_deployed_usage
from .tools import (
    KNOWLEDGE_TOOLS,
    SIDE_EFFECT_TOOLS,
    TOOL_REGISTRY,
    TOOL_SUMMARIES,
    default_tool_names,
    uses_knowledge,
)

app = FastAPI(
    title="Agentic Platform",
    description="Describe a multi-agent task in natural language; get live, callable "
    "endpoints for a compiled multi-agent system.",
    version="0.1.0",
)

# The console SPA runs on its own Vite dev server, so browser calls to this API are
# cross-origin in development. Scoped to localhost dev ports; a deployed build would be
# served same-origin or given its real origin here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_store, _users, _knowledge, _usage = make_stores()
logger = logging.getLogger(__name__)


def _make_cloud():
    """The AWS side of deployments, or None when this server has no AWS credentials.
    A function (not a module constant) so credentials set up later are picked up, and so
    tests can swap in a fake."""
    return make_cloud(AGENTCORE_REGION, AGENTCORE_EXECUTION_ROLE_ARN, AGENTCORE_CODE_BUCKET)


# Swappable in tests: builds the deployment zip.
_package_builder = build_package

# Per-process cache of compiled graphs: project id -> (plan_version, embedding model,
# graph). Purely an optimisation — the store's compiled_version is the source of truth
# for whether a project is runnable, and compiling makes no LLM calls, so a process that
# doesn't hold the graph (after a restart, or a different worker) just rebuilds it.
_COMPILED: dict[str, tuple[int, Any, Any]] = {}

# Files accepted in one upload request (each up to kb.MAX_FILE_BYTES).
MAX_FILES_PER_UPLOAD = 10


# --------------------------------------------------------------------------- models
class CreateProjectRequest(BaseModel):
    brief: str = Field(min_length=1)
    # Omit to let the planner choose the team size (still capped at MAX_AGENTS).
    agent_count: int | None = Field(default=None, gt=0, le=MAX_AGENTS)
    available_tools: list[str] | None = None
    available_llms: list[dict[str, str]] | None = None
    # Files from the user's knowledge library to attach to the new project. The planner is
    # told their names, so it can give the agents that need them knowledge_search.
    document_ids: list[str] = Field(default_factory=list, max_length=50)


class AgentSettings(BaseModel):
    id: str
    provider: str
    model: str = Field(min_length=1, max_length=120)
    tools: list[str] = Field(default_factory=list, max_length=20)


class AgentSettingsRequest(BaseModel):
    agents: list[AgentSettings] = Field(min_length=1, max_length=MAX_AGENTS)


class RegisterRequest(BaseModel):
    email: EmailStr
    # Upper bound keeps a hostile client from making the server hash megabytes.
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(max_length=128)


class ReviseRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class DeployedInvokeRequest(BaseModel):
    input: dict[str, Any]
    # Run one agent instead of the whole graph.
    agent_id: str | None = None
    upstream_outputs: dict[str, Any] = Field(default_factory=dict)


class RunRequest(BaseModel):
    input: dict[str, Any]


class AgentInvokeRequest(BaseModel):
    input: dict[str, Any]
    upstream_outputs: dict[str, Any] = Field(default_factory=dict)


class KnowledgeSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    k: int = Field(default=5, ge=1, le=10)


class ProjectNotFoundError(PlatformError):
    def __init__(self, project_id: str):
        self.project_id = project_id
        super().__init__(f"project not found: {project_id}")


class NotCompiledError(PlatformError):
    def __init__(self, project_id: str):
        self.project_id = project_id
        super().__init__(f"project '{project_id}' has not been compiled yet")


# auto_error=False so a missing header reaches current_user and gets the platform's own
# typed 401, not FastAPI's default error shape.
_bearer = HTTPBearer(auto_error=False, description="Access token from /auth/login")


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserRecord:
    if credentials is None:
        raise AuthenticationError()
    user = _users.get(decode_access_token(credentials.credentials))
    if user is None:  # a well-formed token for an account that no longer exists
        raise AuthenticationError("invalid token")
    return user


def _public_user(user: UserRecord) -> dict[str, Any]:
    return {"id": user.id, "email": user.email, "created_at": user.created_at}


def _session(user: UserRecord) -> dict[str, Any]:
    return {
        "access_token": create_access_token(user.id),
        "token_type": "bearer",
        "expires_in": JWT_EXPIRES_MINUTES * 60,
        "user": _public_user(user),
    }


def _deployment_body(project: ProjectRecord) -> dict[str, Any] | None:
    if project.deployment is None:
        return None
    deployment = project.deployment.effective()
    return {
        **deployment.model_dump(),
        "live": deployment.live,
        "in_progress": deployment.in_progress,
        # The live runtime serves an older plan than the one in the project now.
        "outdated": deployment.live and deployment.live_plan_version != project.plan_version,
    }


def _project_body(project: ProjectRecord) -> dict[str, Any]:
    return {
        "project_id": project.id,
        "brief": project.brief,
        "plan": project.plan.model_dump(),
        "plan_version": project.plan_version,
        "compiled": project.is_compiled,
        "side_effect_tools_enabled": project.side_effect_tools_enabled,
        "conversation": [m.model_dump() for m in project.conversation],
        "deployment": _deployment_body(project),
        "knowledge": _knowledge_summary(project),
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }


def _get_project(project_id: str, user: UserRecord) -> ProjectRecord:
    project = _store.get(project_id)
    # Someone else's project is reported exactly like a missing one, so ids can't be
    # probed for existence.
    if project is None or project.tenant_id != user.id:
        raise ProjectNotFoundError(project_id)
    return project


def _compiled_graph(project: ProjectRecord) -> Any:
    # The embedder is bound when the graph is built, so the library's embedding model is
    # part of the cache key.
    embedding = _knowledge.get_embedding(project.tenant_id) if uses_knowledge(project.plan) else None
    cached = _COMPILED.get(project.id)
    if cached is not None and cached[0] == project.plan_version and cached[1] == embedding:
        return cached[2]
    graph = compile_graph(project.plan, _knowledge_context(project, embedding))
    _COMPILED[project.id] = (project.plan_version, embedding, graph)
    return graph


# --------------------------------------------------------------------------- knowledge
def _knowledge_context(
    project: ProjectRecord, embedding: EmbeddingConfig | None = None
) -> kb.KnowledgeContext | None:
    """The files attached to the project, for knowledge_search — or None when no agent uses
    it or nothing is attached (compiling then fails with KnowledgeUnavailable)."""
    if not uses_knowledge(project.plan):
        return None
    embedding = embedding or _knowledge.get_embedding(project.tenant_id)
    if embedding is None or not _knowledge.list_documents(project.tenant_id, project.id):
        return None
    return kb.store_context(_knowledge, project.tenant_id, project.id, get_embeddings(embedding))


def _has_ready_knowledge(project: ProjectRecord) -> bool:
    return any(d.status == "ready" for d in _knowledge.list_documents(project.tenant_id, project.id))


def _offered_tools(project: ProjectRecord) -> list[str]:
    """Tools the planner may give this project's agents: the built-ins, the external
    tools this project opted into, and knowledge_search once a ready file is attached."""
    tools = set(default_tool_names()) | set(project.side_effect_tools_enabled)
    if _has_ready_knowledge(project):
        tools |= KNOWLEDGE_TOOLS
    return sorted(tools)


def _embedding_options() -> list[dict[str, Any]]:
    return [
        {**o, "available": embedding_available(str(o["provider"]))}
        for o in EMBEDDING_OPTIONS
    ]


def _model_allowed(provider: str, model: str) -> bool:
    """A model the platform offers: a provider's default, or a Bedrock model this AWS
    account can use (checked live — never trusted from the client)."""
    if provider == "bedrock":
        return is_bedrock_model(model)
    return DEFAULT_MODELS.get(provider) == model


def _default_embedding(project: ProjectRecord | None) -> EmbeddingConfig:
    """For a library's first upload: the embedding model of the provider the project's
    agents use (when uploading from a project), else the first one this server has a key
    for, starting with the platform's default provider."""
    preferred = [a.llm.provider for a in project.plan.agents] if project else []
    preferred += [DEFAULT_PROVIDER, *EMBEDDING_MODELS]
    for provider in preferred:
        if provider in EMBEDDING_MODELS and embedding_available(provider):
            return EmbeddingConfig(provider=provider, model=EMBEDDING_MODELS[provider])
    raise KnowledgeError(
        "no embedding model is configured on this server: add a Gemini (GOOGLE_API_KEY) "
        "or OpenAI (OPENAI_API_KEY) key to use a knowledge library",
        status=503,
    )


def _document_body(doc: KnowledgeDocument) -> dict[str, Any]:
    return doc.effective().model_dump(exclude={"tenant_id"})


def _knowledge_summary(project: ProjectRecord) -> dict[str, Any]:
    docs = [d.effective() for d in _knowledge.list_documents(project.tenant_id, project.id)]
    embedding = _knowledge.get_embedding(project.tenant_id)
    return {
        "documents": len(docs),
        "ready": sum(d.status == "ready" for d in docs),
        "embedding": embedding.model_dump() if embedding else None,
    }


def _index_upload(tenant_id: str, document_id: str, data: bytes, config: EmbeddingConfig) -> None:
    """Background job for one uploaded file. Runs after the response, one file at a
    time, so each file's passage budget accounts for the files indexed before it."""
    used = sum(d.chunk_count for d in _knowledge.list_documents(tenant_id) if d.id != document_id)
    try:
        embedder = get_embeddings(config)
    except Exception as e:  # noqa: BLE001 — recorded on the document, never raised
        _knowledge.update_document(tenant_id, document_id, status="failed", error=kb._describe(e))
        return
    collector = UsageCollector()
    doc = _knowledge.get_document(tenant_id, document_id)
    try:
        kb.index_document(
            _knowledge, tenant_id, document_id, data, embedder, kb.MAX_CHUNKS_PER_LIBRARY - used,
            on_embedded=_embedding_counter(collector, config, "embedding_index"),
        )
    finally:
        project_id = doc.project_ids[0] if doc and doc.project_ids else None
        _record_usage(tenant_id, project_id, collector.entries(), run_id=uuid.uuid4().hex)


def _reembed(tenant_id: str, config: EmbeddingConfig) -> None:
    collector = UsageCollector()
    try:
        kb.reembed_library(
            _knowledge, tenant_id, get_embeddings(config),
            on_embedded=_embedding_counter(collector, config, "embedding_index"),
        )
    finally:
        _record_usage(tenant_id, None, collector.entries(), run_id=uuid.uuid4().hex)


# --------------------------------------------------------------------------- usage
def _record_usage(
    tenant_id: str,
    project_id: str | None,
    entries: list[dict[str, Any]],
    *,
    run_id: str | None = None,
    deployed: bool = False,
    via: str | None = None,
) -> None:
    """Store what a unit of work used, with its estimated cost. Best effort: accounting
    must never fail the work it measures, so a storage error is logged and dropped."""
    try:
        _usage.add_many(
            make_records(tenant_id, project_id, entries, run_id=run_id, deployed=deployed, via=via)
        )
    except Exception:  # noqa: BLE001 — accounting is best effort
        logger.exception("recording usage for project %s failed", project_id)


# Direct-AWS usage sync: on demand (no job queue yet), at most once per project per
# SYNC_EVERY_S in this process; the stored cursor keeps every process correct.
SYNC_EVERY_S = 120
_LAST_SYNC: dict[str, float] = {}
_SYNC_STATUS: dict[str, dict[str, Any]] = {}
_SYNC_LOCK = threading.Lock()


def _sync_projects(projects: list[ProjectRecord], cloud: Any, force: bool = False) -> list[dict[str, Any]]:
    results = []
    for project in projects:
        with _SYNC_LOCK:
            if not force and time.monotonic() - _LAST_SYNC.get(project.id, -1e9) < SYNC_EVERY_S:
                continue
            _LAST_SYNC[project.id] = time.monotonic()
        result = sync_deployed_usage(project, cloud, _usage, _store).as_dict()
        _SYNC_STATUS[project.id] = {**result, "at": datetime.now(timezone.utc)}
        results.append(result)
    return results


def _deployed_projects(user: UserRecord, project_id: str | None = None) -> list[ProjectRecord]:
    return [
        p for p in _store.list_for_tenant(user.id)
        if p.deployment is not None and p.deployment.runtime_id and (project_id is None or p.id == project_id)
    ]


def _deployments_usage_status(projects: list[ProjectRecord]) -> list[dict[str, Any]]:
    """Per deployment: does it report usage, how far it's synced, how the last sync went."""
    out = []
    for p in projects:
        last = _SYNC_STATUS.get(p.id)
        out.append({
            "project_id": p.id,
            "name": p.brief,
            "reports_usage": p.deployment.reports_usage,
            "synced_until": p.deployment.usage_synced_until,
            "last_sync": last,
        })
    return out


def _embedding_counter(collector: UsageCollector, config: EmbeddingConfig, kind: str):
    """An `on_embedded` hook counting text sent to the embedding model (estimated)."""

    def count(texts: list[str]) -> None:
        collector.add(
            kind=kind, provider=config.provider, model=config.model, estimated=True,
            input_tokens=usage_mod.estimate_tokens(texts), calls=1,
        )

    return count


# --------------------------------------------------------------------------- routes
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/tools")
def list_tools() -> dict[str, Any]:
    """The tool registry, flagging which entries need explicit per-project opt-in."""
    return {
        "tools": [
            {
                "name": name,
                "side_effect": name in SIDE_EFFECT_TOOLS,
                "description": TOOL_SUMMARIES.get(name, ""),
            }
            for name in TOOL_REGISTRY
        ],
        "default": default_tool_names(),
    }


@app.get("/providers")
def list_providers() -> dict[str, Any]:
    """Selectable provider/model pairs, with the platform default marked, and whether
    this server has the provider's API key (a model without one can't run)."""
    providers = [
        {
            "provider": provider,
            "model": model,
            "default": provider == DEFAULT_PROVIDER,
            "available": provider not in PROVIDER_ENV_VARS
            or any(os.environ.get(v) for v in PROVIDER_ENV_VARS[provider]),
        }
        for provider, model in DEFAULT_MODELS.items()
    ]
    # Amazon Bedrock: whatever this AWS account can use, called with IAM credentials.
    if aws_credentials_available():
        providers += [{**m, "available": True, "group": "Amazon Bedrock"} for m in bedrock_models()]
    return {"providers": providers}


@app.post("/auth/register", status_code=201)
def register(req: RegisterRequest) -> dict[str, Any]:
    """Create an account and sign it in: returns the same body as /auth/login."""
    user = UserRecord(
        id=uuid.uuid4().hex,
        email=req.email.lower(),
        password_hash=hash_password(req.password),
    )
    _users.create(user)
    return _session(user)


@app.post("/auth/login")
def login(req: LoginRequest) -> dict[str, Any]:
    user = _users.get_by_email(req.email.lower())
    # One message for both failures: never reveal whether the email is registered.
    if not verify_password(req.password, user.password_hash if user else None):
        raise AuthenticationError("invalid email or password")
    return _session(user)


@app.get("/auth/me")
def me(user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    return _public_user(user)


@app.post("/projects", status_code=201)
def create_project(
    req: CreateProjectRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    available_llms = req.available_llms or [
        {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODELS[DEFAULT_PROVIDER]}
    ]
    unknown = [
        f"{m.get('provider')}/{m.get('model')}" for m in available_llms
        if not _model_allowed(str(m.get("provider")), str(m.get("model")))
    ]
    if unknown:
        raise KnowledgeError(f"not an available model: {', '.join(unknown)}", status=422)
    # Side-effecting tools (network egress, third-party APIs) are excluded by default;
    # a caller opts a project into one by naming it explicitly here.
    available_tools = req.available_tools if req.available_tools is not None else default_tool_names()
    documents = [_get_document(doc_id, user) for doc_id in dict.fromkeys(req.document_ids)]
    # knowledge_search only when files come with the project — otherwise there's nothing
    # for it to search.
    available_tools = [t for t in available_tools if t not in KNOWLEDGE_TOOLS]
    if documents:
        available_tools = [*available_tools, *sorted(KNOWLEDGE_TOOLS)]
    side_effect_tools_enabled = sorted(set(available_tools) & SIDE_EFFECT_TOOLS)
    collector = UsageCollector()
    project_id: str | None = None
    try:
        plan = plan_project(
            user_brief=req.brief,
            requested_agent_count=req.agent_count,
            available_tools=available_tools,
            available_llms=available_llms,
            usage=collector,
            knowledge_files=[d.filename for d in documents],
        )
        project_id = uuid.uuid4().hex
    finally:
        # Planning costs tokens even when it fails; then there's no project to charge.
        _record_usage(user.id, project_id, collector.entries(), run_id=uuid.uuid4().hex)
    _store.create(
        ProjectRecord(
            id=project_id,
            tenant_id=user.id,
            brief=req.brief,
            plan=plan,
            side_effect_tools_enabled=side_effect_tools_enabled,
        )
    )
    for doc in documents:
        _knowledge.attach(user.id, doc.id, project_id)
    return {
        "project_id": project_id,
        "plan": plan.model_dump(),
        "side_effect_tools_enabled": side_effect_tools_enabled,
    }


@app.get("/projects")
def list_projects(user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The signed-in user's projects, most recently updated first — summaries only; fetch
    one by id for its full plan."""
    return {
        "projects": [
            {
                "project_id": p.id,
                "brief": p.brief,
                "orchestration_pattern": p.plan.orchestration_pattern,
                "agent_count": len(p.plan.agents),
                "compiled": p.is_compiled,
                "created_at": p.created_at,
                "updated_at": p.updated_at,
            }
            for p in _store.list_for_tenant(user.id)
        ]
    }


@app.get("/projects/{project_id}")
def get_project(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    return _project_body(_get_project(project_id, user))


@app.delete("/projects/{project_id}")
def delete_project(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Delete a project with its plan and conversation. Its knowledge files stay in your
    library (detached from it). A project with a deployment on AgentCore (or one being
    deployed) is refused until the deployment is removed, so no runtime is left running
    unreachable in the AWS account."""
    project = _get_project(project_id, user)
    deployment = project.deployment.effective() if project.deployment else None
    if deployment is not None and (deployment.in_progress or deployment.runtime_id):
        raise ProjectDeployedError()
    # The project goes first: if detaching then failed, the leftover attachments point
    # at a project that doesn't exist, and nothing shows those.
    if not _store.delete(project_id):
        raise ProjectNotFoundError(project_id)
    _COMPILED.pop(project_id, None)
    detached = _knowledge.detach_project(user.id, project_id)
    return {"deleted": project_id, "knowledge_documents_detached": detached}


@app.put("/projects/{project_id}/agents")
def update_agent_settings(
    project_id: str, req: AgentSettingsRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Change agents' model and tools (the Brief page's editor). Agents not listed keep
    theirs. Models come from the platform's list (or what the agent already uses); tools
    from the registry, with knowledge_search only when files are attached. Turning on an
    external tool here is this project's explicit opt-in to it. A change makes a new plan
    version, which has to be compiled again."""
    project = _get_project(project_id, user)
    agents = {a.id: a for a in project.plan.agents}
    current_models = {(a.llm.provider, a.llm.model) for a in project.plan.agents}
    has_knowledge = bool(_knowledge.list_documents(user.id, project_id))
    problems: list[str] = []
    updates: dict[str, Any] = {}
    for change in req.agents:
        agent = agents.get(change.id)
        if agent is None:
            problems.append(f"no agent '{change.id}' in this plan")
            continue
        if (change.provider, change.model) not in current_models and not _model_allowed(change.provider, change.model):
            problems.append(f"{change.provider}/{change.model} isn't one of the available models")
        unknown = [t for t in change.tools if t not in TOOL_REGISTRY]
        if unknown:
            problems.append(f"unknown tool(s) for '{change.id}': {unknown}")
        if set(change.tools) & KNOWLEDGE_TOOLS and not has_knowledge:
            problems.append("knowledge_search needs files attached to this project first")
        llm = agent.llm
        if (change.provider, change.model) != (llm.provider, llm.model):
            # Provider-specific extras don't carry over to a different model.
            llm = LLMConfig(provider=change.provider, model=change.model, temperature=llm.temperature)
        updates[change.id] = agent.model_copy(update={"llm": llm, "tools": list(dict.fromkeys(change.tools))})
    if problems:
        raise KnowledgeError("; ".join(problems), status=422)

    plan = project.plan.model_copy(update={"agents": [updates.get(a.id, a) for a in project.plan.agents]})
    plan = AgentPlan.model_validate(plan.model_dump())  # same integrity checks as any plan
    if plan == project.plan:
        return _project_body(project)
    used_external = {t for a in plan.agents for t in a.tools} & SIDE_EFFECT_TOOLS
    enabled = sorted(set(project.side_effect_tools_enabled) | used_external)
    updated = _store.update_plan(project_id, plan, side_effect_tools_enabled=enabled)
    if updated is None:
        raise ProjectNotFoundError(project_id)
    _COMPILED.pop(project_id, None)
    return _project_body(updated)


@app.patch("/projects/{project_id}/plan")
def edit_plan(
    project_id: str, plan: AgentPlan, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    # AgentPlan validators run on parse, so an invalid edit is rejected before it lands.
    _get_project(project_id, user)
    # The edit bumps plan_version, which is what invalidates the compiled graph — in this
    # process and in any other one serving the same project.
    updated = _store.update_plan(project_id, plan)
    if updated is None:
        raise ProjectNotFoundError(project_id)
    _COMPILED.pop(project_id, None)
    return _project_body(updated)


@app.post("/projects/{project_id}/revise")
def revise_project(
    project_id: str, req: ReviseRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Change a project's brief and/or plan by asking for it in plain language.

    The request and the planner's reply are kept as the project's conversation. A change
    makes a new plan version, which has to be compiled again before it can run.
    """
    project = _get_project(project_id, user)
    # A revision may use any built-in tool, but external tools only if this project
    # already opted into them — a chat message is not an opt-in.
    allowed_tools = _offered_tools(project)
    allowed_llms = [{"provider": p, "model": m} for p, m in DEFAULT_MODELS.items()]
    allowed_llms += [{"provider": "bedrock", "model": m["model"]} for m in recommended_bedrock_models()]
    for agent in project.plan.agents:
        current = {"provider": agent.llm.provider, "model": agent.llm.model}
        if current not in allowed_llms:
            allowed_llms.append(current)

    collector = UsageCollector()
    try:
        revision = revise_plan(
            brief=project.brief,
            plan=project.plan,
            request=req.message,
            history=[(m.role, m.content) for m in project.conversation],
            available_tools=allowed_tools,
            available_llms=allowed_llms,
            usage=collector,
        )
    finally:
        _record_usage(user.id, project_id, collector.entries(), run_id=uuid.uuid4().hex)
    changed = revision.brief != project.brief or revision.plan != project.plan
    reply = ChatMessage(
        role="assistant",
        content=revision.reply,
        plan_version=project.plan_version + 1 if changed else None,
    )
    updated = _store.record_exchange(
        project_id,
        project.plan_version,
        [ChatMessage(role="user", content=req.message), reply],
        brief=revision.brief if changed else None,
        plan=revision.plan if changed else None,
    )
    if updated is None:
        raise PlanConflictError(project_id)
    if changed:
        _COMPILED.pop(project_id, None)
    return {"changed": changed, "reply": reply.model_dump(), "project": _project_body(updated)}


@app.post("/projects/{project_id}/compile")
def compile_project(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    project = _get_project(project_id, user)
    _compiled_graph(project)
    _store.mark_compiled(project_id, project.plan_version)
    return {"project_id": project_id, "status": "compiled"}


@app.post("/projects/{project_id}/run")
def run_project(
    project_id: str, req: RunRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    project = _get_project(project_id, user)
    if not project.is_compiled:
        raise NotCompiledError(project_id)
    collector = UsageCollector()
    try:
        result = run_graph(_compiled_graph(project), req.input, project.plan.bounds, collector)
    except TimeoutError:
        raise RunTimeoutError(project.plan.bounds.timeout_s) from None
    finally:
        # Whatever was used up to a timeout is still spent.
        _record_usage(user.id, project_id, collector.entries(), run_id=uuid.uuid4().hex)
    return {
        "project_id": project_id,
        "outputs": result["outputs"],
        "errors": result["errors"],
        "halted": result["halted"],
        "usage": usage_mod.summarize(collector.entries()),
    }


@app.post("/projects/{project_id}/run/stream")
def run_project_stream(
    project_id: str, req: RunRequest, user: UserRecord = Depends(current_user)
) -> StreamingResponse:
    """Run the whole graph and stream its progress as Server-Sent Events.

    Same input as /run. Events: run_started, node_started, node_retry, node_completed
    (with the agent's output), node_failed, node_skipped, then run_completed (same
    outputs/errors/halted as /run) or run_failed (e.g. RunTimeout). Errors before the run
    starts (not compiled, not found) are ordinary JSON error responses.
    """
    project = _get_project(project_id, user)
    if not project.is_compiled:
        raise NotCompiledError(project_id)
    graph = _compiled_graph(project)

    def stream():
        collector = UsageCollector()
        try:
            for event, data in run_graph_events(graph, req.input, project.plan.bounds, collector):
                if event in ("run_completed", "run_failed"):
                    data = {**data, "usage": usage_mod.summarize(collector.entries())}
                yield f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"
        finally:
            # Also runs when the client disconnects mid-run: tokens used so far count.
            _record_usage(user.id, project_id, collector.entries(), run_id=uuid.uuid4().hex)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/projects/{project_id}/agents/{agent_id}/invoke")
def invoke_agent(
    project_id: str,
    agent_id: str,
    req: AgentInvokeRequest,
    user: UserRecord = Depends(current_user),
) -> dict[str, Any]:
    project = _get_project(project_id, user)
    collector = UsageCollector()
    try:
        result = run_single_agent(
            project.plan, agent_id, req.input, req.upstream_outputs, _knowledge_context(project),
            usage=collector,
        )
    except KeyError:
        return JSONResponse(
            status_code=404,
            content={
                "error_type": "AgentNotFound",
                "message": f"agent '{agent_id}' not in project '{project_id}'",
                "details": None,
            },
        )
    finally:
        _record_usage(user.id, project_id, collector.entries(), run_id=uuid.uuid4().hex)
    return {
        "project_id": project_id,
        "agent_id": agent_id,
        "result": result,
        "usage": usage_mod.summarize(collector.entries()),
    }


# --------------------------------------------------------------------------- knowledge
def _knowledge_limits() -> dict[str, Any]:
    return {
        "max_file_bytes": kb.MAX_FILE_BYTES,
        "max_files": kb.MAX_FILES_PER_LIBRARY,
        "max_files_per_upload": MAX_FILES_PER_UPLOAD,
        "max_passages": kb.MAX_CHUNKS_PER_LIBRARY,
        "file_types": sorted(kb.ALLOWED_TYPES),
    }


def _library_embedding_body(tenant_id: str) -> dict[str, Any]:
    embedding = _knowledge.get_embedding(tenant_id)
    return {
        "embedding": embedding.model_dump() if embedding else None,
        "embedding_options": _embedding_options(),
    }


def _get_document(document_id: str, user: UserRecord) -> KnowledgeDocument:
    doc = _knowledge.get_document(user.id, document_id)
    if doc is None:  # someone else's file is reported exactly like a missing one
        raise DocumentNotFoundError(document_id)
    return doc


@app.get("/knowledge")
def knowledge_library(user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The signed-in user's knowledge library: every file (newest first) with the projects
    it is attached to, a summary per project (including projects with nothing attached,
    so files can be attached to any of them), the embedding model and the limits."""
    projects = _store.list_for_tenant(user.id)
    owned = {p.id for p in projects}
    docs = [d.effective() for d in _knowledge.list_documents(user.id)]
    documents = []
    for d in docs:
        body = _document_body(d)
        # Attachments to projects that no longer exist are never shown.
        body["project_ids"] = [pid for pid in d.project_ids if pid in owned]
        documents.append(body)
    return {
        **_library_embedding_body(user.id),
        "documents": documents,
        "passages": sum(d.chunk_count for d in docs),
        "projects": [
            {
                "project_id": p.id,
                "brief": p.brief,
                "documents": sum(p.id in d.project_ids for d in docs),
                "ready": sum(p.id in d.project_ids and d.status == "ready" for d in docs),
                "used_by": [a.id for a in p.plan.agents if set(a.tools) & KNOWLEDGE_TOOLS],
                "updated_at": p.updated_at,
            }
            for p in projects
        ],
        "limits": _knowledge_limits(),
    }


@app.get("/projects/{project_id}/knowledge")
def get_knowledge(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The files attached to this project (its agents search only these), the library
    files that could be attached, the library's embedding model and the limits."""
    project = _get_project(project_id, user)
    library = _knowledge.list_documents(user.id)
    attached = [_document_body(d) for d in library if project_id in d.project_ids]
    return {
        **_library_embedding_body(user.id),
        "documents": attached,
        "available": [_document_body(d) for d in library if project_id not in d.project_ids],
        "passages": sum(d["chunk_count"] for d in attached),
        # Agents that can search the attached files now.
        "used_by": [a.id for a in project.plan.agents if set(a.tools) & KNOWLEDGE_TOOLS],
        "limits": _knowledge_limits(),
    }


def _queue_uploads(
    user: UserRecord,
    files: list[tuple[str, bytes]],
    background: BackgroundTasks,
    project_id: str | None = None,
) -> dict[str, Any]:
    """Add files to the user's library (checked in full before anything is queued) and,
    with `project_id`, attach them to that project."""
    project = _get_project(project_id, user) if project_id else None
    existing = _knowledge.list_documents(user.id)
    if len(existing) + len(files) > kb.MAX_FILES_PER_LIBRARY:
        raise KnowledgeError(
            f"a knowledge library holds at most {kb.MAX_FILES_PER_LIBRARY} files; "
            f"yours has {len(existing)}"
        )
    names = {d.filename.lower() for d in existing}
    for filename, data in files:
        kb.file_kind(filename)
        if filename.lower() in names:
            raise KnowledgeError(
                f"'{filename}' is already in your knowledge library; attach that one, or delete "
                "it first to replace it",
                status=409,
            )
        names.add(filename.lower())
        if not data:
            raise KnowledgeError(f"'{filename}' is empty")

    config = _knowledge.get_embedding(user.id) or _default_embedding(project)
    get_embeddings(config)  # fail now, not in the background, if its key is missing
    if _knowledge.get_embedding(user.id) is None:
        _knowledge.set_embedding(user.id, config)

    queued = []
    for filename, data in files:
        doc = KnowledgeDocument(
            id=uuid.uuid4().hex,
            tenant_id=user.id,
            project_ids=[project_id] if project_id else [],
            filename=filename,
            kind=kb.file_kind(filename),
            size_bytes=len(data),
        )
        _knowledge.add_document(doc)
        background.add_task(_index_upload, user.id, doc.id, data, config)
        queued.append(_document_body(doc))
    return {"documents": queued}


_UPLOAD_BODY = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["files"],
                    "properties": {
                        "files": {"type": "array", "items": {"type": "string", "format": "binary"}}
                    },
                }
            }
        },
    }
}


async def _read_upload(request: Request) -> list[tuple[str, bytes]]:
    # Refuse an oversized body before reading it.
    limit = MAX_FILES_PER_UPLOAD * kb.MAX_FILE_BYTES + 1024 * 1024
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise KnowledgeError("upload too large: send at most 10 files of up to 20 MB each", status=413)
    form = await request.form(max_files=MAX_FILES_PER_UPLOAD, max_fields=10)
    files: list[tuple[str, bytes]] = []
    try:
        for item in form.getlist("files"):
            if isinstance(item, str):
                raise KnowledgeError("'files' must be file uploads")
            filename = (item.filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()[:200]
            if not filename:
                raise KnowledgeError("every uploaded file needs a name")
            data = await item.read(kb.MAX_FILE_BYTES + 1)
            if len(data) > kb.MAX_FILE_BYTES:
                raise KnowledgeError(f"'{filename}' is larger than 20 MB", status=413)
            files.append((filename, data))
    finally:
        await form.close()
    if not files:
        raise KnowledgeError("no files were uploaded (use the multipart field 'files')")
    return files


@app.post("/knowledge/documents", status_code=202, openapi_extra=_UPLOAD_BODY)
async def upload_to_library(
    request: Request, background: BackgroundTasks, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Add files (multipart field `files`, repeatable) to your knowledge library, attached
    to no project yet.

    Returns at once with each file queued; extraction and embedding run in the
    background, reported per file by GET /knowledge. Accepts PDF, Word (.docx), .txt, .md
    and .csv, up to 20 MB each. File contents, and later the agents' search queries, are
    sent to the library's embedding provider; the files themselves are not stored, only
    the text passages extracted from them.
    """
    files = await _read_upload(request)
    return await run_in_threadpool(_queue_uploads, user, files, background)


@app.post("/projects/{project_id}/knowledge/documents", status_code=202, openapi_extra=_UPLOAD_BODY)
async def upload_documents(
    project_id: str,
    request: Request,
    background: BackgroundTasks,
    user: UserRecord = Depends(current_user),
) -> dict[str, Any]:
    """Add files to your knowledge library and attach them to this project — the same as
    POST /knowledge/documents followed by attaching each file."""
    files = await _read_upload(request)
    return await run_in_threadpool(_queue_uploads, user, files, background, project_id)


@app.delete("/knowledge/documents/{document_id}")
def delete_from_library(document_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Delete a file and its passages from your library, detaching it from every project."""
    if not _knowledge.delete_document(user.id, document_id):
        raise DocumentNotFoundError(document_id)
    return {"deleted": document_id}


class AttachmentsRequest(BaseModel):
    project_ids: list[str] = Field(max_length=200)


@app.put("/knowledge/documents/{document_id}/projects")
def set_attachments(
    document_id: str, req: AttachmentsRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Set exactly which of your projects a library file is attached to."""
    doc = _get_document(document_id, user)
    wanted = list(dict.fromkeys(req.project_ids))
    for project_id in wanted:
        _get_project(project_id, user)  # each must be one of yours (else 404)
    for project_id in set(doc.project_ids) - set(wanted):
        _knowledge.detach(user.id, document_id, project_id)
    for project_id in wanted:
        _knowledge.attach(user.id, document_id, project_id)
    return {"document": _document_body(_get_document(document_id, user))}


@app.post("/projects/{project_id}/knowledge/documents/{document_id}")
def attach_document(
    project_id: str, document_id: str, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Attach a file from your library to this project. Agents with knowledge_search find
    it right away — no recompile."""
    _get_project(project_id, user)
    _get_document(document_id, user)
    _knowledge.attach(user.id, document_id, project_id)
    return {"document": _document_body(_get_document(document_id, user))}


@app.delete("/projects/{project_id}/knowledge/documents/{document_id}")
def detach_document(
    project_id: str, document_id: str, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Detach a file from this project. It stays in your library (and in any other
    project it is attached to)."""
    _get_project(project_id, user)
    if not _knowledge.detach(user.id, document_id, project_id):
        raise DocumentNotFoundError(document_id)
    return {"detached": document_id}


@app.put("/knowledge/embedding")
def set_embedding(
    config: EmbeddingConfig,
    background: BackgroundTasks,
    response: Response,
    user: UserRecord = Depends(current_user),
) -> dict[str, Any]:
    """Change your library's embedding model. Every stored passage is re-embedded in the
    background (202); no file needs uploading again."""
    if embedding_option(config.provider, config.model) is None:
        raise KnowledgeError(
            f"unknown embedding model; choose one of {_embedding_options()}", status=422
        )
    current = _knowledge.get_embedding(user.id)
    if config == current:
        return knowledge_library(user)
    docs = [d.effective() for d in _knowledge.list_documents(user.id)]
    if any(d.status in ("queued", "processing") for d in docs):
        raise KnowledgeBusyError()
    get_embeddings(config)  # missing key -> MissingProviderKey now
    _knowledge.set_embedding(user.id, config)
    if docs:
        for d in docs:
            if d.status == "ready":
                _knowledge.update_document(user.id, d.id, status="processing")
        background.add_task(_reembed, user.id, config)
    response.status_code = 202
    return knowledge_library(user)


def _search_body(tenant_id: str, project_id: str | None, req: KnowledgeSearchRequest) -> dict[str, Any]:
    embedding = _knowledge.get_embedding(tenant_id)
    if embedding is None:
        return {"results": []}
    context = kb.store_context(_knowledge, tenant_id, project_id, get_embeddings(embedding))
    hits = context.search(req.query, req.k)
    collector = UsageCollector()
    _embedding_counter(collector, embedding, "embedding_query")([req.query])
    _record_usage(tenant_id, project_id, collector.entries(), run_id=uuid.uuid4().hex)
    return {
        "results": [
            {"filename": h.filename, "source": h.source, "text": h.text, "score": h.score}
            for h in hits
        ]
    }


@app.post("/knowledge/search")
def search_library(req: KnowledgeSearchRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Search your whole library."""
    return _search_body(user.id, None, req)


@app.post("/projects/{project_id}/knowledge/search")
def search_knowledge(
    project_id: str, req: KnowledgeSearchRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Search the files attached to this project, the way its agents' knowledge_search
    does."""
    _get_project(project_id, user)
    return _search_body(user.id, project_id, req)


# --------------------------------------------------------------------------- usage dashboard
@app.get("/usage")
def usage_dashboard(
    background: BackgroundTasks,
    days: int = 30,
    project_id: str | None = None,
    user: UserRecord = Depends(current_user),
) -> dict[str, Any]:
    """Models, tokens and estimated cost of everything the signed-in user ran: agent
    runs (local, deployed, and deployed runs invoked straight through AWS), planner and
    assistant calls, and embeddings — totals, per day, per model, per project, per kind
    of work, and the most recent runs.

    Also starts a background sync of deployed runtimes' usage logs (at most every two
    minutes per project); `deployments` says how far each has been read."""
    deployed = _deployed_projects(user, project_id)
    cloud = _make_cloud() if deployed else None
    if cloud is not None:
        background.add_task(_sync_projects, deployed, cloud)
    days = min(max(days, 1), 366)
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1)
    since = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    records = [r.model_dump() for r in _usage.list(user.id, since, project_id)]
    names = {p.id: p.brief for p in _store.list_for_tenant(user.id)}
    table = usage_mod.prices()
    body = usage_mod.dashboard(
        records, start=start, days=days, project_names=names, currency=table.get("currency", "USD")
    )
    body["deployments"] = _deployments_usage_status(deployed)
    body["sync_available"] = cloud is not None or not deployed
    return body


@app.post("/usage/sync")
def sync_usage(project_id: str | None = None, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Read deployed runtimes' usage logs now, so runs invoked straight through AWS
    (not through this platform) are counted. Per deployment: synced / skipped / failed."""
    deployed = _deployed_projects(user, project_id)
    if not deployed:
        return {"results": [], "deployments": []}
    cloud = _make_cloud()
    if cloud is None:
        raise DeployNotConfiguredError()
    results = _sync_projects(deployed, cloud, force=True)
    return {"results": results, "deployments": _deployments_usage_status(_deployed_projects(user, project_id))}


@app.get("/usage/pricing")
def usage_pricing(user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The price table used for cost estimates, and the models in your usage (last 90
    days) that have no price yet."""
    table = usage_mod.prices()
    since = datetime.now(timezone.utc) - timedelta(days=90)
    seen = {(r.provider, r.model) for r in _usage.list(user.id, since)}
    return {
        "currency": table.get("currency", "USD"),
        "file": "backend/pricing.json",
        "models": table.get("models", {}),
        "unpriced": sorted(
            f"{p}/{m}" for p, m in seen if usage_mod.price_for(p, m, table) is None
        ),
    }


# --------------------------------------------------------------------------- deploy
@app.get("/projects/{project_id}/deployment")
def get_deployment(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The project's deployment (or null), and whether this server can deploy at all."""
    project = _get_project(project_id, user)
    return {
        "available": _make_cloud() is not None,
        "region": AGENTCORE_REGION,
        "deployment": _deployment_body(project),
    }


@app.post("/projects/{project_id}/deploy", status_code=202)
def deploy_project(
    project_id: str, background: BackgroundTasks, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Deploy the compiled plan to Amazon Bedrock AgentCore Runtime, or redeploy it.

    Returns at once; packaging, upload and provisioning run in the background and are
    reported through GET /projects/{id}/deployment. The previous version, if any, keeps
    serving until the new one is ready.
    """
    project = _get_project(project_id, user)
    if not project.is_compiled:
        raise NotCompiledError(project_id)
    cloud = _make_cloud()
    if cloud is None:
        raise DeployNotConfiguredError()
    previous = project.deployment.effective() if project.deployment else None
    if previous is not None and previous.in_progress:
        raise DeployInProgressError()
    # Fail now, not minutes into the job, if a key the plan needs isn't configured or
    # the knowledge base its agents search isn't ready to be copied.
    snapshot = None
    embedding = None
    if uses_knowledge(project.plan):
        docs = [d.effective() for d in _knowledge.list_documents(user.id, project_id)]
        if any(d.status in ("queued", "processing") for d in docs):
            raise KnowledgeBusyError()
        embedding = _knowledge.get_embedding(user.id)
        if embedding is None or not any(d.status == "ready" for d in docs):
            raise KnowledgeUnavailableError()

        def snapshot():
            return kb.build_snapshot(_knowledge, user.id, project_id, embedding)

    runtime_environment(project.plan, embedding)

    deployment = Deployment(
        status="packaging",
        plan_version=project.plan_version,
        region=cloud.region,
        runtime_name=runtime_name(project_id),
        runtime_id=previous.runtime_id if previous else None,
        runtime_arn=previous.runtime_arn if previous else None,
        live_plan_version=previous.live_plan_version if previous else None,
        deployed_at=previous.deployed_at if previous else None,
        reports_usage=previous.reports_usage if previous else False,
        usage_synced_until=previous.usage_synced_until if previous else None,
    )
    _store.set_deployment(project_id, deployment)
    background.add_task(run_deployment, project_id, _store, cloud, _package_builder, snapshot, embedding)
    return {"deployment": _deployment_body(_get_project(project_id, user))}


@app.post("/projects/{project_id}/deployment/invoke")
def invoke_deployment(
    project_id: str, req: DeployedInvokeRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Run the deployed flow on AgentCore — same input and output shape as /run."""
    project = _get_project(project_id, user)
    deployment = project.deployment
    if deployment is None or not deployment.live:
        raise NotDeployedError()
    cloud = _make_cloud()
    if cloud is None:
        raise DeployNotConfiguredError()
    run_id = uuid.uuid4().hex
    payload: dict[str, Any] = {"input": req.input, "run_id": run_id}
    if req.agent_id is not None:
        payload["agent_id"] = req.agent_id
        payload["upstream_outputs"] = req.upstream_outputs
    # The live runtime may serve an older plan version than the project's current one;
    # wait for whichever of the two allows the longer run.
    timeout_s = max(project.plan.bounds.timeout_s, RunBounds().timeout_s)
    result = cloud.invoke(deployment.runtime_arn, payload, timeout_s)
    # The runtime reports its own usage; runtimes deployed before usage reporting don't.
    entries = [e for e in result.get("usage") or [] if isinstance(e, dict) and "model" in e]
    _record_usage(user.id, project_id, entries, run_id=run_id, deployed=True, via="platform")
    return {
        "project_id": project_id,
        "plan_version": deployment.live_plan_version,
        "outputs": result.get("outputs", {}),
        "errors": result.get("errors", []),
        "halted": bool(result.get("halted", False)),
        "usage": usage_mod.summarize(entries),
    }


@app.delete("/projects/{project_id}/deployment")
def delete_deployment(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Take the deployment down: delete the AgentCore runtime and its code packages."""
    project = _get_project(project_id, user)
    if project.deployment is None:
        raise NotDeployedError()
    if project.deployment.effective().in_progress:
        raise DeployInProgressError()
    cloud = _make_cloud()
    if cloud is None:
        raise DeployNotConfiguredError()
    remove_deployment(project_id, _store, cloud)
    return {"deployment": None}


# --------------------------------------------------------------------------- errors
def _error_response(status: int, error_type: str, message: str, details: Any = None):
    return JSONResponse(
        status_code=status,
        content={"error_type": error_type, "message": message, "details": details},
    )


@app.exception_handler(ProjectNotFoundError)
def _handle_not_found(_req: Request, exc: ProjectNotFoundError):
    return _error_response(404, "ProjectNotFound", str(exc))


@app.exception_handler(NotCompiledError)
def _handle_not_compiled(_req: Request, exc: NotCompiledError):
    return _error_response(409, "NotCompiled", str(exc))


@app.exception_handler(UnknownToolError)
def _handle_unknown_tool(_req: Request, exc: UnknownToolError):
    return _error_response(400, "UnknownTool", str(exc), {"names": exc.names})


@app.exception_handler(UnsupportedProviderError)
def _handle_unsupported_provider(_req: Request, exc: UnsupportedProviderError):
    return _error_response(400, "UnsupportedProvider", str(exc))


@app.exception_handler(MissingProviderKeyError)
def _handle_missing_key(_req: Request, exc: MissingProviderKeyError):
    # Server misconfiguration, not client error — but never echo the key or its value.
    return _error_response(500, "MissingProviderKey", str(exc))


@app.exception_handler(MissingToolKeyError)
def _handle_missing_tool_key(_req: Request, exc: MissingToolKeyError):
    # Server misconfiguration, not client error — but never echo the key or its value.
    return _error_response(500, "MissingToolKey", str(exc))


@app.exception_handler(AuthenticationError)
def _handle_unauthenticated(_req: Request, exc: AuthenticationError):
    response = _error_response(401, "Unauthenticated", str(exc))
    response.headers["WWW-Authenticate"] = "Bearer"
    return response


@app.exception_handler(EmailTakenError)
def _handle_email_taken(_req: Request, exc: EmailTakenError):
    return _error_response(409, "EmailTaken", str(exc))


@app.exception_handler(RequestValidationError)
def _handle_request_validation(_req: Request, exc: RequestValidationError):
    # Same typed shape as every other failure. Each entry keeps where and why, but not
    # `input` — that is the rejected value itself, which for /auth routes is a password.
    details = [
        {"loc": [str(part) for part in e["loc"]], "msg": e["msg"], "type": e["type"]}
        for e in exc.errors()
    ]
    first = details[0]
    field = ".".join(part for part in first["loc"] if part != "body") or "request"
    return _error_response(422, "ValidationError", f"{field}: {first['msg']}", details)


@app.exception_handler(StoreUnavailableError)
def _handle_store_unavailable(_req: Request, exc: StoreUnavailableError):
    return _error_response(503, "StoreUnavailable", str(exc))


@app.exception_handler(RunTimeoutError)
def _handle_run_timeout(_req: Request, exc: RunTimeoutError):
    return _error_response(504, "RunTimeout", str(exc), {"limit_s": exc.limit_s})


@app.exception_handler(DeployNotConfiguredError)
def _handle_deploy_not_configured(_req: Request, exc: DeployNotConfiguredError):
    return _error_response(503, "DeployNotConfigured", str(exc))


@app.exception_handler(DeployInProgressError)
def _handle_deploy_in_progress(_req: Request, exc: DeployInProgressError):
    return _error_response(409, "DeployInProgress", str(exc))


@app.exception_handler(NotDeployedError)
def _handle_not_deployed(_req: Request, exc: NotDeployedError):
    return _error_response(409, "NotDeployed", str(exc))


@app.exception_handler(DeployedRunError)
def _handle_deployed_run(_req: Request, exc: DeployedRunError):
    # The runtime's own typed error, passed through; 502 because it came from upstream.
    return _error_response(502, exc.error_type, str(exc), {"runtime_status": exc.status})


@app.exception_handler(ClientError)
@app.exception_handler(BotoCoreError)
def _handle_aws(_req: Request, exc: Exception):
    # AWS refused or failed a call (permissions, quotas, a missing resource); its message
    # says which, and holds no secrets.
    return _error_response(502, "AwsError", str(exc))


@app.exception_handler(DeployError)
def _handle_deploy(_req: Request, exc: DeployError):
    return _error_response(502, "DeployFailed", str(exc))


@app.exception_handler(KnowledgeError)
def _handle_knowledge(_req: Request, exc: KnowledgeError):
    return _error_response(exc.status, "KnowledgeRejected", str(exc))


@app.exception_handler(KnowledgeUnavailableError)
def _handle_knowledge_unavailable(_req: Request, exc: KnowledgeUnavailableError):
    return _error_response(409, "KnowledgeUnavailable", str(exc))


@app.exception_handler(KnowledgeBusyError)
def _handle_knowledge_busy(_req: Request, exc: KnowledgeBusyError):
    return _error_response(409, "KnowledgeBusy", str(exc))


@app.exception_handler(DocumentNotFoundError)
def _handle_document_not_found(_req: Request, exc: DocumentNotFoundError):
    return _error_response(404, "DocumentNotFound", str(exc))


@app.exception_handler(ProjectDeployedError)
def _handle_project_deployed(_req: Request, exc: ProjectDeployedError):
    return _error_response(409, "ProjectDeployed", str(exc))


@app.exception_handler(PlanConflictError)
def _handle_plan_conflict(_req: Request, exc: PlanConflictError):
    return _error_response(409, "PlanConflict", str(exc))


@app.exception_handler(PlannerError)
def _handle_planner(_req: Request, exc: PlannerError):
    return _error_response(
        422, "PlannerFailed", str(exc), {"attempts": exc.attempts, "last_error": exc.last_error}
    )


@app.exception_handler(ValidationError)
def _handle_validation(_req: Request, exc: ValidationError):
    return _error_response(422, "ValidationError", "invalid plan or request", exc.errors())


@app.exception_handler(PlatformError)
def _handle_platform(_req: Request, exc: PlatformError):
    return _error_response(400, type(exc).__name__, str(exc))
