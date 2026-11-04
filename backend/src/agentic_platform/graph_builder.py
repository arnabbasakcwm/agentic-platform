"""LLM factory and (Phase 5) the AgentPlan -> LangGraph compiler.

`get_llm` is the single point where a provider string becomes a chat model. Adding a
provider means adding a branch here (and an entry in config), never touching the
compiler or the planner. Provider-specific SDK errors (missing key, bad model) are
translated into typed platform errors at this boundary so upstream code handles one
uniform error surface.
"""

from __future__ import annotations

import json
import logging
import operator
import os
import queue
import re
import threading
import time
# Optional[...] rather than `| None`: LangGraph only passes `config` to a node whose
# annotation it recognises by name, and it doesn't recognise the `X | None` spelling.
from typing import TYPE_CHECKING, Annotated, Any, Callable, Iterator, Optional, TypedDict  # noqa: UP035

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AnyMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from .agent_schema import AgentOutput, AgentPlan, AgentSpec, EmbeddingConfig, LLMConfig, RunBounds
from .config import (
    BEDROCK_REGION,
    EMBEDDING_MODELS,
    LLM_REQUEST_TIMEOUT_S,
    MOONSHOT_BASE_URL,
    PROVIDER_ENV_VARS,
    embedding_option,
)
from .model_gateway import GatewayRunnable
from .errors import (
    ModelCannotCallToolsError,
    AgentExecutionError,
    MissingProviderKeyError,
    RunStoppedError,
    UnsupportedProviderError,
)
from .citations import CITATION_RULES, CitationLog, carry, enforce, require_citations, resolve
from .tools import get_tools
from .usage import UsageCallback, UsageCollector

logger = logging.getLogger(__name__)

# Providers reject a tool call whose arguments aren't valid JSON (Groq: 400 tool_use_failed,
# "Failed to parse tool call arguments as JSON"). That's the model's slip on one turn, so it
# is corrected in place rather than by restarting the agent's whole attempt.
_MALFORMED_TOOL_CALL_MARKERS = ("tool_use_failed", "Failed to parse tool call arguments")


def _malformed_tool_call(error: Exception) -> str | None:
    """The provider's message if `error` rejected a malformed tool call, else None."""
    text = str(error)
    if not any(marker in text for marker in _MALFORMED_TOOL_CALL_MARKERS):
        return None
    return text[:1500]

if TYPE_CHECKING:
    from .datasources import DataContext
    from .knowledge import KnowledgeContext
    from .mcp_client import McpContext

# Providers reachable through LangChain's native init_chat_model. Moonshot is handled
# separately below because it isn't a native init_chat_model provider string — it's an
# OpenAI-compatible endpoint wired via ChatOpenAI against Moonshot's base URL.
_NATIVE_PROVIDERS = {"openai", "anthropic", "groq", "ollama"}


def _require_key(provider: str) -> str:
    env_vars = PROVIDER_ENV_VARS[provider]
    for env_var in env_vars:
        key = os.environ.get(env_var)
        if key:
            return key
    raise MissingProviderKeyError(provider, " or ".join(env_vars))


def get_llm(config: LLMConfig) -> BaseChatModel:
    """The only way to get a chat model. The result is wrapped by the model gateway
    (model_gateway.py), so every call is gated in one place."""
    return GatewayRunnable(_build_llm(config), config.provider, config.model)  # type: ignore[return-value]


def _build_llm(config: LLMConfig) -> BaseChatModel:
    provider = config.provider
    # A per-request timeout, so a stalled call fails into the agent's retry loop instead
    # of hanging the run. extra_params can still override it.
    params = {"timeout": LLM_REQUEST_TIMEOUT_S, **config.extra_params}

    if provider == "moonshot":
        # Moonshot Kimi: OpenAI-compatible endpoint. extra_params passes through quirks
        # (e.g. reasoning params) without a bespoke schema field per provider.
        from langchain_openai import ChatOpenAI

        key = _require_key(provider)
        return ChatOpenAI(
            model=config.model,
            base_url=MOONSHOT_BASE_URL,
            api_key=key,
            temperature=config.temperature,
            **params,
        )

    if provider == "google_genai":
        # The SDK reads GOOGLE_API_KEY from env, but users commonly store the key under
        # GEMINI_API_KEY — resolve it ourselves and pass it explicitly so either works.
        from langchain_google_genai import ChatGoogleGenerativeAI

        key = _require_key(provider)
        return ChatGoogleGenerativeAI(
            model=config.model,
            google_api_key=key,
            temperature=config.temperature,
            **params,
        )

    if provider == "bedrock":
        # Amazon Bedrock through the Converse API: tool calls and structured output for every
        # model that supports them. No API key — the AWS credential chain (the user's IAM
        # keys locally, a deployment's execution role in AgentCore). `model` is a model id
        # or an inference-profile id (Claude is only reachable through a profile).
        from langchain_aws import ChatBedrockConverse

        return ChatBedrockConverse(
            model=config.model,
            region_name=BEDROCK_REGION,
            temperature=config.temperature,
            **params,
        )

    if provider in _NATIVE_PROVIDERS:
        from langchain.chat_models import init_chat_model

        if provider in PROVIDER_ENV_VARS:  # ollama has no key requirement
            _require_key(provider)
        if provider == "ollama":  # a local server, and ChatOllama takes no `timeout`
            params = dict(config.extra_params)
        return init_chat_model(
            model=config.model,
            model_provider=provider,
            temperature=config.temperature,
            **params,
        )

    raise UnsupportedProviderError(provider)


