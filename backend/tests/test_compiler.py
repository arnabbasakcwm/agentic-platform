from langchain_core.tools import tool

import agentic_platform.graph_builder as gb
import agentic_platform.tools as tools_module
from agentic_platform.agent_schema import AgentOutput, AgentPlan, AgentSpec, LLMConfig, RunBounds
from agentic_platform.graph_builder import _SupervisorDecision, compile_graph, initial_state


def _spec(id_, model, depends_on=None):
    return AgentSpec(
        id=id_,
        role="worker",
        system_prompt=f"agent {id_}",
        llm=LLMConfig(provider="google_genai", model=model),
        depends_on=depends_on or [],
    )


class _Structured:
    def __init__(self, outcomes):
        self._outcomes = list(outcomes)

    def invoke(self, messages):
        outcome = self._outcomes.pop(0) if len(self._outcomes) > 1 else self._outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class _FakeLLM:
    def __init__(self, structured):
        self._structured = structured

    def with_structured_output(self, schema):
        return self._structured

    def bind_tools(self, tools):  # not exercised by these no-tool agents
        return self


def _patch(monkeypatch, by_model):
    monkeypatch.setattr(gb, "get_llm", lambda cfg: _FakeLLM(by_model[cfg.model]))
    monkeypatch.setattr(gb.time, "sleep", lambda s: None)


def test_failed_agent_halts_chain_and_records_structured_failure(monkeypatch):
    # agent 'a' always fails; 'b' depends on it and must never run.
    b_structured = _Structured([AgentOutput(content="should not appear")])
    _patch(
        monkeypatch,
        {
            "fail-model": _Structured([ValueError("boom")]),
            "ok-model": b_structured,
        },
    )
    plan = AgentPlan(
        agents=[_spec("a", "fail-model"), _spec("b", "ok-model", depends_on=["a"])],
        orchestration_pattern="sequential",
        bounds=RunBounds(max_retries=3),
    )
    graph = compile_graph(plan)
    result = graph.invoke(initial_state({"q": "x"}))

    assert result["halted"] is True
    assert len(result["errors"]) == 1
    assert result["errors"][0]["agent_id"] == "a"
    assert result["errors"][0]["attempts"] == 3
    assert "b" not in result["outputs"]  # downstream agent did not run


def test_agent_recovers_after_transient_failure(monkeypatch):
    # 'a' fails once, then succeeds — the retry loop should feed the error back and pass.
    _patch(
        monkeypatch,
        {"flaky": _Structured([ValueError("transient"), AgentOutput(content="recovered")])},
    )
    plan = AgentPlan(
        agents=[_spec("a", "flaky")],
        orchestration_pattern="sequential",
        bounds=RunBounds(max_retries=3),
    )
    graph = compile_graph(plan)
    result = graph.invoke(initial_state({"q": "x"}))

    assert result["halted"] is False
    assert result["errors"] == []
    assert result["outputs"]["a"]["content"] == "recovered"


# --------------------------------------------------------------------------- parallel
def test_parallel_independent_agents_all_run(monkeypatch):
    _patch(
        monkeypatch,
        {
            "m-a": _Structured([AgentOutput(content="from a")]),
            "m-b": _Structured([AgentOutput(content="from b")]),
        },
    )
    plan = AgentPlan(
        agents=[_spec("a", "m-a"), _spec("b", "m-b")],
        orchestration_pattern="parallel",
    )
    result = compile_graph(plan).invoke(initial_state({"q": "x"}))

    assert result["halted"] is False
    assert result["outputs"]["a"]["content"] == "from a"
    assert result["outputs"]["b"]["content"] == "from b"


