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
