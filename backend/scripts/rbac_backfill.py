"""Run or undo the teams backfill by hand.

    uv run python scripts/rbac_backfill.py up      # idempotent; the app also does this at start-up
    uv run python scripts/rbac_backfill.py down    # projects back to personal, Default team removed

Uses MONGODB_URI / MONGODB_DB like the app. Without MONGODB_URI it would only touch an
empty in-memory store, so it refuses.
"""

import sys

from agentic_platform.config import MONGODB_URI
from agentic_platform.rbac_backfill import backfill, rollback
from agentic_platform.stores import make_stores, make_team_store


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("up", "down"):
        print(__doc__)
        return 2
    if not MONGODB_URI:
        print("MONGODB_URI is not set: nothing to do.")
        return 1
    projects, users, _knowledge, _usage = make_stores()
    teams = make_team_store()
    result = backfill(users, projects, teams) if sys.argv[1] == "up" else rollback(projects, teams)
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
