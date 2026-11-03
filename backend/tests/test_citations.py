"""Mandatory citations: numbered sources, the validator (missing → re-prompt → auto-append,
fake markers stripped), the shared system-prompt rule, and an agent run with mocked search
tools whose stored output carries structured citations."""

from types import SimpleNamespace

import pytest
from langchain_core.tools import tool

import agentic_platform.graph_builder as gb
from agentic_platform import citations as cit
from agentic_platform.agent_schema import AgentOutput, AgentPlan, AgentSpec, LLMConfig, RunBounds
from agentic_platform.graph_builder import compile_graph, initial_state


def _log():
    log = cit.CitationLog()
    log.add_web("https://www.goindigo.in/schedule", "IndiGo schedule", "6 daily departures")
    log.add_document("doc1", "fares.pdf", "page 3", "chunk7", "Lowest fare ₹7,004")
    return log


# ------------------------------------------------------------------ the log
def test_sources_are_numbered_once_each():
    log = _log()
    assert [s["n"] for s in log.sources] == [1, 2]
    assert log.add_web("https://www.goindigo.in/schedule", "again") == 1
    assert log.add_document("doc1", "fares.pdf", "page 3", "chunk7") == 2
    assert log.add_document("doc1", "fares.pdf", "page 4", "chunk8") == 3
    doc = log.get(2)
    assert {k: doc[k] for k in ("source_id", "document_id", "document_name", "location", "chunk_id")} == {
        "source_id": "2", "document_id": "doc1", "document_name": "fares.pdf", "location": "p. 3", "chunk_id": "chunk7",
    }
    assert log.get(9) is None


# ------------------------------------------------------------------ the validator
def test_a_properly_cited_answer_keeps_its_citations_and_gets_a_true_sources_section():
    asked = []
    content = "IndiGo has 6 flights [1]. The lowest fare is ₹7,004 [2].\n\n## Sources\n[1] Made-up title — http://fake"
    result = cit.enforce(content, _log(), lambda instruction: asked.append(instruction))
    assert asked == []  # nothing to ask
    assert result.auto_appended is False and result.invalid == []
    assert [c["n"] for c in result.citations] == [1, 2]
    # The Sources section is rebuilt from what the tools really returned.
    assert result.content.endswith(
        "## Sources\n[1] IndiGo schedule — https://www.goindigo.in/schedule\n[2] fares.pdf, p. 3"
    )
    assert "Made-up title" not in result.content


def test_missing_citations_are_asked_for_once():
    asked = []

    def reask(instruction):
        asked.append(instruction)
        return "IndiGo has 6 flights [1]."

    result = cit.enforce("IndiGo has 6 flights.", _log(), reask)
    assert len(asked) == 1 and "[1] IndiGo schedule" in asked[0]
    assert result.reprompted and not result.auto_appended
    assert result.content.startswith("IndiGo has 6 flights [1].")
    assert [c["n"] for c in result.citations] == [1]


def test_still_missing_after_the_reprompt_appends_every_source_and_says_so():
    asked = []
    result = cit.enforce("IndiGo has 6 flights.", _log(), lambda i: asked.append(i) or "Still no markers.")
    assert len(asked) == 1
    assert result.auto_appended is True
    assert result.content.startswith("IndiGo has 6 flights.")
    assert result.content.endswith("## Sources\n[1] IndiGo schedule — https://www.goindigo.in/schedule\n[2] fares.pdf, p. 3")
    assert [c["n"] for c in result.citations] == [1, 2]
    assert result.meta()["citations_auto_appended"] is True


def test_a_failed_reprompt_also_falls_back_to_appending():
    result = cit.enforce("No markers.", _log(), lambda i: None)
    assert result.auto_appended is True


