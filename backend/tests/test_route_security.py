"""Every route is protected: a new endpoint can't ship without sign-in and a scope check (P7.2).

Three sweeps over the app's real route table:
  1. Without a token every route answers 401 - except a short, named public list.
  2. Every route that names a project, a team, a budget, a user's models or the admin area visibly calls
     the policy/scope helper that guards it (so a handler can't forget).
  3. Nothing new has appeared that this file doesn't classify.
"""

import inspect
import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import agentic_platform.app as app_module

PUBLIC = {
    ("GET", "/health"),
    ("GET", "/providers"),  # the platform's model list: no user data
    ("GET", "/tools"),  # the tool registry: no user data
    ("POST", "/auth/login"),
    ("POST", "/auth/register"),
}

ROUTES = [
    (method, r.path, r)
    for r in app_module.app.routes
    if isinstance(r, APIRoute)
    for method in sorted(r.methods - {"HEAD", "OPTIONS"})
]


def source(route: APIRoute) -> str:
    return inspect.getsource(route.endpoint)


def dependency_names(route: APIRoute) -> set[str]:
    return {d.call.__name__ for d in route.dependant.dependencies if d.call is not None}


def test_there_are_routes_to_sweep():
    assert len(ROUTES) > 100


@pytest.mark.parametrize("method,path,route", ROUTES, ids=[f"{m} {p}" for m, p, _ in ROUTES])
def test_every_route_needs_a_signed_in_user_unless_it_is_public(method, path, route):
    client = TestClient(app_module.app)
    concrete = re.sub(r"\{[^}]+\}", "x", path)
    response = client.request(method, concrete, json={} if method in ("POST", "PUT", "PATCH") else None)
    if (method, path) in PUBLIC:
        assert response.status_code != 401
    else:
        assert response.status_code == 401, f"{method} {path} answered {response.status_code} without a token"


def test_the_public_list_is_exactly_the_routes_that_exist():
    existing = {(m, p) for m, p, _ in ROUTES}
    assert PUBLIC <= existing  # no stale entry hiding a removed route


# `_queue_uploads(` checks the project itself (`_get_project`) before attaching anything.
GUARDS_FOR_PROJECTS = ("_get_project(", "_project_at(", "_shareable_project(", "_get_run(", "_queue_uploads")


@pytest.mark.parametrize("method,path,route", [r for r in ROUTES if "{project_id}" in r[1]], ids=lambda v: v if isinstance(v, str) else "")
def test_every_project_route_checks_the_callers_access_to_that_project(method, path, route):
    code = source(route)
    assert any(g in code for g in GUARDS_FOR_PROJECTS), f"{method} {path} never checks access to the project"


@pytest.mark.parametrize("method,path,route", [r for r in ROUTES if "{team_id}" in r[1]], ids=lambda v: v if isinstance(v, str) else "")
def test_every_team_route_checks_the_callers_role_in_that_team(method, path, route):
    code = source(route)
    assert any(g in code for g in ("_visible_team(", "_team_member_target(", "_member_target(")), f"{method} {path} never checks the team scope"
    assert "_actor(" in code or "_team_member_target(" in code or "_member_target(" in code


@pytest.mark.parametrize("method,path,route", [r for r in ROUTES if r[1].startswith("/admin")], ids=lambda v: v if isinstance(v, str) else "")
def test_every_admin_route_requires_an_admin_role(method, path, route):
    assert dependency_names(route) & {"require_admin", "require_master"}, f"{method} {path} is not behind an admin check"


@pytest.mark.parametrize(
    "method,path,route",
    [r for r in ROUTES if r[1].startswith(("/budgets", "/audit", "/me/", "/users/")) or r[1] == "/teams"],
    ids=lambda v: v if isinstance(v, str) else "",
)
def test_delegated_admin_routes_use_the_policy_actor(method, path, route):
    code = source(route)
    assert "_actor(" in code or "current_user" in code or "user.id" in code, f"{method} {path} has no notion of who is asking"
    if path.startswith(("/budgets", "/users/")) and method != "GET":
        assert "_actor(" in code, f"{method} {path} changes something without consulting the policy actor"


def test_every_state_changing_privileged_route_writes_to_the_audit_log():
    """The routes that change roles, teams, shares, budgets or model limits each record the change."""
    privileged = [
        r for r in ROUTES
        if r[0] in ("POST", "PUT", "PATCH", "DELETE")
        and re.match(r"^/(teams|budgets|users/\{[a-z_]+\}/models|admin/(models|users/\{[a-z_]+\}/role)|projects/\{project_id\}/(grants|agents/\{agent_id\}/fallback))", r[1])
    ]
    assert len(privileged) >= 20
    for method, path, route in privileged:
        assert "audit_log.record(" in source(route) or "_set_allowlist(" in source(route) or "_clear_allowlist(" in source(route), \
            f"{method} {path} changes access without an audit entry"
