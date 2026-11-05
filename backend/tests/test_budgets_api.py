"""Budget allocation APIs and the no-escalation rule (P5.2)."""

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform.stores import (
    InMemoryAgentGrantStore,
    InMemoryAuditStore,
    InMemoryBudgetStore,
    InMemoryLedgerStore,
    InMemoryProjectStore,
    InMemoryTeamStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    TeamMembership,
    TeamRecord,
)

USD = 1_000_000


@pytest.fixture
def w(monkeypatch):
    for name, s in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()), ("_usage", InMemoryUsageStore()),
                    ("_teams", InMemoryTeamStore()), ("_audit", InMemoryAuditStore()), ("_grants", InMemoryAgentGrantStore()),
                    ("_budgets", InMemoryBudgetStore()), ("_ledger", InMemoryLedgerStore())]:
        monkeypatch.setattr(app_module, name, s)
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

        @classmethod
        def put(cls, who, scope, sid, amount, **kw):
            sid = cls.ids.get(sid, sid) if scope in ("user", "pool") else sid
            return client.put(f"/budgets/{scope}/{sid}", json={"amount": amount, **kw}, headers=cls.h[who])

    W.user("root", "master")
    W.user("sub", "admin")
    W.user("sub2", "admin")
    W.user("ga", teams=[("A", "group_admin"), ("B", "member")])
    W.user("mem", teams=[("A", "member")])
    W.user("memb", teams=[("B", "member")])
    W.user("out")
    return W


def node(id_):
    return app_module._budgets.get(id_)


def build(w):
    """org 1000 > pool(sub) 600 > team A 400 > user mem 100."""
    assert w.put("root", "org", "org", 1000 * USD).status_code == 200
    assert w.put("root", "pool", "sub", 600 * USD).status_code == 200
    assert w.put("sub", "team", "A", 400 * USD).status_code == 200  # defaults to the Sub Admin's own pool
    assert w.put("ga", "user", "mem", 100 * USD, parent="team:A").status_code == 200


def test_the_super_admin_sets_the_org_budget_and_nobody_else_can(w):
    r = w.put("root", "org", "org", 1000 * USD, hard_limit=True, thresholds=[50, 90], period="weekly")
    body = r.json()["budget"]
    assert (body["amount"], body["remaining"], body["unallocated"], body["period"], body["thresholds"]) == (1000 * USD, 1000 * USD, 1000 * USD, "weekly", [50, 90])
    for who in ("sub", "ga", "mem", "out"):
        assert w.put(who, "org", "org", 5).status_code == 404, who
    assert node("org").amount == 1000 * USD


def test_money_is_integers_and_never_negative(w):
    assert w.c.put("/budgets/org/org", json={"amount": 1.5}, headers=w.h["root"]).status_code == 422
    assert w.c.put("/budgets/org/org", json={"amount": -1}, headers=w.h["root"]).status_code == 422
    assert w.c.put("/budgets/org/org", json={"amount": 10, "thresholds": [0]}, headers=w.h["root"]).status_code == 422
    assert w.c.put("/budgets/org/org", json={"amount": 10, "period": "daily"}, headers=w.h["root"]).status_code == 422
    assert node("org") is None


def test_the_tree_org_pool_team_user(w):
    build(w)
    assert node("org").unallocated == 400 * USD and node("pool:" + w.ids["sub"]).unallocated == 200 * USD
    assert node("team:A").unallocated == 300 * USD and node("user:" + w.ids["mem"]).amount == 100 * USD
    assert node("user:" + w.ids["mem"]).parent_id == "team:A"


def test_a_pool_is_for_a_sub_admin_only(w):
    w.put("root", "org", "org", 1000 * USD)
    assert w.put("root", "pool", "mem", 10).status_code == 404  # not a Sub Admin
    assert w.put("root", "pool", "ghost", 10).status_code == 404
    assert w.put("sub", "pool", "sub", 10).status_code == 404  # nobody allocates their own pool