def test_markers_that_map_to_no_source_are_stripped_and_flagged():
    result = cit.enforce("Six flights [1]. Cheapest is Akasa [7]. See [docs](https://x.y) [2].", _log(), lambda i: None)
    assert result.invalid == [7]
    assert "[7]" not in result.content and "Cheapest is Akasa." in result.content
    assert "[docs](https://x.y)" in result.content  # a Markdown link isn't a marker
    assert [c["n"] for c in result.citations] == [1, 2]
    assert result.meta()["citations_invalid"] == [7]


def test_only_fake_markers_count_as_none():
    asked = []
    result = cit.enforce("Claim [5].", _log(), lambda i: asked.append(i) or "Claim [6].")
    assert len(asked) == 1
    # The re-ask cited nothing real either, so the original answer is kept, its fake
    # marker removed, and every source appended.
    assert result.auto_appended is True and result.invalid == [5]
    assert result.content.startswith("Claim.") and "[5]" not in result.content


def test_the_flag_turns_it_off(monkeypatch):
    monkeypatch.delenv("REQUIRE_CITATIONS", raising=False)
    assert cit.require_citations() is True
    for value in ("false", "0", "off", "No"):
        monkeypatch.setenv("REQUIRE_CITATIONS", value)
        assert cit.require_citations() is False


# ------------------------------------------------------------------ an agent run
class _FakeAIMessage(SimpleNamespace):
    pass


class _SearchingLLM:
    """Calls the given tools once, then answers with the structured outputs in turn."""

    def __init__(self, calls, answers):
        self.calls = calls
        self.answers = list(answers)
        self.turns = 0
        self.system = None
        self.structured_calls = []

    def bind_tools(self, tools):
        return self

    def invoke(self, messages, config=None):
        self.system = messages[0].content
        if self.turns == 0:
            self.turns += 1
            return _FakeAIMessage(content="", tool_calls=self.calls)
        return _FakeAIMessage(content="", tool_calls=[])

    def with_structured_output(self, schema):
        llm = self

        class Structured:
            def invoke(self, messages, config=None):
                llm.structured_calls.append(messages[-1].content)
                return llm.answers.pop(0) if len(llm.answers) > 1 else llm.answers[0]

        return Structured()


def _web_tool():
    from agentic_platform.tools import format_web_results

    @tool
    def web_search(query: str, config: gb.RunnableConfig) -> str:
        """Search the web."""
        log = ((config or {}).get("configurable") or {}).get("citations")
        return format_web_results(query, {"results": [
            {"url": "https://www.goindigo.in/schedule", "title": "IndiGo schedule", "content": "6 daily departures"},
            {"url": "https://www.akasaair.com/fares", "title": "Akasa fares", "content": "From ₹7,004"},
        ]}, log)

    return web_search


def _run(monkeypatch, llm, tools=("web_search",)):
    monkeypatch.setattr(gb, "get_llm", lambda cfg: llm)
    monkeypatch.setattr(gb, "get_tools", lambda names, *a, **k: [_web_tool()])
    monkeypatch.setattr(gb.time, "sleep", lambda s: None)
    spec = AgentSpec(id="searcher", role="r", system_prompt="Find fares.", tools=list(tools),
                     llm=LLMConfig(provider="google_genai", model="m"))
    plan = AgentPlan(agents=[spec], orchestration_pattern="sequential", bounds=RunBounds(max_retries=1))
    events = []
    result = compile_graph(plan).invoke(
        initial_state({"q": "fares"}),
        config={"configurable": {"emit": lambda event, **data: events.append((event, data))}},
    )
    return result, events


def test_an_agent_that_cites_stores_structured_citations(monkeypatch):
    llm = _SearchingLLM(
        [{"name": "web_search", "args": {"query": "goa fares"}, "id": "c1"}],
        [AgentOutput(content="Akasa is cheapest at ₹7,004 [2].")],
    )
    result, events = _run(monkeypatch, llm)
    output = result["outputs"]["searcher"]
    assert output["citations_auto_appended"] is False
    assert [(c["n"], c["url"]) for c in output["citations"]] == [(2, "https://www.akasaair.com/fares")]
    assert output["content"].endswith("## Sources\n[2] Akasa fares — https://www.akasaair.com/fares")
    # The shared rule reached the agent's system prompt.
    assert "CITE YOUR SOURCES" in llm.system and llm.system.startswith("Find fares.")
    # The stored run output (the node_completed event) carries the same data.
    completed = next(d for e, d in events if e == "node_completed")
    assert completed["output"]["citations"] == output["citations"]


