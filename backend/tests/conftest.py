"""Suite-wide fixtures. The suite is offline: nothing here may reach a real cloud service."""

import os

# Before anything imports the app: .env points at the developer's REAL MongoDB, and the app builds
# its stores from it when imported (and runs the teams backfill on them). The suite must never touch
# it, so it gets no URI (in-memory stores) and a throwaway database name should one ever be used.
# The Mongo contract tests choose their own throwaway database and server explicitly.
os.environ["MONGODB_URI"] = ""
os.environ["MONGODB_DB"] = "agentic_platform_pytest_never_real"

import pytest

import agentic_platform.bedrock_catalog as bedrock_catalog
from agentic_platform import config as _config

assert _config.MONGODB_URI is None, "the offline suite must not be configured with a real database"


@pytest.fixture(autouse=True)
def _no_live_bedrock_catalog(monkeypatch):
    """The Bedrock model catalog is read live from AWS; with real credentials in .env that
    would make every /providers call a network call. Tests get an empty catalog unless
    they install their own."""
    monkeypatch.setattr(bedrock_catalog, "_fetch", lambda session=None: [])
    bedrock_catalog._cache.update(at=0.0, models=[])
    yield
    bedrock_catalog._cache.update(at=0.0, models=[])


@pytest.fixture(autouse=True)
def _no_live_bigquery(monkeypatch):
    """BigQuery is reached by federating the platform's AWS identity, and .env holds real
    settings: a test that forgot to install a fake client must fail, not call Google."""
    import agentic_platform.app as app_module
    import agentic_platform.datasources as datasources

    def offline(*args, **kwargs):
        raise RuntimeError("the offline suite must not sign in to Google; install a fake BigQuery client")

    monkeypatch.setattr(datasources, "gcp_credentials", offline)
    app_module._BQ_CLIENTS.clear()
    yield
    app_module._BQ_CLIENTS.clear()


@pytest.fixture(autouse=True)
def _runs_in_memory(monkeypatch):
    """Saved runs never reach a real database from the offline suite (.env may point at
    one): every test gets its own in-memory run store."""
    import agentic_platform.app as app_module
    from agentic_platform.stores import InMemoryRunStore

    monkeypatch.setattr(app_module, "_runs", InMemoryRunStore())


@pytest.fixture(autouse=True)
def _fresh_rbac_stores(monkeypatch):
    """Teams, grants, model limits, budgets, the ledger and the audit log are module-level stores
    in the app: every test starts with empty in-memory ones, so nothing leaks between tests (or
    anywhere else)."""
    import agentic_platform.app as app_module
    import agentic_platform.stores as st

    for name, cls in [("_teams", st.InMemoryTeamStore), ("_audit", st.InMemoryAuditStore),
                      ("_grants", st.InMemoryAgentGrantStore), ("_models", st.InMemoryModelPolicyStore),
                      ("_budgets", st.InMemoryBudgetStore), ("_ledger", st.InMemoryLedgerStore)]:
        monkeypatch.setattr(app_module, name, cls())


@pytest.fixture(autouse=True)
def _no_live_model_checks(monkeypatch):
    """Tool-calling checks call the real model and are stored platform-wide: the offline
    suite gets an in-memory store and a check that can't tell (tests that need a verdict
    install their own)."""
    import agentic_platform.app as app_module
    import agentic_platform.capabilities as caps
    from agentic_platform.stores import InMemoryModelCapabilityStore

    monkeypatch.setattr(app_module, "_capabilities", InMemoryModelCapabilityStore())
    monkeypatch.setattr(caps, "probe_tool_calling", lambda provider, model, usage=None: None)


# ---------------------------------------------------------------------------- MCP test server
MCP_KEY = "k3yInTheUrl0123456789abcdef"
MCP_HEADER_KEY = "header-secret-value"
MCP_TOKEN = "tok_0123456789abcdefSECRET"


def _mcp_test_app():
    """One real MCP server (the SDK's own), reachable four ways, one per auth pattern:
    /open/mcp (no auth), /hdr/mcp (X-API-Key header), /key/<key>/mcp (key in the URL) and
    /oauth/mcp (always asks for OAuth); /tok/mcp takes an access token
    (Authorization: Bearer)."""
    from mcp.server.mcpserver import MCPServer
    from mcp_types import ToolAnnotations

    server = MCPServer("test-tools")

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def add(a: int, b: int) -> int:
        """Add two whole numbers."""
        return a + b

    @server.tool()
    def create_note(text: str) -> str:
        """Create a note (changes data)."""
        return f"created: {text}"

    @server.tool()
    def boom() -> str:
        """Always fails."""
        raise ValueError("kaboom")

    @server.tool()
    def needs_signin() -> str:
        """Answers with a sign-in link, like a per-user OAuth server."""
        return "Please authorize access first: https://accounts.example.com/oauth/authorize?client=x"

    @server.tool()
    def big() -> str:
        """Returns a very long text."""
        return "x" * 50_000

    inner = server.streamable_http_app()

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            return await inner(scope, receive, send)
        if scope["type"] != "http":
            return await inner(scope, receive, send)
        path = scope["path"]
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        allowed = (
            path.startswith("/open/")
            or (path.startswith("/hdr/") and headers.get("x-api-key") == MCP_HEADER_KEY)
            or (path.startswith("/tok/") and headers.get("authorization") == f"Bearer {MCP_TOKEN}")
            or path.startswith(f"/key/{MCP_KEY}/")
        )
        if not allowed:
            challenge = (
                b'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"'
                if path.startswith("/oauth/") else b"Bearer"
            )
            await send({
                "type": "http.response.start", "status": 401,
                "headers": [(b"www-authenticate", challenge), (b"content-type", b"application/json")],
            })
            return await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
        return await inner(dict(scope, path="/mcp", raw_path=b"/mcp"), receive, send)

    return app


@pytest.fixture(scope="session")
def mcp_server():
    """A local MCP server for the whole session; yields its base URL (http://127.0.0.1:port)."""
    import socket
    import threading
    import time

    import uvicorn

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(_mcp_test_app(), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture
def mcp_local(monkeypatch):
    """Allow plain http to this machine (the test server), as MCP_ALLOW_INSECURE_LOCAL does."""
    import agentic_platform.mcp_client as mc

    monkeypatch.setattr(mc, "MCP_ALLOW_INSECURE_LOCAL", True)
