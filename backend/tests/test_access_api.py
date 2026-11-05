"""What a share lets someone do: read, run, edit - and nothing beyond (P3.3)."""

import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryAgentGrantStore,
    InMemoryAuditStore,
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    TeamMembership,
    TeamRecord,
)

LLM = LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview")


def _plan():
    return AgentPlan(
        agents=[AgentSpec(id="analyst", role="r", system_prompt="secret prompt A", llm=LLM),
                AgentSpec(id="writer", role="w", system_prompt="secret prompt W", llm=LLM)],
        orchestration_pattern="sequential",
    )


def _fake_events(graph, task_input, bounds, usage=None, should_stop=None, identity=None):
    usage.add(kind="run", provider="google_genai", model="gemini-3.1-pro-preview", agent_id="analyst",
              input_tokens=100, output_tokens=20)
    yield "run_started", {"at": 1.0, "timeout_s": bounds.timeout_s}
    out = {"content": "done", "data": {}}
    yield "node_completed", {"node": "analyst", "at": 1.5, "output": out, "attempts": 1, "usage": []}
    yield "run_completed", {"at": 1.6, "duration_ms": 600, "outputs": {"analyst": out}, "errors": [], "halted": False,
                            "usage": usage.entries()}


@pytest.fixture
def w(monkeypatch):
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: _plan())
    for name, s in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()), ("_knowledge", InMemoryKnowledgeStore()),
                    ("_usage", InMemoryUsageStore()), ("_teams", InMemoryTeamStore()), ("_audit", InMemoryAuditStore()),
                    ("_grants", InMemoryAgentGrantStore())]:
        monkeypatch.setattr(app_module, name, s)
    monkeypatch.setattr(app_module, "_compiled_graph", lambda project: object())
    monkeypatch.setattr(app_module, "run_graph_events", _fake_events)
    monkeypatch.setattr(app_module, "FLUSH_EVERY_S", 0)
    client = TestClient(app_module.app)
    app_module._teams.create_team(TeamRecord(id="A", name="A"))

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

    # everyone but `out` shares team A with the owner, which is what lets the owner share with them
    for n in ("ann", "viewer", "user", "editor", "other"):
        W.user(n, teams=[("A", "member")])
    W.user("out")
    W.pid = client.post("/projects", json={"brief": "the owner's private brief"}, headers=W.h["ann"]).json()["project_id"]
    app_module._store.mark_compiled(W.pid, 1)
    return W


def share(w, grantee, level, agent="*", gtype="user"):
    gid = w.ids.get(grantee, grantee)
    r = w.c.put(f"/projects/{w.pid}/grants", headers=w.h["root"] if "root" in w.h else w.h["ann"],
                json={"agent_id": agent, "grantee_type": gtype, "grantee_id": gid, "level": level})
    assert r.status_code == 200, r.text
    return r.json()["grant"]


def wait_done(w, who, run_id):
    for _ in range(100):
        run = w.c.get(f"/projects/{w.pid}/runs/{run_id}", headers=w.h[who]).json()["run"]
        if run["status"] != "running":
            return run
        time.sleep(0.02)
    raise AssertionError("run did not finish")


MANAGE_ONLY = [
    ("patch", "", {"name": "x"}),
    ("delete", "", None),
    ("put", "/agents", {"agents": [{"id": "analyst", "provider": "google_genai", "model": "gemini-3.1-pro-preview", "tools": []}]}),
    ("post", "/revise", {"message": "hi"}),
    ("get", "/deployment", None),
    ("post", "/deploy", None),
    ("get", "/datasources", None),
    ("get", "/knowledge", None),
]


