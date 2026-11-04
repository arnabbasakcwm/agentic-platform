"""The model gateway: every call to a chat model passes through its hooks, and with the
default (no-op) hooks the wrapped model behaves exactly as before."""

import pytest

from agentic_platform import model_gateway as mg
from agentic_platform.agent_schema import LLMConfig
from agentic_platform.graph_builder import get_llm
from agentic_platform.model_gateway import CallContext, GatewayRunnable, ModelGateway


class FakeModel:
    timeout = 42

    def __init__(self):
        self.calls = []

    def invoke(self, input, config=None, **kwargs):
        self.calls.append((input, config, kwargs))
        return f"reply:{input}"

    def bind_tools(self, tools):
        return FakeBound(self, tools)

    def with_structured_output(self, schema):
        return FakeBound(self, schema)


class FakeBound:
    def __init__(self, model, extra):
        self.model, self.extra = model, extra

    def invoke(self, input, config=None, **kwargs):
        return self.model.invoke(input, config, **kwargs)

    def with_structured_output(self, schema):
        return FakeBound(self.model, schema)


def wrapped(gw):
    fake = FakeModel()
    return fake, GatewayRunnable(fake, "p", "m", gw)


def test_default_hooks_pass_everything_through():
    fake, llm = wrapped(ModelGateway())
    assert llm.invoke("hi", {"callbacks": []}, stop=["x"]) == "reply:hi"
    assert fake.calls == [("hi", {"callbacks": []}, {"stop": ["x"]})]
    assert llm.timeout == 42  # attributes are delegated to the real model


def test_every_route_to_invoke_is_gated():
    gw = ModelGateway()
    seen = []
    gw.before_call = lambda ctx: seen.append((ctx.provider, ctx.model))
    fake, llm = wrapped(gw)
    llm.invoke("a")
    llm.bind_tools([1]).invoke("b")  # a tool loop's model
    llm.with_structured_output(dict).invoke("c")  # a final structured answer
    llm.bind_tools([1]).with_structured_output(dict).invoke("d")
    assert seen == [("p", "m")] * 4
    assert [c[0] for c in fake.calls] == ["a", "b", "c", "d"]


def test_before_call_can_refuse_and_the_model_is_not_called():
    gw = ModelGateway()

    def refuse(ctx):
        raise RuntimeError("blocked")

    gw.before_call = refuse
    fake, llm = wrapped(gw)
    with pytest.raises(RuntimeError, match="blocked"):
        llm.bind_tools([]).invoke("x")
    assert fake.calls == []


def test_after_call_sees_the_result_but_not_failures():
    gw = ModelGateway()
    results = []
    gw.after_call = lambda ctx, result: results.append(result)
    fake, llm = wrapped(gw)
    llm.invoke("ok")
    assert results == ["reply:ok"]

    def boom(*a, **k):
        raise ValueError("provider down")

    fake.invoke = boom
    with pytest.raises(ValueError):
        llm.invoke("bad")
    assert results == ["reply:ok"]


def test_get_llm_returns_a_gated_model_and_the_global_gateway_applies(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    llm = get_llm(LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))
    assert isinstance(llm, GatewayRunnable)
    # derived runnables stay gated too, and the call context names provider and model
    monkeypatch.setattr(mg.gateway, "before_call", lambda ctx: (_ for _ in ()).throw(RuntimeError(ctx.model)))
    derived = llm.bind_tools([])
    assert isinstance(derived, GatewayRunnable)
    with pytest.raises(RuntimeError, match="gemini-3.1-pro-preview"):
        derived.invoke("x")


def test_no_module_builds_a_chat_model_around_the_gateway():
    """Only graph_builder constructs chat models; everything else must call get_llm()."""
    import pathlib
    import re

    src = pathlib.Path(mg.__file__).parent
    pattern = re.compile(r"\b(ChatOpenAI|ChatBedrockConverse|ChatGoogleGenerativeAI|init_chat_model)\(")
    offenders = [
        f.name for f in src.glob("*.py") if f.name != "graph_builder.py" and pattern.search(f.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_entry_points_that_would_skip_the_gate_are_refused():
    _, llm = wrapped(ModelGateway())
    for name in ("stream", "ainvoke", "batch", "astream"):
        with pytest.raises(NotImplementedError):
            getattr(llm, name)
