"""Admins: see every user's usage and cost (never project contents), and manage roles,
with the platform always keeping at least one admin."""

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    UsageRecord,
)

SECRET_BRIEF = "Summarise the confidential merger memo"


@pytest.fixture
def api(monkeypatch):
    for name, store in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()),
                        ("_usage", InMemoryUsageStore())]:
        monkeypatch.setattr(app_module, name, store)
    plan = AgentPlan(
        agents=[AgentSpec(id="a", role="r", system_prompt="p",
                          llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
        orchestration_pattern="sequential",
    )
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    client = TestClient(app_module.app)

    def login(email):
        r = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()
        return {"Authorization": f"Bearer {r['access_token']}"}, r["user"]["id"]

    client.login = login
    return client


def _usage(tenant, project, *, tokens, cost, kind="run", run_id="r1", days_ago=0):
    return UsageRecord(
        id=f"{tenant}-{run_id}-{kind}-{tokens}", tenant_id=tenant, project_id=project,
        at=datetime.now(timezone.utc) - timedelta(days=days_ago), kind=kind, run_id=run_id,
        provider="google_genai", model="gemini-3.1-pro-preview", calls=1,
        input_tokens=tokens, output_tokens=tokens // 10, cost=cost,
    )


def _make_admin(user_id, role="master"):
    app_module._users.set_role(user_id, role, by="test")


def test_non_admins_never_see_the_admin_area(api):
    h, _ = api.login("bob@example.com")
    _, other = api.login("ada@example.com")
    for r in (
        api.get("/admin/users", headers=h),
        api.get(f"/admin/users/{other}/usage", headers=h),
        api.put(f"/admin/users/{other}/role", json={"role": "admin"}, headers=h),
    ):
        assert r.status_code == 404 and r.json()["error_type"] == "NotFound"
    assert api.get("/admin/users").status_code == 401
    assert api.get("/auth/me", headers=h).json()["role"] == "user"


def test_admin_sees_every_user_with_their_tokens_and_cost(api):
    admin_h, admin_id = api.login("arnab@example.com")
    ada_h, ada = api.login("ada@example.com")
    _, bob = api.login("bob@example.com")
    _make_admin(admin_id)
    pid = api.post("/projects", json={"brief": SECRET_BRIEF}, headers=ada_h).json()["project_id"]
    app_module._usage.add_many([
        _usage(ada, pid, tokens=1000, cost=0.25),
        _usage(ada, pid, tokens=500, cost=None, run_id="r2"),  # an unpriced model
        _usage(ada, pid, tokens=0, cost=0.0, kind="mcp_call", run_id="r2"),
        _usage(ada, pid, tokens=9999, cost=9.0, days_ago=60),  # outside the range
        _usage(bob, None, tokens=200, cost=0.05, kind="planner", run_id="p1"),
    ])
    body = api.get("/admin/users?days=30", headers=admin_h).json()
    users = {u["email"]: u for u in body["users"]}
    assert set(users) == {"arnab@example.com", "ada@example.com", "bob@example.com"}
    a = users["ada@example.com"]
    assert (a["input_tokens"], a["cost"], a["unpriced_tokens"], a["calls"], a["projects"], a["runs"]) == (
        1500, 0.25, 550, 3, 1, 2)
    assert users["bob@example.com"]["cost"] == 0.05 and users["arnab@example.com"]["calls"] == 0
    assert users["arnab@example.com"]["role"] == "master"
    assert body["totals"]["users"] == 3 and body["totals"]["active_users"] == 2
    assert body["totals"]["cost"] == pytest.approx(0.30)

    # Usage only: no brief, plan, run contents or password hashes anywhere.
    detail = api.get(f"/admin/users/{ada}/usage?days=30", headers=admin_h)
    for text in (json.dumps(body, default=str), detail.text):
        assert SECRET_BRIEF[:20] not in text and "argon2" not in text and "system_prompt" not in text

    # The drill-down is exactly what the user sees on their own Usage page.
    own = api.get("/usage?days=30", headers=ada_h).json()
    d = detail.json()
    assert d["user"]["email"] == "ada@example.com"
    for key in ("totals", "by_model", "by_kind"):
        assert d[key] == own[key]
    assert api.get("/admin/users/nobody/usage", headers=admin_h).status_code == 404


def test_admin_user_page_filters_by_the_users_own_projects(api):
    admin_h, admin_id = api.login("arnab@example.com")
    ada_h, ada = api.login("ada@example.com")
    bob_h, _ = api.login("bob@example.com")
    _make_admin(admin_id)
    unnamed = api.post("/projects", json={"brief": SECRET_BRIEF}, headers=ada_h).json()["project_id"]
    named = api.post("/projects", json={"brief": SECRET_BRIEF, "name": "Invoices"},
                     headers=ada_h).json()["project_id"]
    bobs = api.post("/projects", json={"brief": "x"}, headers=bob_h).json()["project_id"]
    app_module._usage.add_many([
        _usage(ada, unnamed, tokens=1000, cost=0.25),
        _usage(ada, named, tokens=300, cost=0.10, run_id="r2"),
    ])

    whole = api.get(f"/admin/users/{ada}/usage", headers=admin_h)
    body = whole.json()
    assert body["user"]["projects"] == 2 and "created_at" in body["user"]
    me = api.get(f"/admin/users/{admin_id}/usage", headers=admin_h).json()["user"]
    assert me["role"] == "master"
    assert {p["name"] for p in body["projects"]} == {"Invoices", f"Untitled project · {unnamed[:6]}"}
    assert len(body["recent_runs"]) == 2 and len(body["by_day"]) == 30
    assert SECRET_BRIEF[:20] not in whole.text and "password" not in whole.text

    one = api.get(f"/admin/users/{ada}/usage?project_id={named}", headers=admin_h).json()
    assert one["totals"]["input_tokens"] == 300 and one["totals"]["cost"] == pytest.approx(0.10)
    assert one["totals"] == api.get(f"/usage?project_id={named}", headers=ada_h).json()["totals"]
    # Another user's project, or an unknown one, is not this user's: 404.
    for pid in (bobs, "nope"):
        assert api.get(f"/admin/users/{ada}/usage?project_id={pid}", headers=admin_h).status_code == 404


def test_only_the_master_adds_and_removes_admins(api):
    master_h, master = api.login("arnab@example.com")
    ada_h, ada = api.login("ada@example.com")
    bob_h, bob = api.login("bob@example.com")
    _make_admin(master)

    # The master's own role is locked; the API can't make anyone master.
    r = api.put(f"/admin/users/{master}/role", json={"role": "user"}, headers=master_h)
    assert r.status_code == 409 and r.json()["error_type"] == "MasterAdmin"
    assert api.put(f"/admin/users/{ada}/role", json={"role": "master"}, headers=master_h).status_code == 422

    for uid in (ada, bob):
        r = api.put(f"/admin/users/{uid}/role", json={"role": "admin"}, headers=master_h)
        assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
    assert app_module._users.get(ada).role_changed_by == master
    # A promotion applies on the very next request; no new token needed.
    assert api.get("/admin/users", headers=ada_h).status_code == 200
    assert api.get(f"/admin/users/{bob}/usage", headers=ada_h).status_code == 200

    # Admins can't remove one another, promote anyone, demote themselves or touch the master.
    for target, role in ((bob, "user"), (ada, "user"), (master, "user")):
        r = api.put(f"/admin/users/{target}/role", json={"role": role}, headers=ada_h)
        assert r.status_code == 403 and r.json()["error_type"] == "MasterAdminRequired"
    assert app_module._users.get(bob).role == "admin"

    # The master removes an admin, and it takes effect at once.
    assert api.put(f"/admin/users/{ada}/role", json={"role": "user"}, headers=master_h).status_code == 200
    assert api.get("/admin/users", headers=ada_h).status_code == 404
    assert api.put(f"/admin/users/{ada}/role", json={"role": "owner"}, headers=master_h).status_code == 422
    assert api.put("/admin/users/nobody/role", json={"role": "admin"}, headers=master_h).status_code == 404


def test_the_set_role_script_promotes_through_the_store(monkeypatch, capsys):
    import importlib.util
    import pathlib

    import agentic_platform.stores as stores

    users = InMemoryUserStore()
    from agentic_platform.stores import UserRecord

    users.create(UserRecord(id="u1", email="arnab@example.com", password_hash="$argon2id$x"))
    users.create(UserRecord(id="u2", email="ada@example.com", password_hash="$argon2id$x"))
    path = pathlib.Path(__file__).parents[1] / "scripts" / "set_role.py"
    spec = importlib.util.spec_from_file_location("set_role", path)
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    monkeypatch.setattr(script, "MONGODB_URI", "mongodb://test")
    monkeypatch.setattr(script, "make_stores", lambda: (None, users, None, None))

    def run(email, role):
        monkeypatch.setattr("sys.argv", ["set_role.py", email, role])
        return script.main()

    assert run("Arnab@Example.com", "master") == 0 and users.get("u1").role == "master"
    assert run("arnab@example.com", "user") == 1 and users.get("u1").role == "master"  # never masterless
    assert run("ada@example.com", "admin") == 0 and users.get("u2").role == "admin"
    # Moving the master role makes the previous master an admin.
    assert run("ada@example.com", "master") == 0
    assert (users.get("u2").role, users.get("u1").role) == ("master", "admin")
    assert run("ghost@example.com", "admin") == 1
    assert "No account for ghost@example.com" in capsys.readouterr().out
    assert stores  # imported for clarity: the script uses the store interface, not a driver
