"""Budget periods and threshold warnings through the gateway (P5.4)."""

import threading
from datetime import datetime, timezone

import pytest

import agentic_platform.app as app_module
from agentic_platform.errors import BudgetExceededError
from agentic_platform.stores import UserRecord, period_start_for

from .test_budget_gateway import Model, env  # noqa: F401  (the gateway test harness and its fixture)


def at(y, m, d, h=12, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc)


@pytest.fixture
def clock(monkeypatch):
    """A movable clock for the budgets: starts mid-November 2026."""
    now = {"t": at(2026, 11, 18)}
    monkeypatch.setattr(app_module, "_budget_now", lambda: now["t"])
    return now


def spend(e, in_tokens, out_tokens=0, **kw):
    e.call(Model(in_tokens=in_tokens, out_tokens=out_tokens), **kw)  # costs in*10 + out*20 micro-USD


def thresholds(e):
    return sorted((x.target_id, x.details["threshold"]) for x in e.audit("budget.threshold"))


def test_thresholds_are_announced_once_as_a_soft_budget_fills(env, clock):
    env.node("org", "org", 10_000_000, None)
    env.node("user", "u", 10_000, "org", hard_limit=False)
    spend(env, 700)  # 7,000 of 10,000: 70%
    assert thresholds(env) == []
    spend(env, 100)  # 8,000: crosses 80%
    assert thresholds(env) == [("user:u", 80)]
    spend(env, 50)  # 8,500: nothing new
    assert thresholds(env) == [("user:u", 80)]
    spend(env, 200)  # 10,500: crosses 100%
    spend(env, 200)  # still over: not announced again
    assert thresholds(env) == [("user:u", 80), ("user:u", 100)]
    entry = [x for x in env.audit("budget.threshold") if x.details["threshold"] == 100][0]
    assert entry.actor_id == "system" and entry.details["hard_limit"] is False and entry.details["percent_used"] >= 100


def test_a_hard_budget_warns_at_80_then_blocks_the_next_call(env, clock):
    env.node("org", "org", 10_000_000, None)
    env.node("user", "u", 25_000, "org")  # a call is estimated at ~20.5k, so one fits
    spend(env, 1000, 500)  # costs 20,000 = 80%
    assert thresholds(env) == [("user:u", 80)]
    with pytest.raises(BudgetExceededError):
        spend(env, 1)  # only 5,000 left, the estimate is higher
    assert thresholds(env) == [("user:u", 80)]  # the refusal spent nothing, so no new threshold


def test_the_team_budgets_entries_belong_to_the_team_and_user_ones_to_their_parent_team(env, clock):
    env.node("org", "org", 10_000_000, None)
    env.node("team", "T", 10_000, "org", hard_limit=False)
    env.node("user", "u", 10_000, "team:T", hard_limit=False)
    spend(env, 900, team="T")
    got = {x.target_id: x.team_id for x in env.audit("budget.threshold")}
    assert got == {"user:u": "T", "team:T": "T"}


