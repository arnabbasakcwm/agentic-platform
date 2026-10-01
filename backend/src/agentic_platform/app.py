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
import uuid
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import BackgroundTasks, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field, ValidationError

from .agent_schema import AgentPlan
from .auth import create_access_token, decode_access_token, hash_password, verify_password
from .agentcore import make_cloud
from .config import (
    AGENTCORE_CODE_BUCKET,
    AGENTCORE_EXECUTION_ROLE_ARN,
    AGENTCORE_REGION,
    DEFAULT_MODELS,
    DEFAULT_PROVIDER,
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
    NotDeployedError,
    PlanConflictError,
    RunTimeoutError,
    MissingToolKeyError,
    PlannerError,
    PlatformError,
    StoreUnavailableError,
    UnknownToolError,
    UnsupportedProviderError,
)
from .graph_builder import compile_graph, run_graph, run_graph_events, run_single_agent
from .meta_planner_prompt import plan_project, revise_plan
from .stores import ChatMessage, Deployment, ProjectRecord, UserRecord, make_stores
from .tools import SIDE_EFFECT_TOOLS, TOOL_REGISTRY, TOOL_SUMMARIES, default_tool_names

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

_store, _users = make_stores()


def _make_cloud():
    """The AWS side of deployments, or None when this server has no AWS credentials.
    A function (not a module constant) so credentials set up later are picked up, and so
    tests can swap in a fake."""
    return make_cloud(AGENTCORE_REGION, AGENTCORE_EXECUTION_ROLE_ARN, AGENTCORE_CODE_BUCKET)


# Swappable in tests: builds the deployment zip.
_package_builder = build_package

# Per-process cache of compiled graphs: project id -> (plan_version, graph). Purely an
# optimisation — the store's compiled_version is the source of truth for whether a
# project is runnable, and compiling makes no LLM calls, so a process that doesn't hold
# the graph (after a restart, or a different worker) just rebuilds it.
_COMPILED: dict[str, tuple[int, Any]] = {}


# --------------------------------------------------------------------------- models
class CreateProjectRequest(BaseModel):
    brief: str = Field(min_length=1)
    # Omit to let the planner choose the team size (still capped at MAX_AGENTS).
    agent_count: int | None = Field(default=None, gt=0, le=MAX_AGENTS)
    available_tools: list[str] | None = None
    available_llms: list[dict[str, str]] | None = None


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
    cached = _COMPILED.get(project.id)
    if cached is not None and cached[0] == project.plan_version:
        return cached[1]
    graph = compile_graph(project.plan)
    _COMPILED[project.id] = (project.plan_version, graph)
    return graph


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
    """Selectable provider/model pairs, with the platform default marked."""
    return {
        "providers": [
            {"provider": provider, "model": model, "default": provider == DEFAULT_PROVIDER}
            for provider, model in DEFAULT_MODELS.items()
        ]
    }


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
    # Side-effecting tools (network egress, third-party APIs) are excluded by default;
    # a caller opts a project into one by naming it explicitly here.
    available_tools = req.available_tools if req.available_tools is not None else default_tool_names()
    side_effect_tools_enabled = sorted(set(available_tools) & SIDE_EFFECT_TOOLS)
    plan = plan_project(
        user_brief=req.brief,
        requested_agent_count=req.agent_count,
        available_tools=available_tools,
        available_llms=available_llms,
    )
    project_id = uuid.uuid4().hex
    _store.create(
        ProjectRecord(
            id=project_id,
            tenant_id=user.id,
            brief=req.brief,
            plan=plan,
            side_effect_tools_enabled=side_effect_tools_enabled,
        )
    )
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
    allowed_tools = sorted(set(default_tool_names()) | set(project.side_effect_tools_enabled))
    allowed_llms = [{"provider": p, "model": m} for p, m in DEFAULT_MODELS.items()]
    for agent in project.plan.agents:
        current = {"provider": agent.llm.provider, "model": agent.llm.model}
        if current not in allowed_llms:
            allowed_llms.append(current)

    revision = revise_plan(
        brief=project.brief,
        plan=project.plan,
        request=req.message,
        history=[(m.role, m.content) for m in project.conversation],
        available_tools=allowed_tools,
        available_llms=allowed_llms,
    )
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
    try:
        result = run_graph(_compiled_graph(project), req.input, project.plan.bounds)
    except TimeoutError:
        raise RunTimeoutError(project.plan.bounds.timeout_s) from None
    return {
        "project_id": project_id,
        "outputs": result["outputs"],
        "errors": result["errors"],
        "halted": result["halted"],
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
        for event, data in run_graph_events(graph, req.input, project.plan.bounds):
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
    project = _get_project(project_id, user)
    try:
        result = run_single_agent(
            project.plan, agent_id, req.input, req.upstream_outputs
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
    return {"project_id": project_id, "agent_id": agent_id, "result": result}


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
    # Fail now, not minutes into the job, if a key the plan needs isn't configured.
    runtime_environment(project.plan)

    deployment = Deployment(
        status="packaging",
        plan_version=project.plan_version,
        region=cloud.region,
        runtime_name=runtime_name(project_id),
        runtime_id=previous.runtime_id if previous else None,
        runtime_arn=previous.runtime_arn if previous else None,
        live_plan_version=previous.live_plan_version if previous else None,
        deployed_at=previous.deployed_at if previous else None,
    )
    _store.set_deployment(project_id, deployment)
    background.add_task(run_deployment, project_id, _store, cloud, _package_builder)
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
    result = cloud.invoke(deployment.runtime_arn, payload)
    return {
        "project_id": project_id,
        "plan_version": deployment.live_plan_version,
        "outputs": result.get("outputs", {}),
        "errors": result.get("errors", []),
        "halted": bool(result.get("halted", False)),
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
