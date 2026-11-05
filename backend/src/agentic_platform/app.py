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
import re
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from urllib.parse import quote
from typing import Any, Callable, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import BackgroundTasks, Depends, FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field, ValidationError, field_validator, model_validator

from . import export as export_mod
from . import mailer
from . import knowledge as kb
from . import usage as usage_mod
from .agent_schema import AgentPlan, EmbeddingConfig, LLMConfig, RunBounds
from .auth import create_access_token, decode_access_token, hash_password, verify_password
from .agentcore import make_cloud
from .config import (
    BIGQUERY_MAX_BYTES,
    BIGQUERY_MAX_ROWS,
    BIGQUERY_PROJECT,
    GCP_SERVICE_ACCOUNT,
    GCP_WIF_AUDIENCE,
    MCP_CALL_TIMEOUT_S,
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
from . import capabilities as caps
from . import datasources as ds
from . import mcp_client as mc
from . import secrets_box
from .deploy import build_package, remove_deployment, run_deployment, runtime_environment, runtime_name
from .errors import (
    AdminNotFoundError,
    AuthenticationError,
    MasterAdminLockedError,
    MasterAdminRequiredError,
    NotATeamMemberError,
    ShareError,
    TeamNotFoundError,
    TeamProtectedError,
    EmailTakenError,
    MissingProviderKeyError,
    DeployedRunError,
    DeployError,
    DeployInProgressError,
    DeployNotConfiguredError,
    DataSourceError,
    ModelCannotCallToolsError,
    RunNotFoundError,
    RunNotStoppableError,
    AccessRevokedError,
    RunStoppedError,
    DataSourceNotFoundError,
    DataSourceUnavailableError,
    DocumentNotFoundError,
    KnowledgeBusyError,
    KnowledgeError,
    KnowledgeUnavailableError,
    McpError,
    McpServerNotFoundError,
    McpUnavailableError,
    NotDeployedError,
    PlanConflictError,
    ProjectDeployedError,
    RunTimeoutError,
    SecretsNotConfiguredError,
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
    run_agent_events,
)
from .meta_planner_prompt import discuss_brief, plan_project, revise_plan
from . import audit as audit_log
from . import model_policy as mpol
from .model_gateway import CallIdentity
from .policy import (
    Actor,
    access_rank,
    actor_for,
    any_access,
    can,
    OWNER_RANK,
    has_full_rank,
    list_visible_projects,
    may_share,
    sharing_teams,
)
from .rbac_backfill import DEFAULT_TEAM_ID, backfill as backfill_teams
from .stores import (
    ADMIN_ROLES,
    DataSource,
    ModelCapability,
    RunRecord,
    ChatMessage,
    Deployment,
    KnowledgeDocument,
    McpAuthKind,
    McpServer,
    McpTool,
    ProjectRecord,
    GRANT_LEVELS,
    WHOLE_PROJECT,
    AgentFallback,
    AgentGrant,
    ModelAllowlist,
    OrgModelSettings,
    level_rank,
    model_key,
    valid_model_ref,
    TEAM_NAME_MAX,
    TeamMembership,
    TeamRecord,
    UsageRecord,
    UserRecord,
    make_capability_store,
    PROJECT_NAME_MAX,
    brief_title,
    make_run_store,
    make_audit_store,
    make_grant_store,
    make_model_policy_store,
    make_team_store,
    make_datasource_store,
    make_mcp_store,
    make_stores,
)
from .usage import UsageCollector
from .usage_sync import make_records, sync_deployed_usage
from .tools import (
    DATA_TOOLS,
    KNOWLEDGE_TOOLS,
    SIDE_EFFECT_TOOLS,
    TOOL_REGISTRY,
    TOOL_SUMMARIES,
    default_tool_names,
    is_mcp_tool,
    uses_data,
    uses_knowledge,
    uses_mcp,
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
    # Exports name their file here; the console reads it to save the download.
    expose_headers=["Content-Disposition"],
)

_store, _users, _knowledge, _usage = make_stores()
_datasources = make_datasource_store()
_mcp = make_mcp_store()
_capabilities = make_capability_store()
_runs = make_run_store()
_teams = make_team_store()
_audit = make_audit_store()
_grants = make_grant_store()
_models = make_model_policy_store()
logger = logging.getLogger(__name__)

try:  # existing installations move onto teams once; idempotent and never blocks start-up
    backfill_teams(_users, _store, _teams)
except Exception:  # noqa: BLE001 - an unreachable store surfaces on the first request instead
    logger.exception("rbac backfill failed; will retry on next start")


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
class IntakeMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4_000)


class CreateProjectRequest(BaseModel):
    brief: str = Field(min_length=1)
    # Optional; without one the project is called by its brief's first line.
    name: str | None = Field(default=None, max_length=PROJECT_NAME_MAX)
    # Omit to let the planner choose the team size (still capped at MAX_AGENTS).
    agent_count: int | None = Field(default=None, gt=0, le=MAX_AGENTS)
    available_tools: list[str] | None = None
    available_llms: list[dict[str, str]] | None = None
    # Files from the user's knowledge library to attach to the new project. The planner is
    # told their names, so it can give the agents that need them knowledge_search.
    document_ids: list[str] = Field(default_factory=list, max_length=50)
    # Data sources (BigQuery) to attach to the new project. The planner is told their
    # table names, so it can give the agents that need data sql_schema / sql_query.
    datasource_ids: list[str] = Field(default_factory=list, max_length=20)
    # MCP servers to attach to the new project. The planner is told the names and
    # descriptions of their approved tools, never anything they return.
    mcp_server_ids: list[str] = Field(default_factory=list, max_length=20)
    # The new-project conversation that led to this brief (POST /brief/chat), kept as the
    # project's conversation so the plan assistant knows how the brief came about.
    intake: list[IntakeMessage] = Field(default_factory=list, max_length=40)


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


class ModelChoice(BaseModel):
    provider: str = Field(min_length=1, max_length=40)
    model: str = Field(min_length=1, max_length=120)


class ReviseRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    # The Assistant's chips. Each is optional and limits only this change: omitted, the
    # revision works as before.
    # Every agent of the revised plan uses this model.
    model: ModelChoice | None = None
    # At most this many agents.
    agent_count: int | None = Field(default=None, gt=0, le=MAX_AGENTS)
    # The registry tools the planner may use. Switching an external tool on here is the
    # project's opt-in to it (an explicit user action, like PUT /agents); the message
    # text never is. Knowledge, data and MCP tools follow the project's attachments.
    tools: list[str] | None = Field(default=None, max_length=50)


class DeployedInvokeRequest(BaseModel):
    input: dict[str, Any]
    # Run one agent instead of the whole graph.
    agent_id: str | None = None
    upstream_outputs: dict[str, Any] = Field(default_factory=dict)


class RunRequest(BaseModel):
    input: dict[str, Any]


class EmailRunRequest(BaseModel):
    """Email a run's output (one agent's, or every finished agent's) as attachments."""

    to: list[EmailStr] = Field(min_length=1, max_length=mailer.MAX_RECIPIENTS)
    cc: list[EmailStr] = Field(default_factory=list, max_length=mailer.MAX_RECIPIENTS)
    subject: str = Field(min_length=1, max_length=200)
    message: str = Field(default="", max_length=5_000)
    formats: list[Literal["docx", "pdf", "csv"]] = Field(min_length=1, max_length=6)  # de-duplicated below
    include_body: bool = False
    agent_id: str | None = Field(default=None, max_length=64)

    @field_validator("subject")
    @classmethod
    def _one_line(cls, value: str) -> str:
        # A line break in a header would let the sender inject other headers.
        if "\r" in value or "\n" in value:
            raise ValueError("the subject must be a single line")
        return value.strip()

    @model_validator(mode="after")
    def _recipients(self) -> "EmailRunRequest":
        everyone = [a.lower() for a in [*self.to, *self.cc]]
        if len(set(everyone)) > mailer.MAX_RECIPIENTS:
            raise ValueError(f"at most {mailer.MAX_RECIPIENTS} recipients (To and CC together)")
        self.formats = list(dict.fromkeys(self.formats))
        return self


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
    return {"id": user.id, "email": user.email, "role": user.role, "created_at": user.created_at}


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


def _project_body(project: ProjectRecord, can_manage: bool = True) -> dict[str, Any]:
    # Every route that returns this body already required manage access; only the
    # view-only GET passes False.
    return {
        "can_manage": can_manage,
        "access_level": "owner" if can_manage else None,  # get_project fills in the real one
        "project_id": project.id,
        "name": project.display_name,
        "named": project.name is not None,
        "brief": project.brief,
        "plan": project.plan.model_dump(),
        "plan_version": project.plan_version,
        "compiled": project.is_compiled,
        "side_effect_tools_enabled": project.side_effect_tools_enabled,
        "conversation": [m.model_dump() for m in project.conversation],
        "deployment": _deployment_body(project),
        "knowledge": _knowledge_summary(project),
        "data_sources": _data_summary(project),
        "mcp": _mcp_summary(project),
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }


def _mcp_summary(project: ProjectRecord) -> dict[str, Any]:
    """The attached MCP servers and their approved tools: what the Brief editor may offer."""
    servers = _attached_mcp(project)
    return {
        "servers": len(servers),
        "tools": [
            {
                "name": mc.exposed_name(s.slug, t.name),
                "tool": t.name,
                "server": s.name,
                "description": t.description,
                "side_effect": not t.looks_read_only(),
            }
            for s in servers for t in s.usable_tools()
        ],
    }


def _data_summary(project: ProjectRecord) -> dict[str, Any]:
    sources = _datasources.list(project.tenant_id, project.id)
    return {"sources": len(sources), "tables": sum(len(s.tables) for s in sources)}


def _actor(user: UserRecord) -> Actor:
    """Who is asking, with their team roles (read per request, so changes apply at once)."""
    return actor_for(user, _teams)


def _get_project(project_id: str, user: UserRecord, action: str = "project.manage") -> ProjectRecord:
    """Load a project the caller may act on. `action` is a policy action: the default,
    `project.manage`, is for anything that changes or runs the project (its owner, the
    Super Admin, or a Group Admin of the team that shares it); `project.view` is for
    read-only access. A project outside the caller's scope is reported exactly like a
    missing one (404), so ids can't be probed for existence."""
    project = _store.get(project_id)
    if project is None or not can(_actor(user), action, project):
        raise ProjectNotFoundError(project_id)
    return project


def _project_at(project_id: str, user: UserRecord, level: str, agent_id: str | None = None) -> ProjectRecord:
    """Load a project the caller holds at least `level` on (view < use < edit < manage): their
    own, one their team or admin role reaches, or one shared with them. `agent_id` asks about
    one agent (a grant on that agent or on the whole project counts); None about the whole
    project. Not enough access reads exactly like a missing project (404)."""
    actor = _actor(user)
    project = _store.get(project_id)
    grants = _grants.list_for_project(project_id) if project is not None else []
    if project is None or not any_access(actor, project, grants):
        raise ProjectNotFoundError(project_id)
    # Seeing a project needs only some access to it (even one agent); anything more needs the rank.
    if level != "view" and access_rank(actor, project, agent_id, grants) < level_rank(level):
        raise ProjectNotFoundError(project_id)
    return project


def _call_identity(project: ProjectRecord, user_id: str) -> CallIdentity:
    """Who a run is for, with a check the model gateway runs before EVERY model call of the run
    (agents, tool loops, the supervisor): the person must still be able to use the project or
    agent. Revoking a share, removing someone from a team, or deleting the project or the
    account therefore ends their live run at its next model call, with `AccessRevokedError`.
    It reads the current records each time; nothing is cached."""

    def check(agent_id: str | None) -> None:
        who = _users.get(user_id)
        current = _store.get(project.id)
        if who is None or current is None:
            raise AccessRevokedError()
        rank = access_rank(_actor(who), current, agent_id if agent_id else None, _grants.list_for_project(project.id))
        if rank < level_rank("use"):
            raise AccessRevokedError()

    return CallIdentity(user_id=user_id, project_id=project.id, team_id=project.team_id, check=check)


def _compiled_graph(project: ProjectRecord) -> Any:
    # Knowledge files and their embedding models are read at search time, so only the plan
    # version keys the cache.
    cached = _COMPILED.get(project.id)
    if cached is not None and cached[0] == project.plan_version:
        return cached[1]
    problems = _tool_problems(project.plan, project.tenant_id)
    if problems:
        raise ModelCannotCallToolsError("; ".join(problems))
    graph = compile_graph(
        project.plan, _knowledge_context(project), _data_context(project),
        _json_models(project.plan, project.tenant_id), mcp=_mcp_context(project),
    )
    _COMPILED[project.id] = (project.plan_version, graph)
    return graph


# --------------------------------------------------------------------------- knowledge
def _embedder_for(config: EmbeddingConfig):
    """The embedder for one file's model (files may each use a different model)."""
    return get_embeddings(config)


def _knowledge_context(project: ProjectRecord) -> kb.KnowledgeContext | None:
    """The files attached to the project, for knowledge_search — or None when no agent uses
    it or nothing is attached (compiling then fails with KnowledgeUnavailable)."""
    if not uses_knowledge(project.plan):
        return None
    if not _knowledge.list_documents(project.tenant_id, project.id):
        return None
    return kb.store_context(_knowledge, project.tenant_id, project.id, _embedder_for)


# --------------------------------------------------------------------------- tool calling
# One lock per model, so concurrent requests check a model once.
_CHECK_LOCKS: dict[str, threading.Lock] = {}
_CHECK_LOCKS_GUARD = threading.Lock()


def _stored_tool_calling(provider: str, model: str) -> bool | None:
    """True/False from what's known; None if this model hasn't been checked (or the check
    is older than CHECK_VALID_FOR)."""
    if not caps.needs_check(provider):
        return True
    item = _capabilities.get(caps.model_key(provider, model))
    if item is None or datetime.now(timezone.utc) - _aware(item.checked_at) > caps.CHECK_VALID_FOR:
        return None
    return item.tool_calling


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _tool_calling(provider: str, model: str, tenant_id: str | None = None) -> bool | None:
    """Whether the model can call tools, checking it once (one tiny call, counted to the
    tenant who triggered it) if nobody has yet. None: the check was inconclusive."""
    known = _stored_tool_calling(provider, model)
    if known is not None:
        return known
    key = caps.model_key(provider, model)
    with _CHECK_LOCKS_GUARD:
        lock = _CHECK_LOCKS.setdefault(key, threading.Lock())
    with lock:
        known = _stored_tool_calling(provider, model)  # checked while we waited
        if known is not None:
            return known
        collector = UsageCollector()
        verdict = caps.probe_tool_calling(provider, model, collector)
        if tenant_id is not None:
            _record_usage(tenant_id, None, collector.entries(), run_id=uuid.uuid4().hex)
        if verdict is not None:
            _capabilities.set(ModelCapability(key=key, tool_calling=verdict, source="probe"))
            _COMPILED.clear()
        return verdict


