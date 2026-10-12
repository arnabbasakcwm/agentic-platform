"""Set a registered user's role from the server.

    uv run python scripts/set_role.py <email> <master|admin|user>

There is one master admin: they alone add and remove admins in the console (Admin page);
other admins only see usage. The master is set here, never through the API:
`master` moves the role to this user and makes the previous master an admin. The master
can't be made `admin` or `user` directly, so the platform always has one; move the role
to someone else first.

It uses the configured store (MONGODB_URI / MONGODB_DB in backend/.env, else in-memory,
which is useless here). On the production stack, from the checkout (the image has no
scripts/ folder, so the script is piped in):

    docker compose --env-file .env.production -f docker-compose.prod.yml exec -T api
        uv run --no-sync python - <email> master < backend/scripts/set_role.py

(one command, split here to fit).
"""

import sys

from agentic_platform.config import MONGODB_DB, MONGODB_URI
from agentic_platform.stores import ROLES, make_stores


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in ROLES:
        print(__doc__)
        return 2
    email, role = sys.argv[1].strip().lower(), sys.argv[2]
    if not MONGODB_URI:
        print("MONGODB_URI isn't set: there is no stored user to change.")
        return 1
    _, users, _, _ = make_stores()
    user = users.get_by_email(email)
    if user is None:
        print(f"No account for {email} in database '{MONGODB_DB}'. Register it first, then run this again.")
        return 1
    if user.role == role:
        print(f"{email} is already {role}.")
        return 0
    if user.role == "master":
        print("Refused: the platform needs a master admin. Make someone else master first "
              "(set_role.py <their email> master); this account then becomes an admin.")
        return 1
    updated = users.set_role(user.id, role, by="server-script")
    if role == "master":
        for previous in users.list_all():
            if previous.role == "master" and previous.id != user.id:
                users.set_role(previous.id, "admin", by="server-script")
                print(f"{previous.email} is no longer master; now admin.")
    print(f"{updated.email} is now {updated.role} (database '{MONGODB_DB}').")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