def test_parallel_failure_isolated_and_merge_node_gated(monkeypatch):
    # 'a' fails, 'b' (independent) succeeds, 'synth' depends on both -> must be skipped
    # because a produced no output, while b's result is preserved.
    _patch(
        monkeypatch,
        {
            "m-fail": _Structured([ValueError("boom")]),
            "m-ok": _Structured([AgentOutput(content="from b")]),
            "m-synth": _Structured([AgentOutput(content="should not appear")]),
        },
    )
    plan = AgentPlan(
        agents=[
            _spec("a", "m-fail"),
            _spec("b", "m-ok"),
            _spec("synth", "m-synth", depends_on=["a", "b"]),
        ],
        orchestration_pattern="parallel",
        bounds=RunBounds(max_retries=2),
    )
    result = compile_graph(plan).invoke(initial_state({"q": "x"}))

    assert result["outputs"]["b"]["content"] == "from b"  # sibling unaffected
    assert "a" not in result["outputs"]
    assert "synth" not in result["outputs"]  # merge node gated on missing dependency
    failed_ids = {e["agent_id"] for e in result["errors"]}
    assert {"a", "synth"} <= failed_ids


# ------------------------------------------------------------------------- supervisor
def test_supervisor_routes_then_finishes(monkeypatch):
    # Supervisor routes to 'w' on its first turn, then FINISH on its second.
    _patch(
        monkeypatch,
        {
            "m-sup": _Structured(
                [
                    _SupervisorDecision(next_agent="w", reason="do work"),
                    _SupervisorDecision(next_agent="FINISH", reason="done"),
                ]
            ),
            "m-w": _Structured([AgentOutput(content="work done")]),
        },
    )
    plan = AgentPlan(
        agents=[_spec("sup", "m-sup"), _spec("w", "m-w")],
        orchestration_pattern="supervisor",
        supervisor_id="sup",
    )
    result = compile_graph(plan).invoke(initial_state({"q": "x"}))

    assert result["outputs"]["w"]["content"] == "work done"
    assert result["next_agent"] == "FINISH"
    assert result["supervisor_steps"] == 2


# ------------------------------------------------------------------------------ tools
@tool
def _fake_web_search(query: str) -> str:
    """Deterministic stand-in for the real web_search tool, so this test never hits
    Tavily's API."""
    return f"search result for {query}"


class _FakeAIMessage:
    def __init__(self, tool_calls):
        self.tool_calls = tool_calls


class _FakeToolCallLLM:
    """Fakes one round of tool-calling then a structured final answer, exercising the
    tool loop in `_run_agent_once` end to end through the compiled graph."""

    def __init__(self, structured):
        self._structured = structured
        self._calls = 0

    def bind_tools(self, tools):
        return self

    def invoke(self, messages):
        self._calls += 1
        if self._calls == 1:
            return _FakeAIMessage(
                tool_calls=[{"name": "web_search", "args": {"query": "test"}, "id": "call-1"}]
            )
        return _FakeAIMessage(tool_calls=[])

    def with_structured_output(self, schema):
        return self._structured


def test_agent_with_tools_calls_tool_then_produces_structured_output(monkeypatch):
    monkeypatch.setitem(tools_module.TOOL_REGISTRY, "web_search", lambda: _fake_web_search)
    fake_llm = _FakeToolCallLLM(_Structured([AgentOutput(content="done")]))
    monkeypatch.setattr(gb, "get_llm", lambda cfg: fake_llm)
    monkeypatch.setattr(gb.time, "sleep", lambda s: None)

    spec = AgentSpec(
        id="a",
        role="worker",
        system_prompt="agent a",
        llm=LLMConfig(provider="google_genai", model="tool-model"),
        tools=["web_search"],
    )
    plan = AgentPlan(agents=[spec], orchestration_pattern="sequential")
    result = compile_graph(plan).invoke(initial_state({"q": "x"}))

    assert result["halted"] is False
    assert result["errors"] == []
    assert result["outputs"]["a"]["content"] == "done"


def _knowledge_spec():
    return AgentSpec(
        id="a",
        role="worker",
        system_prompt="agent a",
        llm=LLMConfig(provider="google_genai", model="tool-model"),
        tools=["knowledge_search"],
    )


def test_knowledge_search_needs_a_knowledge_base_to_compile():
    import pytest

    from agentic_platform.errors import KnowledgeUnavailableError

    plan = AgentPlan(agents=[_knowledge_spec()], orchestration_pattern="sequential")
    with pytest.raises(KnowledgeUnavailableError):
        compile_graph(plan)


