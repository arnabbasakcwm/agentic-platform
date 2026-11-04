"""The one gateway every chat-model call goes through.

`get_llm()` returns its model wrapped in a `GatewayRunnable`. Whatever a caller does with
it (call it, bind tools, ask for structured output) still ends in an `invoke` that passes
through `ModelGateway.before_call` / `after_call`. That is the single place where model
privileges and budgets are enforced (later RBAC tasks); today the hooks do nothing, so
behaviour is unchanged.

The wrapper is deliberately thin: unknown attributes are delegated to the wrapped model,
and `bind_tools` / `with_structured_output` / `bind` return another gateway runnable, so a
sub-agent or tool loop cannot reach the raw model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class CallContext:
    """What the gateway knows about one model call."""

    provider: str
    model: str
    config: dict[str, Any]  # the LangChain run config of this call (callbacks, configurable)


class ModelGateway:
    """Hook points around every model call. Subclass-free: assign callables.

    `before_call(ctx)` may raise a typed error to refuse the call; it runs on every call,
    including each turn of a tool loop and every sub-agent call. `after_call(ctx, result)`
    sees the finished call (failures skip it)."""

    def __init__(self) -> None:
        self.before_call: Callable[[CallContext], None] = lambda ctx: None
        self.after_call: Callable[[CallContext, Any], None] = lambda ctx, result: None


gateway = ModelGateway()

_UNGATED = ("stream", "astream", "ainvoke", "batch", "abatch", "transform", "astream_events")
_WRAPPING = ("bind_tools", "with_structured_output", "bind", "with_config", "with_retry")


class GatewayRunnable:
    """Wraps a chat model (or a runnable derived from one) so `invoke` is gated."""

    def __init__(self, inner: Any, provider: str, model: str, gw: ModelGateway | None = None):
        self._inner = inner
        self._provider = provider
        self._model = model
        self._gw = gw

    def _gateway(self) -> ModelGateway:
        return self._gw or gateway

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        gw = self._gateway()
        ctx = CallContext(self._provider, self._model, dict(config or {}))
        gw.before_call(ctx)
        result = self._inner.invoke(input, config, **kwargs)
        gw.after_call(ctx, result)
        return result

    def __getattr__(self, name: str) -> Any:
        if name in _UNGATED:  # fail closed: these would bypass before_call / after_call
            raise NotImplementedError(f"{name}() is not available on gated models; use invoke()")
        attr = getattr(self._inner, name)
        if name in _WRAPPING and callable(attr):
            def wrapped(*args: Any, **kwargs: Any) -> "GatewayRunnable":
                return GatewayRunnable(attr(*args, **kwargs), self._provider, self._model, self._gw)

            return wrapped
        return attr
