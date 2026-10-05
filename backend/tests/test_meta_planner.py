import pytest

import agentic_platform.meta_planner_prompt as mp
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig, PlanRevision
from agentic_platform.errors import PlannerError


def _valid_plan():
    return AgentPlan(
        agents=[
            AgentSpec(
                id="only",
                role="worker",
                system_prompt="do it",
                llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"),
                tools=["lookup"],
            )
        ],
        orchestration_pattern="sequential",
    )


class _FakeStructured:
    """Stand-in for llm.with_structured_output(AgentPlan): scripted per-call outcomes."""

    def __init__(self, outcomes):
        self._outcomes = list(outcomes)
        self.calls = 0

    def invoke(self, messages, config=None):
        self.calls += 1
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class _FakeLLM:
    def __init__(self, structured):
        self._structured = structured

    def with_structured_output(self, schema):
        return self._structured


def _patch_llm(monkeypatch, outcomes):
    structured = _FakeStructured(outcomes)
    monkeypatch.setattr(mp, "get_llm", lambda cfg: _FakeLLM(structured))
    monkeypatch.setattr(mp.time, "sleep", lambda s: None)  # no real backoff in tests
    return structured


def test_recovers_after_one_invalid_attempt(monkeypatch):
    # First attempt returns a plan using a tool not in the allow-list -> semantic ValueError;
    # second attempt returns a valid plan. The loop should feed the error back and succeed.
    bad_plan = AgentPlan(
        agents=[
            AgentSpec(
                id="only",
                role="worker",
                system_prompt="do it",
                llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"),
                tools=["ghost_tool"],
            )
        ],
        orchestration_pattern="sequential",
    )
    structured = _patch_llm(monkeypatch, [bad_plan, _valid_plan()])

    plan = mp.plan_project(
        user_brief="x",
        requested_agent_count=1,
        available_tools=["lookup"],
        available_llms=[{"provider": "google_genai", "model": "gemini-3.1-pro-preview"}],
    )
    assert plan.agents[0].tools == ["lookup"]
    assert structured.calls == 2


def _plan_with(n):
    return AgentPlan(
        agents=[
            AgentSpec(
                id=f"a{i}",
                role="worker",
                system_prompt="do it",
                llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"),
            )
            for i in range(n)
        ],
        orchestration_pattern="parallel",
    )


_LLMS = [{"provider": "google_genai", "model": "gemini-3.1-pro-preview"}]


class _Recorder(_FakeStructured):
    def __init__(self, outcomes):
        super().__init__(outcomes)
        self.messages = []

    def invoke(self, messages, config=None):
        self.messages.append(messages)
        return super().invoke(messages)


def test_too_many_agents_for_the_requested_count_is_fed_back_and_retried(monkeypatch):
    structured = _patch_llm(monkeypatch, [_plan_with(3), _plan_with(2)])
    plan = mp.plan_project("x", requested_agent_count=2, available_tools=[], available_llms=_LLMS)
    assert len(plan.agents) == 2
    assert structured.calls == 2


def test_without_a_count_the_planner_chooses_and_is_told_so(monkeypatch):
    recorder = _Recorder([_plan_with(4)])
    monkeypatch.setattr(mp, "get_llm", lambda cfg: _FakeLLM(recorder))
    plan = mp.plan_project("x", available_tools=[], available_llms=_LLMS)
    assert len(plan.agents) == 4
    user_message = recorder.messages[0][1].content
    assert "DESIRED AGENT COUNT: not specified" in user_message


def test_without_a_count_the_platform_maximum_still_applies(monkeypatch):
    from agentic_platform.config import MAX_AGENTS

    structured = _patch_llm(monkeypatch, [_plan_with(MAX_AGENTS + 1), _plan_with(MAX_AGENTS)])
    plan = mp.plan_project("x", available_tools=[], available_llms=_LLMS)
    assert len(plan.agents) == MAX_AGENTS
    assert structured.calls == 2


