"""Typed platform errors, shared across the planner, compiler, and API layer.

Centralizing these here (rather than one-off exceptions per module) is what lets the
FastAPI layer map every failure mode to a stable error response with one exception
handler per type, instead of catching provider- or library-specific exceptions at
every call site.
"""

from __future__ import annotations

from typing import Any


class PlatformError(Exception):
    """Base class for all typed platform errors."""


class UnknownToolError(PlatformError):
    def __init__(self, names: list[str]):
        self.names = names
        super().__init__(f"unknown tool name(s): {names}")


class MissingProviderKeyError(PlatformError):
    def __init__(self, provider: str, env_var: str):
        self.provider = provider
        self.env_var = env_var
        super().__init__(
            f"no API key found for provider '{provider}' (expected env var {env_var})"
        )


class UnsupportedProviderError(PlatformError):
    def __init__(self, provider: str):
        self.provider = provider
        super().__init__(f"unsupported LLM provider: '{provider}'")


class MissingToolKeyError(PlatformError):
    def __init__(self, tool_name: str, env_var: str):
        self.tool_name = tool_name
        self.env_var = env_var
        super().__init__(
            f"no API key found for tool '{tool_name}' (expected env var {env_var})"
        )


class StoreUnavailableError(PlatformError):
    """A store (database) could not be reached or failed an operation."""

    def __init__(self, detail: str):
        super().__init__(f"store unavailable: {detail}")


class AuthenticationError(PlatformError):
    """The request carries no valid credentials. Messages stay deliberately vague — they
    never say whether an email exists or which part of a token was wrong."""

    def __init__(self, message: str = "not authenticated"):
        super().__init__(message)


class EmailTakenError(PlatformError):
    def __init__(self) -> None:
        super().__init__("an account with this email already exists")


class ProjectDeployedError(PlatformError):
    """A project with a deployment on AgentCore can't be deleted: its runtime would be
    left running, unreachable, in the AWS account."""

    def __init__(self) -> None:
        super().__init__(
            "this project is deployed on AgentCore; remove the deployment on its Deploy page "
            "before deleting the project"
        )


class PlanConflictError(PlatformError):
    """The plan changed between reading it and writing a revision of it."""

    def __init__(self, project_id: str):
        self.project_id = project_id
        super().__init__(
            "the plan changed while this request was being handled; review it and try again"
        )


class RunTimeoutError(PlatformError):
    def __init__(self, limit_s: float):
        self.limit_s = limit_s
        super().__init__(
            f"the run exceeded its {limit_s:g}s time limit. Agents that search the web or "
            "use large models can need longer: raise bounds.timeout_s in the plan "
            "(Plan → Edit as JSON), compile, and run again"
        )


class DeployError(PlatformError):
    """A deployment step failed (packaging, AWS provisioning, or the runtime itself)."""


class DeployNotConfiguredError(PlatformError):
    def __init__(self) -> None:
        super().__init__(
            "deployment is not set up on this server: no AWS credentials were found "
            "(configure them with `aws configure` or `aws sso login`, then restart the API)"
        )


class DeployInProgressError(PlatformError):
    def __init__(self) -> None:
        super().__init__("a deployment of this project is already in progress")


class NotDeployedError(PlatformError):
    def __init__(self) -> None:
        super().__init__("this project has no live deployment")


class DeployedRunError(PlatformError):
    """The deployed runtime answered, but with an error."""

    def __init__(self, status: int, error_type: str, message: str):
        self.status = status
        self.error_type = error_type
        super().__init__(message)


class KnowledgeError(PlatformError):
    """A document can't be added to a knowledge base (type, size, content, limits).
    The message is written for the person who uploaded it."""

    def __init__(self, message: str, status: int = 400):
        self.status = status
        super().__init__(message)


class DocumentNotFoundError(PlatformError):
    def __init__(self, document_id: str):
        super().__init__(f"document not found: {document_id}")


class KnowledgeBusyError(PlatformError):
    def __init__(self) -> None:
        super().__init__(
            "documents are still being indexed; wait until they are ready and try again"
        )


class KnowledgeUnavailableError(PlatformError):
    """knowledge_search was requested where there is no knowledge base to search."""

    def __init__(self) -> None:
        super().__init__(
            "knowledge_search needs a knowledge base: upload documents on the project's "
            "Knowledge page first"
        )


class DataSourceError(PlatformError):
    """A data source can't be connected, read or queried. The message is written for the
    person (or agent) who asked; `status` and `error_type` are the API's response."""

    def __init__(self, message: str, status: int = 400, error_type: str = "DataSourceError"):
        self.status = status
        self.error_type = error_type
        super().__init__(message)


class DataSourceNotFoundError(DataSourceError):
    def __init__(self, source_id: str):
        super().__init__(f"data source not found: {source_id}", status=404, error_type="DataSourceNotFound")


class DataSourceUnavailableError(DataSourceError):
    """sql_schema / sql_query were requested where no data source is attached."""

    def __init__(self) -> None:
        super().__init__(
            "sql_schema and sql_query need a data source: attach one to this project on the "
            "Data sources page first",
            status=409,
            error_type="DataSourceUnavailable",
        )


class QueryRefusedError(DataSourceError):
    """The platform refused an agent's SQL before running it (or BigQuery stopped it). The
    message tells the agent what to change."""

    def __init__(self, message: str):
        super().__init__(message, status=422, error_type="QueryRefused")


