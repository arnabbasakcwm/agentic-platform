from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
import agentic_platform.auth as auth
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.errors import AuthenticationError
from agentic_platform.stores import InMemoryProjectStore, InMemoryUserStore

PASSWORD = "correct horse battery"


def _plan():
    return AgentPlan(
        agents=[
            AgentSpec(
                id="a",
                role="worker",
                system_prompt="do it",
                llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"),
            )
        ],
        orchestration_pattern="sequential",
    )


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: _plan())
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    app_module._COMPILED.clear()
    return TestClient(app_module.app)


def _register(client, email="ada@example.com", password=PASSWORD):
    return client.post("/auth/register", json={"email": email, "password": password})


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------------ password hashing
def test_password_hash_verifies_and_is_not_the_password():
    hashed = auth.hash_password(PASSWORD)
    assert PASSWORD not in hashed
    assert hashed.startswith("$argon2id$")
    assert auth.verify_password(PASSWORD, hashed) is True
    assert auth.verify_password("wrong password", hashed) is False


def test_same_password_hashes_differently_each_time():
    assert auth.hash_password(PASSWORD) != auth.hash_password(PASSWORD)


def test_verify_against_no_user_or_a_corrupt_hash_is_false():
    assert auth.verify_password(PASSWORD, None) is False
    assert auth.verify_password(PASSWORD, "not-a-hash") is False


# ------------------------------------------------------------------ tokens
def test_token_round_trips_the_user_id():
    assert auth.decode_access_token(auth.create_access_token("user-1")) == "user-1"


def test_expired_token_is_rejected():
    long_ago = datetime.now(timezone.utc) - timedelta(days=2)
    token = auth.create_access_token("user-1", now=long_ago)
    with pytest.raises(AuthenticationError, match="expired"):
        auth.decode_access_token(token)


def test_token_signed_with_another_secret_is_rejected():
    claims = {"sub": "user-1", "exp": datetime.now(timezone.utc) + timedelta(hours=1)}
    forged = jwt.encode(claims, "x" * 40, algorithm="HS256")
    with pytest.raises(AuthenticationError):
        auth.decode_access_token(forged)


def test_unsigned_token_is_rejected():
    # The classic alg=none downgrade: a token that claims it needs no signature.
    claims = {"sub": "user-1", "exp": datetime.now(timezone.utc) + timedelta(hours=1)}
    unsigned = jwt.encode(claims, None, algorithm="none")
    with pytest.raises(AuthenticationError):
        auth.decode_access_token(unsigned)


def test_token_without_expiry_is_rejected():
    no_exp = jwt.encode({"sub": "user-1"}, auth._SECRET, algorithm="HS256")
    with pytest.raises(AuthenticationError):
        auth.decode_access_token(no_exp)


def test_garbage_token_is_rejected():
    with pytest.raises(AuthenticationError):
        auth.decode_access_token("not.a.jwt")


# ------------------------------------------------------------------ register
def test_register_returns_a_working_session(client):
    r = _register(client)
    assert r.status_code == 201
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] > 0
    assert body["user"]["email"] == "ada@example.com"

    me = client.get("/auth/me", headers=_bearer(body["access_token"]))
    assert me.status_code == 200
    assert me.json()["id"] == body["user"]["id"]


def test_responses_never_contain_the_password_or_its_hash(client):
    r = _register(client)
    me = client.get("/auth/me", headers=_bearer(r.json()["access_token"]))
    for text in (r.text, me.text):
        assert PASSWORD not in text
        assert "argon2" not in text
        assert "password" not in text


def test_duplicate_email_is_409_even_with_different_case(client):
    assert _register(client, "ada@example.com").status_code == 201
    r = _register(client, "ADA@Example.com")
    assert r.status_code == 409
    assert r.json()["error_type"] == "EmailTaken"