class Embedder:
    """Embeds knowledge-base passages and search queries with one model. Some models
    embed a passage and a question differently (task types), so the two are separate."""

    def __init__(
        self,
        embed_documents: Callable[[list[str]], list[list[float]]],
        embed_query: Callable[[str], list[float]],
        provider: str | None = None,
        model: str | None = None,
    ):
        self.embed_documents = embed_documents
        self.embed_query = embed_query
        self.provider = provider
        self.model = model


def aws_credentials_available() -> bool:
    """Whether boto3 finds AWS credentials (what Bedrock calls authenticate with)."""
    import boto3

    return boto3.Session(region_name=BEDROCK_REGION).get_credentials() is not None


def embedding_available(provider: str) -> bool:
    """Whether this provider has an embedding model and its credentials are configured."""
    if provider not in EMBEDDING_MODELS:
        return False
    if provider == "bedrock":
        return aws_credentials_available()
    return any(os.environ.get(v) for v in PROVIDER_ENV_VARS[provider])


def get_embeddings(config: EmbeddingConfig) -> Embedder:
    """The embedding counterpart of get_llm(): the only place an embedding provider is chosen."""
    provider = config.provider
    option = embedding_option(provider, config.model)
    if option is None:
        raise UnsupportedProviderError(f"{provider}/{config.model}")
    dimensions = int(option["dimensions"])
    if provider == "google_genai":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings

        model = GoogleGenerativeAIEmbeddings(
            model=f"models/{config.model}", google_api_key=_require_key(provider)
        )
        return Embedder(
            lambda texts: model.embed_documents(
                texts, task_type="RETRIEVAL_DOCUMENT", output_dimensionality=dimensions
            ),
            lambda text: model.embed_query(
                text, task_type="RETRIEVAL_QUERY", output_dimensionality=dimensions
            ),
            provider,
            config.model,
        )
    if provider == "openai":
        from langchain_openai import OpenAIEmbeddings

        model = OpenAIEmbeddings(
            model=config.model, dimensions=dimensions, api_key=_require_key(provider)
        )
        return Embedder(model.embed_documents, model.embed_query, provider, config.model)
    if provider == "bedrock":
        # Titan v2 and Cohere v4 via langchain-aws: it sends Cohere's search_document /
        # search_query input types and each model's own dimensions parameter.
        from langchain_aws import BedrockEmbeddings

        model = BedrockEmbeddings(
            model_id=config.model, region_name=BEDROCK_REGION, dimensions=dimensions, normalize=True
        )
        return Embedder(model.embed_documents, model.embed_query, provider, config.model)
    raise UnsupportedProviderError(provider)


# ---------------------------------------------------------------------------
# Graph compiler
# ---------------------------------------------------------------------------

_NODE_BACKOFF_S = 0.5


class GraphState(TypedDict):
    """Shared state threaded through the compiled graph.

    `outputs` and `errors` use merge reducers so each node contributes its own slice
    without clobbering siblings' contributions. `halted` uses an OR reducer so multiple
    parallel branches can flag failure in the same superstep without a write conflict; it
    short-circuits the remaining sequential chain once an agent exhausts its retries.
    `next_agent`/`supervisor_steps` are only used by the supervisor pattern (single
    routing node writing them, so no reducer needed).
    """

    input: dict[str, Any]
    outputs: Annotated[dict[str, Any], lambda a, b: {**a, **b}]
    errors: Annotated[list[dict[str, Any]], operator.add]
    halted: Annotated[bool, operator.or_]
    next_agent: str
    supervisor_steps: int