def test_over_allocation_is_rejected_at_every_level(w):
    build(w)
    r = w.put("root", "pool", "sub2", 401 * USD)
    assert r.status_code == 409 and r.json()["error_type"] == "BudgetExceedsParent"
    r = w.put("sub", "team", "B", 201 * USD)  # the pool has 200 left
    assert r.status_code == 409 and r.json()["error_type"] == "BudgetExceedsParent"
    r = w.put("ga", "user", "mem", 401 * USD, parent="team:A")  # existing: resizing beyond the team
    assert r.status_code == 409
    assert node("team:A").unallocated == 300 * USD  # nothing moved
    assert w.put("sub", "team", "B", 200 * USD).status_code == 200  # exactly what is left


def test_a_sub_admin_allocates_only_from_their_own_pool(w):
    build(w)
    w.put("root", "pool", "sub2", 100 * USD)
    sub2_pool = "pool:" + w.ids["sub2"]
    assert w.put("sub", "team", "B", 10, parent=sub2_pool).status_code == 404  # someone else's pool
    assert w.put("sub", "team", "B", 10, parent="org").status_code == 404  # the org is the Super Admin's
    assert w.put("sub2", "team", "B", 10).status_code == 200
    # below their pool they may reach users of a team they funded
    assert w.put("sub", "user", "memb", 5 * USD, parent="team:A").status_code == 200
    assert w.put("sub2", "user", "mem", 5, parent="team:A").status_code == 404  # team A hangs off sub's pool


def test_a_group_admin_splits_their_team_among_its_members_only(w):
    build(w)
    w.user("mem2", teams=[("A", "member")])
    assert w.put("ga", "user", "mem2", 50 * USD, parent="team:A").status_code == 200
    assert w.put("ga", "user", "memb", 10, parent="team:A").status_code == 404  # not in team A
    assert w.put("ga", "user", "out", 10, parent="team:A").status_code == 404
    assert w.put("ga", "team", "A", 999).status_code == 404  # a team's own budget comes from above
    assert w.put("ga", "user", "mem2", 1, parent="org").status_code == 409  # exists: its parent is fixed
    assert w.put("ga", "user", "mem2", 1, parent="user:" + w.ids["mem"]).status_code == 409
    w.user("mem3", teams=[("A", "member")])
    assert w.put("ga", "user", "mem3", 1, parent="org").status_code == 404  # new: org is not theirs to give from
    assert w.put("ga", "user", "mem3", 1, parent="user:" + w.ids["mem"]).status_code == 404
    w.put("root", "team", "B", 10 * USD)
    assert w.put("ga", "user", "memb", 5, parent="team:B").status_code == 404  # administers only A
    assert w.put("ga", "user", "mem2", 40 * USD, parent="team:A").status_code == 200  # shrink their own allocation


def test_plain_members_and_outsiders_can_do_nothing(w):
    build(w)
    for who in ("mem", "memb", "out"):
        assert w.put(who, "user", who, 1, parent="team:A").status_code == 404, who
        assert w.c.delete("/budgets/user/" + w.ids["mem"], headers=w.h[who]).status_code == 404, who
    assert w.c.put("/budgets/org/org", json={"amount": 1}).status_code == 401


def test_the_parent_kind_must_fit(w):
    build(w)
    assert w.put("root", "team", "B", 10, parent="team:A").status_code == 422  # a team in a team
    assert w.put("root", "pool", "sub2", 10, parent="pool:" + w.ids["sub"]).status_code == 422
    assert w.put("root", "user", "memb", 10).json()["error_type"] == "BudgetParentRequired"
    assert w.put("root", "user", "memb", 10, parent="team:ghost").status_code == 404
    assert w.put("root", "bogus", "x", 10).status_code == 404


def test_the_parent_of_a_budget_is_fixed(w):
    build(w)
    r = w.put("root", "user", "mem", 100 * USD, parent="org")
    assert r.status_code == 409 and r.json()["error_type"] == "BudgetParentFixed"
    assert node("user:" + w.ids["mem"]).parent_id == "team:A"