def test_agent_searches_the_projects_documents_and_gets_cited_passages(monkeypatch):
    from agentic_platform.knowledge import EXCERPTS_OPEN, Hit, KnowledgeContext

    queries = []

    class Context(KnowledgeContext):
        def search(self, query, k=5):
            queries.append(query)
            return [Hit("policy.pdf", "page 4", "The Delhi hotel cap is INR 9,000.", 0.8)]

    class RecordingLLM(_FakeToolCallLLM):
        seen = []

        def invoke(self, messages):
            RecordingLLM.seen = list(messages)
            if self._calls == 0:
                self._calls += 1
                return _FakeAIMessage(
                    tool_calls=[{"name": "knowledge_search", "args": {"query": "hotel cap"}, "id": "c1"}]
                )
            return _FakeAIMessage(tool_calls=[])

    monkeypatch.setattr(gb, "get_llm", lambda cfg: RecordingLLM(_Structured([AgentOutput(content="done")])))
    plan = AgentPlan(agents=[_knowledge_spec()], orchestration_pattern="sequential")
    context = Context(embed_query=lambda q: [], load=lambda: ([], {}))
    result = compile_graph(plan, knowledge=context).invoke(initial_state({"q": "x"}))

    assert result["errors"] == []
    assert queries == ["hotel cap"]
    tool_result = RecordingLLM.seen[-1].content
    assert tool_result.startswith(EXCERPTS_OPEN)
    assert "[policy.pdf — page 4]" in tool_result


def test_knowledge_search_is_never_offered_by_default():
    assert "knowledge_search" not in tools_module.default_tool_names()


def test_supervisor_invalid_route_target_finishes_safely(monkeypatch):
    # Supervisor names a non-existent worker -> route coerced to FINISH, no crash/loop.
    _patch(
        monkeypatch,
        {
            "m-sup": _Structured([_SupervisorDecision(next_agent="ghost")]),
            "m-w": _Structured([AgentOutput(content="unused")]),
        },
    )
    plan = AgentPlan(
        agents=[_spec("sup", "m-sup"), _spec("w", "m-w")],
        orchestration_pattern="supervisor",
        supervisor_id="sup",
    )
    result = compile_graph(plan).invoke(initial_state({"q": "x"}))

    assert result["next_agent"] == "FINISH"
    assert "w" not in result["outputs"]


def test_run_graph_times_out_on_time_instead_of_waiting_for_the_run():
    import time as _time

    from agentic_platform.agent_schema import RunBounds
    from agentic_platform.graph_builder import run_graph

    class SlowGraph:
        def invoke(self, state, config):
            _time.sleep(2)
            return {"outputs": {}, "errors": [], "halted": False}

    started = _time.monotonic()
    try:
        run_graph(SlowGraph(), {}, RunBounds(timeout_s=0.2))
        raise AssertionError("expected a timeout")
    except TimeoutError as e:
        assert "0.2s time limit" in str(e)
    # Returned at the limit, not after the 2 s run finished.
    assert _time.monotonic() - started < 1.0


# ------------------------------------------------------------------ run events
def _events(plan, monkeypatch, by_model, task_input=None):
    from agentic_platform.graph_builder import run_graph_events

    _patch(monkeypatch, by_model)
    return list(run_graph_events(compile_graph(plan), task_input or {"q": "x"}, plan.bounds))


def test_sequential_run_streams_each_agent_in_order(monkeypatch):
    plan = AgentPlan(
        agents=[_spec("a", "m-a"), _spec("b", "m-b", depends_on=["a"])],
        orchestration_pattern="sequential",
    )
    events = _events(plan, monkeypatch, {
        "m-a": _Structured([AgentOutput(content="from a")]),
        "m-b": _Structured([AgentOutput(content="from b")]),
    })
    names = [(e, d.get("node")) for e, d in events]
    assert names == [
        ("run_started", None),
        ("node_started", "a"), ("node_completed", "a"),
        ("node_started", "b"), ("node_completed", "b"),
        ("run_completed", None),
    ]
    completed_a = events[2][1]
    assert completed_a["output"]["content"] == "from a"
    assert completed_a["duration_ms"] >= 0 and completed_a["attempts"] == 1
    final = events[-1][1]
    assert set(final["outputs"]) == {"a", "b"} and final["halted"] is False
    assert all("at" in d for _, d in events)


