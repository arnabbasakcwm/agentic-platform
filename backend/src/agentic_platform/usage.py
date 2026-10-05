"""Measuring model usage: which models were called, how many tokens, and what it cost.

Pure accounting, no I/O beyond reading the price table: `UsageCollector` gathers usage
during one unit of work (a run, a planner call, an indexing job), `UsageCallback` feeds it
from LangChain's provider-reported `usage_metadata`, and `price()` turns tokens into an
estimated cost from `backend/pricing.json`. Storing usage is the store layer's job.

Chat-model tokens are what the provider reported. Embedding tokens aren't reported by the
LangChain embedding classes, so they are estimated (`estimate_tokens`) and flagged.
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

# Providers bill some models at a higher rate for very long prompts (Gemini: prompts over
# 200k tokens). Calls are bucketed by prompt size at this threshold so either rate applies.
LONG_CONTEXT_TOKENS = 200_000

PRICING_FILE = Path(__file__).resolve().parents[2] / "pricing.json"


@dataclass
class UsageEntry:
    """Usage of one model by one agent (or one platform activity) in one unit of work."""

    kind: str  # run | planner | assistant | embedding_index | embedding_query
    provider: str
    model: str
    agent_id: str | None = None
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    # The part of the above from calls whose prompt exceeded LONG_CONTEXT_TOKENS.
    long_input_tokens: int = 0
    long_output_tokens: int = 0
    estimated: bool = False

    def add(self, input_tokens: int, output_tokens: int, calls: int = 1) -> None:
        self.calls += calls
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        if input_tokens > LONG_CONTEXT_TOKENS * calls:
            self.long_input_tokens += input_tokens
            self.long_output_tokens += output_tokens


class UsageCollector:
    """Thread-safe usage tally for one unit of work. Parallel agents add to it at once."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[tuple[Any, ...], UsageEntry] = {}

    def add(
        self,
        *,
        kind: str,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int = 0,
        agent_id: str | None = None,
        estimated: bool = False,
        calls: int = 1,
    ) -> None:
        key = (kind, provider, model, agent_id, estimated)
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = self._entries[key] = UsageEntry(kind, provider, model, agent_id, estimated=estimated)
            entry.add(max(int(input_tokens), 0), max(int(output_tokens), 0), calls)

    def merge(self, entries: list[dict[str, Any]]) -> None:
        """Add entries reported elsewhere (e.g. by a deployed runtime)."""
        for e in entries:
            key = (e["kind"], e["provider"], e["model"], e.get("agent_id"), bool(e.get("estimated")))
            with self._lock:
                entry = self._entries.get(key)
                if entry is None:
                    entry = self._entries[key] = UsageEntry(
                        e["kind"], e["provider"], e["model"], e.get("agent_id"), estimated=bool(e.get("estimated"))
                    )
                entry.calls += int(e.get("calls", 0))
                entry.input_tokens += int(e.get("input_tokens", 0))
                entry.output_tokens += int(e.get("output_tokens", 0))
                entry.long_input_tokens += int(e.get("long_input_tokens", 0))
                entry.long_output_tokens += int(e.get("long_output_tokens", 0))

    def entries(self, agent_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            items = [asdict(e) for e in self._entries.values()]
        return [e for e in items if agent_id is None or e["agent_id"] == agent_id]

    def totals(self) -> dict[str, int]:
        entries = self.entries()
        return {
            "calls": sum(e["calls"] for e in entries),
            "input_tokens": sum(e["input_tokens"] for e in entries),
            "output_tokens": sum(e["output_tokens"] for e in entries),
        }


class UsageCallback(BaseCallbackHandler):
    """Feeds a collector from chat-model calls, labelled with the agent and the model it
    was configured with (so cost is looked up by the configured name, not whatever alias
    the provider echoes back)."""

    def __init__(self, collector: UsageCollector, *, kind: str, provider: str, model: str, agent_id: str | None = None):
        super().__init__()
        self._collector = collector
        self._labels = {"kind": kind, "provider": provider, "model": model, "agent_id": agent_id}

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        for generations in response.generations:
            for generation in generations:
                message = getattr(generation, "message", None)
                usage = getattr(message, "usage_metadata", None)
                if usage:
                    self._collector.add(
                        **self._labels,
                        input_tokens=usage.get("input_tokens", 0),
                        output_tokens=usage.get("output_tokens", 0),
                    )


def estimate_tokens(texts: list[str] | str) -> int:
    """Rough token count for text whose provider doesn't report one (~4 characters each)."""
    if isinstance(texts, str):
        texts = [texts]
    return sum(math.ceil(len(t) / 4) for t in texts)


# ---------------------------------------------------------------------------- pricing
_PRICES: dict[str, Any] | None = None


def load_prices(path: Path = PRICING_FILE) -> dict[str, Any]:
    """The price table (`backend/pricing.json`). Missing or unreadable: no prices."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"currency": "USD", "models": {}}
    data.setdefault("currency", "USD")
    data.setdefault("models", {})
    return data


def prices() -> dict[str, Any]:
    global _PRICES
    if _PRICES is None:
        _PRICES = load_prices()
    return _PRICES


def price_for(provider: str, model: str, table: dict[str, Any] | None = None) -> dict[str, Any] | None:
    table = table if table is not None else prices()
    return table["models"].get(f"{provider}/{model}")


def cost(entry: dict[str, Any], table: dict[str, Any] | None = None) -> float | None:
    """Estimated cost of a usage entry in the table's currency, or None if the model has
    no price. Long-context calls use the long-context rate when the table has one."""
    rate = price_for(entry["provider"], entry["model"], table)
    if rate is None:
        return None
    long_rate = rate.get("long_context") or {}
    long_in = entry.get("long_input_tokens", 0) if long_rate else 0
    long_out = entry.get("long_output_tokens", 0) if long_rate else 0
    normal_in = entry["input_tokens"] - long_in
    normal_out = entry["output_tokens"] - long_out
    total = (
        normal_in * rate.get("input_per_1m", 0)
        + normal_out * rate.get("output_per_1m", 0)
        + long_in * long_rate.get("input_per_1m", 0)
        + long_out * long_rate.get("output_per_1m", 0)
    ) / 1_000_000
    return round(total, 6)


# ---------------------------------------------------------------------------- dashboard
RUN_KINDS = ("run", "deployed_run")


def dashboard(
    records: list[dict[str, Any]],
    *,
    start: Any,
    days: int,
    project_names: dict[str, str],
    currency: str = "USD",
    recent_limit: int = 50,
) -> dict[str, Any]:
    """Totals for the Usage page from stored usage records (dicts with UsageRecord fields).

    `start` is the first day of the range (a date); `project_names` maps the tenant's
    current project ids to briefs, so records of deleted projects show as such."""
    from datetime import timedelta

    def bucket() -> dict[str, Any]:
        return {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "unpriced_tokens": 0}

    def add(target: dict[str, Any], r: dict[str, Any]) -> None:
        target["calls"] += r["calls"]
        target["input_tokens"] += r["input_tokens"]
        target["output_tokens"] += r["output_tokens"]
        if r["cost"] is None:
            target["unpriced_tokens"] += r["input_tokens"] + r["output_tokens"]
        else:
            target["cost"] += r["cost"]

    def project_label(project_id: str | None) -> str:
        if project_id is None:
            return "No project"
        return project_names.get(project_id, "Deleted project")

    totals = {**bucket(), "runs": 0, "estimated_tokens": 0}
    by_day = {(start + timedelta(days=i)).isoformat(): bucket() for i in range(days)}
    by_model: dict[tuple[str, str], dict[str, Any]] = {}
    by_project: dict[str | None, dict[str, Any]] = {}
    by_kind: dict[str, dict[str, Any]] = {}
    runs: dict[str, dict[str, Any]] = {}
    run_ids_by_project: dict[str | None, set[str]] = {}

    for r in records:
        add(totals, r)
        if r["estimated"]:
            totals["estimated_tokens"] += r["input_tokens"] + r["output_tokens"]
        day = r["at"].date().isoformat()
        if day in by_day:
            add(by_day[day], r)
        model = by_model.setdefault(
            (r["provider"], r["model"]),
            {**bucket(), "provider": r["provider"], "model": r["model"], "priced": True, "estimated": False},
        )
        add(model, r)
        model["priced"] = model["priced"] and r["cost"] is not None
        model["estimated"] = model["estimated"] or r["estimated"]
        project = by_project.setdefault(
            r["project_id"], {**bucket(), "project_id": r["project_id"], "name": project_label(r["project_id"]),
                              "exists": r["project_id"] in project_names, "runs": 0}
        )
        add(project, r)
        # Deployed runs invoked straight through AWS get their own row.
        kind = "deployed_run_direct" if r["kind"] == "deployed_run" and r.get("via") == "direct" else r["kind"]
        add(by_kind.setdefault(kind, {**bucket(), "kind": kind}), r)

        run_id = r.get("run_id")
        if run_id and (r["kind"] in RUN_KINDS or run_id in runs):
            run = runs.setdefault(run_id, {
                "run_id": run_id, "project_id": r["project_id"], "project": project_label(r["project_id"]),
                "deployed": False, "via": None, "at": r["at"], **bucket(), "agents": [],
            })
            run["deployed"] = run["deployed"] or r["kind"] == "deployed_run"
            run["via"] = run["via"] or r.get("via")
            run["at"] = min(run["at"], r["at"])
            add(run, r)
            run["agents"].append({k: r[k] for k in (
                "agent_id", "kind", "provider", "model", "calls", "input_tokens", "output_tokens", "cost", "estimated")})
            run_ids_by_project.setdefault(r["project_id"], set()).add(run_id)

    totals["runs"] = len(runs)
    for project_id, ids in run_ids_by_project.items():
        by_project[project_id]["runs"] = len(ids)

    def rounded(item: dict[str, Any]) -> dict[str, Any]:
        return {**item, "cost": round(item["cost"], 6)}

    recent = sorted(runs.values(), key=lambda r: r["at"], reverse=True)[:recent_limit]
    return {
        "currency": currency,
        "days": days,
        "totals": rounded(totals),
        "by_day": [{"date": d, **rounded(v)} for d, v in by_day.items()],
        "by_model": sorted((rounded(v) for v in by_model.values()), key=lambda v: (-v["cost"], -v["input_tokens"])),
        "by_project": sorted((rounded(v) for v in by_project.values()), key=lambda v: (-v["cost"], -v["input_tokens"])),
        "by_kind": sorted((rounded(v) for v in by_kind.values()), key=lambda v: -v["cost"]),
        "recent_runs": [
            {**rounded(r), "at": r["at"], "agents": [
                {**a, "cost": round(a["cost"], 6) if a["cost"] is not None else None} for a in r["agents"]
            ]}
            for r in recent
        ],
    }


def summarize(entries: list[dict[str, Any]], table: dict[str, Any] | None = None) -> dict[str, Any]:
    """Usage of one run (collector entries) with estimated cost, for the Run / Deploy pages."""
    table = table if table is not None else prices()
    priced = [{**e, "cost": cost(e, table)} for e in entries]
    return {
        "currency": table.get("currency", "USD"),
        "entries": priced,
        "input_tokens": sum(e["input_tokens"] for e in priced),
        "output_tokens": sum(e["output_tokens"] for e in priced),
        "cost": round(sum(e["cost"] for e in priced if e["cost"] is not None), 6),
        "unpriced_models": sorted({f"{e['provider']}/{e['model']}" for e in priced if e["cost"] is None}),
    }
