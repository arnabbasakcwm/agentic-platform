import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Sharing a project from its header: who is offered, what a share looks like, changing and removing
// it, and who gets the Share button at all. The API enforces every rule again.
const API = "http://127.0.0.1:8765";
const URL = "/#/projects/e2e0travel0project/plan";

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

const dialog = (page) => page.getByRole("dialog", { name: "Share this project" });
const openShare = async (page) => {
  await page.goto(URL);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
};

test("the owner shares with a person, changes the level, and takes the share away", async ({ page }) => {
  await openShare(page);
  const d = dialog(page);
  await expect(d.getByText("Only you")).toBeVisible();
  // offered: the teams and people in scope, never the owner
  const options = await d.getByLabel("Share with").locator("option").allTextContents();
  expect(options).toEqual(expect.arrayContaining(["Growth", "ada@example.com", "bob@example.com"]));
  expect(options).not.toContain("e2e@example.com");

  await d.getByLabel("Share with").selectOption({ label: "ada@example.com" });
  await d.getByLabel("Level").selectOption("use");
  await expect(d.getByText("Can run it, and sees only their own runs")).toBeVisible();
  await d.getByRole("button", { name: "Share", exact: true }).click();
  const row = d.getByRole("row").filter({ hasText: "ada@example.com" });
  await expect(row).toContainText("Whole project");
  await expect(row.getByRole("combobox")).toHaveValue("use");

  await row.getByRole("combobox").selectOption("edit");
  await expect(row.getByRole("combobox")).toHaveValue("edit");

  await row.getByRole("button", { name: /Stop sharing with ada@example.com/ }).click();
  await d.getByRole("group", { name: /Confirm: stop sharing/ }).getByRole("button", { name: "Stop sharing" }).click();
  await expect(d.getByText("Only you")).toBeVisible();
});

test("one agent can be shared on its own, and a team too", async ({ page }) => {
  await openShare(page);
  const d = dialog(page);
  await d.getByLabel("Share with").selectOption({ label: "Growth" });
  await d.getByLabel("What").selectOption({ label: "Agent: price_analyzer" });
  await d.getByLabel("Level").selectOption("view");
  await d.getByRole("button", { name: "Share", exact: true }).click();
  const row = d.getByRole("row").filter({ hasText: "Growth (team)" });
  await expect(row).toContainText("price_analyzer");
  await expect(row.getByRole("combobox")).toHaveValue("view");
  // the same team on the whole project is a separate grant, so a separate row
  await d.getByLabel("Share with").selectOption({ label: "Growth" });
  await d.getByLabel("What").selectOption({ label: "Whole project" });
  await d.getByRole("button", { name: "Share", exact: true }).click();
  await expect(d.getByRole("row").filter({ hasText: "Growth (team)" })).toHaveCount(2);
});

test("a refusal from the API is shown, not swallowed", async ({ page }) => {
  await openShare(page);
  const d = dialog(page);
  await page.route("**/projects/*/grants", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error_type: "NotFound", message: "not found", details: null }) })
      : route.continue(),
  );
  await d.getByLabel("Share with").selectOption({ label: "bob@example.com" });
  await d.getByRole("button", { name: "Share", exact: true }).click();
  await expect(d.getByText("not found")).toBeVisible();
});

test("Escape closes the dialog", async ({ page }) => {
  await openShare(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
});

for (const [level, shown] of [["owner", true], ["manage", true], ["edit", false], ["use", false], ["view", false]]) {
  test(`the Share button is ${shown ? "offered" : "not offered"} at the ${level} level`, async ({ page, request }) => {
    await request.post(`${API}/__access_as`, { data: { orgRole: "user", projectLevel: level, teams: {} } });
    await page.goto(URL);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(shown ? 1 : 0);
  });
}

for (const scheme of ["light", "dark"]) {
  test(`the Share dialog has no serious accessibility problems, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openShare(page);
    const d = dialog(page);
    await d.getByLabel("Share with").selectOption({ label: "ada@example.com" });
    await d.getByRole("button", { name: "Share", exact: true }).click();
    await expect(d.getByRole("row").filter({ hasText: "ada@example.com" })).toBeVisible();
    await settled(page);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual([]);
  });
}
