"""Central config: env loading and per-provider settings.

Loading .env here (once, at import) means every module gets the same environment
without each one calling load_dotenv. Provider metadata lives here so the LLM factory
stays a thin dispatch over data, not a pile of hardcoded strings.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

# Project persistence. With MONGODB_URI unset the platform falls back to an in-process
# store (nothing survives a restart) — fine for tests and a first run, not for real use.
MONGODB_URI: str | None = os.environ.get("MONGODB_URI") or None
MONGODB_DB: str = os.environ.get("MONGODB_DB") or "agentic_platform"
# Bounded so an unreachable database fails a request quickly instead of hanging it.
MONGODB_TIMEOUT_MS = 3000

# Signs access tokens (HS256). Unset means a random per-process secret: still secure, but
# every restart signs everyone out — set it for anything longer-lived than a test run.
JWT_SECRET: str | None = os.environ.get("JWT_SECRET") or None
JWT_EXPIRES_MINUTES = int(os.environ.get("JWT_EXPIRES_MINUTES") or 60)

# Deployment to Amazon Bedrock AgentCore Runtime. AWS credentials come from the standard
# boto3 chain (`aws configure`, SSO, env vars); without them the deploy option is off.
AGENTCORE_REGION: str = os.environ.get("AGENTCORE_REGION") or "ap-south-1"
# Optional: use an existing execution role / code bucket instead of the platform's own.
AGENTCORE_EXECUTION_ROLE_ARN: str | None = os.environ.get("AGENTCORE_EXECUTION_ROLE_ARN") or None
AGENTCORE_CODE_BUCKET: str | None = os.environ.get("AGENTCORE_CODE_BUCKET") or None

# Hard ceiling on team size, whether the user picks the count or the planner does.
MAX_AGENTS = 10

# Provider used by default when a brief doesn't name one.
DEFAULT_PROVIDER = "google_genai"

# Default model per provider, used by the meta-planner when a brief doesn't name one.
DEFAULT_MODELS: dict[str, str] = {
    "moonshot": "kimi-k3",
    "openai": "gpt-4o-mini",
    "anthropic": "claude-sonnet-4-6",
    "google_genai": "gemini-3.1-pro-preview",
    # llama-3.3-70b-versatile became Enterprise-only on Groq (no access for standard keys).
    "groq": "openai/gpt-oss-120b",
    "ollama": "llama3.1",
}

# Env var(s) that may hold the API key for each provider, tried in order. The first
# non-empty one wins. google_genai accepts GEMINI_API_KEY as well as the SDK's native
# GOOGLE_API_KEY, since users commonly have the key under either name.
PROVIDER_ENV_VARS: dict[str, tuple[str, ...]] = {
    "moonshot": ("MOONSHOT_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "google_genai": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "groq": ("GROQ_API_KEY",),
    # ollama runs locally and needs no key.
}

MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1"

# Embedding model per provider, for project knowledge bases. Only these providers offer
# one; a project on another provider uses the first of these whose key is configured.
# Every embedding model a knowledge library can use, with the vector size it's asked for.
# A library uses one model at a time (changing it re-embeds every passage), so vectors of
# different sizes are never compared. Bedrock models need no API key: IAM credentials.
EMBEDDING_OPTIONS: list[dict[str, object]] = [
    {"provider": "google_genai", "model": "gemini-embedding-001", "dimensions": 768},
    {"provider": "openai", "model": "text-embedding-3-small", "dimensions": 768},
    {"provider": "bedrock", "model": "amazon.titan-embed-text-v2:0", "dimensions": 1024},
    {"provider": "bedrock", "model": "global.cohere.embed-v4:0", "dimensions": 1024},
]
# The default embedding model per provider (its first option).
EMBEDDING_MODELS: dict[str, str] = {}
for _option in EMBEDDING_OPTIONS:
    EMBEDDING_MODELS.setdefault(str(_option["provider"]), str(_option["model"]))


def embedding_option(provider: str, model: str) -> dict[str, object] | None:
    return next((o for o in EMBEDDING_OPTIONS if o["provider"] == provider and o["model"] == model), None)


# Region for Amazon Bedrock model calls (chat and embeddings).
BEDROCK_REGION: str = os.environ.get("BEDROCK_REGION") or os.environ.get("AGENTCORE_REGION") or "ap-south-1"
