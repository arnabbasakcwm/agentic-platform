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
