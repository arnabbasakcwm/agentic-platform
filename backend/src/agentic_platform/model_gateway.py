"""The one gateway every chat-model call goes through.

`get_llm()` returns its model wrapped in a `GatewayRunnable`. Whatever a caller does with
it (call it, bind tools, ask for structured output) still ends in an `invoke` that passes
through `ModelGateway.before_call` / `after_call`. That is the single place where access,
model privileges and budgets are enforced, on every call - each turn of a tool loop and every
sub-agent included.

`before_call(ctx)` may raise a typed error to refuse the call, or return a `Redirect` to run
it on another model instead (the admin-enabled fallback). A redirect replays the same
derivations (`bind_tools`, `with_structured_output`, ...) on a freshly built model, so the
caller never notices which model answered; token counting is re-labelled to the model that
really ran.

The wrapper is deliberately thin: unknown attributes are delegated to the wrapped model,
and `bind_tools` / `with_structured_output` / `bind` return another gateway runnable, so a
sub-agent or tool loop cannot reach the raw model.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Callable

from .usage import UsageCallback


@dataclass(frozen=True)
class CallIdentity:
    """Who a run's model calls are made for. It travels in the run's config (`configurable`), so
    sub-agents and tool loops carry it too. `check(agent_id)` re-validates access and raises a
    typed error when it is gone; it runs before every model call."""

    user_id: str
    project_id: str | None = None
    team_id: str | None = None
    check: Callable[[str | None], None] | None = None


@dataclass(frozen=True)
class CallContext:
    """What the gateway knows about one model call."""

    provider: str
    model: str
    config: dict[str, Any]  # the LangChain run config of this call (callbacks, configurable)

    @property
    def identity(self) -> CallIdentity | None:
        found = (self.config.get("configurable") or {}).get("identity")
        return found if isinstance(found, CallIdentity) else None

    @property
    def agent_id(self) -> str | None:
        return (self.config.get("configurable") or {}).get("agent_id")


@dataclass(frozen=True)
class Redirect:
    """Run this call on another model. `blocked` is the error to raise if the gateway cannot."""

    provider: str
    model: str
    blocked: Exception


def check_identity(ctx: CallContext) -> None:
    """Default hook: if the call carries an identity with an access check, run it. Calls with
    no identity (planner, probes, tests) are unaffected."""
    identity = ctx.identity
    if identity is not None and identity.check is not None:
        identity.check(ctx.agent_id)


class ModelGateway:
    """Hook points around every model call. Subclass-free: assign callables.

    `before_call(ctx)` may raise a typed error to refuse the call, or return a `Redirect`.
    `after_call(ctx, result)` sees the finished call (failures skip it); `ctx` then names the
    model that really answered."""

    def __init__(self) -> None:
        self.before_call: Callable[[CallContext], Redirect | None] = check_identity
        self.after_call: Callable[[CallContext, Any], None] = lambda ctx, result: None


gateway = ModelGateway()

_UNGATED = ("stream", "astream", "ainvoke", "batch", "abatch", "transform", "astream_events")
_WRAPPING = ("bind_tools", "with_structured_output", "bind", "with_config", "with_retry")

Recipe = tuple[tuple[str, tuple[Any, ...], tuple[tuple[str, Any], ...]], ...]


class GatewayRunnable:
    """Wraps a chat model (or a runnable derived from one) so `invoke` is gated."""

    def __init__(
        self,
        inner: Any,
        provider: str,
        model: str,
        gw: ModelGateway | None = None,
        rebuild: Callable[[str, str], Any] | None = None,
        recipe: Recipe = (),
    ):
        self._inner = inner
        self._provider = provider
        self._model = model
        self._gw = gw
        self._rebuild = rebuild  # builds a raw model for (provider, model), for redirects
        self._recipe = recipe  # the derivations applied to the root model so far

    def _gateway(self) -> ModelGateway:
        return self._gw or gateway

    def _replay(self, provider: str, model: str) -> Any:
        assert self._rebuild is not None
        target = self._rebuild(provider, model)
        for name, args, kwargs in self._recipe:
            target = getattr(target, name)(*args, **dict(kwargs))
        return target

    @staticmethod
    def _relabel(config: dict[str, Any], provider: str, model: str) -> dict[str, Any]:
        """Token counting follows the model that really answers (cost is priced per model)."""
        callbacks = [
            cb.relabelled(provider, model) if isinstance(cb, UsageCallback) else cb
            for cb in config.get("callbacks") or []
        ]
        return {**config, "callbacks": callbacks} if callbacks else config

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        gw = self._gateway()
        config = dict(config or {})
        ctx = CallContext(self._provider, self._model, config)
        outcome = gw.before_call(ctx)
        target = self._inner
        if isinstance(outcome, Redirect):
            if self._rebuild is None:  # nothing to rebuild a model from: the block stands
                raise outcome.blocked
            target = self._replay(outcome.provider, outcome.model)
            config = self._relabel(config, outcome.provider, outcome.model)
            ctx = replace(ctx, provider=outcome.provider, model=outcome.model, config=config)
        result = target.invoke(input, config, **kwargs)
        gw.after_call(ctx, result)
        return result

    def __getattr__(self, name: str) -> Any:
        if name in _UNGATED:  # fail closed: these would bypass before_call / after_call
            raise NotImplementedError(f"{name}() is not available on gated models; use invoke()")
        attr = getattr(self._inner, name)
        if name in _WRAPPING and callable(attr):
            def wrapped(*args: Any, **kwargs: Any) -> "GatewayRunnable":
                recipe = self._recipe + ((name, args, tuple(kwargs.items())),)
                return GatewayRunnable(
                    attr(*args, **kwargs), self._provider, self._model, self._gw, self._rebuild, recipe
                )

            return wrapped
        return attr
