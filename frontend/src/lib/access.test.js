import { describe, expect, it } from "vitest";
import {
  LEVELS,
  accessErrorInfo,
  budgetScopeLabel,
  canEditProject,
  canManageProject,
  canRunProject,
  canShareProject,
  formatMicro,
  levelRank,
  meter,
  microToDollars,
  parseDollars,
  teamRoleLabel,
} from "./access.js";

describe("money", () => {
  it("formats whole micro-USD", () => {
    expect(formatMicro(12_500_000)).toBe("$12.50");
    expect(formatMicro(250_000_000)).toBe("$250");
    expect(formatMicro(15_000_000)).toBe("$15");
    expect(formatMicro(120_500_000)).toBe("$120.50"); // not rounded to $121
    expect(formatMicro(2_000)).toBe("$0.0020");
    expect(formatMicro(0)).toBe("$0.0000");
    expect(formatMicro(null)).toBe("—");
  });

  it("parses amounts exactly, without floats", () => {
    expect(parseDollars("12.5")).toBe(12_500_000);
    expect(parseDollars(" 0.000001 ")).toBe(1);
    expect(parseDollars("3")).toBe(3_000_000);
    expect(parseDollars("0.1")).toBe(100_000);
    expect(parseDollars("1.0000001")).toBeNull(); // more than 6 decimals
    for (const bad of ["", "-1", "1,5", "abc", "1e3", ".5", "1."]) expect(parseDollars(bad)).toBeNull();
  });

  it("round-trips an amount through the edit field", () => {
    for (const micro of [0, 1, 100_000, 12_500_000, 7_000_001]) {
      expect(parseDollars(microToDollars(micro))).toBe(micro);
    }
    expect(microToDollars(12_500_000)).toBe("12.5");
    expect(microToDollars(3_000_000)).toBe("3");
  });
});

describe("meter", () => {
  it("turns amber at 80% and red at 100%", () => {
    expect(meter({ amount: 100, remaining: 100 })).toEqual({ percent: 0, width: 0, tone: "ok" });
    expect(meter({ amount: 100, remaining: 20 }).tone).toBe("warn");
    expect(meter({ amount: 100, remaining: 0 }).tone).toBe("danger");
  });
  it("caps the bar when a soft budget goes over, and survives a zero budget", () => {
    const over = meter({ amount: 100, remaining: -50 });
    expect(over.width).toBe(100);
    expect(over.percent).toBe(150);
    expect(meter({ amount: 0, remaining: 0 }).tone).toBe("ok");
    expect(meter({ amount: 0, remaining: -1 }).tone).toBe("danger");
  });
});

describe("levels and roles", () => {
  it("ranks levels cumulatively", () => {
    expect(LEVELS.map(levelRank)).toEqual([1, 2, 3, 4]);
    expect(levelRank("nonsense")).toBe(0);
  });
  it("labels team roles", () => {
    expect(teamRoleLabel("group_admin")).toBe("Group admin");
    expect(teamRoleLabel("member")).toBe("Member");
  });
});

describe("what to offer", () => {
  it("follows the access level the API reports", () => {
    expect(canRunProject({ access_level: "view" })).toBe(false);
    expect(canRunProject({ access_level: "use" })).toBe(true);
    expect(canEditProject({ access_level: "use" })).toBe(false);
    expect(canEditProject({ access_level: "edit" })).toBe(true);
    expect(canShareProject({ access_level: "edit" })).toBe(false);
    expect(canShareProject({ access_level: "manage" })).toBe(true);
    expect(canManageProject({ access_level: "owner" })).toBe(true);
    expect(canManageProject({ access_level: "manage", can_manage: false })).toBe(false);
  });
  it("offers nothing for an unknown project", () => {
    for (const f of [canRunProject, canEditProject, canShareProject, canManageProject]) {
      expect(f(null)).toBe(false);
      expect(f({})).toBe(false);
    }
  });
});

describe("run errors", () => {
  it("explains the access errors and ignores the rest", () => {
    expect(accessErrorInfo("BUDGET_EXCEEDED").title).toMatch(/budget/i);
    expect(accessErrorInfo("MODEL_NOT_PERMITTED", "no").detail).toBe("no");
    expect(accessErrorInfo("AccessRevokedError").title).toMatch(/access/i);
    expect(accessErrorInfo("RunTimeout")).toBeNull();
    expect(accessErrorInfo(undefined)).toBeNull();
  });
  it("names the budget that ran out", () => {
    expect(budgetScopeLabel("user:abc")).toBe("Your own budget");
    expect(budgetScopeLabel("team:T")).toBe("Your team's budget");
    expect(budgetScopeLabel("org")).toBe("The organisation's budget");
    expect(budgetScopeLabel(undefined)).toBe("A budget");
  });
});

