"""LLM factory and (Phase 5) the AgentPlan -> LangGraph compiler.

`get_llm` is the single point where a provider string becomes a chat model. Adding a
provider means adding a branch here (and an entry in config), never touching the
compiler or the planner. Provider-specific SDK errors (missing key, bad model) are
translated into typed platform errors at this boundary so upstream code handles one
uniform error surface.
"""

from __future__ import annotations

import operator
import os
import queue
import re
import threading
import time
# Optional[...] rather than `| None`: LangGraph only passes `config` to a node whose
# annotation it recognises by name, and it doesn't recognise the `X | None` spelling.
from typing import Annotated, Any, Callable, Iterator, Optional, TypedDict  # noqa: UP035

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
from .config import EMBEDDING_DIMENSIONS, EMBEDDING_MODELS, MOONSHOT_BASE_URL, PROVIDER_ENV_VARS
from .errors import (
    AgentExecutionError,
    MissingProviderKeyError,
    UnsupportedProviderError,
)
from .tools import get_tools

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
    provider = config.provider

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
            **config.extra_params,
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
            **config.extra_params,
        )

    if provider in _NATIVE_PROVIDERS:
        from langchain.chat_models import init_chat_model

        if provider in PROVIDER_ENV_VARS:  # ollama has no key requirement
            _require_key(provider)
        return init_chat_model(
            model=config.model,
            model_provider=provider,
            temperature=config.temperature,
            **config.extra_params,
        )

    raise UnsupportedProviderError(provider)


class Embedder:
    """Embeds knowledge-base passages and search queries with one model. Some models
    embed a passage and a question differently (task types), so the two are separate."""

    def __init__(self, embed_documents: Callable[[list[str]], list[list[float]]], embed_query: Callable[[str], list[float]]):
        self.embed_documents = embed_documents
        self.embed_query = embed_query


def embedding_available(provider: str) -> bool:
    """Whether this provider has an embedding model and its API key is configured."""
    return provider in EMBEDDING_MODELS and any(os.environ.get(v) for v in PROVIDER_ENV_VARS[provider])


def get_embeddings(config: EmbeddingConfig) -> Embedder:
    """The embedding counterpart of get_llm(): the only place an embedding provider is chosen."""
    provider = config.provider
    if provider == "google_genai":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings

        model = GoogleGenerativeAIEmbeddings(
            model=f"models/{config.model}", google_api_key=_require_key(provider)
        )
        return Embedder(
            lambda texts: model.embed_documents(
                texts, task_type="RETRIEVAL_DOCUMENT", output_dimensionality=EMBEDDING_DIMENSIONS
            ),
            lambda text: model.embed_query(
                text, task_type="RETRIEVAL_QUERY", output_dimensionality=EMBEDDING_DIMENSIONS
            ),
        )
    if provider == "openai":
        from langchain_openai import OpenAIEmbeddings

        model = OpenAIEmbeddings(
            model=config.model, dimensions=EMBEDDING_DIMENSIONS, api_key=_require_key(provider)
        )
        return Embedder(model.embed_documents, model.embed_query)
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


def _build_context(
    state: GraphState, spec: AgentSpec, include_all_outputs: bool = False
) -> str:
    parts = [f"TASK INPUT:\n{state['input']}"]
    # Sequential/parallel agents see their declared dependencies; supervisor workers have
    # no depends_on wiring, so they see everything produced so far instead.
    relevant = list(state["outputs"].keys()) if include_all_outputs else spec.depends_on
    shown = [d for d in relevant if d in state["outputs"]]
    if shown:
        header = "\nOUTPUT FROM PRIOR AGENTS:" if include_all_outputs else (
            "\nOUTPUT FROM AGENTS YOU DEPEND ON:"
        )
        parts.append(header)
        for dep in shown:
            dep_out = state["outputs"][dep]
            parts.append(f"  [{dep}]: {dep_out.get('content', dep_out)}")
    return "\n".join(parts)


