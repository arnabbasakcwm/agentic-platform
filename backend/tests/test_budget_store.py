"""Contract tests for BudgetStore and LedgerStore (P5.1): allocation tree, atomic reservation
under concurrency, period reset and thresholds - against memory and (when reachable) MongoDB."""

import threading
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from agentic_platform.stores import (
    BudgetAllocationError,
    BudgetBlock,
    BudgetNode,
    InMemoryBudgetStore,
    InMemoryLedgerStore,
    LedgerEntry,
    MongoBudgetStore,
    MongoLedgerStore,
    period_end_for,
    period_start_for,
)

from .test_stores import backend  # noqa: F401


@pytest.fixture
def budgets(backend):  # noqa: F811
    return InMemoryBudgetStore() if backend is None else MongoBudgetStore(backend)


def node(scope, sid, amount, parent, **kw):
    return BudgetNode(id=BudgetNode.make_id(scope, sid), scope_type=scope, scope_id=sid, parent_id=parent, amount=amount, **kw)


def tree(budgets):
    budgets.create(node("org", "org", 1000, None))
    budgets.create(node("pool", "sub1", 600, "org"))
    budgets.create(node("team", "T", 400, "pool:sub1"))
    budgets.create(node("user", "u1", 100, "team:T"))
    return budgets


