"""The Amazon Bedrock chat models this AWS account can use, for the model menus.

Read live from Bedrock (foundation models + inference profiles) in BEDROCK_REGION with
the platform's AWS credentials, cached in-process, and never an error for the caller: a
failed refresh returns the last good list (or none). Bedrock models are invoked with IAM
credentials — the user's locally, a deployment's execution role in AgentCore — so there's
no per-provider API key.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any

from .config import BEDROCK_REGION

logger = logging.getLogger(__name__)

CACHE_SECONDS = 600

# Not chat models (or not for agents): embeddings, images, speech, safety classifiers.
_EXCLUDE = re.compile(r"embed|image|canvas|reel|voxtral|safeguard|guard|rerank|pegasus|marengo|stable-|sd3", re.I)

# Shown first, in this order, when the account has them (matched against model ids).
_RECOMMENDED = [
    r"anthropic\.claude-sonnet-4-6",
    r"anthropic\.claude-haiku-4-5",
    r"amazon\.nova-pro",
    r"amazon\.nova-lite",
    r"openai\.gpt-oss-120b",
    r"moonshotai\.kimi-k2\.5",
]

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "models": []}


def _base_id(model_id: str) -> str:
    """`in.anthropic.claude-…` / `global.…` → `anthropic.claude-…` (the underlying model)."""
    return re.sub(r"^(global|apac|eu|us|in|jp|au|ca)\.", "", model_id)


def _rank(model_id: str) -> int | None:
    for i, pattern in enumerate(_RECOMMENDED):
        if re.search(pattern, model_id):
            return i
    return None


def build_catalog(foundation_models: list[dict[str, Any]], profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Chat-capable entries from Bedrock's listings: inference profiles preferred over the
    bare model they route to (some models — Claude — can only be invoked through one),
    recommended models first, then by label."""
    entries: dict[str, dict[str, Any]] = {}
    for fm in foundation_models:
        model_id = fm.get("modelId", "")
        if (
            not model_id
            or _EXCLUDE.search(model_id)
            or "TEXT" not in fm.get("outputModalities", ["TEXT"])
            or "ON_DEMAND" not in fm.get("inferenceTypesSupported", [])
            or fm.get("modelLifecycle", {}).get("status", "ACTIVE") != "ACTIVE"
        ):
            continue
        entries[model_id] = {"model": model_id, "label": f"{fm.get('providerName', '')} · {fm.get('modelName', model_id)}".strip(" ·")}
    for profile in profiles:
        profile_id = profile.get("inferenceProfileId", "")
        if not profile_id or _EXCLUDE.search(profile_id) or profile.get("status", "ACTIVE") != "ACTIVE":
            continue
        entries.pop(_base_id(profile_id), None)  # the profile replaces its bare model
        scope = profile_id.split(".", 1)[0]
        entries[profile_id] = {"model": profile_id, "label": f"{profile.get('inferenceProfileName', profile_id)} ({scope})"}

    # Keep one profile per underlying model: prefer in-country, then regional, then global.
    preference = {"in": 0, "apac": 1, "global": 2}
    by_base: dict[str, dict[str, Any]] = {}
    for entry in entries.values():
        base = _base_id(entry["model"])
        scope = entry["model"].split(".", 1)[0]
        current = by_base.get(base)
        if current is None or preference.get(scope, 3) < preference.get(current["model"].split(".", 1)[0], 3):
            by_base[base] = entry

    out = []
    for entry in by_base.values():
        rank = _rank(entry["model"])
        out.append({
            "provider": "bedrock",
            "model": entry["model"],
            "label": entry["label"],
            "recommended": rank is not None,
            "default": False,
            "_rank": rank if rank is not None else 99,
        })
    out.sort(key=lambda e: (e["_rank"], e["label"].lower()))
    for e in out:
        del e["_rank"]
    return out


def _fetch(session: Any = None) -> list[dict[str, Any]]:
    import boto3

    session = session or boto3.Session(region_name=BEDROCK_REGION)
    if session.get_credentials() is None:
        return []
    client = session.client("bedrock", region_name=BEDROCK_REGION)
    foundation = client.list_foundation_models(byOutputModality="TEXT").get("modelSummaries", [])
    profiles: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"maxResults": 100}
    while True:
        page = client.list_inference_profiles(**kwargs)
        profiles.extend(page.get("inferenceProfileSummaries", []))
        if not page.get("nextToken"):
            break
        kwargs["nextToken"] = page["nextToken"]
    return build_catalog(foundation, profiles)


def bedrock_models(session: Any = None, now: float | None = None) -> list[dict[str, Any]]:
    """The cached catalog, refreshed every CACHE_SECONDS. Never raises."""
    now = now if now is not None else time.monotonic()
    with _lock:
        if _cache["models"] and now - _cache["at"] < CACHE_SECONDS:
            return list(_cache["models"])
    try:
        models = _fetch(session)
    except Exception as e:  # noqa: BLE001 — the menus degrade, the page doesn't fail
        logger.warning("listing Bedrock models failed: %s", e)
        with _lock:
            return list(_cache["models"])
    with _lock:
        _cache.update(at=now, models=models)
    return list(models)


def is_bedrock_model(model_id: str) -> bool:
    return any(m["model"] == model_id for m in bedrock_models())


def recommended_bedrock_models() -> list[dict[str, Any]]:
    return [m for m in bedrock_models() if m["recommended"]]
