import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Admin: only admins see the Admin item and page; the users table shows each user's
// tokens and cost, sorts and filters; a row opens that user's breakdown; roles change
// with confirmation, and the last admin can't be removed.
const API = "http://127.0.0.1:8765";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.setViewportSize({ width: 1280, height: 900 });
});

const emails = (page) => page.locator(".admin__table tbody .admin__email");

test("a plain user never sees the admin area", async ({ page }) => {
  await page.goto("/#/usage");
  await expect(page.locator(".sidebar").getByRole("link", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar").getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.goto("/#/admin");
  await expect(page.getByText("Not found")).toBeVisible();
  await expect(page.locator(".admin__table")).toHaveCount(0);
  await page.goto("/#/admin/users/u2");
  await expect(page.getByText("Not found")).toBeVisible();
  await expect(page.getByText("ada@example.com")).toHaveCount(0);
});

for (const scheme of ["light", "dark"]) {
  test(`admin sees every user's usage, in ${scheme}`, async ({ page, request }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await request.post(`${API}/__as_admin`);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/#/usage");
    await page.locator(".sidebar").getByRole("link", { name: "Admin" }).click();
    await expect(page).toHaveURL(/#\/admin$/);

    // Totals and the table, most expensive first.
    const totals = page.getByLabel("Platform totals for the period");
    await expect(totals).toContainText("3");
    await expect(totals).toContainText("~$3.17");
    await expect(emails(page)).toHaveText(["ada@example.com", "e2e@example.com", "bob@example.com"]);

    // Sort and filter.
    await page.getByLabel("Sort users by").selectOption("joined");
    await expect(emails(page)).toHaveText(["bob@example.com", "ada@example.com", "e2e@example.com"]);
    await page.getByLabel("Filter users by email").fill("ada");
    await expect(emails(page)).toHaveText(["ada@example.com"]);
    await page.getByLabel("Filter users by email").fill("");

    await page.screenshot({ path: `e2e/screenshots/admin-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "admin")).toEqual([]);

    // A user's full usage page.
    await page.getByRole("link", { name: "ada@example.com", exact: true }).click();
    await expect(page).toHaveURL(/#\/admin\/users\/u2$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("ada@example.com");
    await expect(page.getByText("2 projects")).toBeVisible();
    for (const title of ["Estimated cost per day", "By model", "By activity", "By project", "Recent runs"]) {
      await expect(page.locator(".panel__title", { hasText: title })).toBeVisible();
    }
    // Project names are labels, never links into someone else's project.
    const byProject = page.locator(".panel", { hasText: "By project" });
    await expect(byProject).toContainText("Untitled project · p1p1p1");
    await expect(byProject.getByRole("link")).toHaveCount(0);
    // A run opens to its agents.
    await page.locator(".urun__head").first().click();
    await expect(page.locator(".urun__detail")).toContainText("researcher");
    await page.screenshot({ path: `e2e/screenshots/admin-user-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "admin user")).toEqual([]);
    // One project narrows everything and hides the per-project table.
    await page.getByLabel("Filter by project").selectOption("p2p2p2p2");
    await expect(page.locator(".panel__title", { hasText: "By project" })).toHaveCount(0);
    await expect(page.getByLabel("Totals for the period")).toContainText("~$0.688");
    await page.getByRole("link", { name: "Back to all users" }).click();
    await expect(page).toHaveURL(/#\/admin$/);

    // The master admin's own role has no control.
    const meRow = page.locator("tr", { hasText: "e2e@example.com" });
    await expect(meRow).toContainText("Master admin");
    await expect(meRow.getByRole("button")).toHaveCount(0);

    // Make Ada an admin (confirmed), then remove it again.
    await page.getByRole("button", { name: "Make admin: ada@example.com" }).click();
    await expect(page.getByText("Give ada@example.com admin access to every user's usage?")).toBeVisible();
    await page.getByRole("group", { name: /Confirm role change for ada/ }).getByRole("button", { name: "Make admin" }).click();
    const adaRow = page.locator("tr", { hasText: "ada@example.com" });
    await expect(adaRow.getByText("Admin", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove admin: ada@example.com" }).click();
    await page.getByRole("group", { name: /Confirm role change for ada/ }).getByRole("button", { name: "Remove admin" }).click();
    await expect(adaRow.getByText("Admin", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("an ordinary admin sees usage but can't add or remove admins", async ({ page, request }) => {
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await request.post(`${API}/__as_sub_admin`);
  await page.goto("/#/admin");
  await expect(emails(page)).toHaveCount(3);
  await expect(page.getByText("Only the master admin adds and removes admins.")).toBeVisible();
  await expect(page.locator("tr", { hasText: "ada@example.com" })).toContainText("Master admin");
  await expect(page.locator("tr", { hasText: "e2e@example.com" })).toContainText("Admin");
  await expect(page.locator(".admin__table").getByRole("button", { name: /Make admin|Remove admin/ })).toHaveCount(0);
  await page.getByRole("link", { name: "bob@example.com", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("bob@example.com");
  await expect(page.getByRole("button", { name: /Make admin|Remove admin/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