def _json_models(plan: AgentPlan, tenant_id: str | None = None) -> set[str]:
    """The plan's models that can't call tools: their agents answer by JSON."""
    out = set()
    for agent in plan.agents:
        if _tool_calling(agent.llm.provider, agent.llm.model, tenant_id) is False:
            out.add(caps.model_key(agent.llm.provider, agent.llm.model))
    return out


def _tool_problems(plan: AgentPlan, tenant_id: str | None = None) -> list[str]:
    """Agents given a job their model can't do: tools, or routing the team."""
    problems = []
    for agent in plan.agents:
        needs = bool(agent.tools) or agent.id == plan.supervisor_id
        if needs and _tool_calling(agent.llm.provider, agent.llm.model, tenant_id) is False:
            job = "has tools" if agent.tools else "routes the team (supervisor)"
            problems.append(
                f"agent '{agent.id}' {job}, but {agent.llm.model} can't call tools; remove its tools "
                "or choose a model that can call tools"
            )
    return problems


def _flag_tools(llms: list[dict[str, Any]], tenant_id: str | None, check: bool) -> list[dict[str, Any]]:
    """The planner's model options, marked (by the server, never the caller) where a model
    can't call tools."""
    out = []
    for m in llms:
        provider, model = str(m.get("provider")), str(m.get("model"))
        verdict = _tool_calling(provider, model, tenant_id) if check else _stored_tool_calling(provider, model)
        entry = {"provider": provider, "model": model}
        if verdict is False:
            entry["tools"] = False
        out.append(entry)
    return out


def _learn_from_errors(project: ProjectRecord, errors: list[dict[str, Any]]) -> None:
    """A run that failed because a model can't call tools records that, so it's disabled
    for agents with tools from now on."""
    agents = {a.id: a for a in project.plan.agents}
    for e in errors or []:
        agent = agents.get(e.get("agent_id"))
        if agent and "ModelCannotCallToolsError" in str(e.get("error", "")) and caps.needs_check(agent.llm.provider):
            _capabilities.set(ModelCapability(
                key=caps.model_key(agent.llm.provider, agent.llm.model), tool_calling=False, source="run",
            ))
            _COMPILED.clear()


# One BigQuery client per (service account, billing project) per process: each holds
# its federated Google token and refreshes it, so queries don't sign in every time.
_BQ_CLIENTS: dict[tuple[str, str], ds.BigQueryClient] = {}


def _bq_client(source: ds.DataSourceConfig) -> ds.BigQueryClient:
    key = (source.service_account, source.billing_project)
    if key not in _BQ_CLIENTS:
        _BQ_CLIENTS[key] = ds.BigQueryClient(source.billing_project, source.service_account)
    return _BQ_CLIENTS[key]


def _data_context(project: ProjectRecord) -> ds.DataContext | None:
    """The data sources attached to the project, for sql_schema / sql_query — or None when
    no agent uses them or none is attached (compiling then fails with
    DataSourceUnavailable). Sources are read at call time."""
    if not uses_data(project.plan) or not _attached_sources(project):
        return None
    return ds.DataContext(
        lambda: [s.config() for s in _attached_sources(project)],
        lambda source: _bq_client(source),
        labels={"agentic_project": project.id},
    )


def _attached_sources(project: ProjectRecord) -> list[Any]:
    return [s for s in _datasources.list(project.tenant_id, project.id) if s.tables]


def _has_ready_knowledge(project: ProjectRecord) -> bool:
    return any(d.status == "ready" for d in _knowledge.list_documents(project.tenant_id, project.id))


def _offered_tools(project: ProjectRecord, chosen: list[str] | None = None) -> list[str]:
    """Tools the planner may give this project's agents: the built-ins, the external
    tools this project opted into, and knowledge_search once a ready file is attached.
    `chosen` (the Assistant's Tools chip) replaces the built-in and external part; the
    tools that follow attachments are added either way."""
    if chosen is None:
        tools = set(default_tool_names()) | set(project.side_effect_tools_enabled)
    else:
        tools = {t for t in chosen if t not in KNOWLEDGE_TOOLS | DATA_TOOLS and not is_mcp_tool(t)}
    if _has_ready_knowledge(project):
        tools |= KNOWLEDGE_TOOLS
    if _attached_sources(project):
        tools |= DATA_TOOLS
    # The approved tools of attached MCP servers: attaching is the project's opt-in.
    tools |= set(_mcp_tool_notes(_attached_mcp(project)))
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


def _document_body(doc: KnowledgeDocument, default: EmbeddingConfig | None = None) -> dict[str, Any]:
    """A file as the API shows it, with the embedding model it is indexed with (the
    library default for files from before per-file models)."""
    body = doc.effective().model_dump(exclude={"tenant_id"})
    if body["embedding"] is None:
        default = default or _knowledge.get_embedding(doc.tenant_id)
        body["embedding"] = default.model_dump() if default else None
    return body


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


def _reembed(tenant_id: str, document_id: str, config: EmbeddingConfig) -> None:
    """Background job: re-index one file with a different embedding model."""
    collector = UsageCollector()
    try:
        try:
            embedder = get_embeddings(config)
        except Exception as e:  # noqa: BLE001 — recorded on the document, never raised
            _knowledge.update_document(tenant_id, document_id, status="failed", error=kb._describe(e))
            return
        kb.reembed_document(
            _knowledge, tenant_id, document_id, embedder, config,
            on_embedded=_embedding_counter(collector, config, "embedding_index"),
        )
    finally:
        _record_usage(tenant_id, None, collector.entries(), run_id=uuid.uuid4().hex)


# --------------------------------------------------------------------------- saved runs
# Every run is saved as it happens (RunRecord), so leaving the page, refreshing or another
# browser never loses it; the last RUNS_KEPT per project and kind are kept. Known
# deviation: background runs are in-process threads until the job queue exists.
FLUSH_EVERY_S = 0.5
# How often a run checks its saved record for a stop requested through another process.
STOP_POLL_S = 2.0
# Stop flags of the runs this process is running, by run id.
_STOP_FLAGS: dict[str, threading.Event] = {}


def _stored_event(event: str, data: dict[str, Any]) -> dict[str, Any]:
    """An event as saved: a node's output is kept once, in the run's `outputs`."""
    body = {"event": event, **{k: v for k, v in data.items() if not (event == "node_completed" and k == "output")}}
    return json.loads(json.dumps(body, default=str))


class _RunRecorder:
    """Writes one run's events to the store, batched, and its outcome when it ends."""

    def __init__(self, run: RunRecord):
        self.run = run
        self.outputs: dict[str, Any] = {}
        self.buffer: list[dict[str, Any]] = []
        self.flushed_at = time.monotonic()
        self.stop = threading.Event()
        self.stop_checked_at = time.monotonic()
        self.exception: BaseException | None = None  # what ended a failed run, for a typed reply
        _STOP_FLAGS[run.id] = self.stop

    def event(self, event: str, data: dict[str, Any]) -> None:
        if event == "node_completed" and data.get("node"):
            self.outputs[data["node"]] = data.get("output")
        self.buffer.append(_stored_event(event, data))
        # run_started is saved at once, so a reloaded page sees the run has begun.
        if event == "run_started" or time.monotonic() - self.flushed_at >= FLUSH_EVERY_S:
            self.flush()

    def stop_requested(self) -> bool:
        """Whether the user asked to stop this run: at once when the request reached this
        process, else from the saved run (another worker took the request)."""
        if not self.stop.is_set() and time.monotonic() - self.stop_checked_at >= STOP_POLL_S:
            self.stop_checked_at = time.monotonic()
            try:
                saved = _runs.get(self.run.tenant_id, self.run.project_id, self.run.id)
            except Exception:  # noqa: BLE001 — a store hiccup never stops a run
                saved = None
            if saved is not None and saved.stop_requested:
                self.stop.set()
        return self.stop.is_set()

    def flush(self, **changes: Any) -> None:
        events, self.buffer = self.buffer, []
        try:
            _runs.update(self.run.tenant_id, self.run.id, new_events=events,
                         outputs=json.loads(json.dumps(self.outputs, default=str)), **changes)
        except Exception:  # noqa: BLE001 — saving a run never fails the run itself
            logger.exception("saving run %s failed", self.run.id)
        self.flushed_at = time.monotonic()

    def finish(self, *, outputs: dict[str, Any] | None = None, errors: list[dict[str, Any]] | None = None,
               halted: bool = False, error: dict[str, Any] | None = None, usage: dict[str, Any] | None = None) -> None:
        _STOP_FLAGS.pop(self.run.id, None)
        if outputs is not None:
            self.outputs = dict(outputs)
        self.flush(
            status="failed" if error else "completed",
            errors=json.loads(json.dumps(errors or [], default=str)),
            halted=bool(halted), error=error, usage=usage, finished_at=datetime.now(timezone.utc),
        )


def _new_run(project: ProjectRecord, *, kind: str, mode: str, task_input: dict[str, Any],
             agent_id: str | None = None, plan_version: int | None = None,
             started_by: str | None = None) -> RunRecord:
    run = RunRecord(
        id=uuid.uuid4().hex, tenant_id=project.tenant_id, project_id=project.id, kind=kind, mode=mode,
        # the owner's own runs stay None, as before sharing existed
        started_by=started_by if started_by and started_by != project.tenant_id else None,
        agent_id=agent_id, plan_version=plan_version if plan_version is not None else project.plan_version,
        input=task_input, timeout_s=max(project.plan.bounds.timeout_s, RunBounds().timeout_s),
    )
    try:
        _runs.create(run)
        _runs.prune(project.tenant_id, project.id, kind)
    except Exception:  # noqa: BLE001 — saving a run never stops it
        logger.exception("saving run for project %s failed", project.id)
    return run


def _graph_events(project: ProjectRecord, graph: Any, task_input: dict[str, Any], collector: UsageCollector,
                  recorder: _RunRecorder):
    """Run the graph, saving every event; yields them for a live stream."""
    events = run_graph_events(graph, task_input, project.plan.bounds, collector, should_stop=recorder.stop_requested,
                              identity=_call_identity(project, recorder.run.started_by or project.tenant_id))
    return _recorded_events(project, events, collector, recorder)


def _recorded_events(project: ProjectRecord, events: Any, collector: UsageCollector, recorder: _RunRecorder):
    """Save a run's events as they happen and yield them. The run is saved as completed or
    failed when it ends, and usage is recorded whatever happens."""
    terminal: tuple[str, dict[str, Any]] | None = None
    try:
        for event, data in events:
            if event == "run_failed" and "exception" in data:
                data = dict(data)
                recorder.exception = data.pop("exception")  # never saved or streamed
            if event in ("run_completed", "run_failed"):
                data = {**data, "usage": usage_mod.summarize(collector.entries())}
                terminal = (event, data)
                if event == "run_completed":
                    _learn_from_errors(project, data.get("errors") or [])
            recorder.event(event, data)
            yield event, data
    finally:
        if terminal is None:
            recorder.finish(error={"error_type": "RunInterrupted", "message": "the run stopped before it finished"},
                            usage=usage_mod.summarize(collector.entries()))
        elif terminal[0] == "run_completed":
            d = terminal[1]
            recorder.finish(outputs=d.get("outputs"), errors=d.get("errors"), halted=d.get("halted", False),
                            usage=d.get("usage"))
        else:
            d = terminal[1]
            recorder.finish(error={"error_type": d.get("error_type"), "message": d.get("message")},
                            usage=d.get("usage"))
        _record_usage(recorder.run.started_by or project.tenant_id, project.id, collector.entries(), run_id=recorder.run.id)


def _agent_run(project: ProjectRecord, agent_id: str, task_input: dict[str, Any],
               upstream: dict[str, Any], collector: UsageCollector, recorder: _RunRecorder) -> dict[str, Any]:
    """One agent on its own, saved like any run, with the same events, time limit and stop.
    Returns its outputs/errors/halted, or raises the typed error that ended it."""
    try:
        events = run_agent_events(
            project.plan, agent_id, task_input, upstream, _knowledge_context(project),
            usage=collector, data=_data_context(project), mcp=_mcp_context(project),
            json_models=_json_models(project.plan, project.tenant_id), should_stop=recorder.stop_requested,
            identity=_call_identity(project, recorder.run.started_by or project.tenant_id),
        )
    except Exception as e:  # e.g. a knowledge or MCP context that can't be set up
        recorder.finish(error={"error_type": type(e).__name__, "message": str(e) or "the agent failed"},
                        usage=usage_mod.summarize(collector.entries()))
        _record_usage(recorder.run.started_by or project.tenant_id, project.id, collector.entries(), run_id=recorder.run.id)
        raise
    completed: dict[str, Any] | None = None
    failed: dict[str, Any] = {}
    for event, data in _recorded_events(project, events, collector, recorder):
        if event == "run_completed":
            completed = data
        elif event == "run_failed":
            failed = data
    if completed is not None:
        return {"outputs": completed.get("outputs", {}), "errors": completed.get("errors", []),
                "halted": bool(completed.get("halted", False)), "usage": collector.entries()}
    if failed.get("error_type") == "RunTimeout":
        raise RunTimeoutError(project.plan.bounds.timeout_s)
    if failed.get("error_type") == "RunStopped":
        raise RunStoppedError("you stopped this run")
    if isinstance(recorder.exception, Exception):
        raise recorder.exception  # the typed platform error, as the endpoint always returned
    raise PlatformError(failed.get("message") or "the agent failed")


def _deployed_run(project: ProjectRecord, payload: dict[str, Any], recorder: _RunRecorder) -> dict[str, Any]:
    """Invoke the deployment, saving the outcome as a `deployed` run."""
    cloud = _make_cloud()
    deployment = project.deployment
    try:
        if deployment is None or not deployment.live:
            raise NotDeployedError()
        if cloud is None:
            raise DeployNotConfiguredError()
        timeout_s = max(project.plan.bounds.timeout_s, RunBounds().timeout_s)
        result = cloud.invoke(deployment.runtime_arn, {**payload, "run_id": recorder.run.id}, timeout_s)
    except Exception as e:
        recorder.finish(error={"error_type": type(e).__name__, "message": str(e) or "the deployed run failed"})
        raise
    entries = [e for e in result.get("usage") or [] if isinstance(e, dict) and "model" in e]
    _record_usage(project.tenant_id, project.id, entries, run_id=recorder.run.id, deployed=True, via="platform")
    summary = usage_mod.summarize(entries)
    if result.get("error_type"):  # the runtime's own typed error (e.g. RunTimeout)
        recorder.finish(error={"error_type": result["error_type"], "message": result.get("message", "")}, usage=summary)
    else:
        recorder.finish(outputs=result.get("outputs", {}), errors=result.get("errors", []),
                        halted=bool(result.get("halted", False)), usage=summary)
    return {**result, "usage_summary": summary}


