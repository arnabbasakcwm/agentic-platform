"""Model privilege APIs: who may set what, and the no-escalation rule (P4.2)."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryAgentGrantStore,
    InMemoryAuditStore,
    InMemoryModelPolicyStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    TeamMembership,
    TeamRecord,
)

OFFERED = ["openai/gpt-5", "openai/gpt-mini", "groq/llama", "bedrock/b1"]


@pytest.fixture
def w(monkeypatch):
    for name, s in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()), ("_usage", InMemoryUsageStore()),
                    ("_teams", InMemoryTeamStore()), ("_audit", InMemoryAuditStore()), ("_grants", InMemoryAgentGrantStore()),
                    ("_models", InMemoryModelPolicyStore())]:
        monkeypatch.setattr(app_module, name, s)
    monkeypatch.setattr(app_module, "_offered_models", lambda: list(OFFERED))
    plan = AgentPlan(agents=[AgentSpec(id="a", role="r", system_prompt="p", llm=LLMConfig(provider="google_genai", model="m"))],
                     orchestration_pattern="sequential")
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    client = TestClient(app_module.app)
    for t in ("A", "B"):
        app_module._teams.create_team(TeamRecord(id=t, name=t))

    class W:
        c, h, ids = client, {}, {}

        @classmethod
        def user(cls, name, role=None, teams=()):
            r = client.post("/auth/register", json={"email": f"{name}@example.com", "password": "a-long-password"}).json()
            uid = r["user"]["id"]
            if role:
                app_module._users.set_role(uid, role, by="t")
            for t, tr in teams:
                app_module._teams.set_member(TeamMembership(team_id=t, user_id=uid, role=tr))
            cls.h[name], cls.ids[name] = {"Authorization": f"Bearer {r['access_token']}"}, uid

    W.user("root", "master")
    W.user("sub", "admin")
    W.user("ga", teams=[("A", "group_admin"), ("B", "member")])
    W.user("mem", teams=[("A", "member"), ("B", "member")])
    W.user("out")
    return W


def audit(action):
    return [e for e in app_module._audit.list(limit=100) if e.action == action]


def test_only_the_super_admin_sets_the_org_catalog_and_fallback(w):
    body = {"catalog": ["openai/*", "groq/llama"], "fallback_model": "groq/llama"}
    assert w.c.put("/admin/models/org", json=body, headers=w.h["root"]).json()["org"]["catalog"] == ["openai/*", "groq/llama"]
    for who, status in (("sub", 403), ("ga", 404), ("mem", 404), ("out", 404)):
        assert w.c.put("/admin/models/org", json={"catalog": []}, headers=w.h[who]).status_code == status, who
    assert app_module._models.get_org().catalog == ["openai/*", "groq/llama"]
    assert len(audit("model.org_updated")) == 1
    w.c.put("/admin/models/org", json=body, headers=w.h["root"])  # same again: no change, no entry
    assert len(audit("model.org_updated")) == 1


def test_the_org_settings_are_validated_against_what_the_platform_offers(w):
    r = w.c.put("/admin/models/org", json={"catalog": ["ghost/*"]}, headers=w.h["root"])
    assert r.status_code == 422 and r.json()["error_type"] == "UnknownModel"
    assert w.c.put("/admin/models/org", json={"catalog": ["nonsense"]}, headers=w.h["root"]).json()["error_type"] == "InvalidModelReference"
    assert w.c.put("/admin/models/org", json={"fallback_model": "ghost/x"}, headers=w.h["root"]).status_code == 422
    assert w.c.put("/admin/models/org", json={"fallback_model": "groq/*"}, headers=w.h["root"]).status_code == 422
    assert app_module._models.get_org().catalog is None and audit("model.org_updated") == []


def test_admins_read_the_catalog_but_group_admins_and_members_do_not(w):
    for who in ("root", "sub"):
        r = w.c.get("/admin/models", headers=w.h[who])
        assert r.status_code == 200 and r.json()["offered"] == OFFERED
    for who in ("ga", "mem", "out"):
        assert w.c.get("/admin/models", headers=w.h[who]).status_code == 404


def test_team_allowlists_are_the_super_admins(w):
    r = w.c.put("/teams/A/models", json={"models": ["openai/*"]}, headers=w.h["root"])
    assert r.status_code == 200 and r.json()["allowlist"]["models"] == ["openai/*"]
    for who in ("ga", "mem", "sub", "out"):
        assert w.c.put("/teams/A/models", json={"models": ["groq/*"]}, headers=w.h[who]).status_code == 404, who
        assert w.c.delete("/teams/A/models", headers=w.h[who]).status_code == 404, who
    assert app_module._models.get_allowlist("team", "A").models == ["openai/*"]
    seen = w.c.get("/teams/A/models", headers=w.h["ga"]).json()
    assert seen["team"]["models"] == ["openai/*"] and w.c.get("/teams/B/models", headers=w.h["mem"]).status_code == 404
    assert w.c.delete("/teams/A/models", headers=w.h["root"]).json() == {"cleared": True}
    assert w.c.delete("/teams/A/models", headers=w.h["root"]).json() == {"cleared": False}
    assert [e.action for e in app_module._audit.list(limit=10)] == ["model.allowlist_cleared", "model.allowlist_set"]
    assert w.c.put("/teams/A/models", json={"models": ["ghost/model"]}, headers=w.h["root"]).status_code == 422
    assert w.c.put("/teams/NOPE/models", json={"models": []}, headers=w.h["root"]).status_code == 404


def test_user_allowlists_are_the_super_admins(w):
    mem = w.ids["mem"]
    assert w.c.put(f"/users/{mem}/models", json={"models": ["groq/*"]}, headers=w.h["root"]).status_code == 200
    for who in ("ga", "sub", "mem"):
        assert w.c.put(f"/users/{mem}/models", json={"models": ["openai/*"]}, headers=w.h[who]).status_code == 404, who
    assert w.c.put("/users/nobody/models", json={"models": []}, headers=w.h["root"]).status_code == 404
    assert w.c.delete(f"/users/{mem}/models", headers=w.h["root"]).json() == {"cleared": True}


def test_a_group_admin_limits_members_but_never_beyond_their_own_set(w):
    mem = w.ids["mem"]
    w.c.put("/teams/A/models", json={"models": ["openai/*", "groq/*"]}, headers=w.h["root"])
    ok = w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["openai/gpt-mini"]}, headers=w.h["ga"])
    assert ok.status_code == 200 and ok.json()["allowlist"]["scope_id"] == f"A:{mem}"
    # beyond the team's set: the group admin does not have it themselves
    over = w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["bedrock/b1"]}, headers=w.h["ga"])
    assert over.status_code == 403 and over.json()["error_type"] == "ModelAboveYourOwn"
    assert w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["openai/*", "bedrock/*"]}, headers=w.h["ga"]).status_code == 403
    assert app_module._models.get_allowlist("member", f"A:{mem}").models == ["openai/gpt-mini"]  # unchanged by the refusals
    # their own limit also caps what they can hand out
    w.c.put(f"/users/{w.ids['ga']}/models", json={"models": ["groq/*"]}, headers=w.h["root"])
    assert w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["openai/gpt-5"]}, headers=w.h["ga"]).status_code == 403
    assert w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["groq/llama"]}, headers=w.h["ga"]).status_code == 200
    assert len(audit("model.allowlist_set")) == 4  # team list, the group admin's own user list, two member lists


def test_a_group_admin_cannot_reach_another_team_or_a_stranger(w):
    mem, out = w.ids["mem"], w.ids["out"]
    assert w.c.put(f"/teams/B/members/{mem}/models", json={"models": ["groq/llama"]}, headers=w.h["ga"]).status_code == 404  # member-only in B
    assert w.c.put(f"/teams/A/members/{out}/models", json={"models": ["groq/llama"]}, headers=w.h["ga"]).status_code == 404  # not in the team
    assert w.c.delete(f"/teams/B/members/{mem}/models", headers=w.h["ga"]).status_code == 404
    assert w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["groq/llama"]}, headers=w.h["mem"]).status_code == 404
    assert w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["groq/llama"]}, headers=w.h["sub"]).status_code == 404
    assert app_module._models.list_allowlists() == []


def test_the_super_admin_can_limit_any_member_and_clear_it(w):
    mem = w.ids["mem"]
    assert w.c.put(f"/teams/B/members/{mem}/models", json={"models": ["bedrock/*"]}, headers=w.h["root"]).status_code == 200
    assert w.c.delete(f"/teams/B/members/{mem}/models", headers=w.h["root"]).json() == {"cleared": True}


def test_my_models_shows_the_effective_set_and_what_blocks_the_rest(w):
    mem = w.ids["mem"]
    w.c.put("/admin/models/org", json={"catalog": ["openai/*", "groq/*"]}, headers=w.h["root"])
    w.c.put("/teams/A/models", json={"models": ["openai/*"]}, headers=w.h["root"])
    w.c.put(f"/teams/A/members/{mem}/models", json={"models": ["openai/gpt-mini"]}, headers=w.h["root"])
    pid = w.c.post("/projects", json={"brief": "x"}, headers=w.h["mem"]).json()["project_id"]
    app_module._store.set_team(pid, "A", True)

    def view(project=None):
        params = {"project_id": project} if project else {}
        r = w.c.get("/me/models", params=params, headers=w.h["mem"]).json()["models"]
        return {m["model"]: (m["allowed"], m["blocked_by"]) for m in r}

    in_a = view(pid)
    assert in_a["openai/gpt-mini"] == (True, None)
    assert in_a["openai/gpt-5"] == (False, "member") and in_a["groq/llama"] == (False, "team") and in_a["bedrock/b1"] == (False, "org")
    assert {k for k, v in view().items() if v[0]} == {"openai/gpt-5", "openai/gpt-mini", "groq/llama"}  # no team context
    assert w.c.get("/me/models", params={"project_id": pid}, headers=w.h["out"]).status_code == 404
    # the Super Admin is bound by the org catalog only
    root_view = {m["model"]: m["allowed"] for m in w.c.get("/me/models", headers=w.h["root"]).json()["models"]}
    assert root_view == {"openai/gpt-5": True, "openai/gpt-mini": True, "groq/llama": True, "bedrock/b1": False}
    assert w.c.get("/me/models", headers=w.h["mem"]).json()["fallback_model"] is None


def test_per_agent_and_org_fallbacks_are_reported(w):
    w.c.put("/admin/models/org", json={"fallback_model": "groq/llama"}, headers=w.h["root"])
    assert w.c.get("/me/models", headers=w.h["mem"]).json()["fallback_model"] == "groq/llama"
