"""Meta-planner: natural-language brief -> validated AgentPlan, and plan revisions.

This is the only component allowed to turn free text into a plan, and it emits nothing
but structured data (an AgentPlan, or a PlanRevision wrapping one). Even though the LLM
is asked for structured output, we re-validate server-side (principle: never trust the
model's claim that its output is well-formed) and apply the runtime error-recovery loop
to the planner itself: on a validation failure, feed the actual error back to the model
and retry up to a small ceiling before raising a typed PlannerError.
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, TypeVar

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, ValidationError

from .agent_schema import AgentPlan, LLMConfig, PlanRevision, RunBounds
from .config import DEFAULT_MODELS, DEFAULT_PROVIDER, MAX_AGENTS
from .errors import PlannerError
from .graph_builder import get_llm
from .tools import TOOL_REGISTRY

_PLANNER_RETRY_CEILING = 3
_PLANNER_BACKOFF_S = 1.0
# How much of a project's conversation a revision sees, newest last.
REVISION_HISTORY_LIMIT = 10

# Rules every plan must satisfy, whether it is designed from scratch or revised.
_PLAN_RULES = """\
- Each agent needs a unique `id` (short snake_case), a `role`, and a concrete
  `system_prompt` telling that agent exactly what to do with its input.
- `tools` for each agent must be chosen ONLY from the available tool names given below.
  Use an empty list if an agent needs no tools. Never invent tool names.
- `llm` for each agent must be chosen ONLY from the available LLM options given below
  (copy provider + model exactly).
- Wire agents with `depends_on` (list of other agent ids whose output this agent needs).
- Pick `orchestration_pattern`:
    * "sequential" — a strict pipeline where each agent feeds the next. Use for simple
      linear tasks. Wire the order with depends_on.
    * "parallel" — independent agents work on the same input concurrently, then one
      merge/synthesis agent combines them. Give the independent agents an empty
      depends_on, and give the merge agent depends_on listing all of them.
    * "supervisor" — a router agent decides at runtime which worker acts next, looping
      until done. Use when the task needs conditional branching or dynamic ordering.
- depends_on must not contain cycles for sequential/parallel patterns.
- If and ONLY if you choose "supervisor", also set `supervisor_id` to the id of the
  router agent (it must be one of the agents), and leave the worker agents' depends_on
  empty (the supervisor decides ordering at runtime). For sequential/parallel, leave
  `supervisor_id` null.
"""

_SYSTEM_PROMPT = f"""\
You are a meta-planner for a multi-agent platform. Given a task description, and
sometimes a desired agent count, you design a team of AI agents and return it as a
structured AgentPlan.

Rules you MUST follow:
- If a desired agent count is given, produce exactly that many agents unless the task
  clearly needs fewer; never exceed it.
- If no count is given, choose the team size yourself: the smallest team that does the
  task well. Give each agent one distinct responsibility, and don't add agents that only
  restate another agent's work. Never use more than {MAX_AGENTS} agents.
{_PLAN_RULES}"""

_REVISION_PROMPT = f"""\
You are a meta-planner for a multi-agent platform, revising an existing agent team at the
user's request. You receive the current task brief, the current AgentPlan, recent
conversation, and the user's new request. Return a PlanRevision: the brief, the plan, and
a short reply to the user.

How to revise:
- Change only what the request asks for. Keep every other agent, id, prompt, tool and
  setting exactly as it is.
- Update `brief` only if the user changes what the task itself is; otherwise return the
  current brief unchanged, word for word.
- If the request is a question rather than a change, answer it in `reply` and return
  the brief and plan unchanged.
- If part of the request can't be done with the available tools or models, make the
  closest valid change and say plainly in `reply` what you could not do and why.
- `reply` is 1-3 plain sentences telling the user what you changed (or why nothing
  changed). Don't repeat the whole plan.
- Never use more than {MAX_AGENTS} agents.

Rules the revised plan MUST follow:
{_PLAN_RULES}"""

T = TypeVar("T", bound=BaseModel)


def _options_block(available_tools: list[str], available_llms: list[dict[str, Any]]) -> list[str]:
    parts = [
        f"\nAVAILABLE TOOL NAMES: {available_tools or '(none)'}",
        "\nAVAILABLE LLM OPTIONS (choose provider+model from these only):",
    ]
    for opt in available_llms:
        parts.append(f"  - provider={opt['provider']}, model={opt['model']}")
    return parts


def _correction_block(correction: str | None, schema_name: str) -> list[str]:
    if not correction:
        return []
    return [
        "\nYOUR PREVIOUS ATTEMPT WAS REJECTED. Fix exactly this problem and return a "
        f"corrected {schema_name}:\n{correction}"
    ]


def _build_user_message(
    user_brief: str,
    requested_agent_count: int | None,
    available_tools: list[str],
    available_llms: list[dict[str, Any]],
    correction: str | None,
) -> str:
    count = (
        str(requested_agent_count)
        if requested_agent_count is not None
        else f"not specified — choose it yourself (at most {MAX_AGENTS})"
    )
    parts = [
        f"TASK DESCRIPTION:\n{user_brief}",
        f"\nDESIRED AGENT COUNT: {count}",
        *_options_block(available_tools, available_llms),
        *_correction_block(correction, "AgentPlan"),
    ]
    return "\n".join(parts)


def _build_revision_message(
    brief: str,
    plan: AgentPlan,
    request: str,
    history: list[tuple[str, str]],
    available_tools: list[str],
    available_llms: list[dict[str, Any]],
    correction: str | None,
) -> str:
    parts = [
        f"CURRENT BRIEF:\n{brief}",
        f"\nCURRENT PLAN (JSON):\n{json.dumps(plan.model_dump(), indent=2)}",
    ]
    if history:
        parts.append("\nRECENT CONVERSATION (oldest first):")
        parts.extend(f"  {role.upper()}: {content}" for role, content in history)
    parts.append(f"\nUSER REQUEST:\n{request}")
    parts.extend(_options_block(available_tools, available_llms))
    parts.extend(_correction_block(correction, "PlanRevision"))
    return "\n".join(parts)


def _semantic_check(
    plan: AgentPlan,
    requested_agent_count: int | None,
    available_tools: list[str],
    available_llms: list[dict[str, Any]],
) -> None:
    """Checks the schema alone can't express, raised as ValueError to feed the retry loop."""
    # The count is a hard limit, not a suggestion the model may talk itself past.
    limit = requested_agent_count if requested_agent_count is not None else MAX_AGENTS
    if len(plan.agents) > limit:
        raise ValueError(
            f"the plan has {len(plan.agents)} agents but at most {limit} are allowed; "
            "merge responsibilities so the team fits"
        )
    tool_set = set(available_tools)
    allowed_llms = {(o["provider"], o["model"]) for o in available_llms}
    for agent in plan.agents:
        unknown_tools = [t for t in agent.tools if t not in tool_set]
        if unknown_tools:
            raise ValueError(
                f"agent '{agent.id}' uses tools not in the available set: {unknown_tools}. "
                f"Allowed: {sorted(tool_set)}"
            )
        choice = (agent.llm.provider, agent.llm.model)
        if choice not in allowed_llms:
            raise ValueError(
                f"agent '{agent.id}' uses llm {choice} which is not an available option. "
                f"Allowed: {sorted(allowed_llms)}"
            )


