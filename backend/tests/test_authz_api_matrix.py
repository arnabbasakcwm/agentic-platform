"""The authorization matrix at the API: every role x every sensitive action, allowed or denied, with
out-of-scope access answering 404 and never revealing that the thing exists (P7.1).

Roles:  super (master) | sub (admin, no pool) | ga (group admin of A, plain member of B) | ma (member of A)
        | mb (member of B) | out (in no team).
Fixtures: team A and B; a project `shared` owned by someone else, in team A and shared with the team; a
`private` project in team A that is owner-only; a `personal` project; budgets org > team A.

Users are created straight in the store and signed in with minted tokens, so the whole matrix is fast.
"""

import uuid

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.auth import create_access_token
from agentic_platform.stores import (
    BudgetNode,
    InMemoryProjectStore,
    InMemoryUserStore,
    ProjectRecord,
    TeamMembership,
    TeamRecord,
    UserRecord,
)

ROLES = ["super", "sub", "ga", "ma", "mb", "out"]
OFFERED = ["openai/gpt-x", "groq/llama"]
USD = 1_000_000


def _plan():
    return AgentPlan(
        agents=[AgentSpec(id="a", role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model="m"))],
        orchestration_pattern="sequential",
    )


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(app_module, "_store", InMemoryProjectStore())
    monkeypatch.setattr(app_module, "_users", InMemoryUserStore())
    monkeypatch.setattr(app_module, "_offered_models", lambda: list(OFFERED))
    monkeypatch.setattr(app_module, "_offered_cached", lambda: list(OFFERED))
    for t in ("A", "B"):
        app_module._teams.create_team(TeamRecord(id=t, name=f"Team {t}"))

    class W:
        ids, headers = {}, {}

    def user(name, role="user", teams=()):
        u = UserRecord(id=f"id-{name}", email=f"{name}@example.com", password_hash="x", role=role)
        app_module._users.create(u)
        for team, team_role in teams:
            app_module._teams.set_member(TeamMembership(team_id=team, user_id=u.id, role=team_role))
        W.ids[name] = u.id
        W.headers[name] = {"Authorization": f"Bearer {create_access_token(u.id)}"}

    user("super", "master")
    user("sub", "admin")
    user("ga", teams=[("A", "group_admin"), ("B", "member")])
    user("ma", teams=[("A", "member")])
    user("mb", teams=[("B", "member")])
    user("out")
    user("owner", teams=[("A", "member")])

    def project(name, team=None, access=False):
        p = ProjectRecord(id=f"p-{name}", tenant_id=W.ids["owner"], brief=f"{name} brief", plan=_plan(), team_id=team, team_access=access)
        app_module._store.create(p)
        W.ids[f"project-{name}"] = p.id

    project("shared", "A", True)
    project("private", "A", False)
    project("personal")
    for nid, scope, sid, parent, amount in [("org", "org", "org", None, 1000 * USD), ("team:A", "team", "A", "org", 400 * USD)]:
        app_module._budgets.create(BudgetNode(id=nid, scope_type=scope, scope_id=sid, parent_id=parent, amount=amount))
    W.client = TestClient(app_module.app)
    return W


def call(w, role, method, path, body=None):
    headers = w.headers[role]
    return w.client.request(method, path, headers=headers, **({"json": body} if body is not None else {}))


# (name, method, path or callable(world), body or callable(world), roles that are ALLOWED)
def p(name):
    return lambda w: f"/projects/{w.ids['project-' + name]}"


