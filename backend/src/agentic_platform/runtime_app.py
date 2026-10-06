"""The HTTP app that serves one compiled project inside Amazon Bedrock AgentCore Runtime.

AgentCore's contract: `GET /ping` for health and `POST /invocations` for work, on port
8080. This wraps the same `compile_graph` / `run_graph` / `run_single_agent` the local
FastAPI app uses, and accepts the same task-input JSON as `POST /projects/{id}/run`, so a
plan behaves identically locally and deployed — only the serving envelope differs.

It deliberately depends on nothing but the plan: no database, no user accounts. A
deployment bakes the validated plan into the package (see deploy.py) — plus a snapshot of
the project's knowledge base when an agent uses knowledge_search — and provider keys
arrive as environment variables.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .agent_schema import AgentPlan
from .errors import PlatformError
from .graph_builder import compile_graph, get_embeddings, run_graph, run_single_agent
from . import datasources as ds
from .knowledge import KnowledgeContext, cached_embedders, load_snapshot, snapshot_context
from .usage import UsageCollector

# Every invocation prints one line like this (stdout → CloudWatch, via AgentCore), so the
# platform can count runs that were invoked straight through AWS, not through it. It holds
# only ids, labels and token counts — never task input, output, document text or keys.
USAGE_LOG_TYPE = "agentic_usage"
USAGE_LOG_VERSION = 1


def log_usage(run_id: str, via: str, usage: UsageCollector) -> None:
    print(
        json.dumps(
            {
                "type": USAGE_LOG_TYPE,
                "v": USAGE_LOG_VERSION,
                "run_id": run_id,
                "via": via,
                "at": round(time.time(), 3),
                "usage": usage.entries(),
            }
        ),
        flush=True,
    )


class InvocationRequest(BaseModel):
    input: dict[str, Any]
    # Run just this agent instead of the whole graph, like the local per-agent endpoint.
    agent_id: str | None = None
    upstream_outputs: dict[str, Any] = Field(default_factory=dict)
    # Set by the platform when it makes the call, so its own record and the usage log line
    # share an id; a direct AWS caller leaves it out and the runtime makes one.
    run_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


def _error(status: int, error_type: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error_type": error_type, "message": message, "details": None},
    )


def _snapshot_context(directory: Path | None) -> KnowledgeContext | None:
    groups = load_snapshot(directory) if directory is not None else None
    if groups is None:
        return None
    return snapshot_context(groups, cached_embedders(lambda config: get_embeddings(config)))


def _json_models(directory: Path | None) -> set[str]:
    """Models in this plan that can't call tools (written at deploy time)."""
    path = directory / "models.json" if directory is not None else None
    if path is None or not path.exists():
        return set()
    return set(json.loads(path.read_text(encoding="utf-8")))


def create_app(plan_data: dict[str, Any], knowledge_dir: Path | None = None) -> FastAPI:
    """Build the runtime app for one plan. The plan is validated and compiled here, at
    startup, so a broken deployment fails its health check instead of its first call.
    `knowledge_dir` holds the knowledge-base snapshot, if the deployment has one."""
    plan = AgentPlan.model_validate(plan_data)
    knowledge = _snapshot_context(knowledge_dir)
    sources = ds.load_snapshot(knowledge_dir) if knowledge_dir is not None else None
    data = ds.config_context(sources) if sources else None
    json_models = _json_models(knowledge_dir)
    graph = compile_graph(plan, knowledge, data, json_models)
    started = int(time.time())

    app = FastAPI(title="Agentic Platform runtime", docs_url=None, redoc_url=None)

    @app.get("/ping")
    def ping() -> dict[str, Any]:
        return {"status": "Healthy", "time_of_last_update": started}

    @app.post("/invocations")
    def invocations(req: InvocationRequest):
        run_id = req.run_id or uuid.uuid4().hex
        usage = UsageCollector()
        try:
            return _invoke(req, run_id, usage)
        finally:
            # Every path — success, timeout, error — logs what it used.
            log_usage(run_id, "platform" if req.run_id else "direct", usage)

    def _invoke(req: InvocationRequest, run_id: str, usage: UsageCollector):
        if req.agent_id is not None:
            try:
                result = run_single_agent(
                    plan, req.agent_id, req.input, req.upstream_outputs, knowledge, usage=usage, data=data,
                    json_models=json_models,
                )
            except KeyError:
                return _error(404, "AgentNotFound", f"agent '{req.agent_id}' is not in this plan")
            return {
                "outputs": result.get("outputs", {}),
                "errors": result.get("errors", []),
                "halted": bool(result.get("halted", False)),
                "usage": usage.entries(),
                "run_id": run_id,
            }
        try:
            result = run_graph(graph, req.input, plan.bounds, usage)
        except TimeoutError as e:
            return _error(504, "RunTimeout", str(e))
        return {
            "outputs": result["outputs"],
            "errors": result["errors"],
            "halted": result["halted"],
            # Tokens per agent and model, so the platform can account for deployed runs.
            "usage": usage.entries(),
            "run_id": run_id,
        }

    @app.exception_handler(RequestValidationError)
    def _bad_request(_req: Request, exc: RequestValidationError):
        return _error(422, "ValidationError", "the request body must be {\"input\": {...}}")

    @app.exception_handler(PlatformError)
    def _platform_error(_req: Request, exc: PlatformError):
        # e.g. a provider key missing from the runtime's environment.
        return _error(500, type(exc).__name__, str(exc))

    return app
