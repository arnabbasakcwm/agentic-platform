import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Budgets: what each role sees, that you can only hand on what you hold, and the team Activity tab.
// The API enforces every rule again (backend/tests/test_budgets_api.py).
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

test("a group admin sees their own limit and splits their team's budget", async ({ page }) => {
  await page.goto("/#/budgets");
  await expect(page.getByRole("heading", { name: "Budgets", level: 1 })).toBeVisible();
  // their own limit: $85 of $100 used, so past 80%
  await expect(page.getByText("$15 left of $100")).toBeVisible();
  await expect(page.getByText("80% reached")).toBeVisible();
  // the team's budget and its members', not the pool or organisation above
  await expect(row(page, "Growth")).toContainText("$400");
  await expect(row(page, "ada@example.com")).toBeVisible();
  await expect(page.getByRole("row", { name: /Organisation/ })).toHaveCount(0);

  await row(page, "ada@example.com").getByRole("button", { name: /Change amount of user:u2/ }).click();
  await page.getByLabel("New amount in dollars for user:u2").fill("45");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "ada@example.com")).toContainText("$45");

  // a budget can never exceed what the one above holds
  await row(page, "ada@example.com").getByRole("button", { name: /Change amount of user:u2/ }).click();
  await page.getByLabel("New amount in dollars for user:u2").fill("9999");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("BudgetExceedsParent")).toBeVisible();
});

test("a group admin can allocate only from their team's budget, to its members", async ({ page }) => {
  await page.goto("/#/budgets");
  const form = page.getByRole("form", { name: "Allocate a budget" });
  await expect(form.getByLabel("Allocate from")).toContainText("Growth");
  await expect(form.getByLabel("Allocate from").locator("option")).toHaveCount(1);
  await expect(form.getByLabel("Give it to a").locator("option")).toHaveText(["Person"]);
  await expect(form.getByLabel("Who")).toContainText("ada@example.com");
  await expect(form.getByLabel("Who")).not.toContainText("bob@example.com"); // not in the team
});

test("a plain member sees their own limit and nothing to allocate", async ({ page, request }) => {
  await as(request, "user", { A: "member" });
  await page.goto("/#/budgets");
  await expect(page.getByText("$15 left of $100")).toBeVisible();
  await expect(page.getByRole("form", { name: "Allocate a budget" })).toHaveCount(0);
  await expect(page.getByText("Nothing to allocate")).toBeVisible();
  await expect(page.getByRole("button", { name: /Change amount/ })).toHaveCount(0);
});

test("the Super Admin sees the whole tree and hands budget to a new team", async ({ page, request }) => {
  await as(request, "master", {});
  await page.goto("/#/budgets");
  for (const name of ["Organisation", "Growth"]) await expect(row(page, name).first()).toBeVisible();
  await expect(row(page, "(pool)")).toBeVisible();
  const form = page.getByRole("form", { name: "Allocate a budget" });
  await form.getByLabel("Allocate from").selectOption({ index: 0 }); // the organisation
  await form.getByLabel("Give it to a").selectOption({ label: "Team" });
  await form.getByLabel("Who").selectOption({ label: "Support" });
  await form.getByLabel("Amount per period (USD)").fill("120.5");
  await form.getByRole("button", { name: "Allocate" }).click();
  await expect(row(page, "Support")).toContainText("$120.50");

  await row(page, "Support").getByRole("button", { name: "Remove budget team:B" }).click();
  await page.getByRole("group", { name: "Confirm removing team:B" }).getByRole("button", { name: "Remove" }).click();
  await expect(row(page, "Support")).toHaveCount(0);
});

test("a budget with people under it can't be removed until they are", async ({ page, request }) => {
  await as(request, "master", {});
  await page.goto("/#/budgets");
  await row(page, "Growth").getByRole("button", { name: "Remove budget team:A" }).click();
  await page.getByRole("group", { name: "Confirm removing team:A" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("BudgetHasChildren")).toBeVisible();
  await expect(row(page, "Growth")).toBeVisible();
});

test("a group admin reads their team's activity and the changes made to it", async ({ page }) => {
  await page.goto("/#/budgets");
  await row(page, "ada@example.com").getByRole("button", { name: /Change amount of user:u2/ }).click();
  await page.getByLabel("New amount in dollars for user:u2").fill("45");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "ada@example.com")).toContainText("$45");

  await page.goto("/#/teams/A");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Who used it" })).toBeVisible();
  await expect(row(page, "ada@example.com")).toContainText("Member");
  await expect(row(page, "e2e@example.com")).toContainText("Group admin");
  await expect(page.getByRole("heading", { name: "Recent changes" })).toBeVisible();
});

for (const scheme of ["light", "dark"]) {
  test(`the budgets page has no serious accessibility problems, ${scheme}`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await as(request, "master", {});
    await page.goto("/#/budgets");
    await expect(row(page, "Growth").first()).toBeVisible();
    await settled(page);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual([]);
  });
}
