"""Whether a model can call tools — measured, not read from documentation.

Every agent needs tool calling unless it has no tools: the tool loop uses it, and the
final structured answer (and a supervisor's routing decision) is requested through it.
Provider documentation has proved unreliable here (AWS's Gemma 3 card lists tool calling,
yet through Bedrock Converse it answers in prose), so the platform asks each model once:
one harmless tool, one instruction to call it. The verdict is stored for every user and
re-checked after CHECK_VALID_FOR.

Models that can't call tools stay usable for agents without tools: those agents give
their final answer as JSON, validated against the same schema (graph_builder).
"""

from __future__ import annotations

import logging
from datetime import timedelta

from langchain_core.tools import tool

from .agent_schema import LLMConfig
from .usage import UsageCallback, UsageCollector

logger = logging.getLogger(__name__)

# Providers whose chat models on this platform call tools reliably. Only Bedrock's
# catalog mixes models with and without tool calling, so only those are checked.
KNOWN_TOOL_CALLING: frozenset[str] = frozenset({"google_genai", "openai", "anthropic", "groq", "moonshot"})
CHECK_VALID_FOR = timedelta(days=30)
PROBE_PROMPT = "Call the record_value tool with value 42. Do not reply with text."


@tool
def record_value(value: int) -> str:
    """Record an integer value."""
    return "recorded"


def model_key(provider: str, model: str) -> str:
    return f"{provider}/{model}"


def needs_check(provider: str) -> bool:
    return provider not in KNOWN_TOOL_CALLING and provider != "ollama"


def _refuses_tools(error: Exception) -> bool:
    text = str(error).lower()
    return "tool" in text and ("not support" in text or "doesn't support" in text or "does not support" in text)


def probe_tool_calling(provider: str, model: str, usage: UsageCollector | None = None) -> bool | None:
    """Ask the model to call one tool. True: it did. False: it answered in prose, or the
    provider rejected tools for it. None: couldn't tell (throttled, no access, network),
    so nothing should be stored."""
    from .graph_builder import get_llm  # local: graph_builder imports this module

    llm = get_llm(LLMConfig(provider=provider, model=model, temperature=0))
    config = (
        {"callbacks": [UsageCallback(usage, kind="model_check", provider=provider, model=model)]}
        if usage is not None
        else {}
    )
    try:
        reply = llm.bind_tools([record_value]).invoke(PROBE_PROMPT, config=config)
    except Exception as e:  # noqa: BLE001 — a probe never fails the request that triggered it
        if _refuses_tools(e):
            return False
        logger.warning("tool-calling check for %s/%s inconclusive: %s", provider, model, e)
        return None
    calls = getattr(reply, "tool_calls", None) or []
    return any(c.get("name") == "record_value" for c in calls)