def test_failures_retries_and_skips_are_streamed(monkeypatch):
    plan = AgentPlan(
        agents=[_spec("a", "bad"), _spec("b", "ok"), _spec("c", "ok", depends_on=["a", "b"])],
        orchestration_pattern="parallel",
        bounds=RunBounds(max_retries=2),
    )
    events = _events(plan, monkeypatch, {
        "bad": _Structured([ValueError("boom")]),
        "ok": _Structured([AgentOutput(content="fine")]),
    })
    kinds = {(e, d.get("node")) for e, d in events}
    assert ("node_retry", "a") in kinds
    assert ("node_failed", "a") in kinds
    assert ("node_completed", "b") in kinds
    assert ("node_skipped", "c") in kinds
    assert events[-1][0] == "run_completed" and events[-1][1]["halted"] is True


def test_supervisor_router_is_streamed_with_its_decisions(monkeypatch):
    plan = AgentPlan(
        agents=[_spec("sup", "router"), _spec("w", "worker")],
        orchestration_pattern="supervisor",
        supervisor_id="sup",
    )
    events = _events(plan, monkeypatch, {
        "router": _Structured([_SupervisorDecision(next_agent="w"), _SupervisorDecision(next_agent="FINISH")]),
        "worker": _Structured([AgentOutput(content="did it")]),
    })
    decisions = [d["next_agent"] for e, d in events if e == "node_completed" and d["node"] == "sup"]
    assert decisions == ["w", "FINISH"]
    assert ("node_completed", "w") in {(e, d.get("node")) for e, d in events}


def test_streamed_run_times_out_on_time():
    import time as _time

    from agentic_platform.graph_builder import run_graph_events

    class SlowGraph:
        def invoke(self, state, config):
            _time.sleep(2)

    started = _time.monotonic()
    events = list(run_graph_events(SlowGraph(), {}, RunBounds(timeout_s=0.3)))
    assert [e for e, _ in events] == ["run_started", "run_failed"]
    assert events[-1][1]["error_type"] == "RunTimeout"
    assert _time.monotonic() - started < 1.5


def test_agent_output_schema_asks_for_markdown_with_line_breaks():
    schema = AgentOutput.model_json_schema()
    description = schema["properties"]["content"]["description"]
    assert "Markdown" in description and "own line" in description


def test_flattened_answer_is_sent_back_once_for_line_breaks(monkeypatch):
    flat = AgentOutput(content="Intro text. ### Option 1 * **Price:** 10 * **Time:** 2h ### Option 2 * **Price:** 12")
    fixed = AgentOutput(content="Intro text.\n\n### Option 1\n* **Price:** 10")
    structured = _Structured([flat, fixed])
    _patch(monkeypatch, {"m": structured})
    plan = AgentPlan(agents=[_spec("a", "m")], orchestration_pattern="sequential")
    result = compile_graph(plan).invoke(initial_state({"q": "x"}))
    assert result["outputs"]["a"]["content"] == fixed.content


def test_still_flat_rewrite_keeps_the_original_answer(monkeypatch):
    flat = AgentOutput(content="A. ### B * c * d")
    _patch(monkeypatch, {"m": _Structured([flat])})  # always flat
    plan = AgentPlan(agents=[_spec("a", "m")], orchestration_pattern="sequential")
    result = compile_graph(plan).invoke(initial_state({"q": "x"}))
    assert result["outputs"]["a"]["content"] == flat.content  # not failed over formatting
    assert result["errors"] == []


def test_short_or_multiline_answers_are_not_treated_as_flattened():
    from agentic_platform.graph_builder import _looks_flattened

    assert not _looks_flattened("The speed of light is 299,792 km/s.")
    assert not _looks_flattened("# Title\n\n- one\n- two")
    assert _looks_flattened("x " * 400)
