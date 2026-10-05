import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Deleting a project from the Projects page: the trash button asks for confirmation in
// place (and never opens the project), Keep backs out, Delete removes the project and its
// files everywhere in the console.
const API = "http://127.0.0.1:8765";
const TITLE = "Travel agent for finding cheap flights";

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

for (const scheme of ["light", "dark"]) {
  test(`delete a project from the Projects page in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });

    // Give the project a knowledge file, so deleting it is seen to take the file too.
    await page.goto("/#/knowledge");
    await page.getByLabel("Choose files to add").setInputFiles([
      { name: "policy.md", mimeType: "text/markdown", buffer: Buffer.from("# Policy") },
    ]);
    await expect(page.getByRole("link", { name: /^Knowledge/ }).locator(".navitem__count")).toHaveText("1");

    await page.getByRole("link", { name: "Projects", exact: false }).first().click();
    const row = page.locator(".table tbody tr", { hasText: TITLE });
    await expect(row).toBeVisible();

    // The trash button asks first and doesn't navigate into the project.
    await row.getByRole("button", { name: `Delete ${TITLE}` }).click();
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(row).toContainText("Delete project and its files?");
    await page.screenshot({ path: `e2e/screenshots/projects-delete-confirm-${scheme}.png` });
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const bad = results.violations.filter((v) => ["serious", "critical"].includes(v.impact));
    expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);

    await row.getByRole("button", { name: "Keep" }).click();
    await expect(row.getByRole("button", { name: `Delete ${TITLE}` })).toBeVisible();

    await row.getByRole("button", { name: `Delete ${TITLE}` }).click();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("No projects yet")).toBeVisible();
    // Gone from the sidebar's recent list and its file from the knowledge count.
    await expect(page.locator(".sidebar__recent")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Knowledge/ }).locator(".navitem__count")).toHaveCount(0);

    expect(errors).toEqual([]);
  });
}