def test_parallel_calls_crossing_a_threshold_announce_it_exactly_once(env, clock):
    env.node("org", "org", 100_000_000, None)
    env.node("user", "u", 10_000, "org", hard_limit=False)
    barrier = threading.Barrier(20)

    def work():
        barrier.wait()
        spend(env, 50)  # 500 each: 20 calls cross 80% and 100% together

    threads = [threading.Thread(target=work) for _ in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert thresholds(env) == [("user:u", 80), ("user:u", 100)]


def test_a_new_month_resets_the_budget_and_the_warnings(env, clock):
    env.node("org", "org", 100_000_000, None, period_start=period_start_for("monthly", clock["t"]))
    env.node("user", "u", 10_000, "org", hard_limit=False, period_start=period_start_for("monthly", clock["t"]))
    spend(env, 900)  # 9,000 in November: 90%
    assert env.rem("user:u") == 1000 and thresholds(env) == [("user:u", 80)]
    clock["t"] = at(2026, 11, 30, 23, 59)  # still November: nothing changes
    spend(env, 10)
    assert env.rem("user:u") == 900
    clock["t"] = at(2026, 12, 1, 0, 0)  # the first call of December starts a new period
    spend(env, 100)
    node = app_module._budgets.get("user:u")
    assert node.remaining == 10_000 - 1000 and node.period_start.replace(tzinfo=None) == datetime(2026, 12, 1)
    spend(env, 750)  # 8,500 in December: warns again, the new month is a new count
    assert thresholds(env) == [("user:u", 80), ("user:u", 80)]


def test_a_hard_budget_that_was_full_works_again_in_the_next_period(env, clock):
    env.node("org", "org", 100_000_000, None, period_start=period_start_for("monthly", clock["t"]))
    env.node("user", "u", 25_000, "org", period_start=period_start_for("monthly", clock["t"]))
    spend(env, 1000, 500)
    with pytest.raises(BudgetExceededError):
        spend(env, 1)
    clock["t"] = at(2026, 12, 2)
    spend(env, 1000, 500)  # topped up again
    assert env.rem("user:u") == 5000


def test_weeks_start_on_monday(env, clock):
    clock["t"] = at(2026, 11, 18)  # a Wednesday
    env.node("org", "org", 100_000_000, None, period="weekly", period_start=period_start_for("weekly", clock["t"]))
    env.node("user", "u", 10_000, "org", period="weekly", hard_limit=False, period_start=period_start_for("weekly", clock["t"]))
    assert app_module._budgets.get("user:u").period_start.replace(tzinfo=None) == datetime(2026, 11, 16)
    spend(env, 500)
    clock["t"] = at(2026, 11, 22, 23, 59)  # Sunday night: same week
    spend(env, 100)
    assert env.rem("user:u") == 10_000 - 6000
    clock["t"] = at(2026, 11, 23, 0, 0)  # Monday: a new week
    spend(env, 100)
    assert env.rem("user:u") == 10_000 - 1000
    assert app_module._budgets.get("user:u").period_start.replace(tzinfo=None) == datetime(2026, 11, 23)


def test_a_one_time_budget_is_never_topped_up(env, clock):
    env.node("org", "org", 100_000_000, None, period="one_time", period_start=at(2026, 1, 1))
    env.node("user", "u", 25_000, "org", period="one_time", period_start=at(2026, 1, 1))
    spend(env, 1000, 500)
    clock["t"] = at(2031, 1, 1)
    with pytest.raises(BudgetExceededError):
        spend(env, 1)
    assert env.rem("user:u") == 5000


def test_parallel_first_calls_of_a_new_period_reset_it_once_and_lose_no_spending(env, clock):
    start = period_start_for("monthly", at(2026, 10, 15))  # last month's period
    env.node("org", "org", 100_000_000, None, period_start=start)
    env.node("user", "u", 1_000_000, "org", hard_limit=False, period_start=start)
    app_module._budgets.reserve(["user:u"], 900_000)  # last month's spending
    barrier = threading.Barrier(15)

    def work():
        barrier.wait()
        spend(env, 10)  # 100 each

    threads = [threading.Thread(target=work) for _ in range(15)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert env.rem("user:u") == 1_000_000 - 15 * 100  # reset once; every call of the new month is counted
    assert len(env.ledger()) == 15


def test_my_budget_reports_how_full_it_is(env, clock):
    env.node("org", "org", 100_000_000, None)
    env.node("user", "u", 10_000, "org", hard_limit=False)
    spend(env, 900)
    user = app_module._users.get("u")
    mine = app_module.my_budget(None, user)
    assert mine["chain"][0]["id"] == "user:u"
    assert mine["chain"][0]["percent_used"] == 90.0 and mine["chain"][0]["thresholds_reached"] == [80]
