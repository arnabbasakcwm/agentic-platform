import { describe, expect, it } from "vitest";
import { parseRoute, paths } from "./router.js";

describe("usage routes", () => {
  it("opens a breakdown tab, defaulting to models", () => {
    expect(parseRoute("#/usage")).toEqual({ page: "usage", tab: "models" });
    expect(parseRoute("#/usage/runs")).toEqual({ page: "usage", tab: "runs" });
    expect(parseRoute("#/usage/nope").tab).toBe("models");
    expect(paths.usageTab("activity")).toBe("#/usage/activity");
  });
});

describe("admin routes", () => {
  it("opens the user list or one user's usage", () => {
    expect(parseRoute("#/admin")).toEqual({ page: "admin" });
    expect(parseRoute("#/admin/users")).toEqual({ page: "admin" });
    expect(parseRoute("#/admin/users/u2")).toEqual({ page: "adminUser", id: "u2" });
    expect(paths.adminUser("u2")).toBe("#/admin/users/u2");
  });
});

describe("project routes", () => {
  it("opens a Resources tab, defaulting to documents", () => {
    expect(parseRoute("#/projects/p1/resources/tools")).toEqual({
      page: "project",
      id: "p1",
      step: "resources",
      tab: "tools",
    });
    expect(parseRoute("#/projects/p1/resources").tab).toBe("documents");
    expect(parseRoute("#/projects/p1/resources/nope").tab).toBe("documents");
  });

  it("sends the old Knowledge and Data steps to their tabs", () => {
    expect(parseRoute("#/projects/p1/knowledge")).toMatchObject({
      step: "resources",
      tab: "documents",
    });
    expect(parseRoute("#/projects/p1/data")).toMatchObject({
      step: "resources",
      tab: "databases",
    });
  });

  it("keeps the other steps and falls back to the plan", () => {
    expect(parseRoute("#/projects/p1/run").step).toBe("run");
    expect(parseRoute("#/projects/p1/whatever").step).toBe("plan");
  });

  it("builds links with an optional tab", () => {
    expect(paths.project("p1", "resources", "tools")).toBe(
      "#/projects/p1/resources/tools",
    );
    expect(paths.project("p1", "run")).toBe("#/projects/p1/run");
  });
});

describe("team and budget routes", () => {
  it("opens the team list, one team, and the budgets", () => {
    expect(parseRoute("#/teams")).toEqual({ page: "teams" });
    expect(parseRoute("#/teams/t1")).toEqual({ page: "team", id: "t1" });
    expect(parseRoute("#/budgets")).toEqual({ page: "budgets" });
    expect(paths.team("a b")).toBe("#/teams/a%20b");
    expect(paths.teams).toBe("#/teams");
  });
});
