# Platform API (FastAPI). The source stays in its src/ layout under /app, next to
# pyproject.toml, uv.lock and pricing.json: deploy.py runs `uv export` / `uv pip install`
# from the backend directory to package AgentCore runtimes, and usage.py reads
# pricing.json from it, so `uv` ships in the runtime image too.
FROM ghcr.io/astral-sh/uv:0.12.1 AS uv

FROM python:3.11-slim-bookworm

COPY --from=uv /uv /uvx /usr/local/bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_CACHE_DIR=/app/.deploy-cache/uv-cache \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_CACHE_DIR=/root/.cache/uv uv sync --frozen --no-dev --no-install-project

COPY pricing.json ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    UV_CACHE_DIR=/root/.cache/uv uv sync --frozen --no-dev

RUN useradd --system --uid 10001 --home-dir /app app \
    && mkdir -p /app/.deploy-cache \
    && chown -R app:app /app/.deploy-cache
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"

# One worker: runs, deploys, knowledge indexing and usage sync are in-process
# background jobs until the job queue exists (see CLAUDE.md decision log).
# --root-path /api because Caddy serves the API under /api and strips the prefix.
CMD ["uvicorn", "agentic_platform.app:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--root-path", "/api", "--proxy-headers", "--forwarded-allow-ips", "*", \
     "--timeout-graceful-shutdown", "30"]