def _text(content: Any) -> str:
    """Flatten message content to text, handling providers (e.g. Gemini 3.x) that return
    a list of content blocks rather than a plain string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return str(content)


def _upstream(state: GraphState, spec: AgentSpec, include_all_outputs: bool = False) -> list[tuple[str, Any]]:
    """The answers this agent works from. Sequential/parallel agents see their declared
    dependencies; supervisor workers have no depends_on wiring, so they see everything
    produced so far instead."""
    relevant = list(state["outputs"].keys()) if include_all_outputs else spec.depends_on
    return [(d, state["outputs"][d]) for d in relevant if d in state["outputs"]]


def _build_context(
    state: GraphState, spec: AgentSpec, include_all_outputs: bool = False,
    contents: dict[str, str] | None = None,
) -> str:
    """`contents`: the upstream answers to show instead of the stored text (their citation
    numbers renumbered into one sequence, see citations.carry)."""
    parts = [f"TASK INPUT:\n{state['input']}"]
    shown = _upstream(state, spec, include_all_outputs)
    if shown:
        header = "\nOUTPUT FROM PRIOR AGENTS:" if include_all_outputs else (
            "\nOUTPUT FROM AGENTS YOU DEPEND ON:"
        )
        parts.append(header)
        for dep, dep_out in shown:
            text = (contents or {}).get(dep)
            if text is None:
                text = dep_out.get("content", dep_out) if isinstance(dep_out, dict) else dep_out
            parts.append(f"  [{dep}]: {text}")
    return "\n".join(parts)


def _run_agent_once(
    llm: BaseChatModel,
    spec: AgentSpec,
    base_messages: list[AnyMessage],
    bounds: RunBounds,
    knowledge: KnowledgeContext | None = None,
    usage: UsageCollector | None = None,
    data: DataContext | None = None,
    mcp: McpContext | None = None,
    json_answer: bool = False,
    stop: threading.Event | None = None,
    citations_out: dict[str, Any] | None = None,
    inherited: list[dict[str, Any]] | None = None,
) -> AgentOutput:
    """One full attempt for an agent node: bounded tool loop, then structured output.

    Sources the search tools return are numbered in this attempt's CitationLog; when
    citations are required and the answer used any, it's checked (citations.enforce) and
    the structured citations are put in `citations_out`.

    Any exception here (tool error, schema-validation failure) propagates to the caller's
    retry loop, which feeds the error text back into the agent's own context. A stopped
    run raises RunStoppedError before the next model or tool call.
    """
    messages = list(base_messages)
    tools = get_tools(spec.tools, knowledge, data, mcp)
    # Every model call (tool turns, the structured answer, the rewrite) reports its
    # provider-counted tokens to the run's collector, labelled with this agent.
    call_config: RunnableConfig = (
        {"callbacks": [UsageCallback(usage, kind="run", provider=spec.llm.provider,
                                     model=spec.llm.model, agent_id=spec.id)]}
        if usage is not None
        else {}
    )
    citation_log = CitationLog()
    for source in inherited or []:  # numbered first, as in the context the agent was shown
        citation_log.inherit(source)
    tool_config: RunnableConfig = {
        "configurable": {"usage": usage, "agent_id": spec.id, "citations": citation_log}
    }

    if tools:
        bound = llm.bind_tools(tools)
        tool_map = {t.name: t for t in tools}
        for _ in range(bounds.max_steps):
            _check_stop(stop)
            try:
                ai = bound.invoke(messages, config=call_config)
            except Exception as e:  # noqa: BLE001 — only malformed tool calls are handled here
                rejected = _malformed_tool_call(e)
                if rejected is None:
                    raise  # anything else goes to the node's retry loop
                # Feed the provider's actual error (including the broken call it quotes) back
                # into this agent's context and let it re-issue the call. Counts as a step,
                # so it stays bounded by max_steps.
                logger.warning("agent %s sent a malformed tool call; asking it to resend: %s", spec.id, rejected[:300])
                messages.append(
                    HumanMessage(
                        content=(
                            "Your last tool call was rejected because its arguments were not valid "
                            f"JSON:\n{rejected}\n\nCall the tool again with valid JSON arguments. "
                            "Inside string values, escape double quotes as \\\" or leave them out."
                        )
                    )
                )
                continue
            messages.append(ai)
            tool_calls = getattr(ai, "tool_calls", None) or []
            if not tool_calls:
                break
            for tc in tool_calls:
                _check_stop(stop)
                tool = tool_map[tc["name"]]  # names validated at compile time
                result = tool.invoke(tc["args"], config=tool_config)  # may raise -> retry loop
                messages.append(
                    ToolMessage(content=str(result), tool_call_id=tc["id"])
                )

    _check_stop(stop)
    if json_answer:
        # The model can't call tools (capabilities.py), so it can't use structured output
        # either: ask for the same schema as JSON, and validate it exactly as strictly.
        output = _json_answer(llm, list(messages), call_config)
        return _cited(output, spec, citation_log, citations_out, stop,
                      lambda extra: _json_answer(llm, [*messages, extra], call_config))
    structured = llm.with_structured_output(AgentOutput)
    messages.append(
        HumanMessage(
            content=(
                "Now produce your final structured answer for this task. Write `content` "
                "as Markdown with real line breaks between headings, list items and "
                "paragraphs."
            )
        )
    )
    output = structured.invoke(messages, config=call_config)
    if output is None:
        raise ModelCannotCallToolsError(_no_tools_message(spec.llm))
    if _looks_flattened(output.content):
        # Models sometimes ignore the instruction and return the whole answer on one
        # line, which renders as a single paragraph. Say exactly what's wrong and ask
        # once more; if the rewrite is still flat, keep the original rather than fail an
        # agent over formatting.
        messages.append(
            HumanMessage(
                content=(
                    f"Your `content` came back as {len(output.content)} characters on a "
                    "single line, so its headings, list items and paragraphs run together. "
                    "Return the same answer again with each heading, list item and "
                    "paragraph on its own line."
                )
            )
        )
        retry = structured.invoke(messages, config=call_config)
        if retry is not None and not _looks_flattened(retry.content):
            output = retry
    return _cited(output, spec, citation_log, citations_out, stop,
                  lambda extra: structured.invoke([*messages, extra], config=call_config))


def _cited(
    output: AgentOutput,
    spec: AgentSpec,
    log: CitationLog,
    citations_out: dict[str, Any] | None,
    stop: threading.Event | None,
    ask: Callable[[HumanMessage], AgentOutput | None],
) -> AgentOutput:
    """The answer with its citations checked (citations.py), if any were needed."""
    if citations_out is None or not log.sources or not require_citations():
        return output
    if not log.own:
        # Only inherited sources: link the ones it cites; nothing is demanded.
        resolved = resolve(output.content, log)
        if resolved is None:
            return output
        citations_out.update(resolved.meta())
        return output.model_copy(update={"content": resolved.content})

    def reask(instruction: str) -> str | None:
        _check_stop(stop)
        try:
            retry = ask(HumanMessage(content=f"Your answer was:\n{output.content}\n\n{instruction}"))
        except RunStoppedError:
            raise
        except Exception as e:  # noqa: BLE001 — a failed re-ask falls back to auto-append
            logger.warning("agent %s: asking for citations failed: %s", spec.id, e)
            return None
        return retry.content if retry is not None else None

    result = enforce(output.content, log, reask)
    if result.auto_appended:
        logger.warning("agent %s cited none of its %d sources; Sources appended by the platform",
                       spec.id, len(log.sources))
    if result.invalid:
        logger.warning("agent %s cited sources that don't exist: %s (removed)", spec.id, result.invalid)
    citations_out.update(result.meta())
    return output.model_copy(update={"content": result.content})


def _no_tools_message(llm: LLMConfig) -> str:
    return (
        f"model {llm.model} didn't return a structured answer: it can't call tools, which this "
        "step needs. Choose a model that can call tools, or remove this agent's tools."
    )


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _json_answer(llm: BaseChatModel, messages: list[AnyMessage], call_config: RunnableConfig) -> AgentOutput:
    """The final answer from a model without tool calling: JSON matching AgentOutput,
    validated by Pydantic. A ValidationError goes to the node's retry loop, which feeds
    the exact error back to the agent."""
    schema = json.dumps(AgentOutput.model_json_schema())
    messages.append(
        HumanMessage(
            content=(
                "Now give your final answer as ONLY a JSON object — no other text, no code fences — "
                f"matching this JSON schema:\n{schema}\n"
                "Write `content` as Markdown, with \\n line breaks between headings, list items "
                "and paragraphs."
            )
        )
    )
    reply = llm.invoke(messages, config=call_config)
    text = reply.content if isinstance(reply.content, str) else "".join(
        part.get("text", "") if isinstance(part, dict) else str(part) for part in reply.content
    )
    text = _FENCE.sub("", text.strip())
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        text = text[start:end + 1]
    return AgentOutput.model_validate_json(text)


# Block-level Markdown that should start a line: headings, bullets, numbered items.
_INLINE_BLOCK_MARKER = re.compile(r"\s(?:#{1,6}|[*-]|\d{1,2}\.)\s")


def _looks_flattened(content: str) -> bool:
    """True when an answer that should span several lines arrived as one: no line break,
    and either Markdown block markers in mid-line or simply too long for one paragraph."""
    if "\n" in content:
        return False
    return len(_INLINE_BLOCK_MARKER.findall(content)) >= 2 or len(content) > 700


Emit = Callable[..., None]


def _usage(config: RunnableConfig | None) -> UsageCollector | None:
    """The run's usage collector, passed like `emit` through LangGraph's config."""
    usage = ((config or {}).get("configurable") or {}).get("usage")
    return usage if isinstance(usage, UsageCollector) else None


def _emitter(config: RunnableConfig | None) -> Emit:
    """The run's event callback, if the caller asked for events (see run_graph_events);
    otherwise a no-op. Passed per run through LangGraph's config, so one compiled graph
    serves streaming and non-streaming runs alike."""
    emit = ((config or {}).get("configurable") or {}).get("emit")
    return emit if callable(emit) else (lambda event, **data: None)


def _stop_event(config: RunnableConfig | None) -> threading.Event | None:
    """The run's stop flag, passed like `emit`. Set when the user stops the run or its
    time limit passes; agents check it before every model and tool call."""
    stop = ((config or {}).get("configurable") or {}).get("stop")
    return stop if isinstance(stop, threading.Event) else None


def _check_stop(stop: threading.Event | None) -> None:
    if stop is not None and stop.is_set():
        raise RunStoppedError()


def _make_node(
    spec: AgentSpec,
    bounds: RunBounds,
    include_all_outputs: bool = False,
    knowledge: KnowledgeContext | None = None,
    data: DataContext | None = None,
    mcp: McpContext | None = None,
    json_models: frozenset[str] = frozenset(),
):
    json_answer = f"{spec.llm.provider}/{spec.llm.model}" in json_models

    def node(state: GraphState, config: Optional[RunnableConfig] = None) -> dict[str, Any]:
        emit = _emitter(config)
        usage = _usage(config)
        stop = _stop_event(config)
        started = time.monotonic()

        def elapsed_ms() -> int:
            return int((time.monotonic() - started) * 1000)

        # Dependency gating (the parallel/DAG failure-isolation mechanism): if any agent
        # this node depends on failed and produced no output, skip rather than run on
        # missing input. In sequential mode the halted short-circuit means we never even
        # reach a node with a failed dependency, so this is a no-op there.
        missing = [d for d in spec.depends_on if d not in state["outputs"]]
        if missing:
            skipped = AgentExecutionError(
                spec.id,
                f"agent '{spec.id}' skipped: upstream dependencies did not produce "
                f"output: {missing}",
                attempts=0,
            )
            emit("node_skipped", node=spec.id, reason=str(skipped))
            return {"errors": [skipped.to_dict()], "halted": True}

        emit("node_started", node=spec.id)

        llm = get_llm(spec.llm)
        # The platform's citation rule goes to every agent, current and future.
        system = spec.system_prompt + (f"\n\n{CITATION_RULES}" if require_citations() else "")
        # Sources cited upstream come along, renumbered into one sequence.
        inherited, contents = (
            carry(_upstream(state, spec, include_all_outputs)) if require_citations() else ([], None)
        )
        base_messages: list[AnyMessage] = [
            SystemMessage(content=system),
            HumanMessage(content=_build_context(state, spec, include_all_outputs, contents)),
        ]

        last_error: str | None = None
        for attempt in range(1, bounds.max_retries + 1):
            attempt_messages = list(base_messages)
            if last_error is not None:
                # Feed the actual error back into THIS agent's context, not a generic
                # "try again" — the recovery signal the SYSTEM_PROMPT loop requires.
                attempt_messages.append(
                    HumanMessage(
                        content=(
                            "Your previous attempt failed with this error. Correct it "
                            f"and try again:\n{last_error}"
                        )
                    )
                )
            try:
                citations: dict[str, Any] = {}
                output = _run_agent_once(llm, spec, attempt_messages, bounds, knowledge, usage, data, mcp,
                                         json_answer, stop, citations, inherited)
                # Structured citations travel with the output (and are stored with the run).
                dumped = {**output.model_dump(), **citations}
                emit("node_completed", node=spec.id, duration_ms=elapsed_ms(),
                     attempts=attempt, output=dumped,
                     usage=usage.entries(spec.id) if usage else [])
                return {"outputs": {spec.id: dumped}}
            except RunStoppedError:
                raise  # the run is over; nobody is waiting for this agent any more
            except Exception as e:  # noqa: BLE001 — deliberate: recover from any node failure
                last_error = f"{type(e).__name__}: {e}"
                if attempt < bounds.max_retries:
                    emit("node_retry", node=spec.id, attempt=attempt, error=last_error)
                    time.sleep(_NODE_BACKOFF_S)

        # Ceiling exhausted: record a structured failure and halt the chain rather than
        # raising, so one agent's failure never crashes the whole graph run silently.
        failure = AgentExecutionError(
            spec.id,
            f"agent '{spec.id}' failed after {bounds.max_retries} attempts: {last_error}",
            attempts=bounds.max_retries,
        )
        emit("node_failed", node=spec.id, duration_ms=elapsed_ms(),
             attempts=bounds.max_retries, error=str(failure),
             usage=usage.entries(spec.id) if usage else [])
        return {"errors": [failure.to_dict()], "halted": True}

    return node


def _topological_order(agents: list[AgentSpec]) -> list[AgentSpec]:
    by_id = {a.id: a for a in agents}
    indegree = {a.id: 0 for a in agents}
    dependents: dict[str, list[str]] = {a.id: [] for a in agents}
    for a in agents:
        for dep in a.depends_on:
            indegree[a.id] += 1
            dependents[dep].append(a.id)

    # Preserve the planner's agent ordering among ready nodes for a stable, readable chain.
    ready = [a.id for a in agents if indegree[a.id] == 0]
    order: list[str] = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for nxt in dependents[current]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                ready.append(nxt)
    return [by_id[i] for i in order]


class _SupervisorDecision(BaseModel):
    """Structured routing decision the supervisor emits each turn."""

    next_agent: str = Field(
        description="id of the worker to run next, or 'FINISH' when the task is complete"
    )
    reason: str = Field(default="", description="brief justification for the choice")


def compile_graph(
    plan: AgentPlan,
    knowledge: KnowledgeContext | None = None,
    data: DataContext | None = None,
    json_models: set[str] | frozenset[str] | None = None,
    mcp: McpContext | None = None,
):
    """Compile a validated AgentPlan into a runnable LangGraph graph.

    Dispatches on orchestration pattern. All three share the same node implementation,
    state shape, and error-recovery loop — only the wiring differs:
      - sequential: a dependency-ordered chain, halting the rest on a node failure.
      - parallel:   the real dependency DAG, so independent agents run concurrently and
                    merge at agents that depend on them; failures are isolated per branch.
      - supervisor: a router node picks the next worker at runtime, looping until it
                    signals FINISH or a bounded iteration cap is hit.

    `knowledge` binds knowledge_search to the project's documents. It searches at call
    time, so documents added later are found without recompiling.
    """
    # Fail fast at compile time if any agent references an unknown tool, rather than
    # discovering it mid-run.
    for spec in plan.agents:
        get_tools(spec.tools, knowledge, data, mcp)
    # Models that can't call tools answer by JSON; they can't be given tools or routing.
    json_models = frozenset(json_models or ())
    for spec in plan.agents:
        if f"{spec.llm.provider}/{spec.llm.model}" in json_models and (
            spec.tools or spec.id == plan.supervisor_id
        ):
            job = "has tools" if spec.tools else "is the supervisor"
            raise ModelCannotCallToolsError(
                f"agent '{spec.id}' {job}, but its model {spec.llm.model} can't call tools; "
                "remove its tools or choose a model that can call tools"
            )

    if plan.orchestration_pattern == "sequential":
        return _compile_sequential(plan, knowledge, data, json_models=json_models, mcp=mcp)
    if plan.orchestration_pattern == "parallel":
        return _compile_parallel(plan, knowledge, data, json_models=json_models, mcp=mcp)
    if plan.orchestration_pattern == "supervisor":
        return _compile_supervisor(plan, knowledge, data, json_models=json_models, mcp=mcp)
    raise NotImplementedError(
        f"orchestration pattern '{plan.orchestration_pattern}' is not supported"
    )


def _compile_sequential(
    plan: AgentPlan,
    knowledge: KnowledgeContext | None = None,
    data: DataContext | None = None,
    mcp: McpContext | None = None,
    json_models: frozenset[str] = frozenset(),
):
    ordered = _topological_order(plan.agents)
    builder = StateGraph(GraphState)
    for spec in ordered:
        builder.add_node(spec.id, _make_node(spec, plan.bounds, knowledge=knowledge, data=data, mcp=mcp, json_models=json_models))

    builder.add_edge(START, ordered[0].id)
    for i, spec in enumerate(ordered):
        is_last = i == len(ordered) - 1
        next_node = END if is_last else ordered[i + 1].id

        def route(state: GraphState, _next=next_node):
            return END if state.get("halted") else _next

        builder.add_conditional_edges(
            spec.id, route, {END: END} | ({} if is_last else {next_node: next_node})
        )

    return builder.compile()


def _compile_parallel(
    plan: AgentPlan,
    knowledge: KnowledgeContext | None = None,
    data: DataContext | None = None,
    mcp: McpContext | None = None,
    json_models: frozenset[str] = frozenset(),
):
    """Wire the dependency DAG directly: agents with no deps fan out from START and run
    concurrently; agents with deps run once their deps complete (the merge/synthesis
    step). Failure isolation is per-branch via the node's dependency gating, not a global
    halt — an independent worker failing doesn't stop its siblings."""
    has_dependents: set[str] = set()
    for spec in plan.agents:
        has_dependents.update(spec.depends_on)

    builder = StateGraph(GraphState)
    for spec in plan.agents:
        builder.add_node(spec.id, _make_node(spec, plan.bounds, knowledge=knowledge, data=data, mcp=mcp, json_models=json_models))

    for spec in plan.agents:
        if not spec.depends_on:
            builder.add_edge(START, spec.id)
        else:
            for dep in spec.depends_on:
                builder.add_edge(dep, spec.id)
        if spec.id not in has_dependents:
            builder.add_edge(spec.id, END)

    return builder.compile()