def test_short_password_is_rejected_without_echoing_it(client):
    r = _register(client, password="short1")
    assert r.status_code == 422
    body = r.json()
    assert body["error_type"] == "ValidationError"
    assert body["message"].startswith("password:")
    assert "short1" not in r.text


def test_malformed_email_is_rejected(client):
    r = _register(client, email="not-an-email")
    assert r.status_code == 422
    assert r.json()["message"].startswith("email:")


# ------------------------------------------------------------------ login
def test_login_with_correct_password(client):
    _register(client)
    r = client.post("/auth/login", json={"email": "Ada@Example.com", "password": PASSWORD})
    assert r.status_code == 200
    token = r.json()["access_token"]
    assert client.get("/auth/me", headers=_bearer(token)).status_code == 200


def test_wrong_password_and_unknown_email_are_indistinguishable(client):
    _register(client)
    wrong = client.post(
        "/auth/login", json={"email": "ada@example.com", "password": "wrong password"}
    )
    unknown = client.post(
        "/auth/login", json={"email": "nobody@example.com", "password": PASSWORD}
    )
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    assert wrong.json()["error_type"] == "Unauthenticated"


# ------------------------------------------------------------------ protected routes
@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/auth/me"),
        ("post", "/projects"),
        ("get", "/projects"),
        ("get", "/projects/x"),
        ("patch", "/projects/x/plan"),
        ("post", "/projects/x/compile"),
        ("post", "/projects/x/revise"),
        ("post", "/projects/x/run"),
        ("post", "/projects/x/agents/a/invoke"),
    ],
)
def test_protected_routes_reject_a_missing_token(client, method, path):
    r = getattr(client, method)(path)
    assert r.status_code == 401
    assert r.json()["error_type"] == "Unauthenticated"
    assert r.headers["www-authenticate"] == "Bearer"


def test_invalid_token_is_401(client):
    r = client.get("/auth/me", headers=_bearer("not.a.jwt"))
    assert r.status_code == 401


def test_token_for_a_deleted_user_is_401(client, monkeypatch):
    token = _register(client).json()["access_token"]
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())  # account is gone
    assert client.get("/auth/me", headers=_bearer(token)).status_code == 401


def test_public_routes_need_no_token(client):
    assert client.get("/health").status_code == 200
    assert client.get("/tools").status_code == 200
    assert client.get("/providers").status_code == 200


# ------------------------------------------------------------------ ownership
def test_users_cannot_see_or_touch_each_others_projects(client):
    ada = _bearer(_register(client, "ada@example.com").json()["access_token"])
    bob = _bearer(_register(client, "bob@example.com").json()["access_token"])

    created = client.post("/projects", json={"brief": "x", "agent_count": 1}, headers=ada)
    assert created.status_code == 201
    pid = created.json()["project_id"]
    assert client.get(f"/projects/{pid}", headers=ada).status_code == 200

    attempts = [
        client.get(f"/projects/{pid}", headers=bob),
        client.patch(f"/projects/{pid}/plan", json=_plan().model_dump(), headers=bob),
        client.post(f"/projects/{pid}/compile", headers=bob),
        client.post(f"/projects/{pid}/revise", json={"message": "x"}, headers=bob),
        client.post(f"/projects/{pid}/run", json={"input": {}}, headers=bob),
        client.post(f"/projects/{pid}/agents/a/invoke", json={"input": {}}, headers=bob),
    ]
    for r in attempts:
        # 404, not 403: another user's project looks exactly like one that doesn't exist.
        assert r.status_code == 404
        assert r.json()["error_type"] == "ProjectNotFound"

    # Each user's list holds only their own projects.
    assert [p["project_id"] for p in client.get("/projects", headers=ada).json()["projects"]] == [pid]
    assert client.get("/projects", headers=bob).json()["projects"] == []

    # Bob's attempts changed nothing for Ada.
    assert client.get(f"/projects/{pid}", headers=ada).json()["compiled"] is False