def hammer(n, fn):
    results, barrier = [], threading.Barrier(n)

    def work():
        barrier.wait()
        try:
            results.append(fn())
        except Exception as e:  # noqa: BLE001
            results.append(e)

    threads = [threading.Thread(target=work) for _ in range(n)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    return results


# ------------------------------------------------------------------------------ the model
def test_ids_and_parents_are_validated():
    with pytest.raises(ValidationError):
        BudgetNode(id="team:T", scope_type="user", scope_id="T", parent_id="org", amount=1)
    with pytest.raises(ValidationError):
        node("team", "T", 1, None)  # only the org has no parent
    with pytest.raises(ValidationError):
        node("org", "org", 1, "org")
    with pytest.raises(ValidationError):
        node("user", "u", -1, "org")  # money is never negative
    with pytest.raises(ValidationError):
        node("user", "u", 1, "org", thresholds=[0])
    assert node("user", "u", 1, "org", thresholds=[100, 80, 80]).thresholds == [80, 100]


def test_periods():
    t = datetime(2026, 11, 5, 13, 30, tzinfo=timezone.utc)  # a Thursday
    assert period_start_for("monthly", t) == datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert period_start_for("weekly", t) == datetime(2026, 11, 2, tzinfo=timezone.utc)  # Monday
    assert period_end_for("monthly", datetime(2026, 12, 1, tzinfo=timezone.utc)) == datetime(2027, 1, 1, tzinfo=timezone.utc)
    assert period_end_for("weekly", datetime(2026, 11, 2, tzinfo=timezone.utc)) == datetime(2026, 11, 9, tzinfo=timezone.utc)
    assert period_end_for("one_time", t) is None


# ------------------------------------------------------------------------------ allocation
def test_allocation_follows_the_tree_and_never_over_allocates(budgets):
    tree(budgets)
    assert budgets.get("org").unallocated == 400 and budgets.get("pool:sub1").unallocated == 200
    assert budgets.get("team:T").unallocated == 300 and budgets.get("user:u1").remaining == 100
    with pytest.raises(BudgetAllocationError) as e:
        budgets.create(node("pool", "sub2", 401, "org"))
    assert e.value.reason == "over_parent"
    budgets.create(node("pool", "sub2", 400, "org"))  # exactly what is left
    assert budgets.get("org").unallocated == 0
    with pytest.raises(BudgetAllocationError) as e:
        budgets.create(node("user", "u2", 1, "ghost"))
    assert e.value.reason == "no_parent"
    with pytest.raises(BudgetAllocationError) as e:
        budgets.create(node("user", "u1", 1, "team:T"))
    assert e.value.reason == "exists" and budgets.get("team:T").unallocated == 300  # nothing was taken


def test_children_listing(budgets):
    tree(budgets)
    budgets.create(node("user", "u2", 50, "team:T"))
    assert [n.id for n in budgets.list_children("team:T")] == ["user:u1", "user:u2"]
    assert [n.id for n in budgets.list_all()] == ["org", "pool:sub1", "team:T", "user:u1", "user:u2"]


def test_resize_moves_the_difference_through_the_parent(budgets):
    tree(budgets)
    assert budgets.resize("user:u1", 150, by="ga").amount == 150
    assert budgets.get("team:T").unallocated == 250 and budgets.get("user:u1").remaining == 150
    with pytest.raises(BudgetAllocationError) as e:
        budgets.resize("user:u1", 451)  # team has 250 left + the 150 it already gave
    assert e.value.reason == "over_parent"
    budgets.resize("user:u1", 60)
    assert budgets.get("team:T").unallocated == 340 and budgets.get("user:u1").unallocated == 60


def test_a_budget_cannot_shrink_below_what_is_spent_or_handed_on(budgets):
    tree(budgets)
    budgets.reserve(["user:u1"], 70)  # 70 of 100 spent
    with pytest.raises(BudgetAllocationError) as e:
        budgets.resize("user:u1", 60)
    assert e.value.reason == "below_used" and budgets.get("user:u1").amount == 100
    budgets.resize("user:u1", 70)  # exactly what is spent
    assert budgets.get("user:u1").remaining == 0
    with pytest.raises(BudgetAllocationError):
        budgets.resize("team:T", 60)  # 70 is already handed on to u1


def test_the_parent_is_made_whole_when_a_resize_fails(budgets):
    tree(budgets)
    before = budgets.get("team:T").unallocated
    budgets.reserve(["user:u1"], 100)
    with pytest.raises(BudgetAllocationError):
        budgets.resize("user:u1", 1)
    assert budgets.get("team:T").unallocated == before


def test_concurrent_allocations_never_exceed_the_parent(budgets):
    budgets.create(node("org", "org", 1000, None))
    budgets.create(node("pool", "p", 500, "org"))
    results = hammer(20, lambda: budgets.create(node("user", f"u{threading.get_ident()}", 100, "pool:p")))
    made = [r for r in results if isinstance(r, BudgetNode)]
    assert len(made) == 5 and all(isinstance(r, BudgetAllocationError) for r in results if r not in made)
    assert budgets.get("pool:p").unallocated == 0


def test_delete_returns_the_amount_and_refuses_while_children_exist(budgets):
    tree(budgets)
    with pytest.raises(BudgetAllocationError) as e:
        budgets.delete("team:T")
    assert e.value.reason == "has_children"
    budgets.delete("user:u1")
    assert budgets.get("user:u1") is None and budgets.get("team:T").unallocated == 400
    with pytest.raises(BudgetAllocationError):
        budgets.delete("user:u1")


def test_settings_change_hard_flag_thresholds_and_period(budgets):
    tree(budgets)
    n = budgets.update_settings("user:u1", hard_limit=False, thresholds=[50], period="weekly", by="x")
    assert (n.hard_limit, n.thresholds, n.period) == (False, [50], "weekly") and n.amount == 100
    assert budgets.update_settings("ghost", hard_limit=True) is None


# ------------------------------------------------------------------------------ spending
def test_reserve_settle_and_release(budgets):
    tree(budgets)
    chain = ["user:u1", "team:T", "pool:sub1", "org"]
    r = budgets.reserve(chain, 30)
    assert [budgets.get(i).remaining for i in chain] == [70, 370, 570, 970]
    budgets.settle(r, 20)  # the call cost less than estimated: 10 comes back everywhere
    assert [budgets.get(i).remaining for i in chain] == [80, 380, 580, 980]
    r2 = budgets.reserve(chain, 30)
    budgets.settle(r2, 45)  # more than estimated: charged the difference
    assert budgets.get("user:u1").remaining == 80 - 45 and budgets.get("org").remaining == 980 - 45
    r3 = budgets.reserve(chain, 10)
    budgets.release(r3)
    assert budgets.get("user:u1").remaining == 35


def test_a_hard_budget_refuses_and_everything_taken_is_given_back(budgets):
    tree(budgets)
    budgets.update_settings("team:T", hard_limit=True)
    chain = ["org", "pool:sub1", "team:T", "user:u1"]  # the user is last and the tightest
    with pytest.raises(BudgetBlock) as e:
        budgets.reserve(chain, 101)
    assert e.value.node_id == "user:u1" and e.value.remaining == 100 and e.value.needed == 101
    assert [budgets.get(i).remaining for i in chain] == [1000, 600, 400, 100]  # nothing stayed taken


def test_a_soft_budget_warns_but_never_blocks(budgets):
    tree(budgets)
    budgets.update_settings("user:u1", hard_limit=False)
    budgets.reserve(["user:u1"], 250)
    assert budgets.get("user:u1").remaining == -150
    with pytest.raises(BudgetBlock):  # the hard team above it still stops the call
        budgets.reserve(["user:u1", "team:T"], 401)
    assert budgets.get("user:u1").remaining == -150 and budgets.get("team:T").remaining == 400


def test_nodes_without_a_budget_are_skipped(budgets):
    budgets.create(node("org", "org", 100, None))
    r = budgets.reserve(["user:nobody", "org"], 40)
    assert r.nodes == ["org"] and budgets.get("org").remaining == 60
    assert budgets.reserve(["user:nobody"], 5).nodes == []


def test_n_parallel_calls_against_the_last_credit_let_exactly_one_through(budgets):
    budgets.create(node("org", "org", 100, None))
    results = hammer(25, lambda: budgets.reserve(["org"], 100))
    assert sum(1 for r in results if not isinstance(r, Exception)) == 1
    assert all(isinstance(r, BudgetBlock) for r in results if isinstance(r, Exception))
    assert budgets.get("org").remaining == 0


def test_parallel_calls_over_a_chain_never_overspend_and_leave_no_credit_stuck(budgets):
    tree(budgets)
    chain = ["user:u1", "team:T", "pool:sub1", "org"]
    results = hammer(30, lambda: budgets.reserve(chain, 60))
    ok = [r for r in results if not isinstance(r, Exception)]
    assert len(ok) == 1  # the user's 100 covers one call of 60
    assert [budgets.get(i).remaining for i in chain] == [40, 340, 540, 940]  # the 29 refusals gave everything back


def test_parallel_calls_split_a_wider_budget_exactly(budgets):
    budgets.create(node("org", "org", 1000, None))
    results = hammer(40, lambda: budgets.reserve(["org"], 100))
    assert sum(1 for r in results if not isinstance(r, Exception)) == 10
    assert budgets.get("org").remaining == 0


# ------------------------------------------------------------------------------ periods
def test_reset_starts_a_new_period_once(budgets):
    old = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=70)
    budgets.create(node("org", "org", 500, None, period_start=period_start_for("monthly", old)))
    budgets.reserve(["org"], 200)
    budgets.mark_notified("org", 80)
    now = datetime.now(timezone.utc)
    results = hammer(10, lambda: budgets.reset_if_due("org", now))
    assert results.count(True) == 1  # one racer resets it
    fresh = budgets.get("org")
    assert fresh.remaining == 500 and fresh.notified == []
    assert period_start_for("monthly", now).replace(tzinfo=None) == fresh.period_start.replace(tzinfo=None)
    assert budgets.reset_if_due("org", now) is False  # already current