def _invoke_with_retries(
    schema: type[T],
    system_prompt: str,
    build_message: Callable[[str | None], str],
    check: Callable[[T], None],
    planner_llm: LLMConfig | None,
) -> T:
    """One structured-output call, re-validated server-side, retried with the actual
    error fed back until it passes or the ceiling is hit (then PlannerError)."""
    planner_llm = planner_llm or LLMConfig(
        provider=DEFAULT_PROVIDER, model=DEFAULT_MODELS[DEFAULT_PROVIDER]
    )
    structured = get_llm(planner_llm).with_structured_output(schema)

    correction: str | None = None
    last_error: str | None = None
    for attempt in range(1, _PLANNER_RETRY_CEILING + 1):
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=build_message(correction)),
        ]
        try:
            # Parsing into the schema runs its validators (graph integrity); `check` adds
            # the semantic constraints the schema can't express (allow-lists, limits).
            result: T = structured.invoke(messages)
            check(result)
            return result
        except (ValidationError, ValueError) as e:
            last_error = str(e)
            correction = last_error
            if attempt < _PLANNER_RETRY_CEILING:
                time.sleep(_PLANNER_BACKOFF_S)

    raise PlannerError(
        f"planner failed to produce a valid {schema.__name__} after "
        f"{_PLANNER_RETRY_CEILING} attempts",
        attempts=_PLANNER_RETRY_CEILING,
        last_error=last_error,
    )


def _resolve_options(
    available_tools: list[str] | None, available_llms: list[dict[str, Any]] | None
) -> tuple[list[str], list[dict[str, Any]]]:
    tools = available_tools if available_tools is not None else list(TOOL_REGISTRY)
    llms = available_llms or [
        {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODELS[DEFAULT_PROVIDER]}
    ]
    return tools, llms


def plan_project(
    user_brief: str,
    requested_agent_count: int | None = None,
    available_tools: list[str] | None = None,
    available_llms: list[dict[str, Any]] | None = None,
    planner_llm: LLMConfig | None = None,
) -> AgentPlan:
    """Turn a natural-language brief into a validated AgentPlan.

    `requested_agent_count` caps the team size; leave it None to let the planner choose
    (still capped at MAX_AGENTS).
    """
    tools, llms = _resolve_options(available_tools, available_llms)
    plan = _invoke_with_retries(
        AgentPlan,
        _SYSTEM_PROMPT,
        lambda correction: _build_user_message(
            user_brief, requested_agent_count, tools, llms, correction
        ),
        lambda plan: _semantic_check(plan, requested_agent_count, tools, llms),
        planner_llm,
    )
    # Run limits are set by the platform, never by the model (principle 6): whatever
    # `bounds` the model filled in is replaced with the platform defaults.
    return plan.model_copy(update={"bounds": RunBounds()})


def revise_plan(
    brief: str,
    plan: AgentPlan,
    request: str,
    history: list[tuple[str, str]] | None = None,
    available_tools: list[str] | None = None,
    available_llms: list[dict[str, Any]] | None = None,
    planner_llm: LLMConfig | None = None,
) -> PlanRevision:
    """Apply a natural-language change request to an existing brief and plan.

    `history` is recent (role, content) conversation for follow-ups like "undo that";
    only the last REVISION_HISTORY_LIMIT entries are sent. The revised plan is held to
    exactly the same checks as a new one.
    """
    tools, llms = _resolve_options(available_tools, available_llms)
    recent = (history or [])[-REVISION_HISTORY_LIMIT:]
    revision = _invoke_with_retries(
        PlanRevision,
        _REVISION_PROMPT,
        lambda correction: _build_revision_message(
            brief, plan, request, recent, tools, llms, correction
        ),
        lambda revision: _semantic_check(revision.plan, None, tools, llms),
        planner_llm,
    )
    # A revision never changes run limits; they stay whatever the project had.
    revised_plan = revision.plan.model_copy(update={"bounds": plan.bounds})
    return revision.model_copy(update={"plan": revised_plan})