def _in_background(target: Callable[[], Any], name: str) -> None:
    def work() -> None:
        try:
            target()
        except Exception:  # noqa: BLE001 — the run record already says what failed
            logger.info("background %s ended with an error (recorded on the run)", name)

    threading.Thread(target=work, daemon=True, name=name).start()


def _may_see_run(actor: Actor, project: ProjectRecord, run: RunRecord) -> bool:
    """The owner (and Super Admin / the team's group admin) see every run of the project; anyone
    it is shared with sees only the runs they started."""
    return has_full_rank(actor, project) or run.started_by == actor.user_id


def _get_run(project_id: str, run_id: str, user: UserRecord) -> RunRecord:
    project = _project_at(project_id, user, "use")
    run = _runs.get(project.tenant_id, project_id, run_id)
    if run is None or not _may_see_run(_actor(user), project, run):
        raise RunNotFoundError(run_id)
    return run.effective()


def _run_body(run: RunRecord) -> dict[str, Any]:
    return run.effective().model_dump(exclude={"tenant_id"})


class StartRunRequest(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)
    mode: Literal["graph", "agent"] = "graph"
    agent_id: str | None = Field(default=None, max_length=100)
    upstream_outputs: dict[str, Any] = Field(default_factory=dict)


@app.post("/projects/{project_id}/runs", status_code=202)
def start_run(project_id: str, req: StartRunRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Start a run in the background and save it as it happens. Returns at once; follow it
    with GET …/runs/{id}/stream (or poll GET …/runs/{id}). It keeps running if you leave."""
    project = _project_at(project_id, user, "use", req.agent_id if req.mode == "agent" else None)
    if req.mode == "agent":
        if not any(a.id == req.agent_id for a in project.plan.agents):
            return JSONResponse(status_code=404, content={
                "error_type": "AgentNotFound", "message": f"agent '{req.agent_id}' not in project '{project_id}'",
                "details": None})
        run = _new_run(project, kind="local", mode="agent", task_input=req.input, agent_id=req.agent_id,
                       started_by=user.id)
        recorder = _RunRecorder(run)
        _in_background(lambda: _agent_run(project, req.agent_id, req.input, req.upstream_outputs,
                                          UsageCollector(), recorder), f"agent-run-{run.id}")
        return {"run": _run_body(run)}
    if not project.is_compiled:
        raise NotCompiledError(project_id)
    graph = _compiled_graph(project)  # compile errors are this request's errors
    run = _new_run(project, kind="local", mode="graph", task_input=req.input, started_by=user.id)
    recorder = _RunRecorder(run)

    def drive() -> None:
        for _ in _graph_events(project, graph, req.input, UsageCollector(), recorder):
            pass

    _in_background(drive, f"graph-run-{run.id}")
    return {"run": _run_body(run)}


@app.get("/projects/{project_id}/runs")
def list_runs(
    project_id: str, kind: Literal["local", "deployed"] = "local", user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """The project's last saved runs of one kind (local or deployed), newest first."""
    project = _project_at(project_id, user, "use")
    actor = _actor(user)
    return {"runs": [r.summary() for r in _runs.list(project.tenant_id, project_id, kind) if _may_see_run(actor, project, r)]}


@app.get("/projects/{project_id}/runs/{run_id}")
def get_run(project_id: str, run_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """One saved run in full: input, events, outputs, errors and usage."""
    return {"run": _run_body(_get_run(project_id, run_id, user))}


@app.get("/projects/{project_id}/runs/{run_id}/export")
def export_run(
    project_id: str,
    run_id: str,
    format: Literal["docx", "pdf", "csv"],
    agent_id: str | None = None,
    user: UserRecord = Depends(current_user),
) -> Response:
    """One agent's output (`agent_id`), or every finished agent's, as a Word, PDF or CSV
    file with its sources. Owner-only like the run itself: someone else's project or run
    is a 404."""
    project = _project_at(project_id, user, "use")
    run = _get_run(project_id, run_id, user)
    doc = export_mod.build_export(project, run, agent_id)
    data = export_mod.render(doc, format)
    return Response(
        content=data,
        media_type=export_mod.MEDIA_TYPES[format],
        headers={"Content-Disposition": _attachment(export_mod.filename(doc, format)),
                 "Cache-Control": "no-store"},
    )


@app.post("/projects/{project_id}/runs/{run_id}/email")
def email_run(
    project_id: str, run_id: str, req: EmailRunRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Email a run's output with Word / PDF / CSV attachments made by the export pipeline
    (sources included), and optionally the output in the body. Owner-only; at most 10
    recipients and 20 MB of attachments; rate-limited per user. A sending failure is
    logged here and reported to the client without the server's details."""
    project = _project_at(project_id, user, "use")
    run = _get_run(project_id, run_id, user)
    config = mailer.mail_config()
    if config is None:
        raise MailError(503, "MailNotConfigured",
                        "email isn't set up on this server (an administrator sets SMTP_HOST and MAIL_FROM)")
    doc = export_mod.build_export(project, run, req.agent_id)
    files = [(export_mod.filename(doc, f), export_mod.MEDIA_TYPES[f], export_mod.render(doc, f)) for f in req.formats]
    total = sum(len(data) for _, _, data in files)
    if total > mailer.MAX_ATTACHMENT_BYTES:
        raise MailError(413, "AttachmentsTooLarge",
                        f"the attachments come to {total / 1_048_576:.1f} MB; the limit is 20 MB — choose fewer formats")
    if not mailer.limiter.allow(user.id):
        raise MailError(429, "RateLimited", "too many emails in the last hour; try again later")

    message = EmailMessage()
    message["From"] = config.sender
    message["To"] = ", ".join(req.to)
    if req.cc:
        message["Cc"] = ", ".join(req.cc)
    message["Reply-To"] = user.email
    message["Subject"] = req.subject
    body = [req.message.strip()] if req.message.strip() else []
    if req.include_body:
        body.append(export_mod.as_text(doc))
    body.append(f"— Sent by {user.email} from Agentic Platform ({doc.project_name}, run {run.id[:8]}).")
    message.set_content("\n\n".join(body))
    for name, media, data in files:
        maintype, subtype = media.split(";")[0].split("/")
        message.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    try:
        mailer.send(config, message)
    except Exception:  # noqa: BLE001 — logged in full here, never sent to the client
        logger.exception("email of run %s (project %s, user %s) failed", run.id, project_id, user.id)
        raise MailError(502, "MailSendFailed", "the email couldn't be sent; try again later")
    recipients = len({a.lower() for a in [*req.to, *req.cc]})
    logger.info("emailed run %s (project %s) for user %s to %d recipient(s)", run.id, project_id, user.id, recipients)
    return {"sent": True, "recipients": recipients, "attachments": [name for name, _, _ in files]}


class MailError(Exception):
    def __init__(self, status: int, error_type: str, message: str):
        self.status = status
        self.error_type = error_type
        super().__init__(message)


@app.exception_handler(MailError)
def _handle_mail(_req: Request, exc: MailError):
    return _error_response(exc.status, exc.error_type, str(exc))


def _attachment(name: str) -> str:
    """A Content-Disposition for a download; the name is already ASCII-safe."""
    return f'attachment; filename="{name}"; filename*=UTF-8\'\'{quote(name)}'


@app.post("/projects/{project_id}/runs/{run_id}/stop")
def stop_run(project_id: str, run_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Stop a running local run. It ends within about two seconds as failed with
    `RunStopped`, keeping the outputs and usage so far; an agent mid-call finishes that
    one call, then makes no more. A run that already ended is returned unchanged.
    Deployed runs execute on AWS and can't be stopped here (409 `RunNotStoppable`)."""
    run = _get_run(project_id, run_id, user)
    if run.status != "running":
        return {"run": _run_body(run)}
    if run.kind == "deployed":
        raise RunNotStoppableError(run_id)
    _runs.update(_project_at(project_id, user, "use").tenant_id, run_id, stop_requested=True)
    flag = _STOP_FLAGS.get(run_id)
    if flag is not None:  # running in this process: stop at once rather than at the next poll
        flag.set()
    return {"run": _run_body(_get_run(project_id, run_id, user))}


@app.get("/projects/{project_id}/runs/{run_id}/stream")
def stream_saved_run(
    project_id: str, run_id: str, after: int = 0, user: UserRecord = Depends(current_user)
) -> StreamingResponse:
    """A saved run's events as Server-Sent Events: replayed from index `after`, then
    followed live until the run ends. Reconnect with the number of events received to
    resume. Same events as /run/stream."""
    _get_run(project_id, run_id, user)  # 404 before streaming
    owner_id = _store.get(project_id).tenant_id

    def stream():
        index = max(after, 0)
        idle = 0.0
        while True:
            run = _runs.get(owner_id, project_id, run_id)
            if run is None:
                return
            run = run.effective()
            for i in range(index, len(run.events)):
                event = dict(run.events[i])
                name = event.pop("event")
                if name == "node_completed":
                    event["output"] = run.outputs.get(event.get("node"))
                yield f"id: {i + 1}\nevent: {name}\ndata: {json.dumps(event, default=str)}\n\n"
                idle = 0.0
            index = len(run.events)
            if run.status != "running":
                ended = any(e.get("event") in ("run_completed", "run_failed") for e in run.events)
                if not ended:  # interrupted: say so, the way a live stream would
                    data = {**(run.error or {"error_type": "RunInterrupted", "message": "the run stopped"}),
                            "at": time.time()}
                    yield f"event: run_failed\ndata: {json.dumps(data, default=str)}\n\n"
                return
            time.sleep(0.5)
            idle += 0.5
            if idle >= 15:
                yield ": keep-alive\n\n"
                idle = 0.0

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class StartDeployedRunRequest(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)
    agent_id: str | None = Field(default=None, max_length=100)
    upstream_outputs: dict[str, Any] = Field(default_factory=dict)


@app.post("/projects/{project_id}/deployment/runs", status_code=202)
def start_deployed_run(
    project_id: str, req: StartDeployedRunRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Run the deployed flow in the background and save the result (the console's Try it).
    Returns at once; poll GET …/runs/{id}."""
    project = _get_project(project_id, user)
    deployment = project.deployment
    if deployment is None or not deployment.live:
        raise NotDeployedError()
    if _make_cloud() is None:
        raise DeployNotConfiguredError()
    payload: dict[str, Any] = {"input": req.input}
    if req.agent_id is not None:
        payload["agent_id"] = req.agent_id
        payload["upstream_outputs"] = req.upstream_outputs
    run = _new_run(project, kind="deployed", mode="agent" if req.agent_id else "graph", task_input=req.input,
                   agent_id=req.agent_id, plan_version=deployment.live_plan_version)
    recorder = _RunRecorder(run)
    _in_background(lambda: _deployed_run(project, payload, recorder), f"deployed-run-{run.id}")
    return {"run": _run_body(run)}


# --------------------------------------------------------------------------- model checks
class ModelCheckRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=40)
    model: str = Field(min_length=1, max_length=200)


@app.post("/models/check")
def check_model(req: ModelCheckRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Whether a model can call tools. A Bedrock model nobody has checked yet gets one tiny
    test call (counted on your Usage page); the result is kept for everyone for 30 days."""
    if not _model_allowed(req.provider, req.model):
        raise KnowledgeError(f"not an available model: {req.provider}/{req.model}", status=422)
    return {"provider": req.provider, "model": req.model, "tool_calling": _tool_calling(req.provider, req.model, user.id)}


# --------------------------------------------------------------------------- data sources
class DataSourceCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    billing_project: str | None = Field(default=None, max_length=64)
    service_account: str | None = Field(default=None, max_length=200)


class DataSourceTablesRequest(BaseModel):
    tables: list[str] = Field(max_length=200)


class DataSourceProjectsRequest(BaseModel):
    project_ids: list[str] = Field(max_length=200)


class DataQueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=20_000)


def _get_source(source_id: str, user: UserRecord) -> Any:
    source = _datasources.get(user.id, source_id)
    if source is None:  # someone else's source is reported exactly like a missing one
        raise DataSourceNotFoundError(source_id)
    return source


def _source_body(source: Any, owned: set[str] | None = None) -> dict[str, Any]:
    body = source.model_dump(exclude={"tenant_id"})
    if owned is not None:
        body["project_ids"] = [p for p in source.project_ids if p in owned]
    return body


def _require_configured() -> None:
    if not GCP_WIF_AUDIENCE:
        raise DataSourceError(
            "BigQuery isn't set up on this server: set GCP_WIF_AUDIENCE, GCP_SERVICE_ACCOUNT and "
            "BIGQUERY_PROJECT in backend/.env (see docs/bigquery_setup.md)",
            status=503,
            error_type="DataSourceNotConfigured",
        )


@app.get("/datasources")
def list_datasources(user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Your data sources, the projects you can attach them to, whether BigQuery is set up
    on this server, the defaults for a new source and the per-query limits."""
    projects = _store.list_for_tenant(user.id)
    owned = {p.id for p in projects}
    sources = _datasources.list(user.id)
    return {
        "configured": bool(GCP_WIF_AUDIENCE),
        "defaults": {"billing_project": BIGQUERY_PROJECT, "service_account": GCP_SERVICE_ACCOUNT},
        "limits": {"max_bytes": BIGQUERY_MAX_BYTES, "max_rows": BIGQUERY_MAX_ROWS},
        "sources": [_source_body(s, owned) for s in sources],
        "projects": [
            {
                "project_id": p.id,
                "name": p.display_name,
                "brief": p.brief,
                "used_by": [a.id for a in p.plan.agents if set(a.tools) & DATA_TOOLS],
            }
            for p in projects
        ],
    }


@app.post("/datasources", status_code=201)
def create_datasource(req: DataSourceCreateRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Connect BigQuery as a service account that trusts this platform. The connection is
    checked first (sign in, then list datasets); a failure names the step that failed."""
    _require_configured()
    billing_project = (req.billing_project or BIGQUERY_PROJECT or "").strip()
    service_account = (req.service_account or GCP_SERVICE_ACCOUNT or "").strip().lower()
    try:
        config = ds.DataSourceConfig(
            id=uuid.uuid4().hex, name=req.name.strip(), billing_project=billing_project,
            service_account=service_account,
        )
    except ValidationError as e:
        raise DataSourceError(
            "enter a Google Cloud project id and a service account email (…@….iam.gserviceaccount.com)",
            status=422,
        ) from e
    owner = _datasources.owner_of_service_account(service_account)
    if owner is not None and owner != user.id:
        # Federation trusts the platform, not the user: one tenant per service account.
        raise DataSourceError("that service account is already connected by another account", status=409)
    check = ds.check_connection(_bq_client(config), billing_project)
    if not check["ok"]:
        error = DataSourceError(
            f"couldn't connect: {check['steps'][-1]['error']}", status=422, error_type="DataSourceConnectionFailed"
        )
        error.details = {"steps": check["steps"]}
        raise error
    source = DataSource(**config.model_dump(), tenant_id=user.id)
    _datasources.add(source)
    return {"source": _source_body(source), "check": check}


@app.get("/datasources/{source_id}/browse")
def browse_datasource(
    source_id: str, project: str | None = None, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """The datasets and tables the source's service account can see in a project (its
    billing project by default), to choose which tables agents may query."""
    source = _get_source(source_id, user)
    target = (project or source.billing_project).strip()
    client = _bq_client(source.config())
    datasets = client.list_datasets(target)[:50]
    return {
        "project": target,
        "datasets": [{"id": d, "tables": client.list_tables(target, d)[:500]} for d in datasets],
    }


@app.put("/datasources/{source_id}/tables")
def set_datasource_tables(
    source_id: str, req: DataSourceTablesRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Set exactly which tables agents may query, as `project.dataset.table` (public
    datasets included). Each is read first, to confirm access and record its location."""
    source = _get_source(source_id, user)
    client = _bq_client(source.config())
    known = {t.id: t for t in source.tables}
    tables: list[ds.AllowedTable] = []
    for table_id in dict.fromkeys(t.strip() for t in req.tables):
        if table_id.count(".") < 2:
            raise DataSourceError(f"'{table_id}' isn't a full table name (project.dataset.table)", status=422)
        if table_id in known:
            tables.append(known[table_id])
            continue
        try:
            meta = client.table(table_id)
        except DataSourceError as e:
            raise DataSourceError(f"can't read `{table_id}`: {e}", status=422) from e
        tables.append(ds.AllowedTable(
            id=table_id, location=meta.get("location") or "US", description=meta.get("description"),
        ))
    updated = _datasources.update(user.id, source_id, tables=tables)
    if updated is None:
        raise DataSourceNotFoundError(source_id)
    _COMPILED.clear()  # compiled graphs check data tools against attached sources
    return {"source": _source_body(updated)}


@app.put("/datasources/{source_id}/projects")
def set_datasource_projects(
    source_id: str, req: DataSourceProjectsRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Set exactly which of your projects may query this source. Attaching is that
    project's opt-in to sending query results to its agents' model provider."""
    _get_source(source_id, user)
    wanted = list(dict.fromkeys(req.project_ids))
    for project_id in wanted:
        _get_project(project_id, user)  # each must be one of yours (else 404)
    updated = _datasources.update(user.id, source_id, project_ids=wanted)
    if updated is None:
        raise DataSourceNotFoundError(source_id)
    return {"source": _source_body(updated)}


@app.delete("/datasources/{source_id}")
def delete_datasource(source_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Remove a data source (and its project attachments). Nothing in BigQuery changes."""
    if not _datasources.delete(user.id, source_id):
        raise DataSourceNotFoundError(source_id)
    return {"deleted": source_id}


@app.get("/projects/{project_id}/datasources")
def project_datasources(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The data sources attached to this project (its agents query only these), your
    other sources that could be attached, which agents have the SQL tools, and whether
    BigQuery is set up on this server."""
    project = _get_project(project_id, user)
    sources = _datasources.list(user.id)
    return {
        "configured": bool(GCP_WIF_AUDIENCE),
        "limits": {"max_bytes": BIGQUERY_MAX_BYTES, "max_rows": BIGQUERY_MAX_ROWS},
        "attached": [_source_body(s) for s in sources if project_id in s.project_ids],
        "available": [_source_body(s) for s in sources if project_id not in s.project_ids],
        "used_by": [a.id for a in project.plan.agents if set(a.tools) & DATA_TOOLS],
    }


@app.post("/projects/{project_id}/datasources/{source_id}")
def attach_datasource(project_id: str, source_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Attach one of your data sources to this project: its opt-in to sending query
    results to its agents' model provider. Agents with sql_query can use it at once."""
    _get_project(project_id, user)
    source = _get_source(source_id, user)
    if project_id not in source.project_ids:
        source = _datasources.update(user.id, source_id, project_ids=[*source.project_ids, project_id])
    return {"source": _source_body(source)}


@app.delete("/projects/{project_id}/datasources/{source_id}")
def detach_datasource(project_id: str, source_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Detach a data source from this project. The source itself stays."""
    _get_project(project_id, user)
    source = _get_source(source_id, user)
    source = _datasources.update(user.id, source_id, project_ids=[p for p in source.project_ids if p != project_id])
    return {"source": _source_body(source)}


@app.post("/datasources/{source_id}/query")
def query_datasource(
    source_id: str, req: DataQueryRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Run a query the way an agent's sql_query does — same checks and limits — to test
    the source. The bytes it's billed for are recorded on the Usage page."""
    source = _get_source(source_id, user)
    context = ds.DataContext(lambda: [source.config()], lambda s: _bq_client(s), labels={"agentic_test": "1"})
    result = context.query(req.sql)
    collector = UsageCollector()
    collector.add(kind="bigquery_query", provider="bigquery", model="on-demand", input_tokens=0,
                  bytes_billed=result.bytes_billed)
    _record_usage(user.id, None, collector.entries(), run_id=uuid.uuid4().hex)
    return {
        "columns": result.columns,
        "rows": result.rows,
        "truncated": result.truncated,
        "bytes_processed": result.bytes_processed,
        "bytes_billed": result.bytes_billed,
    }


# --------------------------------------------------------------------------- MCP servers
class McpCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=2_048)
    headers: dict[str, str] = Field(default_factory=dict, max_length=20)
    transport: Literal["http", "sse"] = "http"
    preset: str | None = Field(default=None, max_length=40)
    # How the console asked for credentials (an access token, an API key header, …), so it
    # can show and ask again the same way. Display only: `headers` is what's sent.
    auth: McpAuthKind | None = None


class McpSecretRequest(BaseModel):
    """A new URL and/or new header values; what's left out stays as it is."""

    url: str | None = Field(default=None, max_length=2_048)
    headers: dict[str, str] | None = Field(default=None, max_length=20)
    auth: McpAuthKind | None = None


class McpRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class McpToolsRequest(BaseModel):
    approved: list[str] = Field(max_length=200)


class McpProjectsRequest(BaseModel):
    project_ids: list[str] = Field(max_length=200)


class McpTestRequest(BaseModel):
    tool: str = Field(min_length=1, max_length=128)
    arguments: dict[str, Any] = Field(default_factory=dict)


_HEADER_NAME = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_PLATFORM_HEADERS = {"host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"}


def _get_mcp(server_id: str, user: UserRecord) -> McpServer:
    server = _mcp.get(user.id, server_id)
    if server is None:  # someone else's server is reported exactly like a missing one
        raise McpServerNotFoundError(server_id)
    return server


def _clean_headers(headers: dict[str, str]) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for name, value in headers.items():
        name = name.strip()
        if not _HEADER_NAME.match(name):
            raise McpError("header names may use letters, digits and dashes only", status=422, error_type="McpBadHeader")
        if name.lower() in _PLATFORM_HEADERS:
            raise McpError(f"the {name} header is set by the platform", status=422, error_type="McpBadHeader")
        if "\n" in value or "\r" in value or len(value) > 4_096:
            raise McpError(f"the value of {name} isn't a valid header value", status=422, error_type="McpBadHeader")
        cleaned[name] = value.strip()
    return cleaned


def _slug_for(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]", "", name.lower())[:12] or "mcp"
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base[:12]}{n}", n + 1
    return slug


def _server_config(server: McpServer) -> mc.McpServerConfig:
    """A server's approved tools with its decrypted URL and headers, for one use."""
    secret = secrets_box.open_(server.secret)
    return mc.McpServerConfig(
        id=server.id, name=server.name, slug=server.slug, transport=server.transport,
        tools=[mc.McpToolDef.model_validate(t.model_dump(include=set(mc.McpToolDef.model_fields)))
               for t in server.usable_tools()],
        url=secret["url"], headers=secret.get("headers") or {},
    )


def _connection(server: McpServer) -> mc.McpConnection:
    secret = secrets_box.open_(server.secret)
    return mc.McpConnection(
        url=secret["url"], headers=secret.get("headers") or {}, transport=server.transport, name=server.name
    )


def _attached_mcp(project: ProjectRecord) -> list[McpServer]:
    return _mcp.list(project.tenant_id, project.id)


def _mcp_context(project: ProjectRecord) -> mc.McpContext | None:
    """The approved tools of the servers attached to the project, or None when no agent
    uses MCP tools. Servers are read at call time, so attaching needs no recompile."""
    if not uses_mcp(project.plan):
        return None
    return mc.McpContext(lambda: [_server_config(s) for s in _attached_mcp(project) if s.usable_tools()])


def _deployable_mcp(project: ProjectRecord) -> list[mc.McpServerConfig]:
    """The attached servers whose approved tools the plan uses, with their secrets, for a
    deployment. Raises McpUnavailableError if a tool the plan uses isn't offered."""
    needed = {t for a in project.plan.agents for t in a.tools if is_mcp_tool(t)}
    configs = [_server_config(s) for s in _attached_mcp(project) if s.usable_tools()]
    offered = {mc.exposed_name(c.slug, t.name): c.slug for c in configs for t in c.tools}
    missing = sorted(needed - set(offered))
    if missing:
        raise McpUnavailableError(missing)
    used = {offered[t] for t in needed}
    return [c for c in configs if c.slug in used]


def _mcp_tool_notes(servers: list[McpServer]) -> dict[str, str]:
    """Exposed name -> "server: description" for the approved tools of `servers`."""
    return {
        mc.exposed_name(s.slug, t.name): f"{s.name}: {t.description or t.name}"
        for s in servers for t in s.usable_tools()
    }


def _mcp_tools_used(project: ProjectRecord, server: McpServer) -> list[str]:
    prefix = f"{mc.PREFIX}{server.slug}__"
    return sorted({t for a in project.plan.agents for t in a.tools if t.startswith(prefix)})


def _tool_body(server: McpServer, tool: McpTool) -> dict[str, Any]:
    return {
        "name": tool.name,
        "exposed_name": mc.exposed_name(server.slug, tool.name),
        "description": tool.description,
        "input_schema": tool.input_schema,
        "annotations": tool.annotations,
        "approved": tool.approved,
        "changed": tool.changed,
        "usable": tool.usable(),
        "read_only_hint": tool.looks_read_only(),
    }


def _mcp_body(server: McpServer, owned: set[str] | None = None) -> dict[str, Any]:
    """A server as the API shows it: never the URL or header values."""
    body = server.model_dump(exclude={"tenant_id", "secret", "tools"})
    body["tools"] = [_tool_body(server, t) for t in server.tools]
    if owned is not None:
        body["project_ids"] = [p for p in server.project_ids if p in owned]
    return body


def _merge_tools(old: list[McpTool], listed: list[mc.McpToolDef]) -> list[McpTool]:
    """The server's current tools, keeping approvals whose definitions didn't change. An
    approved tool that changed is held back (`changed`) until approved again."""
    previous = {t.name: t for t in old}
    merged: list[McpTool] = []
    for definition in listed:
        before = previous.get(definition.name)
        tool = McpTool(**definition.model_dump())
        if before is not None and before.approved:
            same = before.approved_hash == definition.definition_hash()
            tool.approved, tool.approved_hash, tool.changed = True, before.approved_hash, not same
        merged.append(tool)
    return merged


def _check_exposed_names(slug: str, tools: list[mc.McpToolDef]) -> None:
    seen: dict[str, str] = {}
    for tool in tools:
        name = mc.exposed_name(slug, tool.name)
        if name in seen:
            raise McpError(
                f"the server's tools '{seen[name]}' and '{tool.name}' get the same name ({name}); "
                "the platform can't tell them apart",
                status=422,
                error_type="McpToolNameClash",
            )
        seen[name] = tool.name


def _status_for(error: McpError) -> str:
    auth = ("McpAuthFailed", "McpOAuthRequired", "McpAuthorizationRequired")
    return "auth_failed" if error.error_type in auth else "unreachable"


def _list_with_steps(conn: mc.McpConnection) -> mc.McpListing:
    """List the server's tools; a failure carries the step it failed at, for the console."""
    try:
        mc.check_url(conn.url)
    except McpError as e:
        e.details = {"steps": [{"step": "check the address", "ok": False, "error": str(e)}]}
        raise
    try:
        listing = mc.list_tools(conn)
    except McpError as e:
        step = "sign in" if e.error_type in ("McpAuthFailed", "McpOAuthRequired") else "reach the server"
        e.details = {"steps": [{"step": "check the address", "ok": True}, {"step": step, "ok": False, "error": str(e)}]}
        raise
    return listing


@app.get("/mcp")
def list_mcp_servers(user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Your MCP servers (never their URLs or header values), the projects you can attach
    them to, and whether this server can store secrets."""
    projects = _store.list_for_tenant(user.id)
    owned = {p.id for p in projects}
    return {
        "configured": secrets_box.configured(),
        "servers": [_mcp_body(s, owned) for s in _mcp.list(user.id)],
        "projects": [
            {
                "project_id": p.id,
                "name": p.display_name,
                "used_by": [a.id for a in p.plan.agents if any(is_mcp_tool(t) for t in a.tools)],
            }
            for p in projects
        ],
        "limits": {"max_tools": mc.MAX_TOOLS, "call_timeout_s": MCP_CALL_TIMEOUT_S},
    }


@app.post("/mcp", status_code=201)
def create_mcp_server(req: McpCreateRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Connect a remote MCP server: check its address, sign in, list its tools. Nothing is
    approved yet: agents get a tool only after you approve it. The URL and header values
    are stored encrypted, and never shown again."""
    if not secrets_box.configured():
        raise SecretsNotConfiguredError()
    headers = _clean_headers(req.headers)
    url = req.url.strip()
    conn = mc.McpConnection(url=url, headers=headers, transport=req.transport, name=req.name.strip())
    listing = _list_with_steps(conn)
    slug = _slug_for(req.name, {s.slug for s in _mcp.list(user.id)})
    _check_exposed_names(slug, listing.tools)
    server = McpServer(
        id=uuid.uuid4().hex, tenant_id=user.id, name=req.name.strip(), slug=slug,
        display_url=mc.display_url(url), host=mc.host_of(url), transport=req.transport,
        preset=req.preset, auth=req.auth, header_names=sorted(headers),
        secret=secrets_box.seal({"url": url, "headers": headers}),
        server_name=listing.server_name, server_version=listing.server_version,
        tools=[McpTool(**t.model_dump()) for t in listing.tools],
    )
    _mcp.add(server)
    return {"server": _mcp_body(server), "skipped": listing.skipped}


@app.post("/mcp/{server_id}/refresh")
def refresh_mcp_server(server_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """List the server's tools again. Approvals stay for tools that didn't change; a
    changed tool is held back until you approve it again; new tools come in unapproved."""
    server = _get_mcp(server_id, user)
    try:
        listing = mc.list_tools(_connection(server))
    except McpError as e:
        _mcp.update(user.id, server_id, status=_status_for(e), status_message=str(e),
                    checked_at=datetime.now(timezone.utc))
        raise
    _check_exposed_names(server.slug, listing.tools)
    updated = _mcp.update(
        user.id, server_id, tools=_merge_tools(server.tools, listing.tools), status="ok", status_message=None,
        server_name=listing.server_name, server_version=listing.server_version,
        checked_at=datetime.now(timezone.utc),
    )
    _COMPILED.clear()  # compiled graphs hold the old tool definitions
    return {"server": _mcp_body(updated), "skipped": listing.skipped}


@app.put("/mcp/{server_id}/tools")
def approve_mcp_tools(server_id: str, req: McpToolsRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Set which of the server's tools agents may use. Approving pins each tool's current
    definition; tools not listed are no longer approved."""
    server = _get_mcp(server_id, user)
    names = {t.name for t in server.tools}
    unknown = sorted(set(req.approved) - names)
    if unknown:
        raise McpError(f"the server has no tool named {', '.join(unknown)}", status=422, error_type="McpUnknownTool")
    wanted = set(req.approved)
    tools = [
        t.model_copy(update={"approved": True, "approved_hash": t.definition_hash(), "changed": False})
        if t.name in wanted
        else t.model_copy(update={"approved": False, "approved_hash": None, "changed": False})
        for t in server.tools
    ]
    updated = _mcp.update(user.id, server_id, tools=tools)
    _COMPILED.clear()
    return {"server": _mcp_body(updated)}


@app.put("/mcp/{server_id}/secret")
def replace_mcp_secret(server_id: str, req: McpSecretRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Replace the server's URL and/or header values, after a token expires or a key is
    regenerated. The new ones are checked first; approvals of unchanged tools carry over."""
    server = _get_mcp(server_id, user)
    secret = secrets_box.open_(server.secret)
    url = (req.url or secret["url"]).strip()
    headers = _clean_headers(req.headers) if req.headers is not None else secret.get("headers") or {}
    conn = mc.McpConnection(url=url, headers=headers, transport=server.transport, name=server.name)
    listing = _list_with_steps(conn)
    _check_exposed_names(server.slug, listing.tools)
    updated = _mcp.update(
        user.id, server_id, secret=secrets_box.seal({"url": url, "headers": headers}),
        display_url=mc.display_url(url), host=mc.host_of(url), header_names=sorted(headers),
        **({"auth": req.auth} if req.auth is not None else {}),
        tools=_merge_tools(server.tools, listing.tools), status="ok", status_message=None,
        checked_at=datetime.now(timezone.utc),
    )
    _COMPILED.clear()
    return {"server": _mcp_body(updated), "skipped": listing.skipped}


@app.patch("/mcp/{server_id}")
def rename_mcp_server(server_id: str, req: McpRenameRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    _get_mcp(server_id, user)
    return {"server": _mcp_body(_mcp.update(user.id, server_id, name=req.name.strip()))}


@app.delete("/mcp/{server_id}")
def delete_mcp_server(server_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Remove a server and its stored secret. Refused while a project's plan uses its
    tools: change those agents' tools first."""
    server = _get_mcp(server_id, user)
    using = [p.display_name for p in _store.list_for_tenant(user.id) if _mcp_tools_used(p, server)]
    if using:
        raise McpError(
            f"agents in {', '.join(using)} use this server's tools; remove those tools from the agents first",
            status=409,
            error_type="McpServerInUse",
        )
    _mcp.delete(user.id, server_id)
    _COMPILED.clear()
    return {"deleted": server_id}


@app.put("/mcp/{server_id}/projects")
def set_mcp_projects(server_id: str, req: McpProjectsRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Attach the server to exactly these projects of yours. Attaching is the project's
    opt-in to the server's approved tools."""
    server = _get_mcp(server_id, user)
    owned = {p.id for p in _store.list_for_tenant(user.id)}
    wanted = list(dict.fromkeys(req.project_ids))
    missing = [p for p in wanted if p not in owned]
    if missing:
        raise ProjectNotFoundError(missing[0])
    keep_foreign = [p for p in server.project_ids if p not in owned]
    updated = _mcp.update(user.id, server_id, project_ids=[*keep_foreign, *wanted])
    for project_id in set(server.project_ids) ^ set(wanted):
        _COMPILED.pop(project_id, None)
    return {"server": _mcp_body(updated, owned)}


@app.get("/projects/{project_id}/mcp")
def project_mcp_servers(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Your MCP servers, which are attached to this project, and which tools its agents use."""
    project = _get_project(project_id, user)
    return {
        "configured": secrets_box.configured(),
        "servers": [
            {**_mcp_body(s), "attached": project_id in s.project_ids, "used_tools": _mcp_tools_used(project, s)}
            for s in _mcp.list(user.id)
        ],
    }


@app.post("/projects/{project_id}/mcp/{server_id}")
def attach_mcp_server(project_id: str, server_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    _get_project(project_id, user)
    server = _get_mcp(server_id, user)
    if project_id not in server.project_ids:
        server = _mcp.update(user.id, server_id, project_ids=[*server.project_ids, project_id])
    return {"server": _mcp_body(server)}


@app.delete("/projects/{project_id}/mcp/{server_id}")
def detach_mcp_server(project_id: str, server_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Detach a server. If agents still use its tools, compiling fails until they don't."""
    _get_project(project_id, user)
    server = _get_mcp(server_id, user)
    server = _mcp.update(user.id, server_id, project_ids=[p for p in server.project_ids if p != project_id])
    _COMPILED.pop(project_id, None)
    return {"server": _mcp_body(server)}


@app.post("/mcp/{server_id}/test")
def test_mcp_tool(server_id: str, req: McpTestRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Run one approved tool with these arguments, exactly as an agent would (same checks,
    limits and fencing), to try it before agents use it."""
    server = _get_mcp(server_id, user)
    tool = next((t for t in server.tools if t.name == req.tool), None)
    if tool is None or not tool.usable():
        raise McpError("approve the tool before trying it", status=409, error_type="McpToolNotApproved")
    context = mc.McpContext(lambda: [_server_config(server)])
    try:
        _, output = context.call(mc.exposed_name(server.slug, tool.name), req.arguments)
    except McpError as e:
        _mcp.update(user.id, server_id, status=_status_for(e), status_message=str(e),
                    checked_at=datetime.now(timezone.utc))
        raise
    collector = UsageCollector()
    collector.add(kind="mcp_call", provider="mcp", model=server.slug, input_tokens=0)
    _record_usage(user.id, None, collector.entries(), run_id=uuid.uuid4().hex)
    if server.status != "ok":
        _mcp.update(user.id, server_id, status="ok", status_message=None, checked_at=datetime.now(timezone.utc))
    return {"output": output}


# --------------------------------------------------------------------------- admin
# Admins see every user's usage and cost, never their projects' contents (briefs, plans,
# run inputs and outputs, files). The one master admin alone adds and removes admins.
# Roles live on the user and are read on every request.
class RoleRequest(BaseModel):
    role: Literal["user", "admin"]


def require_admin(user: UserRecord = Depends(current_user)) -> UserRecord:
    """The signed-in user, if an admin. Anyone else gets the same 404 as an unknown
    route, so the admin area isn't even shown to exist."""
    if user.role not in ADMIN_ROLES:
        raise AdminNotFoundError()
    return user


def require_master(user: UserRecord = Depends(require_admin)) -> UserRecord:
    """The signed-in user, if the master admin. Other admins know the admin area exists,
    so they get a plain 403; non-admins still get the 404."""
    if not can(_actor(user), "role.grant_sub_admin"):
        raise MasterAdminRequiredError()
    return user


def _range_start(days: int) -> tuple[date, int, datetime]:
    days = min(max(days, 1), 366)
    start = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
    return start, days, datetime(start.year, start.month, start.day, tzinfo=timezone.utc)


@app.get("/admin/users")
def admin_users(days: int = 30, admin: UserRecord = Depends(require_admin)) -> dict[str, Any]:
    """Every user, with their tokens and estimated cost over the last `days` days, and
    platform totals. Usage only: no project contents."""
    _, days, since = _range_start(days)
    records = [r.model_dump() for r in _usage.list_all(since)]
    per_user = usage_mod.by_tenant(records)
    currency = usage_mod.prices().get("currency", "USD")
    users = []
    for u in _users.list_all():
        totals = per_user.get(u.id) or {
            "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "unpriced_tokens": 0,
            "last_active": None, "runs": 0, "deployed_runs": 0,
        }
        users.append({
            "id": u.id,
            "email": u.email,
            "role": u.role,
            "created_at": u.created_at,
            "projects": len(_store.list_for_tenant(u.id)),
            **totals,
        })
    logger.info("admin %s listed users (days=%d)", admin.id, days)
    return {
        "days": days,
        "currency": currency,
        "totals": {
            "users": len(users),
            "active_users": sum(1 for u in users if u["calls"] > 0),
            "admins": sum(1 for u in users if u["role"] in ADMIN_ROLES),
            "calls": sum(u["calls"] for u in users),
            "input_tokens": sum(u["input_tokens"] for u in users),
            "output_tokens": sum(u["output_tokens"] for u in users),
            "cost": round(sum(u["cost"] for u in users), 6),
            "unpriced_tokens": sum(u["unpriced_tokens"] for u in users),
        },
        "users": users,
    }


def _admin_project_names(user_id: str) -> dict[str, str]:
    """A user's projects as an admin may see them: the project's own name if the user gave
    it one, never the brief (an unnamed project's display name is the brief's first line,
    which is the user's content)."""
    return {p.id: p.name or f"Untitled project · {p.id[:6]}" for p in _store.list_for_tenant(user_id)}


@app.get("/admin/users/{user_id}/usage")
def admin_user_usage(
    user_id: str,
    days: int = 30,
    project_id: str | None = None,
    admin: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    """One user's usage, exactly as their own Usage page counts it (totals, by day, model,
    project name and kind of work, recent runs with each agent's tokens), optionally for
    one of their projects. Starts no sync and shows no project contents."""
    target = _users.get(user_id)
    if target is None:
        raise AdminNotFoundError()
    names = _admin_project_names(user_id)
    if project_id is not None and project_id not in names:
        raise AdminNotFoundError()
    start, days, since = _range_start(days)
    records = [r.model_dump() for r in _usage.list(user_id, since, project_id)]
    body = usage_mod.dashboard(
        records, start=start, days=days, project_names=names,
        currency=usage_mod.prices().get("currency", "USD"),
    )
    logger.info(
        "admin %s viewed usage of user %s (days=%d%s)", admin.id, user_id, days,
        f", project={project_id}" if project_id else "",
    )
    user = {
        **_public_user(target),
        "role_changed_at": target.role_changed_at,
        "projects": len(names),
    }
    projects = [{"project_id": pid, "name": name} for pid, name in names.items()]
    return {"user": user, "projects": projects, **body}


# ------------------------------------------------------------------------ model privileges
def _offered_models() -> list[str]:
    """Every model the platform offers, as `provider/model` keys: each provider's default plus,
    when the AWS account is reachable, the Bedrock models it can use. This is the org's full
    catalog before the Super Admin narrows it."""
    keys = [model_key(p, m) for p, m in DEFAULT_MODELS.items()]
    if aws_credentials_available():
        keys += [model_key("bedrock", m["model"]) for m in bedrock_models()]
    return list(dict.fromkeys(keys))


def _limits_for(actor: Actor, team_id: str | None) -> mpol.Limits:
    """The model limits that apply to this person working in this team's context. The Super
    Admin is bound only by the org's catalog (which the Super Admin sets)."""
    if actor.is_master:
        return mpol.Limits(org=None, layers=())
    return mpol.limits_for(_models, actor.user_id, team_id)


class OrgModelsRequest(BaseModel):
    catalog: list[str] | None = None  # None = every offered model
    fallback_model: str | None = None  # None = never substitute


class AllowlistRequest(BaseModel):
    models: list[str] = Field(max_length=200)


def _checked_refs(refs: list[str], offered: list[str]) -> list[str]:
    """Every reference must be well-formed and cover at least one offered model."""
    bad = [r for r in refs if not valid_model_ref(r)]
    if bad:
        raise ShareError(f"not a model reference (provider/model or provider/*): {bad[0]!r}", error_type="InvalidModelReference")
    unknown = mpol.escalations(refs, offered, mpol.Limits(org=None, layers=()))
    if unknown:
        raise ShareError(f"the platform does not offer: {', '.join(unknown)}", error_type="UnknownModel")
    return list(dict.fromkeys(refs))


def _org_body(org: OrgModelSettings) -> dict[str, Any]:
    return {"catalog": org.catalog, "fallback_model": org.fallback_model, "updated_by": org.updated_by,
            "updated_at": org.updated_at}


def _allowlist_body(a: ModelAllowlist) -> dict[str, Any]:
    return {"scope_type": a.scope_type, "scope_id": a.scope_id, "models": a.models, "set_by": a.set_by,
            "updated_at": a.updated_at}


@app.get("/admin/models")
def admin_models(admin: UserRecord = Depends(require_admin)) -> dict[str, Any]:
    """The org's model catalog and fallback, every allowlist, and what the platform offers
    (Super Admin and Sub Admins)."""
    return {
        "offered": _offered_models(),
        "org": _org_body(_models.get_org()),
        "allowlists": [_allowlist_body(a) for a in _models.list_allowlists()],
    }


@app.put("/admin/models/org")
def set_org_models(req: OrgModelsRequest, admin: UserRecord = Depends(require_master)) -> dict[str, Any]:
    """Narrow the org's catalog and/or set the fallback model (Super Admin only)."""
    offered = _offered_models()
    catalog = _checked_refs(req.catalog, offered) if req.catalog is not None else None
    fallback = req.fallback_model
    if fallback is not None and (not valid_model_ref(fallback) or fallback not in offered):
        raise ShareError("the fallback must be one model the platform offers", error_type="UnknownModel")
    before = _models.get_org()
    after = OrgModelSettings(catalog=catalog, fallback_model=fallback, updated_by=admin.id)
    if (before.catalog, before.fallback_model) != (after.catalog, after.fallback_model):
        _models.set_org(after)
        audit_log.record(
            _audit, admin.id, "model.org_updated", "model_settings", "org",
            before={"catalog": before.catalog, "fallback_model": before.fallback_model},
            after={"catalog": after.catalog, "fallback_model": after.fallback_model},
        )
    return {"org": _org_body(_models.get_org())}


def _set_allowlist(actor: Actor, scope_type: str, scope_id: str, models: list[str], team_id: str | None) -> ModelAllowlist:
    previous = _models.get_allowlist(scope_type, scope_id)
    current = ModelAllowlist(
        id=ModelAllowlist.make_id(scope_type, scope_id), scope_type=scope_type, scope_id=scope_id,  # type: ignore[arg-type]
        models=models, set_by=actor.user_id,
    )
    if previous is None or previous.models != current.models:
        _models.set_allowlist(current)
        audit_log.record(
            _audit, actor.user_id, "model.allowlist_set", "model_allowlist", current.id, team_id=team_id,
            before={"models": previous.models} if previous else None, after={"models": current.models},
        )
    return _models.get_allowlist(scope_type, scope_id) or current


def _clear_allowlist(actor: Actor, scope_type: str, scope_id: str, team_id: str | None) -> bool:
    previous = _models.get_allowlist(scope_type, scope_id)
    if previous is None:
        return False
    _models.delete_allowlist(scope_type, scope_id)
    audit_log.record(
        _audit, actor.user_id, "model.allowlist_cleared", "model_allowlist", previous.id, team_id=team_id,
        before={"models": previous.models}, after=None,
    )
    return True


@app.get("/teams/{team_id}/models")
def team_models(team_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The team's allowlist and its members' limits (Super Admin and the team's group admins)."""
    actor = _actor(user)
    _visible_team(team_id, actor, "team.manage_members")
    members = [a for a in _models.list_allowlists("member") if a.scope_id.startswith(f"{team_id}:")]
    team = _models.get_allowlist("team", team_id)
    return {
        "offered": _offered_models(),
        "org": _org_body(_models.get_org()),
        "team": _allowlist_body(team) if team else None,
        "members": [_allowlist_body(a) for a in members],
    }


@app.put("/teams/{team_id}/models")
def set_team_models(team_id: str, req: AllowlistRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Limit the models a team's projects may use (Super Admin only)."""
    actor = _actor(user)
    _visible_team(team_id, actor, "models.team_allowlist")
    models = _checked_refs(req.models, _offered_models())
    return {"allowlist": _allowlist_body(_set_allowlist(actor, "team", team_id, models, team_id))}


@app.delete("/teams/{team_id}/models")
def clear_team_models(team_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    actor = _actor(user)
    _visible_team(team_id, actor, "models.team_allowlist")
    return {"cleared": _clear_allowlist(actor, "team", team_id, team_id)}


def _member_target(team_id: str, member_id: str, actor: Actor) -> None:
    _visible_team(team_id, actor, "team.manage_members")
    if _teams.get_membership(team_id, member_id) is None:
        raise TeamNotFoundError()


@app.put("/teams/{team_id}/members/{member_id}/models")
def set_member_models(
    team_id: str, member_id: str, req: AllowlistRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Limit one member's models inside the team (Super Admin, or the team's group admin). You can
    give only models you may use yourself in this team, so nobody is handed more than the granter has."""
    actor = _actor(user)
    _member_target(team_id, member_id, actor)
    offered = _offered_models()
    models = _checked_refs(req.models, offered)
    over = mpol.escalations(models, offered, _limits_for(actor, team_id))
    if over:
        raise ShareError(f"you cannot grant models you may not use yourself: {', '.join(over)}", status=403,
                         error_type="ModelAboveYourOwn")
    return {"allowlist": _allowlist_body(_set_allowlist(actor, "member", f"{team_id}:{member_id}", models, team_id))}


@app.delete("/teams/{team_id}/members/{member_id}/models")
def clear_member_models(team_id: str, member_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    actor = _actor(user)
    _member_target(team_id, member_id, actor)
    return {"cleared": _clear_allowlist(actor, "member", f"{team_id}:{member_id}", team_id)}


@app.put("/users/{target_id}/models")
def set_user_models(target_id: str, req: AllowlistRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Limit the models a person may use anywhere (Super Admin only)."""
    actor = _actor(user)
    if not can(actor, "models.user_allowlist") or _users.get(target_id) is None:
        raise TeamNotFoundError()
    models = _checked_refs(req.models, _offered_models())
    return {"allowlist": _allowlist_body(_set_allowlist(actor, "user", target_id, models, None))}


@app.delete("/users/{target_id}/models")
def clear_user_models(target_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    actor = _actor(user)
    if not can(actor, "models.user_allowlist") or _users.get(target_id) is None:
        raise TeamNotFoundError()
    return {"cleared": _clear_allowlist(actor, "user", target_id, None)}


@app.get("/me/models")
def my_models(project_id: str | None = None, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The models you may use, optionally for one project (its team's limits apply). Each
    offered model says whether you may use it, and which limit stops you when you may not."""
    actor = _actor(user)
    team_id = None
    if project_id is not None:
        team_id = _project_at(project_id, user, "view").team_id
    limits = mpol.limits_for(_models, actor.user_id, team_id)
    if actor.is_master:
        limits = mpol.Limits(org=limits.org, layers=())
    offered = _offered_models()
    return {
        "models": [
            {"model": k, "allowed": (b := mpol.blocked_by(k, limits)) is None, "blocked_by": b} for k in offered
        ],
        "fallback_model": _models.get_org().fallback_model,
    }


# ------------------------------------------------------------------------------ sharing
class ShareRequest(BaseModel):
    agent_id: str = Field(default=WHOLE_PROJECT, min_length=1, max_length=100)  # "*" = every agent
    grantee_type: Literal["user", "team"]
    grantee_id: str = Field(min_length=1, max_length=100)
    level: Literal["view", "use", "edit", "manage"]


def _shareable_project(project_id: str, user: UserRecord) -> tuple[Actor, ProjectRecord, list[AgentGrant]]:
    """The project, if the caller can see it at all (owner, admin, team member, or someone it is
    shared with); everything else is the usual 404."""
    actor = _actor(user)
    project = _store.get(project_id)
    grants = _grants.list_for_project(project_id) if project is not None else []
    if project is None or not any_access(actor, project, grants):
        raise ProjectNotFoundError(project_id)
    return actor, project, grants


def _level_name(rank: int) -> str | None:
    if rank >= OWNER_RANK:
        return "owner"
    return GRANT_LEVELS[rank - 1] if 1 <= rank <= len(GRANT_LEVELS) else None


def _grant_body(g: AgentGrant) -> dict[str, Any]:
    return g.model_dump()


def _check_grantee(actor: Actor, project: ProjectRecord, req: ShareRequest) -> None:
    """The grantee must exist and be inside the sharer's scope; otherwise it is one 404, so the
    API cannot be used to find out which users or teams exist."""
    scope = sharing_teams(actor, project)
    if req.grantee_type == "team":
        if _teams.get_team(req.grantee_id) is None or (scope is not None and req.grantee_id not in scope):
            raise TeamNotFoundError()
        return
    if req.grantee_id == actor.user_id or req.grantee_id == project.tenant_id:
        raise ShareError("a project is already fully available to its owner and to you")
    if _users.get(req.grantee_id) is None:
        raise TeamNotFoundError()
    if scope is not None and not any(_teams.get_membership(t, req.grantee_id) is not None for t in scope):
        raise TeamNotFoundError()


@app.put("/projects/{project_id}/grants")
def share_project(project_id: str, req: ShareRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Share a project (or one of its agents) with a user or a team, at a level. Sharing makes a
    grant, never a copy. You need `manage` on it, can hand out at most your own level, and can
    share only with people and teams in your scope. Sharing again at another level changes the
    grant; a manage-level grantee can change only the grants they made themselves."""
    actor, project, grants = _shareable_project(project_id, user)
    if req.agent_id != WHOLE_PROJECT and req.agent_id not in {a.id for a in project.plan.agents}:
        raise ShareError(f"this project has no agent {req.agent_id!r}")
    if not may_share(actor, project, req.agent_id, "view", grants):
        raise ProjectNotFoundError(project_id)  # can see it, cannot share it
    if not may_share(actor, project, req.agent_id, req.level, grants):
        raise ShareError("you cannot share at a level above your own", status=403, error_type="LevelAboveYourOwn")
    _check_grantee(actor, project, req)
    gid = AgentGrant.make_id(project_id, req.agent_id, req.grantee_type, req.grantee_id)
    existing = _grants.get(gid)
    if existing is not None and not has_full_rank(actor, project) and existing.granted_by != actor.user_id:
        raise ProjectNotFoundError(project_id)  # someone else's grant is not yours to change
    if existing is not None and existing.level == req.level:
        return {"grant": _grant_body(existing)}
    grant = AgentGrant(
        id=gid, project_id=project_id, agent_id=req.agent_id, grantee_type=req.grantee_type,
        grantee_id=req.grantee_id, level=req.level, granted_by=actor.user_id,
    )
    _grants.upsert(grant)
    logger.info("user %s shared %s/%s with %s %s at %s", actor.user_id, project_id, req.agent_id,
                req.grantee_type, req.grantee_id, req.level)
    audit_log.record(
        _audit, actor.user_id, "agent.shared", "agent_grant", gid, team_id=project.team_id,
        before={"level": existing.level} if existing else None, after={"level": req.level},
        details={"project_id": project_id, "agent_id": req.agent_id,
                 "grantee_type": req.grantee_type, "grantee_id": req.grantee_id},
    )
    return {"grant": _grant_body(grant)}


@app.get("/projects/{project_id}/grants")
def list_grants(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Who the project is shared with. For people who can manage it (and share it onward)."""
    actor, project, grants = _shareable_project(project_id, user)
    if access_rank(actor, project, WHOLE_PROJECT, grants) < level_rank("manage"):
        raise ProjectNotFoundError(project_id)
    return {"grants": [_grant_body(g) for g in grants]}


@app.delete("/projects/{project_id}/grants/{grant_id}")
def revoke_grant(project_id: str, grant_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Take a share away. It applies to the very next check: a run in progress stops at its
    next model call. The owner, the Super Admin and the team's group admin may revoke any
    share; a manage-level grantee only the shares they made."""
    actor, project, grants = _shareable_project(project_id, user)
    grant = _grants.get(grant_id)
    if grant is None or grant.project_id != project_id:
        raise ProjectNotFoundError(project_id)
    if not may_share(actor, project, grant.agent_id, "view", grants):
        raise ProjectNotFoundError(project_id)
    if not has_full_rank(actor, project) and grant.granted_by != actor.user_id:
        raise ProjectNotFoundError(project_id)
    _grants.revoke(grant_id)
    logger.info("user %s revoked grant %s", actor.user_id, grant_id)
    audit_log.record(
        _audit, actor.user_id, "agent.share_revoked", "agent_grant", grant_id, team_id=project.team_id,
        before={"level": grant.level}, after=None,
        details={"project_id": project_id, "agent_id": grant.agent_id,
                 "grantee_type": grant.grantee_type, "grantee_id": grant.grantee_id},
    )
    return {"revoked": grant_id}


# ------------------------------------------------------------------------------ teams
class TeamRequest(BaseModel):
    name: str = Field(min_length=1, max_length=TEAM_NAME_MAX)

    @field_validator("name")
    @classmethod
    def _tidy(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("a team needs a name")
        return v


def _team_body(team: TeamRecord, actor: Actor) -> dict[str, Any]:
    return {
        "id": team.id,
        "name": team.name,
        "created_at": team.created_at,
        "members": len(_teams.list_members(team.id)),
        "my_role": actor.team_roles.get(team.id),
    }


def _visible_team(team_id: str, actor: Actor, action: str = "team.view") -> TeamRecord:
    """A team the caller holds `action` on; anything else is the same 404."""
    team = _teams.get_team(team_id)
    if team is None or not can(actor, action, team_id):
        raise TeamNotFoundError()
    return team


@app.post("/teams", status_code=201)
def create_team(req: TeamRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Create a team (Super Admin only). Everyone else gets the same 404 as an unknown route."""
    actor = _actor(user)
    if not can(actor, "team.create"):
        raise TeamNotFoundError()
    team = TeamRecord(id=uuid.uuid4().hex, name=req.name, created_by=user.id)
    _teams.create_team(team)
    logger.info("user %s created team %s", user.id, team.id)
    audit_log.record(_audit, user.id, "team.created", "team", team.id, team_id=team.id, after={"name": team.name})
    return {"team": _team_body(team, actor)}


@app.get("/teams")
def list_teams(user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The Super Admin sees every team; anyone else only the teams they belong to."""
    actor = _actor(user)
    teams = _teams.list_teams() if actor.is_master else [
        t for t in (_teams.get_team(tid) for tid in actor.team_roles) if t is not None
    ]
    return {"teams": [_team_body(t, actor) for t in teams]}


@app.get("/teams/{team_id}")
def get_team(team_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    actor = _actor(user)
    return {"team": _team_body(_visible_team(team_id, actor), actor)}


@app.patch("/teams/{team_id}")
def rename_team(team_id: str, req: TeamRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    actor = _actor(user)
    old = _visible_team(team_id, actor, "team.manage_members")
    team = _teams.rename_team(team_id, req.name)
    if team is None:
        raise TeamNotFoundError()
    logger.info("user %s renamed team %s", user.id, team_id)
    if old.name != team.name:
        audit_log.record(
            _audit, user.id, "team.renamed", "team", team_id, team_id=team_id,
            before={"name": old.name}, after={"name": team.name},
        )
    return {"team": _team_body(team, actor)}


@app.delete("/teams/{team_id}")
def delete_team(team_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Delete a team (Super Admin only). Its projects go back to being personal and owner-only;
    nothing else is deleted. The Default team cannot be deleted."""
    actor = _actor(user)
    doomed = _visible_team(team_id, actor, "team.delete")
    if team_id == DEFAULT_TEAM_ID:
        raise TeamProtectedError()
    released = 0
    for p in _store.list_all():
        if p.team_id == team_id:
            _store.set_team(p.id, None, False)
            released += 1
    _teams.delete_team(team_id)
    _grants.delete_for_grantee("team", team_id)
    logger.info("user %s deleted team %s (%d projects made personal)", user.id, team_id, released)
    audit_log.record(
        _audit, user.id, "team.deleted", "team", team_id, team_id=team_id,
        before={"name": doomed.name}, details={"projects_made_personal": released},
    )
    return {"deleted": team_id, "projects_made_personal": released}


@app.get("/teams/{team_id}/members")
def list_team_members(team_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Who is in the team and their role (Super Admin and the team's group admins). A plain
    member sees only the team itself, not their colleagues."""
    actor = _actor(user)
    _visible_team(team_id, actor, "team.manage_members")
    by_id = {u.id: u for u in _users.list_all()}
    members = []
    for m in _teams.list_members(team_id):
        u = by_id.get(m.user_id)
        if u is not None:
            members.append({"user_id": u.id, "email": u.email, "role": m.role, "added_at": m.added_at})
    return {"members": members}


@app.put("/teams/{team_id}/members/{user_id}")
def add_team_member(team_id: str, user_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Add a person to a team as a plain member (Super Admin only). A group admin role is
    given separately, by `PUT /teams/{id}/admins/{user}`. Adding someone already in the team
    changes nothing."""
    actor = _actor(user)
    _visible_team(team_id, actor, "team.add_member")
    if _users.get(user_id) is None:
        raise TeamNotFoundError()
    existing = _teams.get_membership(team_id, user_id)
    if existing is None:
        existing = TeamMembership(team_id=team_id, user_id=user_id, role="member", added_by=user.id)
        _teams.set_member(existing)
        logger.info("user %s added %s to team %s", user.id, user_id, team_id)
        audit_log.record(
            _audit, user.id, "team.member_added", "membership", user_id, team_id=team_id, after={"role": "member"}
        )
    return _membership_body(existing)


@app.delete("/teams/{team_id}/members/{user_id}")
def remove_team_member(team_id: str, user_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Remove a person from a team (Super Admin, or the team's group admin). Taking out a
    group admin needs the same right as removing their admin role: the Super Admin, or the
    person leaving themselves. Their projects stay theirs; they just stop seeing the team's."""
    actor = _actor(user)
    _visible_team(team_id, actor, "team.manage_members")
    membership = _teams.get_membership(team_id, user_id)
    if membership is None:
        raise TeamNotFoundError()
    if membership.role == "group_admin" and not can(actor, "role.revoke_group_admin", (team_id, user_id)):
        raise TeamNotFoundError()
    _teams.remove_member(team_id, user_id)
    logger.info("user %s removed %s from team %s", user.id, user_id, team_id)
    audit_log.record(
        _audit, user.id, "team.member_removed", "membership", user_id, team_id=team_id, before={"role": membership.role}
    )
    return {"removed": user_id}


@app.get("/audit")
def read_audit(
    team_id: str | None = None,
    action: str | None = None,
    before: datetime | None = None,
    limit: int = 100,
    user: UserRecord = Depends(current_user),
) -> dict[str, Any]:
    """The audit log, newest first. The Super and Sub Admin read it org-wide (optionally for one
    team); a group admin only the entries of the teams they administer. Anyone else gets
    the same 404 as an unknown route."""
    actor = _actor(user)
    limit = min(max(limit, 1), 500)
    if actor.is_master or actor.is_sub_admin:
        entries = _audit.list(team_id=team_id, action=action, before=before, limit=limit)
    elif actor.admined_teams:
        if team_id is not None and not can(actor, "audit.view", team_id):
            raise TeamNotFoundError()
        entries = _audit.list(
            team_ids=[team_id] if team_id else sorted(actor.admined_teams), action=action, before=before, limit=limit
        )
    else:
        raise TeamNotFoundError()
    return {"entries": [e.model_dump() for e in entries]}


@app.get("/teams/{team_id}/usage")
def team_usage(team_id: str, days: int = 30, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The team's usage (Super Admin and its group admins): only calls made for projects the
    team shares (`team_access`), by anyone, with a per-person breakdown. Planner and personal
    calls of the members, and owner-only projects, are not included."""
    actor = _actor(user)
    team = _visible_team(team_id, actor, "team.manage_members")
    start, days, since = _range_start(days)
    team_projects = {p.id: p for p in _store.list_for_teams([team_id])}
    records = [r.model_dump() for r in _usage.list_all(since) if r.project_id in team_projects]
    by_id = {u.id: u for u in _users.list_all()}
    per_person = usage_mod.by_tenant(records)
    members = []
    for m in _teams.list_members(team_id):
        u = by_id.get(m.user_id)
        if u is None:
            continue
        totals = per_person.get(u.id) or {
            "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "unpriced_tokens": 0,
            "last_active": None, "runs": 0, "deployed_runs": 0,
        }
        members.append({"user_id": u.id, "email": u.email, "role": m.role, **totals})
    # Given names only: an unnamed project's display name is its brief, which is the owner's content.
    names = {pid: p.name or f"Untitled project · {pid[:6]}" for pid, p in team_projects.items()}
    body = usage_mod.dashboard(
        records, start=start, days=days, project_names=names, currency=usage_mod.prices().get("currency", "USD")
    )
    body["team"] = {"id": team.id, "name": team.name}
    body["members"] = members
    return body


def _team_member_target(team_id: str, user_id: str, user: UserRecord, action: str, resource: Any) -> tuple[Actor, TeamMembership]:
    """Shared guard for changing someone's role in a team: the caller must hold `action` on
    the team (anything else, including a team they cannot see, is one 404), the person must
    exist, and must already be a member."""
    actor = _actor(user)
    if _teams.get_team(team_id) is None or not can(actor, action, resource):
        raise TeamNotFoundError()
    if _users.get(user_id) is None:
        raise TeamNotFoundError()
    membership = _teams.get_membership(team_id, user_id)
    if membership is None:
        raise NotATeamMemberError()
    return actor, membership


def _membership_body(m: TeamMembership) -> dict[str, Any]:
    return {"membership": {"team_id": m.team_id, "user_id": m.user_id, "role": m.role}}


@app.put("/teams/{team_id}/admins/{user_id}")
def grant_group_admin(team_id: str, user_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Make a member of the team its group admin (Super Admin, or a group admin of that team).
    Never reaches beyond the team, and cannot grant org-level roles."""
    actor, membership = _team_member_target(team_id, user_id, user, "role.grant_group_admin", team_id)
    if membership.role != "group_admin":
        membership = membership.model_copy(update={"role": "group_admin", "added_by": actor.user_id})
        _teams.set_member(membership)
        logger.info("user %s made %s a group admin of team %s", actor.user_id, user_id, team_id)
        audit_log.record(
            _audit, actor.user_id, "team.group_admin_granted", "membership", user_id,
            team_id=team_id, before={"role": "member"}, after={"role": "group_admin"},
        )
    return _membership_body(membership)


@app.delete("/teams/{team_id}/admins/{user_id}")
def revoke_group_admin(team_id: str, user_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """Make a group admin an ordinary member again. The Super Admin may do this for anyone;
    a group admin only for themselves."""
    actor, membership = _team_member_target(
        team_id, user_id, user, "role.revoke_group_admin", (team_id, user_id)
    )
    if membership.role == "group_admin":
        membership = membership.model_copy(update={"role": "member", "added_by": actor.user_id})
        _teams.set_member(membership)
        logger.info("user %s removed %s as group admin of team %s", actor.user_id, user_id, team_id)
        audit_log.record(
            _audit, actor.user_id, "team.group_admin_revoked", "membership", user_id,
            team_id=team_id, before={"role": "group_admin"}, after={"role": "member"},
        )
    return _membership_body(membership)


@app.put("/admin/users/{user_id}/role")
def admin_set_role(
    user_id: str, req: RoleRequest, admin: UserRecord = Depends(require_master)
) -> dict[str, Any]:
    """Make a user an admin, or take it away (master admin only). The master's own role
    can't be changed here, so the platform always has one; admins can't remove each
    other."""
    target = _users.get(user_id)
    if target is None:
        raise AdminNotFoundError()
    if target.role == "master":
        raise MasterAdminLockedError()
    updated = _users.set_role(user_id, req.role, admin.id)
    if updated is None:
        raise AdminNotFoundError()
    logger.info("admin %s set role of user %s to %s", admin.id, user_id, req.role)
    if target.role != updated.role:
        audit_log.record(
            _audit, admin.id, "user.role_changed", "user", user_id,
            before={"role": target.role}, after={"role": updated.role},
        )
    return {"user": {**_public_user(updated), "role_changed_at": updated.role_changed_at}}


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
            "name": p.display_name,
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
    for p in providers:
        p["tool_calling"] = _stored_tool_calling(p["provider"], p["model"])
    # Amazon Bedrock: whatever this AWS account can use, called with IAM credentials.
    if aws_credentials_available():
        providers += [
            {**m, "available": True, "group": "Amazon Bedrock",
             "tool_calling": _stored_tool_calling("bedrock", m["model"])}
            for m in bedrock_models()
        ]
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


class BriefChatRequest(BaseModel):
    """The new-project conversation so far (the console holds it; nothing is stored) and
    what the user has picked to attach. Only the attachments' names reach the model."""

    messages: list[IntakeMessage] = Field(min_length=1, max_length=40)
    document_ids: list[str] = Field(default_factory=list, max_length=50)
    datasource_ids: list[str] = Field(default_factory=list, max_length=20)
    mcp_server_ids: list[str] = Field(default_factory=list, max_length=20)


@app.post("/brief/chat")
def brief_chat(req: BriefChatRequest, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """One turn of the new-project conversation, before any plan exists: a reply, a few
    clarifying questions and the task brief so far. Creates nothing; planning is the
    user's explicit step (POST /projects with the brief)."""
    if req.messages[-1].role != "user":
        raise KnowledgeError("the last message must be the user's", status=422)
    documents = [_get_document(doc_id, user) for doc_id in dict.fromkeys(req.document_ids)]
    sources = [_get_source(source_id, user) for source_id in dict.fromkeys(req.datasource_ids)]
    mcp_servers = [_get_mcp(server_id, user) for server_id in dict.fromkeys(req.mcp_server_ids)]
    notes = _mcp_tool_notes(mcp_servers)
    tools = default_tool_names() + sorted(notes)
    if documents:
        tools += sorted(KNOWLEDGE_TOOLS)
    if any(s.tables for s in sources):
        tools += sorted(DATA_TOOLS)
    collector = UsageCollector()
    try:
        turn = discuss_brief(
            [(m.role, m.content) for m in req.messages],
            available_tools=tools,
            tool_notes=notes,
            knowledge_files=[d.filename for d in documents],
            data_tables=[t.id for s in sources for t in s.tables],
            usage=collector,
        )
    finally:
        _record_usage(user.id, None, collector.entries(), run_id=uuid.uuid4().hex)
    return turn.model_dump()


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
    # Check untested models now, so the planner knows which can't take tools.
    available_llms = _flag_tools(available_llms, user.id, check=True)
    # Side-effecting tools (network egress, third-party APIs) are excluded by default;
    # a caller opts a project into one by naming it explicitly here.
    available_tools = req.available_tools if req.available_tools is not None else default_tool_names()
    documents = [_get_document(doc_id, user) for doc_id in dict.fromkeys(req.document_ids)]
    sources = [_get_source(source_id, user) for source_id in dict.fromkeys(req.datasource_ids)]
    data_tables = [t.id for s in sources for t in s.tables]
    # knowledge_search only when files come with the project — otherwise there's nothing
    # for it to search.
    # SQL tools likewise only when data sources with tables come with it.
    available_tools = [t for t in available_tools if t not in KNOWLEDGE_TOOLS | DATA_TOOLS]
    if documents:
        available_tools = [*available_tools, *sorted(KNOWLEDGE_TOOLS)]
    if data_tables:
        available_tools = [*available_tools, *sorted(DATA_TOOLS)]
    mcp_servers = [_get_mcp(server_id, user) for server_id in dict.fromkeys(req.mcp_server_ids)]
    mcp_notes = _mcp_tool_notes(mcp_servers)
    available_tools = [t for t in available_tools if not is_mcp_tool(t)] + sorted(mcp_notes)
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
            data_tables=data_tables,
            tool_notes=mcp_notes,
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
            name=_clean_name(req.name),
            plan=plan,
            side_effect_tools_enabled=side_effect_tools_enabled,
            conversation=[ChatMessage(role=m.role, content=m.content) for m in req.intake],
        )
    )
    for doc in documents:
        _knowledge.attach(user.id, doc.id, project_id)
    for source in sources:
        _datasources.update(user.id, source.id, project_ids=[*source.project_ids, project_id])
    for server in mcp_servers:
        _mcp.update(user.id, server.id, project_ids=[*server.project_ids, project_id])
    return {
        "project_id": project_id,
        "name": _clean_name(req.name) or brief_title(req.brief),
        "named": _clean_name(req.name) is not None,
        "brief": req.brief,
        "plan": plan.model_dump(),
        "side_effect_tools_enabled": side_effect_tools_enabled,
    }


@app.get("/projects")
def list_projects(scope: str | None = None, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    """The projects the signed-in user may see, most recently updated first: their own plus
    those their teams share with them (`team_access`) - summaries only; fetch one by id
    for its full plan. The Super Admin can pass `scope=all` to list every project; for
    anyone else the parameter changes nothing."""
    actor = _actor(user)
    reaching = _grants.list_for_grantee(actor.user_id, list(actor.team_roles))
    return {
        "projects": [
            {
                "project_id": p.id,
                "name": p.display_name,
                "named": p.name is not None,
                "brief": p.brief,
                "orchestration_pattern": p.plan.orchestration_pattern,
                "agent_count": len(p.plan.agents),
                "compiled": p.is_compiled,
                "created_at": p.created_at,
                "updated_at": p.updated_at,
                "mine": p.tenant_id == user.id,
                "team_id": p.team_id,
                "team_access": p.team_access,
                "access_level": _level_name(access_rank(actor, p, None, reaching)),
            }
            for p in list_visible_projects(_store, actor, everything=scope == "all", grants=reaching)
        ]
    }


@app.get("/projects/{project_id}")
def get_project(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    actor = _actor(user)
    project = _project_at(project_id, user, "view")
    grants = _grants.list_for_project(project_id)
    manage = has_full_rank(actor, project)
    body = _project_body(project, manage)
    body["access_level"] = _level_name(access_rank(actor, project, None, grants))
    if not manage:  # a viewer or grantee sees the plan, not the owner's chat or resources
        body.update(conversation=[], knowledge=None, data_sources=None, mcp=None, deployment=None)
        if access_rank(actor, project, None, grants) == 0:
            # shared agent by agent: only those agents' configuration, nothing of the brief or the rest
            mine = [a for a in project.plan.agents if access_rank(actor, project, a.id, grants) > 0]
            body.update(plan={"agents": [a.model_dump() for a in mine]}, brief="", restricted=True)
    return body


class RenameProjectRequest(BaseModel):
    # Empty clears the name: the project is called by its brief's first line again.
    name: str = Field(max_length=PROJECT_NAME_MAX)


def _clean_name(name: str | None) -> str | None:
    """A name as stored: whitespace collapsed; empty means none."""
    cleaned = " ".join((name or "").split())
    return cleaned or None


@app.patch("/projects/{project_id}")
def rename_project(
    project_id: str, req: RenameProjectRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    """Rename a project. Changes only its name — not the brief, plan or plan version."""
    _get_project(project_id, user)
    updated = _store.rename(project_id, _clean_name(req.name))
    if updated is None:
        raise ProjectNotFoundError(project_id)
    return _project_body(updated)


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
    _datasources.detach_project(user.id, project_id)
    _mcp.detach_project(user.id, project_id)
    _runs.delete_for_project(project.tenant_id, project_id)
    _grants.delete_for_project(project_id)
    _models.delete_for_project(project_id)
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
    has_data = bool(_attached_sources(project))
    mcp_offered = set(_mcp_tool_notes(_attached_mcp(project)))
    problems: list[str] = []
    updates: dict[str, Any] = {}
    for change in req.agents:
        agent = agents.get(change.id)
        if agent is None:
            problems.append(f"no agent '{change.id}' in this plan")
            continue
        if (change.provider, change.model) not in current_models and not _model_allowed(change.provider, change.model):
            problems.append(f"{change.provider}/{change.model} isn't one of the available models")
        unknown = [t for t in change.tools if t not in TOOL_REGISTRY and not is_mcp_tool(t)]
        if unknown:
            problems.append(f"unknown tool(s) for '{change.id}': {unknown}")
        unoffered = [t for t in change.tools if is_mcp_tool(t) and t not in mcp_offered]
        if unoffered:
            problems.append(
                f"{', '.join(unoffered)}: attach the tool's MCP server to this project and approve the tool first"
            )
        if set(change.tools) & KNOWLEDGE_TOOLS and not has_knowledge:
            problems.append("knowledge_search needs files attached to this project first")
        if set(change.tools) & DATA_TOOLS and not has_data:
            problems.append("sql_schema and sql_query need a data source attached to this project first")
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
    tool_problems = _tool_problems(plan, user.id)
    if tool_problems:
        raise ModelCannotCallToolsError("; ".join(tool_problems))
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
    _project_at(project_id, user, "edit")
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
    current_models = {(a.llm.provider, a.llm.model) for a in project.plan.agents}
    if req.tools is not None:
        unknown = [t for t in req.tools if t not in TOOL_REGISTRY]
        if unknown:
            raise KnowledgeError(f"unknown tool(s): {', '.join(unknown)}", status=422)
    if req.model is not None:
        choice = (req.model.provider, req.model.model)
        if choice not in current_models and not _model_allowed(*choice):
            raise KnowledgeError(f"not an available model: {'/'.join(choice)}", status=422)
    # A revision may use any built-in tool, but external tools only if this project
    # already opted into them — a chat message is not an opt-in. The Tools chip
    # (req.tools) is: switching a tool on there is an explicit user action.
    allowed_tools = _offered_tools(project, req.tools)
    if req.model is not None:
        # The Model chip: every agent of the revised plan uses this model.
        allowed_llms = [{"provider": req.model.provider, "model": req.model.model}]
    else:
        allowed_llms = [{"provider": p, "model": m} for p, m in DEFAULT_MODELS.items()]
        allowed_llms += [{"provider": "bedrock", "model": m["model"]} for m in recommended_bedrock_models()]
        for provider, model in current_models:
            current = {"provider": provider, "model": model}
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
            available_llms=_flag_tools(allowed_llms, user.id, check=False),
            usage=collector,
            tool_notes=_mcp_tool_notes(_attached_mcp(project)),
            data_tables=[t.id for s in _attached_sources(project) for t in s.tables],
            requested_agent_count=req.agent_count,
        )
    finally:
        _record_usage(user.id, project_id, collector.entries(), run_id=uuid.uuid4().hex)
    changed = revision.brief != project.brief or revision.plan != project.plan
    # The Tools chip's external tools become the project's opt-ins, plus any the saved plan
    # still uses (so a plan never uses a tool the project hasn't opted into).
    enabled = None
    if req.tools is not None:
        saved_plan = revision.plan if changed else project.plan
        used = {t for a in saved_plan.agents for t in a.tools}
        enabled = sorted((set(req.tools) | used) & SIDE_EFFECT_TOOLS)
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
        side_effect_tools_enabled=enabled,
    )
    if updated is None:
        raise PlanConflictError(project_id)
    if changed:
        _COMPILED.pop(project_id, None)
    return {"changed": changed, "reply": reply.model_dump(), "project": _project_body(updated)}


@app.post("/projects/{project_id}/compile")
def compile_project(project_id: str, user: UserRecord = Depends(current_user)) -> dict[str, Any]:
    project = _project_at(project_id, user, "edit")
    _compiled_graph(project)
    _store.mark_compiled(project_id, project.plan_version)
    return {"project_id": project_id, "status": "compiled"}


@app.post("/projects/{project_id}/run")
def run_project(
    project_id: str, req: RunRequest, user: UserRecord = Depends(current_user)
) -> dict[str, Any]:
    project = _project_at(project_id, user, "use")
    if not project.is_compiled:
        raise NotCompiledError(project_id)
    collector = UsageCollector()
    graph = _compiled_graph(project)
    recorder = _RunRecorder(_new_run(project, kind="local", mode="graph", task_input=req.input, started_by=user.id))
    try:
        result = run_graph(graph, req.input, project.plan.bounds, collector, _call_identity(project, user.id))
    except TimeoutError:
        recorder.finish(error={"error_type": "RunTimeout",
                               "message": f"the run exceeded its {project.plan.bounds.timeout_s:g}s time limit"},
                        usage=usage_mod.summarize(collector.entries()))
        raise RunTimeoutError(project.plan.bounds.timeout_s) from None
    finally:
        # Whatever was used up to a timeout is still spent.
        _record_usage(user.id, project_id, collector.entries(), run_id=recorder.run.id)
    recorder.finish(outputs=result["outputs"], errors=result["errors"], halted=result["halted"],
                    usage=usage_mod.summarize(collector.entries()))
    _learn_from_errors(project, result["errors"])
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
    project = _project_at(project_id, user, "use")
    if not project.is_compiled:
        raise NotCompiledError(project_id)
    graph = _compiled_graph(project)

    recorder = _RunRecorder(_new_run(project, kind="local", mode="graph", task_input=req.input, started_by=user.id))

    def stream():
        # Saved as it streams; a client disconnect still records usage so far (and the run
        # as interrupted).
        for event, data in _graph_events(project, graph, req.input, UsageCollector(), recorder):
            yield f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"

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
    project = _project_at(project_id, user, "use", agent_id)
    if not any(a.id == agent_id for a in project.plan.agents):
        return JSONResponse(
            status_code=404,
            content={"error_type": "AgentNotFound", "message": f"agent '{agent_id}' not in project '{project_id}'",
                     "details": None},
        )
    collector = UsageCollector()
    recorder = _RunRecorder(_new_run(project, kind="local", mode="agent", task_input=req.input, agent_id=agent_id,
                                     started_by=user.id))
    result = _agent_run(project, agent_id, req.input, req.upstream_outputs, collector, recorder)
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
    body = embedding.model_dump() if embedding else None
    return {
        # The default for new uploads; each file carries the model it is indexed with.
        "default_embedding": body,
        "embedding": body,  # older name, kept for compatibility
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
    default = _knowledge.get_embedding(user.id)
    documents = []
    for d in docs:
        body = _document_body(d, default)
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
                "name": p.display_name,
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
            embedding=config,
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
    """Set the embedding model new uploads use. Files already in the library keep the
    model they were indexed with; change a file's model with
    PUT /knowledge/documents/{id}/embedding."""
    _check_embedding(config)
    current = _knowledge.get_embedding(user.id)
    if config == current:
        return knowledge_library(user)
    # Files from before per-file models follow the default: pin them to the model they
    # were actually indexed with before it changes.
    if current is not None:
        for d in _knowledge.list_documents(user.id):
            if d.embedding is None:
                _knowledge.update_document(user.id, d.id, embedding=current)
    _knowledge.set_embedding(user.id, config)
    return knowledge_library(user)


def _check_embedding(config: EmbeddingConfig) -> None:
    if embedding_option(config.provider, config.model) is None:
        raise KnowledgeError(
            f"unknown embedding model; choose one of {_embedding_options()}", status=422
        )
    get_embeddings(config)  # missing key -> MissingProviderKey now


@app.put("/knowledge/documents/{document_id}/embedding")
def set_document_embedding(
    document_id: str,
    config: EmbeddingConfig,
    background: BackgroundTasks,
    response: Response,
    user: UserRecord = Depends(current_user),
) -> dict[str, Any]:
    """Re-index one library file with a different embedding model. Its stored passages
    are re-embedded in the background (202; the file shows processing until ready); the
    file needn't be uploaded again. Agents keep finding it: search embeds the question
    once per model in use."""
    doc = _get_document(document_id, user).effective()
    _check_embedding(config)
    default = _knowledge.get_embedding(user.id)
    if kb.effective_embedding(doc, default) == config and doc.status == "ready":
        return {"document": _document_body(doc, default)}
    if doc.status in ("queued", "processing"):
        raise KnowledgeBusyError()
    if doc.chunk_count == 0:
        raise KnowledgeError(
            f"'{doc.filename}' has no stored passages to re-index; upload it again", status=409
        )
    _knowledge.update_document(user.id, document_id, status="processing", error=None)
    background.add_task(_reembed, user.id, document_id, config)
    response.status_code = 202
    return {"document": _document_body(_get_document(document_id, user), default)}


def _search_body(tenant_id: str, project_id: str | None, req: KnowledgeSearchRequest) -> dict[str, Any]:
    context = kb.store_context(_knowledge, tenant_id, project_id, _embedder_for)
    collector = UsageCollector()

    def count(config: EmbeddingConfig, query: str) -> None:
        _embedding_counter(collector, config, "embedding_query")([query])

    try:
        hits = context.search(req.query, req.k, on_query_embedded=count)
    finally:
        _record_usage(tenant_id, project_id, collector.entries(), run_id=uuid.uuid4().hex)
    return {
        "results": [
            {"filename": h.filename, "source": h.source, "text": h.text, "score": h.score, "model": h.model}
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
    names = {p.id: p.display_name for p in _store.list_for_tenant(user.id)}
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
    # MCP calls are counted but never priced, so they're never "missing" a price.
    seen = {
        (r.provider, r.model) for r in _usage.list(user.id, since)
        if r.kind not in usage_mod.UNCOSTED_KINDS
    }
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
    embeddings: list[EmbeddingConfig] = []
    if uses_knowledge(project.plan):
        docs = [d.effective() for d in _knowledge.list_documents(user.id, project_id)]
        if any(d.status in ("queued", "processing") for d in docs):
            raise KnowledgeBusyError()
        default = _knowledge.get_embedding(user.id)
        for d in docs:
            model = kb.effective_embedding(d, default)
            if d.status == "ready" and model is not None and model not in embeddings:
                embeddings.append(model)
        if not embeddings:
            raise KnowledgeUnavailableError()

        def snapshot():
            return kb.build_snapshot(_knowledge, user.id, project_id)

    data_snapshot = None
    if uses_data(project.plan):
        sources = _attached_sources(project)
        if not sources:
            raise DataSourceUnavailableError()

        def data_snapshot():
            return ds.snapshot([s.config() for s in _attached_sources(project)])

    mcp_snapshot = None
    if uses_mcp(project.plan):
        _deployable_mcp(project)  # fail now if a tool the plan uses isn't attached and approved

        def mcp_snapshot():
            configs = _deployable_mcp(project)
            secrets = {
                mc.secret_env_name(c.slug): json.dumps({"url": c.url, "headers": c.headers}) for c in configs
            }
            return mc.snapshot(configs), secrets

    runtime_environment(project.plan, embeddings)

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
    json_models = sorted(_json_models(project.plan, user.id))
    background.add_task(
        run_deployment, project_id, _store, cloud, _package_builder, snapshot, embeddings, data_snapshot,
        json.dumps(json_models).encode("utf-8") if json_models else None, mcp_snapshot=mcp_snapshot,
    )
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
    payload: dict[str, Any] = {"input": req.input}
    if req.agent_id is not None:
        payload["agent_id"] = req.agent_id
        payload["upstream_outputs"] = req.upstream_outputs
    # Saved as a deployed run too; the runtime reports its own usage (runtimes deployed
    # before usage reporting don't), recorded against the run's id.
    recorder = _RunRecorder(_new_run(
        project, kind="deployed", mode="agent" if req.agent_id else "graph", task_input=req.input,
        agent_id=req.agent_id, plan_version=deployment.live_plan_version,
    ))
    result = _deployed_run(project, payload, recorder)
    return {
        "project_id": project_id,
        "plan_version": deployment.live_plan_version,
        "outputs": result.get("outputs", {}),
        "errors": result.get("errors", []),
        "halted": bool(result.get("halted", False)),
        "usage": result["usage_summary"],
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


@app.exception_handler(AccessRevokedError)
def _handle_access_revoked(_req: Request, exc: AccessRevokedError):
    return _error_response(403, "AccessRevoked", str(exc))


@app.exception_handler(RunStoppedError)
def _handle_run_stopped(_req: Request, exc: RunStoppedError):
    return _error_response(409, "RunStopped", str(exc))


@app.exception_handler(RunNotStoppableError)
def _handle_run_not_stoppable(_req: Request, exc: RunNotStoppableError):
    return _error_response(409, "RunNotStoppable", str(exc))


@app.exception_handler(RunNotFoundError)
def _handle_run_not_found(_req: Request, exc: RunNotFoundError):
    return _error_response(404, "RunNotFound", str(exc))


@app.exception_handler(ModelCannotCallToolsError)
def _handle_cannot_call_tools(_req: Request, exc: ModelCannotCallToolsError):
    return _error_response(422, "ModelCannotCallTools", str(exc))


@app.exception_handler(AdminNotFoundError)
def _handle_admin_not_found(_req: Request, exc: AdminNotFoundError):
    return _error_response(404, "NotFound", str(exc))


@app.exception_handler(MasterAdminRequiredError)
def _handle_master_required(_req: Request, exc: MasterAdminRequiredError):
    return _error_response(403, "MasterAdminRequired", str(exc))


@app.exception_handler(TeamNotFoundError)
def _handle_team_not_found(_req: Request, exc: TeamNotFoundError):
    return _error_response(404, "NotFound", str(exc))


@app.exception_handler(ShareError)
def _handle_share(_req: Request, exc: ShareError):
    return _error_response(exc.status, exc.error_type, str(exc))


@app.exception_handler(TeamProtectedError)
def _handle_team_protected(_req: Request, exc: TeamProtectedError):
    return _error_response(409, "TeamProtected", str(exc))


@app.exception_handler(NotATeamMemberError)
def _handle_not_team_member(_req: Request, exc: NotATeamMemberError):
    return _error_response(409, "NotATeamMember", str(exc))


@app.exception_handler(MasterAdminLockedError)
def _handle_master_locked(_req: Request, exc: MasterAdminLockedError):
    return _error_response(409, "MasterAdmin", str(exc))


@app.exception_handler(McpError)
def _handle_mcp(_req: Request, exc: McpError):
    return _error_response(exc.status, exc.error_type, str(exc), getattr(exc, "details", None))


@app.exception_handler(SecretsNotConfiguredError)
def _handle_secrets_not_configured(_req: Request, exc: SecretsNotConfiguredError):
    return _error_response(503, "SecretsNotConfigured", str(exc))


@app.exception_handler(DataSourceError)
def _handle_data_source(_req: Request, exc: DataSourceError):
    return _error_response(exc.status, exc.error_type, str(exc), getattr(exc, "details", None))


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


@app.exception_handler(export_mod.ExportUnavailable)
def _handle_export_unavailable(_req: Request, exc: export_mod.ExportUnavailable):
    return _error_response(exc.status, "ExportUnavailable", str(exc))


@app.exception_handler(PlatformError)
def _handle_platform(_req: Request, exc: PlatformError):
    return _error_response(400, type(exc).__name__, str(exc))
