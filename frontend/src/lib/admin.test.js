import { describe, expect, it } from "vitest";
import { canChangeRole, isAdminRole, roleBadge, visibleUsers } from "./admin.js";

const users = [
  {
    id: "1",
    email: "ada@x.com",
    role: "user",
    cost: 2,
    input_tokens: 10,
    output_tokens: 1,
    last_active: "2026-10-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
  },
  {
    id: "2",
    email: "bob@x.com",
    role: "admin",
    cost: 5,
    input_tokens: 1,
    output_tokens: 0,
    last_active: null,
    created_at: "2026-09-05T00:00:00Z",
  },
  {
    id: "3",
    email: "cy@y.com",
    role: "user",
    cost: 2,
    input_tokens: 500,
    output_tokens: 50,
    last_active: "2026-10-05T00:00:00Z",
    created_at: "2026-09-03T00:00:00Z",
  },
];

describe("admin users table", () => {
  it("sorts by cost by default, ties by email", () => {
    expect(visibleUsers(users).map((u) => u.id)).toEqual(["2", "1", "3"]);
  });

  it("sorts by tokens, last active and joined", () => {
    expect(visibleUsers(users, { key: "tokens" }).map((u) => u.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
    expect(visibleUsers(users, { key: "active" }).map((u) => u.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
    expect(visibleUsers(users, { key: "joined" }).map((u) => u.id)).toEqual([
      "2",
      "3",
      "1",
    ]);
  });

  it("filters by email and doesn't change the input", () => {
    expect(visibleUsers(users, { query: " X.COM " }).map((u) => u.id)).toEqual([
      "2",
      "1",
    ]);
    expect(users.map((u) => u.id)).toEqual(["1", "2", "3"]);
  });

  it("lets only the master change roles, never the master's own", () => {
    const master = { id: "m", role: "master" };
    const admin = { id: "a", role: "admin" };
    const user = { id: "u", role: "user" };
    expect(canChangeRole(master, admin)).toBe(true);
    expect(canChangeRole(master, user)).toBe(true);
    expect(canChangeRole(master, master)).toBe(false);
    expect(canChangeRole(admin, user)).toBe(false);
    expect(canChangeRole(admin, { id: "b", role: "admin" })).toBe(false);
    expect(canChangeRole(null, user)).toBe(false);
  });

  it("names roles", () => {
    expect([isAdminRole("master"), isAdminRole("admin"), isAdminRole("user")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(roleBadge("master")).toBe("Master admin");
    expect(roleBadge("admin")).toBe("Admin");
    expect(roleBadge("user")).toBeNull();
  });
});