def _make_supervisor(sup_spec: AgentSpec, worker_ids: list[str], cap: int):
    routing_instructions = (
        "\n\nYou are the ROUTER for a team of worker agents. Based on the task and the "
        "outputs produced so far, choose the single worker that should act next, or "
        "return 'FINISH' when the task is complete. You must pick from exactly these "
        f"worker ids: {worker_ids}. Do not invent ids."
    )

    def node(state: GraphState, config: Optional[RunnableConfig] = None) -> dict[str, Any]:
        emit = _emitter(config)
        usage = _usage(config)
        started = time.monotonic()
        steps = state.get("supervisor_steps", 0) + 1
        emit("node_started", node=sup_spec.id)
        if steps > cap:
            # Bounded: never let the router loop forever (principle: every run is bounded).
            note = AgentExecutionError(
                sup_spec.id,
                f"supervisor stopped after hitting its {cap}-iteration cap",
                attempts=cap,
            )
            emit("node_failed", node=sup_spec.id, error=str(note),
                 duration_ms=int((time.monotonic() - started) * 1000), attempts=cap)
            return {"supervisor_steps": steps, "next_agent": "FINISH", "errors": [note.to_dict()]}

        _check_stop(_stop_event(config))
        llm = get_llm(sup_spec.llm)
        messages: list[AnyMessage] = [
            SystemMessage(content=sup_spec.system_prompt + routing_instructions),
            HumanMessage(content=_build_context(state, sup_spec, include_all_outputs=True)),
        ]
        try:
            call_config: RunnableConfig = (
                {"callbacks": [UsageCallback(usage, kind="run", provider=sup_spec.llm.provider,
                                             model=sup_spec.llm.model, agent_id=sup_spec.id)]}
                if usage is not None
                else {}
            )
            decision = llm.with_structured_output(_SupervisorDecision).invoke(messages, config=call_config)
            if decision is None:
                raise ModelCannotCallToolsError(_no_tools_message(sup_spec.llm))
            nxt = decision.next_agent.strip()
            if nxt not in worker_ids and nxt != "FINISH":
                nxt = "FINISH"  # invalid routing target -> finish safely rather than loop
        except Exception as e:  # noqa: BLE001 — a router failure must end the run cleanly
            note = AgentExecutionError(
                sup_spec.id, f"supervisor routing failed: {e}", attempts=1
            )
            emit("node_failed", node=sup_spec.id, error=str(note),
                 duration_ms=int((time.monotonic() - started) * 1000), attempts=1)
            return {"supervisor_steps": steps, "next_agent": "FINISH", "errors": [note.to_dict()]}

        emit("node_completed", node=sup_spec.id, next_agent=nxt,
             duration_ms=int((time.monotonic() - started) * 1000), attempts=1)
        return {"supervisor_steps": steps, "next_agent": nxt}

    return node


