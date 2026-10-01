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


class PlanConflictError(PlatformError):
    """The plan changed between reading it and writing a revision of it."""

    def __init__(self, project_id: str):
        self.project_id = project_id
        super().__init__(
            "the plan changed while this request was being handled; review it and try again"
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
