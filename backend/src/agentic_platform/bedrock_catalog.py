"""The Amazon Bedrock chat models this AWS account can use, for the model menus.

Read live from Bedrock (foundation models + inference profiles) in BEDROCK_REGION with
the platform's AWS credentials, keeping only models this account can actually invoke
(GetFoundationModelAvailability: agreement, authorization, entitlement and region all
available). Cached in-process, and never an error for the caller: a failed refresh
returns the last good list (or none). Bedrock models are invoked with IAM
credentials — the user's locally, a deployment's execution role in AgentCore — so there's
no per-provider API key.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

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

# Display names by the vendor prefix of a model id ("anthropic.claude-…" → "Anthropic").
_VENDORS = {
    "ai21": "AI21 Labs", "amazon": "Amazon", "anthropic": "Anthropic", "cohere": "Cohere",
    "deepseek": "DeepSeek", "google": "Google", "meta": "Meta", "minimax": "MiniMax",
    "mistral": "Mistral AI", "moonshot": "Moonshot AI", "moonshotai": "Moonshot AI",
    "nvidia": "NVIDIA", "openai": "OpenAI", "qwen": "Qwen", "writer": "Writer", "xai": "xAI",
    "zai": "Z.ai",
}
# Inference-profile prefixes → where requests may be served.
SCOPES = {
    "in": "India", "apac": "Asia Pacific", "global": "Global", "us": "US", "eu": "Europe",
    "jp": "Japan", "au": "Australia", "ca": "Canada",
}

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "models": []}


def _base_id(model_id: str) -> str:
    """`in.anthropic.claude-…` / `global.…` → `anthropic.claude-…` (the underlying model)."""
    return re.sub(r"^(global|apac|eu|us|in|jp|au|ca)\.", "", model_id)


def _scope(model_id: str) -> str | None:
    prefix = model_id.split(".", 1)[0]
    return prefix if prefix in SCOPES and model_id.count(".") >= 2 else None


def _vendor(base_id: str, fallback: str = "") -> str:
    prefix = base_id.split(".", 1)[0]
    return _VENDORS.get(prefix) or fallback or prefix.title()


def _profile_name(profile_name: str, vendor: str) -> str:
    """"Global Anthropic Claude Sonnet 4.6" → "Claude Sonnet 4.6": drop the scope word and
    the vendor, which are shown separately."""
    words = profile_name.split()
    if words and words[0].lower() in SCOPES:
        words = words[1:]
    return _strip_vendor(" ".join(words), vendor)


# Company names that prefix some model names but aren't part of them ("Mistral" and
# "MiniMax" are: "Mistral Large", "MiniMax M2").
_COMPANY_PREFIXES = ("Amazon", "Anthropic", "Meta", "NVIDIA", "OpenAI", "xAI")


def _strip_vendor(name: str, vendor: str) -> str:
    """"NVIDIA Nemotron Nano 9B v2" → "Nemotron Nano 9B v2" (the vendor is shown apart)."""
    if vendor in _COMPANY_PREFIXES and name.lower().startswith(vendor.lower() + " "):
        return name[len(vendor) + 1:]
    return name


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
    names = {fm.get("modelId", ""): fm for fm in foundation_models}
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
        entries[model_id] = {
            "model": model_id,
            "vendor": _vendor(model_id, fm.get("providerName", "")),
            "name": _strip_vendor(fm.get("modelName") or model_id, _vendor(model_id, fm.get("providerName", ""))),
        }
    for profile in profiles:
        profile_id = profile.get("inferenceProfileId", "")
        if not profile_id or _EXCLUDE.search(profile_id) or profile.get("status", "ACTIVE") != "ACTIVE":
            continue
        entries.pop(_base_id(profile_id), None)  # the profile replaces its bare model
        base = names.get(_base_id(profile_id), {})
        vendor = _vendor(_base_id(profile_id), base.get("providerName", ""))
        entries[profile_id] = {
            "model": profile_id,
            "vendor": vendor,
            "name": _strip_vendor(base["modelName"], vendor) if base.get("modelName")
            else _profile_name(profile.get("inferenceProfileName", profile_id), vendor),
        }

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
            "vendor": entry["vendor"],
            "name": entry["name"],
            "scope": _scope(entry["model"]),
            "label": f"{entry['vendor']} · {entry['name']}",
            "recommended": rank is not None,
            "default": False,
            "_rank": rank if rank is not None else 99,
        })
    out.sort(key=lambda e: (e["_rank"], e["label"].lower()))
    for e in out:
        del e["_rank"]
    return out


def is_accessible(availability: dict[str, Any]) -> bool:
    """Whether a GetFoundationModelAvailability response says this account can invoke the
    model now (a model without an accepted agreement fails at call time)."""
    return (
        availability.get("agreementAvailability", {}).get("status") == "AVAILABLE"
        and availability.get("authorizationStatus") == "AUTHORIZED"
        and availability.get("entitlementAvailability") == "AVAILABLE"
        and availability.get("regionAvailability") == "AVAILABLE"
    )


def filter_accessible(
    models: list[dict[str, Any]], check: Callable[[str], bool | None]
) -> list[dict[str, Any]]:
    """The models `check` (base model id → accessible, or None when it can't tell) doesn't
    rule out. A model whose access can't be read is kept: calling it shows the real error."""
    bases = sorted({_base_id(m["model"]) for m in models})
    with ThreadPoolExecutor(max_workers=8) as pool:
        verdicts = dict(zip(bases, pool.map(check, bases)))
    unknown = [b for b, v in verdicts.items() if v is None]
    if unknown:
        logger.warning("couldn't read Bedrock access for %d model(s); listing them anyway", len(unknown))
    return [m for m in models if verdicts[_base_id(m["model"])] is not False]


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

    def check(model_id: str) -> bool | None:
        try:
            return is_accessible(client.get_foundation_model_availability(modelId=model_id))
        except Exception:  # noqa: BLE001 — e.g. no bedrock:GetFoundationModelAvailability
            return None

    return filter_accessible(build_catalog(foundation, profiles), check)


def _refresh(session: Any, now: float) -> list[dict[str, Any]]:
    try:
        models = _fetch(session)
    except Exception as e:  # noqa: BLE001 — the menus degrade, the page doesn't fail
        logger.warning("listing Bedrock models failed: %s", e)
        with _lock:
            _cache["refreshing"] = False
            return list(_cache["models"])
    with _lock:
        _cache.update(at=now, models=models, refreshing=False)
    return list(models)


def bedrock_models(session: Any = None, now: float | None = None, wait: bool = False) -> list[dict[str, Any]]:
    """The cached catalog, refreshed every CACHE_SECONDS. Never raises. Listing and the
    per-model access checks take seconds, so once there is a list a stale one is returned
    at once and refreshed in the background (`wait=True` refreshes in line)."""
    now = now if now is not None else time.monotonic()
    with _lock:
        if _cache["models"] and now - _cache["at"] < CACHE_SECONDS:
            return list(_cache["models"])
        if _cache["models"] and not wait:
            if not _cache.get("refreshing"):
                _cache["refreshing"] = True
                threading.Thread(target=_refresh, args=(session, now), daemon=True).start()
            return list(_cache["models"])
    return _refresh(session, now)


def is_bedrock_model(model_id: str) -> bool:
    return any(m["model"] == model_id for m in bedrock_models())


def recommended_bedrock_models() -> list[dict[str, Any]]:
    return [m for m in bedrock_models() if m["recommended"]]
