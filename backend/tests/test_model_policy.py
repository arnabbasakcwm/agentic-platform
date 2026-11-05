"""Model privileges: the intersection, the no-escalation check and the fallback decision (P4.2)."""

from agentic_platform.model_policy import Limits, blocked_by, decide, effective_models, escalations, is_allowed, limits_for
from agentic_platform.stores import InMemoryModelPolicyStore, ModelAllowlist, OrgModelSettings

OFFERED = ["openai/gpt-5", "openai/gpt-mini", "groq/llama", "google_genai/gem", "bedrock/b1"]


def lim(org=None, **layers):
    return Limits(org=tuple(org) if org is not None else None, layers=tuple((k, tuple(v)) for k, v in layers.items()))


def test_no_limits_means_everything_offered():
    assert effective_models(OFFERED, lim()) == OFFERED


def test_org_catalog_narrows_the_platform_list():
    assert effective_models(OFFERED, lim(org=["openai/*", "groq/llama"])) == ["openai/gpt-5", "openai/gpt-mini", "groq/llama"]


def test_the_result_is_the_intersection_of_every_layer():
    limits = lim(org=["openai/*", "groq/*"], team=["openai/gpt-5", "groq/llama", "bedrock/b1"], user=["openai/*", "bedrock/b1"])
    # org drops bedrock; team drops gpt-mini; user drops groq
    assert effective_models(OFFERED, limits) == ["openai/gpt-5"]


def test_a_missing_layer_is_no_limit_but_an_empty_one_is_no_model():
    assert effective_models(OFFERED, lim(team=["groq/*"])) == ["groq/llama"]
    assert effective_models(OFFERED, lim(team=[])) == []
    assert effective_models(OFFERED, lim(org=[])) == []


def test_blocked_by_names_the_first_layer_that_stops_the_model():
    limits = lim(org=["openai/*", "groq/*"], team=["openai/*"], member=["openai/gpt-5"], user=["openai/*"])
    assert blocked_by("openai/gpt-5", limits) is None
    assert blocked_by("bedrock/b1", limits) == "org"
    assert blocked_by("groq/llama", limits) == "team"
    assert blocked_by("openai/gpt-mini", limits) == "member"
    assert blocked_by("openai/gpt-5", lim(user=["groq/*"])) == "user"
    assert not is_allowed("nothing/here", lim(org=["openai/*"]))


def test_limits_for_reads_the_layers_that_apply_to_this_person_and_team(monkeypatch):
    store = InMemoryModelPolicyStore()
    store.set_org(OrgModelSettings(catalog=["openai/*", "groq/*"]))
    for scope, sid, models in [("team", "A", ["openai/*"]), ("team", "B", ["groq/*"]),
                               ("member", "A:u1", ["openai/gpt-5"]), ("user", "u1", ["openai/*", "groq/*"])]:
        store.set_allowlist(ModelAllowlist(id=f"{scope}:{sid}", scope_type=scope, scope_id=sid, models=models, set_by="r"))
    assert effective_models(OFFERED, limits_for(store, "u1", "A")) == ["openai/gpt-5"]  # all four layers
    assert effective_models(OFFERED, limits_for(store, "u1", "B")) == ["groq/llama"]  # team B; no member limit there
    assert effective_models(OFFERED, limits_for(store, "u1", None)) == ["openai/gpt-5", "openai/gpt-mini", "groq/llama"]  # no team context
    assert effective_models(OFFERED, limits_for(store, "u2", "A")) == ["openai/gpt-5", "openai/gpt-mini"]  # someone else's member limit is not theirs


def test_escalation_check_rejects_models_the_granter_lacks_and_models_that_do_not_exist():
    granter = lim(org=["openai/*", "groq/*"], team=["openai/*"])
    assert escalations(["openai/gpt-5"], OFFERED, granter) == []
    assert escalations(["openai/*"], OFFERED, granter) == []
    assert escalations(["groq/llama"], OFFERED, granter) == ["groq/llama"]  # not in the granter's team set
    assert escalations(["groq/*"], OFFERED, granter) == ["groq/llama"]
    assert escalations(["bedrock/b1"], OFFERED, granter) == ["bedrock/b1"]
    assert escalations(["ghost/model"], OFFERED, granter) == ["ghost/model"]  # nobody grants what does not exist
    assert escalations([], OFFERED, granter) == []
    assert escalations(["openai/gpt-5", "openai/gpt-5", "groq/llama"], OFFERED, granter) == ["groq/llama"]


def test_decide_allows_falls_back_or_refuses():
    limits = lim(org=["openai/*", "groq/*"], team=["openai/*"])
    assert decide("openai/gpt-5", limits, OFFERED, ["groq/llama"]) == decide("openai/gpt-5", limits, OFFERED, [])
    assert decide("openai/gpt-5", limits, OFFERED, []).model == "openai/gpt-5"
    blocked = decide("bedrock/b1", limits, OFFERED, [])
    assert blocked.model is None and blocked.reason == "org" and not blocked.fell_back
    used = decide("bedrock/b1", limits, OFFERED, ["groq/llama", "openai/gpt-mini"])  # first is not allowed for this person
    assert used.model == "openai/gpt-mini" and used.fell_back and used.reason == "org"
    assert decide("bedrock/b1", limits, OFFERED, ["groq/llama"]).model is None  # the fallback is blocked too
    assert decide("bedrock/b1", limits, OFFERED, ["ghost/x"]).model is None  # and it must exist
    unknown = decide("ghost/x", lim(), OFFERED, [])
    assert unknown.model is None and unknown.reason == "unknown_model"
    assert decide("ghost/x", lim(), OFFERED, ["groq/llama"]).model == "groq/llama"