def _compile_supervisor(
    plan: AgentPlan,
    knowledge: KnowledgeContext | None = None,
    data: DataContext | None = None,
    mcp: McpContext | None = None,
    json_models: frozenset[str] = frozenset(),
):
    workers = [a for a in plan.agents if a.id != plan.supervisor_id]
    worker_ids = [w.id for w in workers]
    sup_spec = next(a for a in plan.agents if a.id == plan.supervisor_id)
    cap = max(plan.bounds.max_steps, 2 * len(workers) + 2)

    builder = StateGraph(GraphState)
    builder.add_node(sup_spec.id, _make_supervisor(sup_spec, worker_ids, cap))
    for w in workers:
        # Supervisor workers see all accumulated outputs (they carry no depends_on wiring).
        builder.add_node(w.id, _make_node(w, plan.bounds, include_all_outputs=True, knowledge=knowledge, data=data, mcp=mcp, json_models=json_models))
        builder.add_edge(w.id, sup_spec.id)  # control returns to the router after each worker

    builder.add_edge(START, sup_spec.id)

    def route(state: GraphState):
        nxt = state.get("next_agent")
        return END if nxt in (None, "FINISH") else nxt

    builder.add_conditional_edges(
        sup_spec.id, route, {wid: wid for wid in worker_ids} | {END: END}
    )

    return builder.compile()