def test_shrinking_below_whats_spent_or_handed_on_is_refused(w):
    build(w)
    app_module._budgets.reserve(["user:" + w.ids["mem"]], 30 * USD)
    r = w.put("ga", "user", "mem", 20 * USD)
    assert r.status_code == 409 and r.json()["error_type"] == "BudgetBelowUsed"
    assert w.put("ga", "user", "mem", 30 * USD).status_code == 200
    assert w.put("sub", "team", "A", 20 * USD).status_code == 409  # 30 is already handed on to the member
    assert w.put("sub", "team", "A", 30 * USD).status_code == 200


def test_settings_change_without_touching_the_amount(w):
    build(w)
    r = w.put("ga", "user", "mem", 100 * USD, hard_limit=False, thresholds=[50])
    b = r.json()["budget"]
    assert (b["hard_limit"], b["thresholds"], b["amount"]) == (False, [50], 100 * USD)


def test_delete_returns_the_amount_and_needs_the_children_gone_first(w):
    build(w)
    r = w.c.delete(f"/budgets/team/A", headers=w.h["sub"])
    assert r.status_code == 409 and r.json()["error_type"] == "BudgetHasChildren"
    assert w.c.delete("/budgets/user/" + w.ids["mem"], headers=w.h["ga"]).json() == {"deleted": "user:" + w.ids["mem"]}
    assert node("team:A").unallocated == 400 * USD
    assert w.c.delete("/budgets/team/A", headers=w.h["sub"]).status_code == 200
    assert node("pool:" + w.ids["sub"]).unallocated == 600 * USD
    assert w.c.delete("/budgets/org/org", headers=w.h["root"]).status_code == 404  # the root is never deleted here
    assert w.c.delete("/budgets/team/A", headers=w.h["sub"]).status_code == 404


def test_who_sees_which_budgets(w):
    build(w)
    w.put("root", "pool", "sub2", 100 * USD)

    def ids(who):
        return {b["id"] for b in w.c.get("/budgets", headers=w.h[who]).json()["budgets"]}

    mem, sub, sub2 = "user:" + w.ids["mem"], "pool:" + w.ids["sub"], "pool:" + w.ids["sub2"]
    assert ids("root") == {"org", sub, sub2, "team:A", mem}
    assert ids("sub") == {sub, "team:A", mem}  # their pool and everything below; not the org, not sub2
    assert ids("sub2") == {sub2}
    assert ids("ga") == {"team:A", mem}  # the team's budget and its members' (not the pool above)
    assert ids("mem") == {mem}
    assert ids("out") == set()


def test_my_budget_shows_only_my_chain(w):
    build(w)
    chain = w.c.get("/me/budget", headers=w.h["mem"]).json()
    assert [n["id"] for n in chain["chain"]] == ["user:" + w.ids["mem"], "team:A", "pool:" + w.ids["sub"], "org"]
    assert chain["tightest_remaining"] == 100 * USD
    pid = w.c.post("/projects", json={"brief": "x"}, headers=w.h["mem"]).json()["project_id"] if False else None
    assert w.c.get("/me/budget", headers=w.h["out"]).json() == {"chain": [], "tightest_remaining": None}


def test_every_change_writes_one_audit_entry_and_refusals_none(w):
    build(w)
    actions = lambda: [e.action for e in app_module._audit.list(limit=100) if e.action.startswith("budget.")]  # noqa: E731
    assert sorted(actions()) == ["budget.created"] * 4
    w.put("ga", "user", "mem", 100 * USD)  # unchanged
    assert len(actions()) == 4
    w.put("ga", "user", "mem", 90 * USD)
    entry = [e for e in app_module._audit.list(limit=100) if e.action == "budget.changed"][0]
    assert entry.before == {"amount": 100 * USD} and entry.after == {"amount": 90 * USD} and entry.team_id == "A"
    w.put("root", "pool", "sub2", 10 ** 15)  # refused: more than the org has
    w.put("mem", "user", "mem", 1, parent="team:A")  # refused: not allowed
    assert len(actions()) == 5
    w.c.delete("/budgets/user/" + w.ids["mem"], headers=w.h["ga"])
    assert actions().count("budget.deleted") == 1