class SecretsNotConfiguredError(PlatformError):
    """The server has no PLATFORM_SECRET_KEY, so it can't store a secret encrypted."""

    def __init__(self) -> None:
        super().__init__(
            "this server can't store secrets: set PLATFORM_SECRET_KEY in backend/.env "
            "(see docs/mcp_setup.md)"
        )


class McpError(PlatformError):
    """An MCP server can't be reached, signed in to, or used. Messages name the server's
    host, never its URL: a URL can carry the server's key."""

    def __init__(self, message: str, status: int = 400, error_type: str = "McpError"):
        self.status = status
        self.error_type = error_type
        super().__init__(message)


class McpServerNotFoundError(McpError):
    def __init__(self, server_id: str):
        super().__init__(f"MCP server not found: {server_id}", status=404, error_type="McpServerNotFound")


class McpUnavailableError(McpError):
    """A plan uses MCP tools that no attached server offers (detached, or not approved)."""

    def __init__(self, names: list[str]):
        self.names = names
        super().__init__(
            "these MCP tools aren't available to this project: "
            + ", ".join(sorted(names))
            + ". Attach their server and approve the tools on the MCP servers page",
            status=409,
            error_type="McpUnavailable",
        )


class RunStoppedError(PlatformError):
    """The run was stopped (by the user, or because it ran out of time). Raised at an
    agent's next checkpoint so an abandoned run stops spending; never retried."""

    def __init__(self, message: str = "the run was stopped") -> None:
        super().__init__(message)


class AccessRevokedError(RunStoppedError):
    """The person running this no longer has access to the project or agent (a share was
    revoked, or they left the team). Raised before the next model call, so a live session
    ends at once and spends nothing more; handled like a stopped run, never retried."""

    def __init__(self, message: str = "your access to this agent was removed") -> None:
        super().__init__(message)


class ModelNotPermittedError(RunStoppedError):
    """The person running this may not use the agent's model (org catalog, team, member or user
    limit), and no allowed fallback exists. The agent stops gracefully before the call; the
    run ends with this typed error and is never retried."""

    code = "MODEL_NOT_PERMITTED"

    def __init__(self, model: str, reason: str | None) -> None:
        self.model = model
        self.reason = reason
        why = {"unpriced": "it has no price, so its cost cannot be limited",
               "unknown_model": "the platform does not offer it"}.get(reason or "", f"your {reason} limit does not include it")
        super().__init__(f"you may not use the model {model}: {why}")


class RunNotStoppableError(PlatformError):
    def __init__(self, run_id: str):
        super().__init__(f"run {run_id} runs on AWS and can't be stopped from here; it ends at its time limit")


class AdminNotFoundError(PlatformError):
    """An admin route asked for by a non-admin, or an unknown user: both read as a plain
    404, so the admin area isn't shown to exist."""

    def __init__(self) -> None:
        super().__init__("not found")


class MasterAdminRequiredError(PlatformError):
    """Only the master admin adds and removes admins; other admins only read usage."""

    def __init__(self) -> None:
        super().__init__("only the master admin can add or remove admins")


class MasterAdminLockedError(PlatformError):
    """The master admin's role isn't changed through the API, so the platform always has
    one; it's moved on the server with scripts/set_role.py."""

    def __init__(self) -> None:
        super().__init__(
            "the master admin's role can't be changed here; it's moved on the server with scripts/set_role.py"
        )


class TeamNotFoundError(PlatformError):
    """A team (or a person in it) that doesn't exist or is out of the caller's scope: one
    404, so teams can't be probed."""

    def __init__(self) -> None:
        super().__init__("not found")


class BudgetError(PlatformError):
    """A budget change the tree forbids. `status`/`error_type` are the API's response."""

    def __init__(self, message: str, status: int = 409, error_type: str = "BudgetError"):
        self.status = status
        self.error_type = error_type
        super().__init__(message)


class ShareError(PlatformError):
    """A share that is not allowed or not valid. `status`/`error_type` are the API's response."""

    def __init__(self, message: str, status: int = 422, error_type: str = "ShareRefused"):
        self.status = status
        self.error_type = error_type
        super().__init__(message)


class TeamProtectedError(PlatformError):
    """The Default team holds the backfill's state and the projects that predate teams."""

    def __init__(self) -> None:
        super().__init__("the Default team can be renamed but not deleted")


class NotATeamMemberError(PlatformError):
    """Roles within a team go to its members; add the person to the team first."""

    def __init__(self) -> None:
        super().__init__("that person is not a member of this team; add them to the team first")


class RunNotFoundError(PlatformError):
    def __init__(self, run_id: str):
        super().__init__(f"run not found: {run_id}")


class ModelCannotCallToolsError(PlatformError):
    """A model that can't call tools was given a job that needs it (tools, routing), or
    returned no structured answer where tool calling was expected."""

    def __init__(self, message: str):
        super().__init__(message)


class PlannerError(PlatformError):
    """Raised when the meta-planner cannot produce a valid AgentPlan within the retry ceiling."""

    def __init__(self, message: str, *, attempts: int, last_error: str | None = None):
        self.attempts = attempts
        self.last_error = last_error
        super().__init__(message)


class AgentExecutionError(PlatformError):
    """Structured record of an agent node exhausting its retries inside a compiled graph.

    Carried in graph state rather than raised, so one agent's failure never crashes
    sibling agents or the graph run — see AgentPlan.bounds and the compiler's
    per-node retry loop.
    """

    def __init__(self, agent_id: str, message: str, *, attempts: int):
        self.agent_id = agent_id
        self.attempts = attempts
        super().__init__(message)

    def to_dict(self) -> dict[str, Any]:
        return {"agent_id": self.agent_id, "error": str(self), "attempts": self.attempts}