def _run_agent_once(
    llm: BaseChatModel,
    spec: AgentSpec,
    base_messages: list[AnyMessage],
    bounds: RunBounds,
) -> AgentOutput:
    """One full attempt for an agent node: bounded tool loop, then structured output.

    Any exception here (tool error, schema-validation failure) propagates to the caller's
    retry loop, which feeds the error text back into the agent's own context.
    """
    messages = list(base_messages)
    tools = get_tools(spec.tools)

    if tools:
        bound = llm.bind_tools(tools)
        tool_map = {t.name: t for t in tools}
        for _ in range(bounds.max_steps):
            ai = bound.invoke(messages)
            messages.append(ai)
            tool_calls = getattr(ai, "tool_calls", None) or []
            if not tool_calls:
                break
            for tc in tool_calls:
                tool = tool_map[tc["name"]]  # names validated at compile time
                result = tool.invoke(tc["args"])  # may raise -> caught by retry loop
                messages.append(
                    ToolMessage(content=str(result), tool_call_id=tc["id"])
                )

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
    output = structured.invoke(messages)
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
        retry = structured.invoke(messages)
        if not _looks_flattened(retry.content):
            output = retry
    return output


# Block-level Markdown that should start a line: headings, bullets, numbered items.
_INLINE_BLOCK_MARKER = re.compile(r"\s(?:#{1,6}|[*-]|\d{1,2}\.)\s")


def _looks_flattened(content: str) -> bool:
    """True when an answer that should span several lines arrived as one: no line break,
    and either Markdown block markers in mid-line or simply too long for one paragraph."""
    if "\n" in content:
        return False
    return len(_INLINE_BLOCK_MARKER.findall(content)) >= 2 or len(content) > 700


Emit = Callable[..., None]


def _emitter(config: RunnableConfig | None) -> Emit:
    """The run's event callback, if the caller asked for events (see run_graph_events);
    otherwise a no-op. Passed per run through LangGraph's config, so one compiled graph
    serves streaming and non-streaming runs alike."""
    emit = ((config or {}).get("configurable") or {}).get("emit")
    return emit if callable(emit) else (lambda event, **data: None)


def _make_node(spec: AgentSpec, bounds: RunBounds, include_all_outputs: bool = False):
    def node(state: GraphState, config: Optional[RunnableConfig] = None) -> dict[str, Any]:
        emit = _emitter(config)
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
        base_messages: list[AnyMessage] = [
            SystemMessage(content=spec.system_prompt),
            HumanMessage(content=_build_context(state, spec, include_all_outputs)),
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
                output = _run_agent_once(llm, spec, attempt_messages, bounds)
                dumped = output.model_dump()
                emit("node_completed", node=spec.id, duration_ms=elapsed_ms(),
                     attempts=attempt, output=dumped)
                return {"outputs": {spec.id: dumped}}
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
             attempts=bounds.max_retries, error=str(failure))
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


def compile_graph(plan: AgentPlan):
    """Compile a validated AgentPlan into a runnable LangGraph graph.

    Dispatches on orchestration pattern. All three share the same node implementation,
    state shape, and error-recovery loop — only the wiring differs:
      - sequential: a dependency-ordered chain, halting the rest on a node failure.
      - parallel:   the real dependency DAG, so independent agents run concurrently and
                    merge at agents that depend on them; failures are isolated per branch.
      - supervisor: a router node picks the next worker at runtime, looping until it
                    signals FINISH or a bounded iteration cap is hit.
    """
    # Fail fast at compile time if any agent references an unknown tool, rather than
    # discovering it mid-run.
    for spec in plan.agents:
        get_tools(spec.tools)

    if plan.orchestration_pattern == "sequential":
        return _compile_sequential(plan)
    if plan.orchestration_pattern == "parallel":
        return _compile_parallel(plan)
    if plan.orchestration_pattern == "supervisor":
        return _compile_supervisor(plan)
    raise NotImplementedError(
        f"orchestration pattern '{plan.orchestration_pattern}' is not supported"
    )


def _compile_sequential(plan: AgentPlan):
    ordered = _topological_order(plan.agents)
    builder = StateGraph(GraphState)
    for spec in ordered:
        builder.add_node(spec.id, _make_node(spec, plan.bounds))

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


def _compile_parallel(plan: AgentPlan):
    """Wire the dependency DAG directly: agents with no deps fan out from START and run
    concurrently; agents with deps run once their deps complete (the merge/synthesis
    step). Failure isolation is per-branch via the node's dependency gating, not a global
    halt — an independent worker failing doesn't stop its siblings."""
    has_dependents: set[str] = set()
    for spec in plan.agents:
        has_dependents.update(spec.depends_on)

    builder = StateGraph(GraphState)
    for spec in plan.agents:
        builder.add_node(spec.id, _make_node(spec, plan.bounds))

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

        llm = get_llm(sup_spec.llm)
        messages: list[AnyMessage] = [
            SystemMessage(content=sup_spec.system_prompt + routing_instructions),
            HumanMessage(content=_build_context(state, sup_spec, include_all_outputs=True)),
        ]
        try:
            decision = llm.with_structured_output(_SupervisorDecision).invoke(messages)
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