def initial_state(task_input: dict[str, Any]) -> GraphState:
    return {
        "input": task_input,
        "outputs": {},
        "errors": [],
        "halted": False,
        "next_agent": "",
        "supervisor_steps": 0,
    }


def _agent_invoker(
    plan: AgentPlan,
    agent_id: str,
    task_input: dict[str, Any],
    upstream_outputs: dict[str, Any] | None,
    knowledge: KnowledgeContext | None,
    data: DataContext | None,
    mcp: McpContext | None,
    json_models: set[str] | frozenset[str] | None,
) -> Callable[[RunnableConfig], dict[str, Any]]:
    """One agent node, ready to run with a run's config. KeyError for an unknown agent."""
    spec = next((a for a in plan.agents if a.id == agent_id), None)
    if spec is None:
        raise KeyError(agent_id)
    node = _make_node(spec, plan.bounds, knowledge=knowledge, data=data, mcp=mcp, json_models=frozenset(json_models or ()))
    state = initial_state(task_input)
    state["outputs"] = dict(upstream_outputs or {})

    def invoke(config: RunnableConfig) -> dict[str, Any]:
        result = node(state, config)
        return {"outputs": result.get("outputs", {}), "errors": result.get("errors", []),
                "halted": bool(result.get("halted", False))}

    return invoke