def test_a_view_share_shows_the_plan_but_nothing_private_and_runs_nothing(w):
    share(w, "viewer", "view")
    body = w.c.get(f"/projects/{w.pid}", headers=w.h["viewer"]).json()
    assert body["access_level"] == "view" and body["can_manage"] is False
    assert [a["id"] for a in body["plan"]["agents"]] == ["analyst", "writer"]
    assert body["conversation"] == [] and body["knowledge"] is None and body["deployment"] is None
    assert w.c.post(f"/projects/{w.pid}/run", json={"input": {}}, headers=w.h["viewer"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["viewer"]).status_code == 404
    assert w.c.get(f"/projects/{w.pid}/runs", headers=w.h["viewer"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/compile", headers=w.h["viewer"]).status_code == 404


def test_nobody_below_manage_can_reach_the_owners_other_routes(w):
    for level in ("view", "use", "edit", "manage"):
        who = {"view": "viewer", "use": "user", "edit": "editor", "manage": "other"}[level]
        share(w, who, level)
        for method, suffix, body in MANAGE_ONLY:
            r = getattr(w.c, method)(f"/projects/{w.pid}{suffix}", headers=w.h[who], **({"json": body} if body is not None else {}))
            assert r.status_code == 404, (level, method, suffix, r.status_code)
    assert w.c.get(f"/projects/{w.pid}", headers=w.h["ann"]).status_code == 200  # nothing above touched it


def test_a_use_share_runs_the_project_and_the_runner_pays_and_owns_the_view_of_their_run(w):
    share(w, "user", "use")
    r = w.c.post(f"/projects/{w.pid}/runs", json={"input": {"q": 1}}, headers=w.h["user"])
    assert r.status_code == 202
    run = wait_done(w, "user", r.json()["run"]["id"])
    assert run["status"] == "completed" and run["started_by"] == w.ids["user"]
    since = datetime.now(timezone.utc) - timedelta(days=1)
    tenants = {u.tenant_id for u in app_module._usage.list_all(since)}
    assert tenants == {w.ids["user"]}  # their usage, not the owner's

    # the owner also runs it; each sees their own runs, the owner sees all
    mine = w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["ann"]).json()["run"]["id"]
    wait_done(w, "ann", mine)
    assert len(w.c.get(f"/projects/{w.pid}/runs", headers=w.h["ann"]).json()["runs"]) == 2
    assert [x["id"] for x in w.c.get(f"/projects/{w.pid}/runs", headers=w.h["user"]).json()["runs"]] == [run["id"]]
    assert w.c.get(f"/projects/{w.pid}/runs/{mine}", headers=w.h["user"]).status_code == 404  # not theirs
    assert w.c.get(f"/projects/{w.pid}/runs/{run['id']}", headers=w.h["ann"]).status_code == 200


def test_runs_stay_private_between_grantees(w):
    share(w, "user", "use")
    share(w, "other", "use")
    rid = w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["user"]).json()["run"]["id"]
    wait_done(w, "user", rid)
    assert w.c.get(f"/projects/{w.pid}/runs/{rid}", headers=w.h["other"]).status_code == 404
    assert w.c.get(f"/projects/{w.pid}/runs/{rid}/stream", headers=w.h["other"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/runs/{rid}/stop", headers=w.h["other"]).status_code == 404
    assert w.c.get(f"/projects/{w.pid}/runs", headers=w.h["other"]).json()["runs"] == []


def test_the_synchronous_run_endpoints_follow_the_same_rule(w, monkeypatch):
    result = {"outputs": {"analyst": {"content": "x", "data": {}}}, "errors": [], "halted": False}
    monkeypatch.setattr(app_module, "run_graph", lambda graph, inp, bounds, collector, identity=None: result)
    assert w.c.post(f"/projects/{w.pid}/run", json={"input": {}}, headers=w.h["viewer"]).status_code == 404
    share(w, "user", "use")
    assert w.c.post(f"/projects/{w.pid}/run", json={"input": {}}, headers=w.h["user"]).status_code == 200
    assert w.c.post(f"/projects/{w.pid}/run/stream", json={"input": {}}, headers=w.h["viewer"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/run/stream", json={"input": {}}, headers=w.h["user"]).status_code == 200


def test_an_agent_level_share_covers_only_that_agent(w):
    share(w, "user", "use", agent="analyst")
    body = w.c.get(f"/projects/{w.pid}", headers=w.h["user"]).json()
    assert body["restricted"] is True and body["brief"] == ""
    assert [a["id"] for a in body["plan"]["agents"]] == ["analyst"]
    assert "secret prompt W" not in str(body)
    assert w.c.post(f"/projects/{w.pid}/agents/writer/invoke", json={"input": {}}, headers=w.h["user"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/runs", json={"mode": "agent", "agent_id": "writer", "input": {}},
                    headers=w.h["user"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["user"]).status_code == 404  # whole graph
    ok = w.c.post(f"/projects/{w.pid}/runs", json={"mode": "agent", "agent_id": "analyst", "input": {}}, headers=w.h["user"])
    assert ok.status_code == 202


def test_an_edit_share_can_compile_and_change_the_plan_but_a_use_share_cannot(w):
    share(w, "user", "use")
    share(w, "editor", "edit")
    plan = _plan().model_dump()
    assert w.c.post(f"/projects/{w.pid}/compile", headers=w.h["user"]).status_code == 404
    assert w.c.patch(f"/projects/{w.pid}/plan", json=plan, headers=w.h["user"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/compile", headers=w.h["editor"]).status_code == 200
    assert w.c.patch(f"/projects/{w.pid}/plan", json=plan, headers=w.h["editor"]).status_code == 200


def test_shared_projects_are_listed_with_the_access_you_hold(w):
    share(w, "user", "use")
    share(w, "editor", "edit")
    rows = w.c.get("/projects", headers=w.h["user"]).json()["projects"]
    assert [(r["project_id"], r["mine"], r["access_level"]) for r in rows] == [(w.pid, False, "use")]
    assert w.c.get("/projects", headers=w.h["out"]).json()["projects"] == []
    own = w.c.get("/projects", headers=w.h["ann"]).json()["projects"][0]
    assert own["access_level"] == "owner" and own["mine"] is True


def test_a_team_share_reaches_every_member_and_stops_when_they_leave(w):
    app_module._teams.set_member(TeamMembership(team_id="A", user_id=w.ids["ann"], role="member"))
    for n in ("viewer", "user"):
        app_module._teams.set_member(TeamMembership(team_id="A", user_id=w.ids[n], role="member"))
    share(w, "A", "use", gtype="team")
    assert w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["user"]).status_code == 202
    assert w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["viewer"]).status_code == 202
    assert w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["out"]).status_code == 404
    app_module._teams.remove_member("A", w.ids["viewer"])
    assert w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["viewer"]).status_code == 404


def test_revoking_takes_effect_on_the_next_request(w):
    g = share(w, "user", "use")
    assert w.c.get(f"/projects/{w.pid}", headers=w.h["user"]).status_code == 200
    assert w.c.delete(f"/projects/{w.pid}/grants/{g['id']}", headers=w.h["ann"]).status_code == 200
    assert w.c.get(f"/projects/{w.pid}", headers=w.h["user"]).status_code == 404
    assert w.c.post(f"/projects/{w.pid}/runs", json={"input": {}}, headers=w.h["user"]).status_code == 404
    assert w.c.get("/projects", headers=w.h["user"]).json()["projects"] == []


def test_the_highest_of_several_grants_wins_and_a_lower_one_never_lowers_it(w):
    app_module._teams.set_member(TeamMembership(team_id="A", user_id=w.ids["ann"], role="member"))
    app_module._teams.set_member(TeamMembership(team_id="A", user_id=w.ids["user"], role="member"))
    share(w, "A", "view", gtype="team")
    share(w, "user", "edit")
    assert w.c.get(f"/projects/{w.pid}", headers=w.h["user"]).json()["access_level"] == "edit"


def test_a_response_that_returns_the_project_reports_the_callers_own_access(w):
    share(w, "editor", "edit")
    plan = _plan().model_dump()
    body = w.c.patch(f"/projects/{w.pid}/plan", json=plan, headers=w.h["editor"]).json()
    assert body["access_level"] == "edit" and body["can_manage"] is False  # not promoted to "owner" by saving
    assert body["conversation"] == [] and body["knowledge"] is None
    own = w.c.patch(f"/projects/{w.pid}/plan", json=plan, headers=w.h["ann"]).json()
    assert own["access_level"] == "owner" and own["can_manage"] is True