def test_an_agent_that_forgets_is_reprompted_then_auto_appended(monkeypatch):
    llm = _SearchingLLM(
        [{"name": "web_search", "args": {"query": "goa fares"}, "id": "c1"}],
        [AgentOutput(content="Akasa is cheapest."), AgentOutput(content="Akasa is cheapest, really.")],
    )
    result, _ = _run(monkeypatch, llm)
    output = result["outputs"]["searcher"]
    assert any("cites none of them" in m for m in llm.structured_calls)  # asked once
    assert output["citations_auto_appended"] is True
    assert [c["n"] for c in output["citations"]] == [1, 2]
    assert "[1] IndiGo schedule — https://www.goindigo.in/schedule" in output["content"]


def test_an_agent_without_search_results_gets_no_citations(monkeypatch):
    llm = _SearchingLLM([], [AgentOutput(content="Here's the plan.")])
    result, _ = _run(monkeypatch, llm, tools=())
    output = result["outputs"]["searcher"]
    assert "citations" not in output and output["content"] == "Here's the plan."


def test_with_the_flag_off_nothing_is_enforced(monkeypatch):
    monkeypatch.setenv("REQUIRE_CITATIONS", "false")
    llm = _SearchingLLM(
        [{"name": "web_search", "args": {"query": "goa fares"}, "id": "c1"}],
        [AgentOutput(content="Akasa is cheapest.")],
    )
    result, _ = _run(monkeypatch, llm)
    output = result["outputs"]["searcher"]
    assert output["content"] == "Akasa is cheapest." and "citations" not in output
    assert "CITE YOUR SOURCES" not in llm.system


def test_document_search_results_are_numbered_and_cited(monkeypatch):
    from agentic_platform.knowledge import Hit, KnowledgeContext
    from agentic_platform.tools import get_tools as real_get_tools

    class Context(KnowledgeContext):
        def search(self, query, k=5, on_query_embedded=None):
            return [Hit("fares.pdf", "page 3", "Lowest fare ₹7,004.", 0.9, document_id="doc1", chunk_id="c7")]

    context = Context(load_groups=lambda: [], embedder_for=lambda config: None)
    llm = _SearchingLLM(
        [{"name": "knowledge_search", "args": {"query": "lowest fare"}, "id": "k1"}],
        [AgentOutput(content="The lowest fare is ₹7,004 [1].")],
    )
    monkeypatch.setattr(gb, "get_llm", lambda cfg: llm)
    monkeypatch.setattr(gb, "get_tools", real_get_tools)
    spec = AgentSpec(id="reader", role="r", system_prompt="Read.", tools=["knowledge_search"],
                     llm=LLMConfig(provider="google_genai", model="m"))
    plan = AgentPlan(agents=[spec], orchestration_pattern="sequential")
    output = compile_graph(plan, knowledge=context).invoke(initial_state({"q": "x"}))["outputs"]["reader"]
    (citation,) = output["citations"]
    assert {k: citation[k] for k in ("n", "kind", "document_id", "document_name", "location", "chunk_id")} == {
        "n": 1, "kind": "document", "document_id": "doc1", "document_name": "fares.pdf",
        "location": "p. 3", "chunk_id": "c7",
    }
    assert output["content"].endswith("## Sources\n[1] fares.pdf, p. 3")


@pytest.mark.parametrize("source, label", [("page 4", "p. 4"), ("pages 3–5", "pp. 3–5"), ("rows 2–9", "rows 2–9")])
def test_document_locations_read_naturally(source, label):
    assert cit.location_label(source) == label