import { CHILD_KINDS, allocatableParents, budgetLabel, budgetTree } from "./access.js";

const node = (id, parent, type = id.split(":")[0]) => ({ id, parent_id: parent, scope_type: type, scope_id: id.split(":")[1] ?? "org" });
const NODES = [
  node("user:u1", "team:A"),
  node("team:A", "pool:sub"),
  node("pool:sub", "org"),
  node("org", null),
  node("user:u2", "team:A"),
  node("team:B", "org"),
];

describe("budget tree", () => {
  it("orders parents before children with their depth", () => {
    const tree = budgetTree(NODES);
    expect(tree.map((n) => [n.id, n.depth])).toEqual([
      ["org", 0],
      ["pool:sub", 1],
      ["team:A", 2],
      ["user:u1", 3],
      ["user:u2", 3],
      ["team:B", 1],
    ]);
  });
  it("treats a node whose parent isn't visible as a root", () => {
    const part = budgetTree(NODES.filter((n) => n.id.startsWith("team:A") || n.id.startsWith("user:")));
    expect(part.map((n) => [n.id, n.depth])).toEqual([["team:A", 0], ["user:u1", 1], ["user:u2", 1]]);
  });
  it("mirrors which kinds may contain which", () => {
    expect(CHILD_KINDS.org).toEqual(["pool", "team", "user"]);
    expect(CHILD_KINDS.team).toEqual(["user"]);
    expect(CHILD_KINDS.user).toEqual([]);
  });
});

describe("what you may allocate from", () => {
  it("lets the Super Admin allocate from any non-person budget", () => {
    expect(allocatableParents(NODES, { id: "root", role: "master" }).map((n) => n.id).sort()).toEqual(["org", "pool:sub", "team:A", "team:B"]);
  });
  it("lets a Sub Admin allocate only from their pool and below", () => {
    expect(allocatableParents(NODES, { id: "sub", role: "admin" }).map((n) => n.id).sort()).toEqual(["pool:sub", "team:A"]);
    expect(allocatableParents(NODES, { id: "other", role: "admin" })).toEqual([]);
  });
  it("lets a group admin split only their own team's budget", () => {
    const teams = [{ id: "A", my_role: "group_admin" }, { id: "B", my_role: "member" }];
    expect(allocatableParents(NODES, { id: "ga", role: "user" }, teams).map((n) => n.id)).toEqual(["team:A"]);
    expect(allocatableParents(NODES, { id: "m", role: "user" }, [{ id: "A", my_role: "member" }])).toEqual([]);
  });
});

describe("budget labels", () => {
  it("names teams and people when known", () => {
    const ctx = { teams: [{ id: "A", name: "Growth" }], users: [{ id: "u1", email: "ann@example.com" }] };
    expect(budgetLabel(node("org", null), ctx)).toBe("Organisation");
    expect(budgetLabel(node("team:A", "org"), ctx)).toBe("Growth");
    expect(budgetLabel(node("user:u1", "team:A"), ctx)).toBe("ann@example.com");
    expect(budgetLabel(node("pool:u1", "org"), ctx)).toBe("ann@example.com (pool)");
    expect(budgetLabel(node("user:abcdefgh", "org"), ctx)).toBe("abcdef…");
    expect(budgetLabel(node("team:Z", "org"), ctx)).toBe("Team Z");
  });
});

import { modelLabel, summarizeLimit, toggleRef } from "./access.js";

describe("model limits", () => {
  it("labels models by provider", () => {
    expect(modelLabel("bedrock/openai.gpt-oss-120b-1:0")).toBe("Amazon Bedrock · openai.gpt-oss-120b-1:0");
    expect(modelLabel("google_genai/gemini-3.1-pro-preview")).toBe("Google · gemini-3.1-pro-preview");
    expect(modelLabel("groq/*")).toBe("Groq · all models");
    expect(modelLabel("newprovider/x")).toBe("newprovider · x");
    expect(modelLabel("nonsense")).toBe("nonsense");
  });
  it("toggles a model in a list without mutating it", () => {
    const list = ["a/1"];
    expect(toggleRef(list, "b/2")).toEqual(["a/1", "b/2"]);
    expect(toggleRef(["a/1", "b/2"], "a/1")).toEqual(["b/2"]);
    expect(list).toEqual(["a/1"]);
  });
  it("tells no limit from an empty or ordered list", () => {
    expect(summarizeLimit(null)).toBe("no-limit");
    expect(summarizeLimit(undefined)).toBe("no-limit");
    expect(summarizeLimit([])).toBe("only:");
    expect(summarizeLimit(["b/2", "a/1"])).toBe(summarizeLimit(["a/1", "b/2"]));
    expect(summarizeLimit([])).not.toBe(summarizeLimit(null)); // an empty list means NO model
  });
});
