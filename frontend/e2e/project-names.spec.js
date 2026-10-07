import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Project names: set one when creating a project, and rename with the pencil from the
// project page, the Projects list and the planner's reply; the new name shows everywhere.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
});

for (const scheme of ["light", "dark"]) {
  test(`rename from the project page, in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/#/projects/${PROJECT}/plan`);
    const header = page.locator(".pagehead");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Travel agent for finding cheap flights");

    // Escape cancels.
    await header.getByRole("button", { name: "Rename Travel agent for finding cheap flights" }).click();
    await page.getByLabel("Project name").fill("Never saved");
    await page.getByLabel("Project name").press("Escape");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Travel agent for finding cheap flights");

    await header.getByRole("button", { name: /^Rename/ }).click();
    await page.getByLabel("Project name").fill("Diwali flights");
    await page.screenshot({ path: `e2e/screenshots/rename-editing-${scheme}.png` });
    expect(await axeProblems(page, "editing")).toEqual([]);
    await page.getByLabel("Project name").press("Enter");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Diwali flights");
    // Everywhere else follows: breadcrumb and sidebar.
    await expect(page.locator(".topbar")).toContainText("Diwali flights");
    await expect(page.locator(".sidebar__recent")).toContainText("Diwali flights");
    await page.screenshot({ path: `e2e/screenshots/rename-done-${scheme}.png` });
    expect(await axeProblems(page, "renamed")).toEqual([]);

    // Saving an empty name goes back to the brief's first line.
    await header.getByRole("button", { name: /^Rename/ }).click();
    await page.getByLabel("Project name").fill("");
    await header.getByRole("button", { name: "Save name" }).click();
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Travel agent for finding cheap flights");
    expect(errors).toEqual([]);
  });
}

test("rename from the Projects list without opening the project", async ({ page }) => {
  await page.goto("/#/projects");
  const row = page.locator(".table tbody tr").first();
  await row.getByRole("button", { name: /^Rename/ }).click();
  await expect(page).toHaveURL(/#\/projects$/); // the row didn't open
  await row.getByLabel("Project name").fill("Budget flights");
  await row.getByRole("button", { name: "Save name" }).click();
  await expect(row.getByRole("link", { name: "Budget flights" })).toBeVisible();
  await expect(page.locator(".sidebar__recent")).toContainText("Budget flights");
});

test("name a project when creating it, and rename it from the reply", async ({ page, request }) => {
  await page.goto("/#/new");
  await page.getByRole("button", { name: /Auto team size/ }).click();
  await page.getByLabel("Name", { exact: true }).fill("Goa getaway");
  await page.getByLabel("Task description").fill("Find cheap flights to Goa");
  await page.getByRole("button", { name: "Plan this team" }).click();
  const reply = page.locator(".msg--assistant").last();
  await expect(reply).toContainText("Goa getaway");
  expect((await (await request.get(`${API}/__last_create`)).json()).name).toBe("Goa getaway");
  // The name field is cleared for the next project.
  if (!(await page.getByLabel("Name", { exact: true }).isVisible())) {
    await page.getByRole("button", { name: /Auto team size/ }).click();
  }
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");

  await reply.getByRole("button", { name: "Rename Goa getaway" }).click();
  await reply.getByLabel("Project name").fill("Goa in December");
  await reply.getByLabel("Project name").press("Enter");
  await expect(reply).toContainText("Goa in December");
});
