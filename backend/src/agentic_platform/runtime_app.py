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

import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .agent_schema import AgentPlan
from .errors import PlatformError
from .graph_builder import compile_graph, get_embeddings, run_graph, run_single_agent
from .knowledge import KnowledgeContext, SnapshotContext, load_snapshot


class InvocationRequest(BaseModel):
    input: dict[str, Any]
    # Run just this agent instead of the whole graph, like the local per-agent endpoint.
    agent_id: str | None = None
    upstream_outputs: dict[str, Any] = Field(default_factory=dict)


def _error(status: int, error_type: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error_type": error_type, "message": message, "details": None},
    )


def _snapshot_context(directory: Path | None) -> KnowledgeContext | None:
    snapshot = load_snapshot(directory) if directory is not None else None
    if snapshot is None:
        return None
    embedding, filenames, passages, matrix = snapshot
    context = SnapshotContext(get_embeddings(embedding).embed_query, filenames, passages, matrix)
    context.embedding = (embedding.provider, embedding.model)
    return context


def create_app(plan_data: dict[str, Any], knowledge_dir: Path | None = None) -> FastAPI:
    """Build the runtime app for one plan. The plan is validated and compiled here, at
    startup, so a broken deployment fails its health check instead of its first call.
    `knowledge_dir` holds the knowledge-base snapshot, if the deployment has one."""
    plan = AgentPlan.model_validate(plan_data)
    knowledge = _snapshot_context(knowledge_dir)
    graph = compile_graph(plan, knowledge)
    started = int(time.time())

    app = FastAPI(title="Agentic Platform runtime", docs_url=None, redoc_url=None)

    @app.get("/ping")
    def ping() -> dict[str, Any]:
        return {"status": "Healthy", "time_of_last_update": started}

    @app.post("/invocations")
    def invocations(req: InvocationRequest):
        if req.agent_id is not None:
            try:
                result = run_single_agent(
                    plan, req.agent_id, req.input, req.upstream_outputs, knowledge
                )
            except KeyError:
                return _error(404, "AgentNotFound", f"agent '{req.agent_id}' is not in this plan")
            return {
                "outputs": result.get("outputs", {}),
                "errors": result.get("errors", []),
                "halted": bool(result.get("halted", False)),
                "usage": result.get("usage", []),
            }
        try:
            result = run_graph(graph, req.input, plan.bounds)
        except TimeoutError as e:
            return _error(504, "RunTimeout", str(e))
        return {
            "outputs": result["outputs"],
            "errors": result["errors"],
            "halted": result["halted"],
            # Tokens per agent and model, so the platform can account for deployed runs.
            "usage": result.get("usage", []),
        }

    @app.exception_handler(RequestValidationError)
    def _bad_request(_req: Request, exc: RequestValidationError):
        return _error(422, "ValidationError", "the request body must be {\"input\": {...}}")

    @app.exception_handler(PlatformError)
    def _platform_error(_req: Request, exc: PlatformError):
        # e.g. a provider key missing from the runtime's environment.
        return _error(500, type(exc).__name__, str(exc))

    return app