def test_one_time_budgets_never_reset_and_unknown_nodes_are_ignored(budgets):
    budgets.create(node("org", "org", 500, None, period="one_time", period_start=datetime(2020, 1, 1, tzinfo=timezone.utc)))
    budgets.reserve(["org"], 200)
    assert budgets.reset_if_due("org", datetime.now(timezone.utc)) is False
    assert budgets.get("org").remaining == 300
    assert budgets.reset_if_due("ghost", datetime.now(timezone.utc)) is False


def test_a_threshold_is_announced_once(budgets):
    budgets.create(node("org", "org", 100, None))
    results = hammer(10, lambda: budgets.mark_notified("org", 80))
    assert results.count(True) == 1
    assert budgets.mark_notified("org", 100) is True and budgets.mark_notified("ghost", 80) is False


# ------------------------------------------------------------------------------ ledger
@pytest.fixture
def ledger(backend):  # noqa: F811
    return InMemoryLedgerStore() if backend is None else MongoLedgerStore(backend)


def test_the_ledger_appends_and_filters_and_has_no_edit(ledger):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    a = LedgerEntry(id="1", at=now - timedelta(minutes=2), user_id="u1", team_id="T", project_id="p", provider="x", model="m", cost_micro=5)
    b = LedgerEntry(id="2", at=now, user_id="u2", team_id="T", provider="x", model="m", cost_micro=7, unpriced=True)
    c = LedgerEntry(id="3", at=now - timedelta(minutes=1), user_id="u1", provider="x", model="m")
    for e in (a, b, c):
        ledger.append(e)
    assert [e.id for e in ledger.list()] == ["2", "3", "1"]
    assert [e.id for e in ledger.list(user_id="u1")] == ["3", "1"]
    assert [e.id for e in ledger.list(team_id="T")] == ["2", "1"]
    assert [e.id for e in ledger.list(project_id="p")] == ["1"]
    assert [e.id for e in ledger.list(since=now - timedelta(seconds=90))] == ["2", "3"]
    assert [e.id for e in ledger.list(limit=1)] == ["2"]
    assert ledger.list(user_id="2")[:0] == [] and ledger.list(limit=0) == []
    for name in ("update", "delete", "remove", "clear", "replace"):
        assert not hasattr(ledger, name)
    assert ledger.list()[0].unpriced is True
