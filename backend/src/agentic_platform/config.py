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
    "groq": "llama-3.3-70b-versatile",
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