def test_raises_planner_error_after_ceiling(monkeypatch):
    structured = _patch_llm(monkeypatch, [ValueError("bad")] * 3)

    with pytest.raises(PlannerError) as exc_info:
        mp.plan_project(
            user_brief="x",
            requested_agent_count=1,
            available_tools=["lookup"],
            available_llms=[{"provider": "google_genai", "model": "gemini-3.1-pro-preview"}],
        )
    assert exc_info.value.attempts == 3
    assert structured.calls == 3


# ------------------------------------------------------------------ revise_plan
def test_revision_is_validated_like_a_new_plan_and_retried(monkeypatch):
    sneaky = PlanRevision(
        reply="Added web search.",
        brief="x",
        plan=_plan_with(1).model_copy(
            update={"agents": [_plan_with(1).agents[0].model_copy(update={"tools": ["web_search"]})]}
        ),
    )
    honest = PlanRevision(reply="Web search isn't available here.", brief="x", plan=_plan_with(1))
    recorder = _Recorder([sneaky, honest])
    monkeypatch.setattr(mp, "get_llm", lambda cfg: _FakeLLM(recorder))
    monkeypatch.setattr(mp.time, "sleep", lambda s: None)

    revision = mp.revise_plan(
        "x", _plan_with(1), "add web search", available_tools=["lookup"], available_llms=_LLMS
    )
    assert revision.reply == "Web search isn't available here."
    assert recorder.calls == 2
    # The second attempt was told exactly why the first was rejected.
    assert "web_search" in recorder.messages[1][1].content
    assert "REJECTED" in recorder.messages[1][1].content


def test_revision_sees_the_current_plan_request_and_recent_history(monkeypatch):
    recorder = _Recorder([PlanRevision(reply="Done.", brief="new brief", plan=_plan_with(2))])
    monkeypatch.setattr(mp, "get_llm", lambda cfg: _FakeLLM(recorder))
    history = [("user", f"old message {i}") for i in range(15)]

    mp.revise_plan(
        "old brief", _plan_with(1), "use two agents", history=history,
        available_tools=[], available_llms=_LLMS,
    )
    message = recorder.messages[0][1].content
    assert "CURRENT BRIEF:\nold brief" in message
    assert '"a0"' in message  # the current plan, as JSON
    assert "USER REQUEST:\nuse two agents" in message
    # Only the most recent history is sent.
    assert "old message 14" in message
    assert "old message 4" not in message


def test_revision_cannot_exceed_the_platform_maximum(monkeypatch):
    from agentic_platform.config import MAX_AGENTS

    too_big = PlanRevision(reply="ok", brief="x", plan=_plan_with(MAX_AGENTS + 1))
    _patch_llm(monkeypatch, [too_big] * 3)
    with pytest.raises(PlannerError):
        mp.revise_plan("x", _plan_with(1), "more agents", available_tools=[], available_llms=_LLMS)


def test_planner_cannot_set_run_limits(monkeypatch):
    from agentic_platform.agent_schema import RunBounds

    tight = _plan_with(1).model_copy(update={"bounds": RunBounds(timeout_s=60, max_steps=10, max_retries=2)})
    _patch_llm(monkeypatch, [tight])
    plan = mp.plan_project("x", available_tools=[], available_llms=_LLMS)
    assert plan.bounds == RunBounds()


def test_revision_keeps_the_projects_run_limits(monkeypatch):
    from agentic_platform.agent_schema import RunBounds

    current = _plan_with(1).model_copy(update={"bounds": RunBounds(timeout_s=600)})
    proposed = PlanRevision(reply="ok", brief="x",
                            plan=_plan_with(2).model_copy(update={"bounds": RunBounds(timeout_s=30)}))
    _patch_llm(monkeypatch, [proposed])
    revision = mp.revise_plan("x", current, "add an agent", available_tools=[], available_llms=_LLMS)
    assert revision.plan.bounds.timeout_s == 600
    assert len(revision.plan.agents) == 2