def _graph_invoker(graph, task_input: dict[str, Any]) -> Callable[[RunnableConfig], dict[str, Any]]:
    return lambda config: graph.invoke(initial_state(task_input), {"recursion_limit": 50, **config})


def run_single_agent(
    plan: AgentPlan,
    agent_id: str,
    task_input: dict[str, Any],
    upstream_outputs: dict[str, Any] | None = None,
    knowledge: KnowledgeContext | None = None,
    usage: UsageCollector | None = None,
    data: DataContext | None = None,
    mcp: McpContext | None = None,
    json_models: set[str] | frozenset[str] | None = None,
) -> dict[str, Any]:
    """Run one agent node in isolation (the per-agent endpoint path), under the plan's
    time limit like a whole run (TimeoutError when it passes).

    `upstream_outputs` lets the caller supply the outputs this agent's `depends_on`
    would normally provide, without running the whole graph.
    """
    invoke = _agent_invoker(plan, agent_id, task_input, upstream_outputs, knowledge, data, mcp, json_models)
    return _run_bounded(invoke, plan.bounds, usage)


def run_agent_events(
    plan: AgentPlan,
    agent_id: str,
    task_input: dict[str, Any],
    upstream_outputs: dict[str, Any] | None = None,
    knowledge: KnowledgeContext | None = None,
    usage: UsageCollector | None = None,
    data: DataContext | None = None,
    mcp: McpContext | None = None,
    json_models: set[str] | frozenset[str] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> Iterator[tuple[str, dict[str, Any]]]:
    """One agent on its own, with the same events, time limit and stop as
    run_graph_events. KeyError (raised at once) for an unknown agent."""
    invoke = _agent_invoker(plan, agent_id, task_input, upstream_outputs, knowledge, data, mcp, json_models)
    return _run_events(invoke, plan.bounds, usage, should_stop)


def run_graph(
    graph, task_input: dict[str, Any], bounds: RunBounds, usage: UsageCollector | None = None
) -> dict[str, Any]:
    """Invoke a compiled graph with a wall-clock timeout bound (principle: every run is
    bounded, not left to model good behavior).

    On timeout the caller gets TimeoutError as soon as the limit passes. The run's worker
    thread can't be killed, so it is told to stop and quits at its agents' next model or
    tool call; whatever it was doing is dropped.

    The result includes `usage`: tokens per agent and model. Pass a collector to keep
    reading it after a timeout (it holds whatever was used up to then).
    """
    return _run_bounded(_graph_invoker(graph, task_input), bounds, usage)


def _run_bounded(
    invoke: Callable[[RunnableConfig], dict[str, Any]], bounds: RunBounds, usage: UsageCollector | None
) -> dict[str, Any]:
    import concurrent.futures

    usage = usage if usage is not None else UsageCollector()
    stop = threading.Event()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(invoke, {"configurable": {"usage": usage, "stop": stop}})
    try:
        return {**future.result(timeout=bounds.timeout_s), "usage": usage.entries()}
    except concurrent.futures.TimeoutError as e:
        stop.set()
        raise TimeoutError(f"the run exceeded its {bounds.timeout_s:g}s time limit") from e
    finally:
        # Never block on the worker: a `with` block here would wait for it to finish,
        # which is exactly what made the timeout fire late.
        pool.shutdown(wait=False, cancel_futures=True)


def run_graph_events(
    graph,
    task_input: dict[str, Any],
    bounds: RunBounds,
    usage: UsageCollector | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> Iterator[tuple[str, dict[str, Any]]]:
    """Run a compiled graph and yield (event, data) pairs as it happens:

      run_started → node_started / node_retry / node_completed / node_failed /
      node_skipped … → run_completed (with the same outputs/errors/halted as run_graph)
      or run_failed (timeout, stopped, or an unexpected error).

    Every event carries `at` (Unix time, seconds). The same wall-clock limit as run_graph
    applies. `should_stop` is polled about once a second; when it returns True the run
    ends at once with run_failed `RunStopped`. Either way the abandoned worker is told to
    stop and quits at its agents' next model or tool call.
    """
    return _run_events(_graph_invoker(graph, task_input), bounds, usage, should_stop)


def _run_events(
    invoke: Callable[[RunnableConfig], dict[str, Any]],
    bounds: RunBounds,
    usage: UsageCollector | None,
    should_stop: Callable[[], bool] | None,
) -> Iterator[tuple[str, dict[str, Any]]]:
    events: queue.Queue = queue.Queue()
    started = time.time()
    usage = usage if usage is not None else UsageCollector()
    stop = threading.Event()

    def emit(event: str, **data: Any) -> None:
        events.put((event, {**data, "at": time.time()}))

    def work() -> None:
        try:
            result = invoke({"configurable": {"emit": emit, "usage": usage, "stop": stop}})
            events.put(("__done__", result))
        except Exception as e:  # noqa: BLE001 — reported to the caller as run_failed
            events.put(("__error__", e))

    threading.Thread(target=work, daemon=True, name="graph-run").start()
    yield "run_started", {"at": started, "timeout_s": bounds.timeout_s}

    deadline = started + bounds.timeout_s
    try:
        while True:
            if should_stop is not None and should_stop():
                yield "run_failed", {
                    "at": time.time(),
                    "error_type": "RunStopped",
                    "message": "you stopped this run",
                    "usage": usage.entries(),
                }
                return
            remaining = deadline - time.time()
            if remaining <= 0:
                yield "run_failed", {
                    "at": time.time(),
                    "error_type": "RunTimeout",
                    "message": f"the run exceeded its {bounds.timeout_s:g}s time limit",
                    "limit_s": bounds.timeout_s,
                    "usage": usage.entries(),
                }
                return
            try:
                event, data = events.get(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue
            if event == "__done__":
                yield "run_completed", {
                    "at": time.time(),
                    "duration_ms": int((time.time() - started) * 1000),
                    "outputs": data["outputs"],
                    "usage": usage.entries(),
                    "errors": data["errors"],
                    "halted": data["halted"],
                }
                return
            if event == "__error__":
                yield "run_failed", {
                    "at": time.time(),
                    "error_type": type(data).__name__,
                    "message": str(data) or "the run failed",
                    "exception": data,  # for callers that answer with the typed error; not data to send
                }
                return
            yield event, data
    finally:
        # However the run ended for the caller (done, timeout, stopped, or the caller went
        # away), an abandoned worker stops at its next model or tool call.
        stop.set()
