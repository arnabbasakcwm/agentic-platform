"""Which models a person may use, and the no-escalation rule for granting them.

What someone may use is the INTERSECTION of up to four layers, each optional below the org:

    org catalog  ∩  team allowlist  ∩  member allowlist (their limit inside that team)  ∩  user allowlist

* org catalog   - the platform's models, narrowed by the Super Admin (none set = all offered).
* team          - the allowlist of the team that owns the project being run.
* member        - a group admin's limit for one person, inside that team only.
* user          - a Super Admin's limit that follows the person everywhere.

A missing layer is "no limit here"; an empty list is "no model at all". Everything fails
closed: an unknown model, or a layer that cannot be read, is not allowed.
"""

from __future__ import annotations

from dataclasses import dataclass

from .stores import ModelAllowlist, ModelPolicyStore, model_matches


@dataclass(frozen=True)
class Limits:
    """The layers that apply to one person working in one team context."""

    org: tuple[str, ...] | None  # None = every offered model
    layers: tuple[tuple[str, tuple[str, ...]], ...]  # (layer name, patterns), present layers only


def limits_for(store: ModelPolicyStore, user_id: str, team_id: str | None) -> Limits:
    org = store.get_org()
    layers: list[tuple[str, tuple[str, ...]]] = []
    if team_id is not None:
        team = store.get_allowlist("team", team_id)
        if team is not None:
            layers.append(("team", tuple(team.models)))
        member = store.get_allowlist("member", f"{team_id}:{user_id}")
        if member is not None:
            layers.append(("member", tuple(member.models)))
    user = store.get_allowlist("user", user_id)
    if user is not None:
        layers.append(("user", tuple(user.models)))
    return Limits(org=tuple(org.catalog) if org.catalog is not None else None, layers=tuple(layers))


def _covered(key: str, patterns: tuple[str, ...]) -> bool:
    return any(model_matches(p, key) for p in patterns)


def blocked_by(key: str, limits: Limits) -> str | None:
    """None if the model is allowed; otherwise the layer that blocks it ("org", "team", "member", "user")."""
    if limits.org is not None and not _covered(key, limits.org):
        return "org"
    for name, patterns in limits.layers:
        if not _covered(key, patterns):
            return name
    return None


def is_allowed(key: str, limits: Limits) -> bool:
    return blocked_by(key, limits) is None


def effective_models(offered: list[str], limits: Limits) -> list[str]:
    """The offered models this person may use (order kept)."""
    return [k for k in offered if is_allowed(k, limits)]


def escalations(requested: list[str], offered: list[str], granter: Limits) -> list[str]:
    """The no-escalation check for a grant. `requested` are allowlist patterns somebody wants to
    give; every offered model they cover must be one the granter may use themselves. Returns the
    models that would exceed the granter's own set (empty = fine). A pattern that covers no
    offered model at all is reported too, as the pattern itself: nobody grants what does not exist."""
    over: list[str] = []
    for pattern in requested:
        covered = [k for k in offered if model_matches(pattern, k)]
        if not covered:
            over.append(pattern)
            continue
        over.extend(k for k in covered if not is_allowed(k, granter))
    return list(dict.fromkeys(over))


@dataclass(frozen=True)
class Decision:
    """What the gateway does with one call: run `model` (the one asked for or the fallback),
    or refuse. `reason` names the blocking layer or "unknown_model"; `fell_back` is set when the
    fallback replaced a blocked model."""

    model: str | None
    reason: str | None = None
    fell_back: bool = False


def decide(key: str, limits: Limits, offered: list[str], fallbacks: list[str]) -> Decision:
    """Allow the model, else try the fallbacks in order (agent's own first, then the org's) -
    but only a fallback that is itself offered AND allowed for this person - else refuse."""
    if key in offered:  # the offered list is the source of truth
        layer = blocked_by(key, limits)
        if layer is None:
            return Decision(key)
    else:
        layer = "unknown_model"
    for fb in fallbacks:
        if fb in offered and is_allowed(fb, limits):
            return Decision(fb, reason=layer, fell_back=True)
    return Decision(None, reason=layer)
