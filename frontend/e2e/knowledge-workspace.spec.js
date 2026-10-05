import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The workspace Knowledge page: every file across projects in one table — opened from the
// sidebar, upload to a chosen project, live indexing status, filters, the link to the
// project's Knowledge step, and delete; readable and accessible in both themes.
const API = "http://127.0.0.1:8765";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

const file = (name) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(`contents of ${name}`) });

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

for (const scheme of ["light", "dark"]) {
  test(`knowledge workspace in ${scheme}: see, add, filter and delete files across projects`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.emulateMedia({ colorScheme: scheme });

    await page.goto("/#/projects");
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    await expect(page).toHaveURL(/#\/knowledge$/);
    await expect(page.getByRole("heading", { name: "Knowledge", level: 1 })).toBeVisible();
    await expect(page.getByText("No files yet")).toBeVisible();
    expect(await axeProblems(page, "empty")).toEqual([]);

    // Two files to the travel project (one refused in the page), one to the second project.
    const project = page.getByRole("combobox", { name: /^Project/ });
    await project.selectOption({ label: "Travel agent for finding cheap flights" });
    await page.getByLabel("Choose files to add").setInputFiles([file("policy.pdf"), file("deck.pptx"), file("scan.pdf")]);
    await expect(page.getByText(/deck\.pptx: not a supported type/)).toBeVisible();
    await project.selectOption({ label: "Weekend budget planner" });
    await page.getByLabel("Choose files to add").setInputFiles([file("budget.csv")]);

    const rows = page.locator(".ktable tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(page.locator(".kstat", { hasText: "Failed" })).toContainText("1");
    await expect(rows.filter({ hasText: "scan.pdf" })).toContainText(/scanned PDFs need OCR/);
    await page.screenshot({ path: `e2e/screenshots/knowledge-workspace-indexing-${scheme}.png`, fullPage: true });

    // Polling picks up the finished indexing; the sidebar counts the files.
    await expect(rows.filter({ hasText: "policy.pdf" }).locator(".badge")).toHaveText("Ready", { timeout: 10_000 });
    await expect(rows.filter({ hasText: "budget.csv" }).locator(".badge")).toHaveText("Ready", { timeout: 10_000 });
    await expect(page.locator(".kstat", { hasText: "Passages" })).toContainText("8");
    await expect(page.getByRole("link", { name: /^Knowledge/ }).locator(".navitem__count")).toHaveText("3");
    // Ready files no agent can use yet are flagged on their project.
    await expect(rows.filter({ hasText: "policy.pdf" })).toContainText("Agents can't use yet");

    // Filters: name, project, status — and clearing them.
    await page.getByLabel("Search file names").fill("PDF");
    await expect(rows).toHaveCount(2);
    await page.getByLabel("Search file names").fill("");
    await page.getByLabel("Filter by project").selectOption({ label: "Weekend budget planner" });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("budget.csv");
    await page.getByLabel("Filter by project").selectOption("");
    await page.getByLabel("Filter by status").selectOption("failed");
    await expect(rows).toHaveCount(1);
    await page.getByLabel("Search file names").fill("nothing-like-this");
    await expect(page.getByText("No files match")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(3);

    await page.screenshot({ path: `e2e/screenshots/knowledge-workspace-ready-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "ready")).toEqual([]);

    await page.getByRole("button", { name: "Delete scan.pdf" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".kstat", { hasText: "Failed" })).toContainText("0");

    // A file's project links to that project's Knowledge step.
    await rows.filter({ hasText: "policy.pdf" }).getByRole("link", { name: "Travel agent for finding cheap flights" }).click();
    await expect(page).toHaveURL(/#\/projects\/e2e0travel0project\/knowledge$/);
    await expect(page.locator(".doclist").getByText("policy.pdf")).toBeVisible();

    expect(errors).toEqual([]);
  });
}