ACTIONS = [
    # ---- teams
    ("create a team", "POST", "/teams", {"name": "New"}, {"super"}),
    ("rename team A", "PATCH", "/teams/A", {"name": "A2"}, {"super", "ga"}),
    ("rename team B", "PATCH", "/teams/B", {"name": "B2"}, {"super"}),
    ("delete team B", "DELETE", "/teams/B", None, {"super"}),
    ("list the members of A", "GET", "/teams/A/members", None, {"super", "ga"}),
    ("list the members of B", "GET", "/teams/B/members", None, {"super"}),
    ("add someone to A", "PUT", lambda w: f"/teams/A/members/{w.ids['out']}", None, {"super"}),
    ("remove a member from A", "DELETE", lambda w: f"/teams/A/members/{w.ids['ma']}", None, {"super", "ga"}),
    ("make a member of A group admin", "PUT", lambda w: f"/teams/A/admins/{w.ids['ma']}", None, {"super", "ga"}),
    ("make a member of B group admin", "PUT", lambda w: f"/teams/B/admins/{w.ids['mb']}", None, {"super"}),
    ("read team A's usage", "GET", "/teams/A/usage", None, {"super", "ga"}),
    # ---- roles and the admin area
    ("read the admin user list", "GET", "/admin/users", None, {"super", "sub"}),
    ("make someone a Sub Admin", "PUT", lambda w: f"/admin/users/{w.ids['ma']}/role", {"role": "admin"}, {"super"}),
    # ---- audit
    ("read the audit log org-wide", "GET", "/audit", None, {"super", "sub", "ga"}),  # ga: only their teams' entries
    ("read team A's audit entries", "GET", "/audit?team_id=A", None, {"super", "sub", "ga"}),
    ("read team B's audit entries", "GET", "/audit?team_id=B", None, {"super", "sub"}),
    # ---- model privileges
    ("set the organisation's models", "PUT", "/admin/models/org", {"catalog": ["openai/*"]}, {"super"}),
    ("set team A's models", "PUT", "/teams/A/models", {"models": ["openai/gpt-x"]}, {"super"}),
    ("limit a member of A", "PUT", lambda w: f"/teams/A/members/{w.ids['ma']}/models", {"models": ["openai/gpt-x"]}, {"super", "ga"}),
    ("limit a member of B", "PUT", lambda w: f"/teams/B/members/{w.ids['mb']}/models", {"models": ["openai/gpt-x"]}, {"super"}),
    ("limit a user everywhere", "PUT", lambda w: f"/users/{w.ids['ma']}/models", {"models": ["openai/gpt-x"]}, {"super"}),
    # ---- budgets
    ("set the org budget", "PUT", "/budgets/org/org", {"amount": 2000 * USD}, {"super"}),
    ("allocate a team budget from the org", "PUT", "/budgets/team/B", {"amount": 10 * USD, "parent": "org"}, {"super"}),
    ("split team A's budget to a member", "PUT", lambda w: f"/budgets/user/{w.ids['ma']}", {"amount": 10 * USD, "parent": "team:A"}, {"super", "ga"}),
    ("split team A's budget to someone outside it", "PUT", lambda w: f"/budgets/user/{w.ids['mb']}", {"amount": 10 * USD, "parent": "team:A"}, {"super"}),
    # ---- projects
    ("read a team-shared project", "GET", p("shared"), None, {"super", "ga", "ma"}),
    ("read an owner-only project of team A", "GET", p("private"), None, {"super"}),
    ("read a personal project", "GET", p("personal"), None, {"super"}),
    ("rename a team-shared project", "PATCH", p("shared"), {"name": "renamed"}, {"super", "ga"}),
    ("delete a team-shared project", "DELETE", p("shared"), None, {"super", "ga"}),
    ("list who a team-shared project is shared with", "GET", lambda w: f"/projects/{w.ids['project-shared']}/grants", None, {"super", "ga"}),
    ("share a team-shared project with team A", "PUT", lambda w: f"/projects/{w.ids['project-shared']}/grants",
     {"grantee_type": "team", "grantee_id": "A", "level": "use"}, {"super", "ga"}),
    ("share an owner-only project", "PUT", lambda w: f"/projects/{w.ids['project-private']}/grants",
     {"grantee_type": "team", "grantee_id": "A", "level": "use"}, {"super"}),
    ("see who a project can be shared with", "GET", lambda w: f"/projects/{w.ids['project-shared']}/share-targets", None, {"super", "ga"}),
    ("read a team-shared project's runs", "GET", lambda w: f"/projects/{w.ids['project-shared']}/runs", None, {"super", "ga"}),
]


def resolve(w, value):
    return value(w) if callable(value) else value


CASES = [(a, role) for a in ACTIONS for role in ROLES]


@pytest.mark.parametrize("action,role", CASES, ids=[f"{a[0]} | {r}" for a, r in CASES])
def test_matrix(world, action, role):
    name, method, path, body, allowed = action
    response = call(world, role, method, resolve(world, path), resolve(world, body))
    if role in allowed:
        assert response.status_code < 300, (name, role, response.status_code, response.text)
    else:
        # Out of scope reads as "not there" (404); a role that knows the area exists but may not
        # use it (a Sub Admin in the master-only role area) gets a plain 403. Never success.
        assert response.status_code in (403, 404), (name, role, response.status_code, response.text)
        if response.status_code == 404:
            assert response.json()["error_type"] in ("NotFound", "ProjectNotFound"), response.text


def test_out_of_scope_looks_exactly_like_missing(world):
    """A project you can't see answers the same as one that never existed, so ids can't be probed."""
    for role in ("mb", "out", "sub"):
        real = call(world, role, "GET", f"/projects/{world.ids['project-personal']}")
        fake = call(world, role, "GET", "/projects/does-not-exist")
        assert real.status_code == fake.status_code == 404
        assert real.json()["error_type"] == fake.json()["error_type"]
        assert real.json()["message"].split(":")[0] == fake.json()["message"].split(":")[0]
    for role in ("ma", "out"):
        assert call(world, role, "GET", "/teams/B").status_code == 404
        assert call(world, role, "GET", "/teams/NOPE").status_code == 404


def test_a_group_admin_has_admin_powers_in_a_and_member_powers_in_b(world):
    assert call(world, "ga", "PATCH", "/teams/A", {"name": "Alpha"}).status_code == 200
    assert call(world, "ga", "PATCH", "/teams/B", {"name": "Beta"}).status_code == 404
    assert call(world, "ga", "GET", "/teams/B").status_code == 200  # a member of B sees it exists
    assert call(world, "ga", "GET", "/teams/B/members").status_code == 404  # but not who is in it


def test_nothing_is_reachable_without_signing_in(world):
    for _, method, path, body, _ in ACTIONS:
        r = world.client.request(method, resolve(world, path), **({"json": resolve(world, body)} if body is not None else {}))
        assert r.status_code == 401, (method, resolve(world, path), r.status_code)
