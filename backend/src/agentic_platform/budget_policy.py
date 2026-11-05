"""Who may allocate and see budgets (P5.2).

The rule that keeps delegation safe: you can only hand out what you hold. A budget node is
allocated FROM a parent, and you may allocate from a parent only if it is yours:

* the Super Admin: any parent (the org budget is theirs);
* a Sub Admin: their own pool, or any budget that descends from their pool;
* a Group Admin: their own team's budget (to split it among the team's members).

Children can never add up to more than the parent holds - that is enforced atomically by the
store, not here. Everything else is invisible (the routes answer 404).
"""

from __future__ import annotations

from .policy import Actor
from .stores import BudgetNode, BudgetStore

# Which kind of node may sit under which.
ALLOWED_CHILDREN: dict[str, tuple[str, ...]] = {
    "org": ("pool", "team", "user"),
    "pool": ("team", "user"),
    "team": ("user",),
    "user": (),
}


def ancestors(store: BudgetStore, node: BudgetNode) -> list[BudgetNode]:
    """The chain above `node`, nearest first (bounded, so a corrupt cycle cannot loop forever)."""
    out: list[BudgetNode] = []
    current = node
    for _ in range(8):
        parent = store.get(current.parent_id) if current.parent_id else None
        if parent is None:
            break
        out.append(parent)
        current = parent
    return out


def may_allocate_from(actor: Actor, parent: BudgetNode, store: BudgetStore) -> bool:
    if actor.is_master:
        return True
    if actor.is_sub_admin:
        own = f"pool:{actor.user_id}"
        return parent.id == own or any(a.id == own for a in ancestors(store, parent))
    if parent.scope_type == "team":
        return parent.scope_id in actor.admined_teams
    return False


def may_see(actor: Actor, node: BudgetNode, store: BudgetStore) -> bool:
    """Your own budget; everything below a parent you may allocate from, and that parent itself."""
    if actor.is_master:
        return True
    if node.id == f"user:{actor.user_id}":
        return True
    if may_allocate_from(actor, node, store):
        return True
    parent = store.get(node.parent_id) if node.parent_id else None
    return parent is not None and may_allocate_from(actor, parent, store)


def chain_ids(user_id: str, team_id: str | None, store: BudgetStore) -> list[str]:
    """The budgets a model call is charged to, tightest first: the person's, then the project
    team's, each with everything above it (duplicates removed, order kept)."""
    ids: list[str] = []
    for start in (f"user:{user_id}", f"team:{team_id}" if team_id else None):
        node = store.get(start) if start else None
        if node is None:
            continue
        ids.append(node.id)
        ids.extend(a.id for a in ancestors(store, node))
    return list(dict.fromkeys(ids))