def _compile_supervisor(plan: AgentPlan):
    workers = [a for a in plan.agents if a.id != plan.supervisor_id]
    worker_ids = [w.id for w in workers]
    sup_spec = next(a for a in plan.agents if a.id == plan.supervisor_id)
    cap = max(plan.bounds.max_steps, 2 * len(workers) + 2)

    builder = StateGraph(GraphState)
    builder.add_node(sup_spec.id, _make_supervisor(sup_spec, worker_ids, cap))
    for w in workers:
        # Supervisor workers see all accumulated outputs (they carry no depends_on wiring).
        builder.add_node(w.id, _make_node(w, plan.bounds, include_all_outputs=True))
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


def run_single_agent(
    plan: AgentPlan,
    agent_id: str,
    task_input: dict[str, Any],
    upstream_outputs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run one agent node in isolation (the per-agent endpoint path).

    `upstream_outputs` lets the caller supply the outputs this agent's `depends_on`
    would normally provide, without running the whole graph.
    """
    spec = next((a for a in plan.agents if a.id == agent_id), None)
    if spec is None:
        raise KeyError(agent_id)
    node = _make_node(spec, plan.bounds)
    state = initial_state(task_input)
    state["outputs"] = dict(upstream_outputs or {})
    return node(state)


def run_graph(graph, task_input: dict[str, Any], bounds: RunBounds) -> dict[str, Any]:
    """Invoke a compiled graph with a wall-clock timeout bound (principle: every run is
    bounded, not left to model good behavior).

    On timeout the caller gets TimeoutError as soon as the limit passes. The run's worker
    thread can't be killed, so it finishes in the background and its result is dropped.
    """
    import concurrent.futures

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(
        graph.invoke,
        initial_state(task_input),
        {"recursion_limit": 50},
    )
    try:
        return future.result(timeout=bounds.timeout_s)
    except concurrent.futures.TimeoutError as e:
        raise TimeoutError(f"the run exceeded its {bounds.timeout_s:g}s time limit") from e
    finally:
        # Never block on the worker: a `with` block here would wait for it to finish,
        # which is exactly what made the timeout fire late.
        pool.shutdown(wait=False, cancel_futures=True)


def run_graph_events(
    graph, task_input: dict[str, Any], bounds: RunBounds
) -> Iterator[tuple[str, dict[str, Any]]]:
    """Run a compiled graph and yield (event, data) pairs as it happens:

      run_started → node_started / node_retry / node_completed / node_failed /
      node_skipped … → run_completed (with the same outputs/errors/halted as run_graph)
      or run_failed (timeout or an unexpected error).

    Every event carries `at` (Unix time, seconds). The same wall-clock limit as run_graph
    applies; on timeout the abandoned run finishes in the background, as there.
    """
    events: queue.Queue = queue.Queue()
    started = time.time()

    def emit(event: str, **data: Any) -> None:
        events.put((event, {**data, "at": time.time()}))

    def work() -> None:
        try:
            result = graph.invoke(
                initial_state(task_input),
                {"recursion_limit": 50, "configurable": {"emit": emit}},
            )
            events.put(("__done__", result))
        except Exception as e:  # noqa: BLE001 — reported to the caller as run_failed
            events.put(("__error__", e))

    threading.Thread(target=work, daemon=True, name="graph-run").start()
    yield "run_started", {"at": started, "timeout_s": bounds.timeout_s}

    deadline = started + bounds.timeout_s
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            yield "run_failed", {
                "at": time.time(),
                "error_type": "RunTimeout",
                "message": f"the run exceeded its {bounds.timeout_s:g}s time limit",
                "limit_s": bounds.timeout_s,
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
                "errors": data["errors"],
                "halted": data["halted"],
            }
            return
        if event == "__error__":
            yield "run_failed", {
                "at": time.time(),
                "error_type": type(data).__name__,
                "message": str(data) or "the run failed",
            }
            return
        yield event, data
