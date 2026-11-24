import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Teams: who sees what, who may change what. The API enforces every rule again; these checks cover
// what the console offers each role and that what it offers works.
const API = "http://127.0.0.1:8765";

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
});
test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

const as = (request, orgRole, teams) => request.post(`${API}/__access_as`, { data: { orgRole, teams } });
const row = (page, text) => page.getByRole("row").filter({ hasText: text });

async function noSeriousViolations(page) {
  await settled(page); // entry animations tint colours mid-flight
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual([]);
}

test("a group admin sees their teams, and manages the members of the one they administer", async ({ page }) => {
  await page.goto("/#/teams");
  await expect(page.getByRole("link", { name: /^Teams/ })).toBeVisible(); // in the sidebar
  await expect(page.getByRole("heading", { name: "Teams", level: 1 })).toBeVisible();
  await expect(page.getByRole("form", { name: "New team" })).toHaveCount(0); // only the Super Admin makes teams
  await expect(row(page, "Growth")).toContainText("Group admin");
  await expect(row(page, "Default")).toContainText("Member");
  await expect(page.getByRole("row", { name: /Support/ })).toHaveCount(0); // a team they are not in

  await page.getByRole("link", { name: "Growth" }).click();
  await expect(page.getByRole("heading", { name: "Growth", level: 1 })).toBeVisible();
  await expect(row(page, "ada@example.com")).toContainText("Member");
  await expect(page.getByRole("form", { name: "Add a member" })).toHaveCount(0); // adding people is the Super Admin's
  await expect(page.getByRole("button", { name: /Delete team/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Make ada@example.com a group admin" }).click();
  await page.getByRole("group", { name: /Confirm: Make ada@example.com a group admin/ }).getByRole("button", { name: "Make group admin" }).click();
  await expect(row(page, "ada@example.com")).toContainText("Group admin");
  // a peer admin can't be removed or demoted by another group admin; they can only step down themselves
  await expect(page.getByRole("button", { name: "Remove ada@example.com from the team" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove admin role", exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Step down as group admin" })).toBeVisible();

  await page.getByRole("button", { name: "Step down as group admin" }).click();
  await page.getByRole("group", { name: /Confirm: Step down/ }).getByRole("button", { name: "Step down" }).click();
  // having stepped down they are an ordinary member: the member list is no longer theirs to see
  await expect(page.getByText("Members aren't listed for you")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("a plain member sees their team but not its people", async ({ page, request }) => {
  await as(request, "user", { A: "member" });
  await page.goto("/#/teams");
  await expect(row(page, "Growth")).toContainText("Member");
  await page.getByRole("link", { name: "Growth" }).click();
  await expect(page.getByText("Members aren't listed for you")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Rename/ })).toHaveCount(0);
});

test("someone in no team is not offered Teams at all", async ({ page, request }) => {
  await as(request, "user", { A: null, default: null });
  await page.goto("/#/projects");
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Teams/ })).toHaveCount(0);
  await page.goto("/#/teams");
  await expect(page.getByText("You aren't in a team yet")).toBeVisible();
});

test("the Super Admin creates, fills, renames and deletes a team", async ({ page, request }) => {
  await as(request, "master", {});
  await page.goto("/#/teams");
  await expect(page.getByRole("row", { name: /Support/ })).toBeVisible(); // sees every team
  await page.getByLabel("Team name").fill("Platform");
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(row(page, "Platform")).toBeVisible();

  await page.getByRole("link", { name: "Growth" }).click();
  await page.getByRole("button", { name: "Add a person" }).click();
  await page.getByRole("option", { name: "bob@example.com" }).click();
  await page.getByRole("button", { name: "Add to team" }).click();
  await expect(row(page, "bob@example.com")).toContainText("Member");

  await page.getByRole("button", { name: "Remove bob@example.com from the team" }).click();
  await page.getByRole("group", { name: /Confirm: Remove bob@example.com/ }).getByRole("button", { name: "Remove" }).click();
  await expect(row(page, "bob@example.com")).toHaveCount(0);

  await page.getByLabel("Team name").fill("Growth & Revenue");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("heading", { name: "Growth & Revenue", level: 1 })).toBeVisible();

  await page.goto("/#/teams");
  await page.getByRole("link", { name: "Platform", exact: true }).click();
  await page.getByRole("button", { name: "Delete team Platform" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/#\/teams$/);
  await expect(page.getByRole("row", { name: /Platform/ })).toHaveCount(0);
});

test("the Default team can be renamed but not deleted", async ({ page, request }) => {
  await as(request, "master", {});
  await page.goto("/#/teams/default");
  await expect(page.getByRole("heading", { name: "Default", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete team/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
});

for (const scheme of ["light", "dark"]) {
  test(`team pages have no serious accessibility problems, ${scheme}`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await as(request, "master", {});
    await page.goto("/#/teams");
    await expect(row(page, "Growth")).toBeVisible();
    await noSeriousViolations(page);
    await page.goto("/#/teams/A");
    await expect(row(page, "ada@example.com")).toBeVisible();
    await noSeriousViolations(page);
  });
}
