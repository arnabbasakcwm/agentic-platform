import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The Knowledge library page: upload files with no project, attach one file to several
// projects from the table, filter, follow a project link, and delete from the library —
// readable and accessible in both themes.
const API = "http://127.0.0.1:8765";
const TRAVEL = "Travel agent for finding cheap flights";
const BUDGET = "Weekend budget planner";

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
  test(`knowledge library in ${scheme}: upload without a project, attach, filter, delete`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });

    await page.goto("/#/projects");
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    await expect(page).toHaveURL(/#\/knowledge$/);
    await expect(page.getByRole("heading", { name: "Knowledge", level: 1 })).toBeVisible();
    await expect(page.getByText("No files yet")).toBeVisible();
    expect(await axeProblems(page, "empty")).toEqual([]);

    // No project needed: the default is "library only". One file is refused in the page.
    await expect(page.getByRole("combobox", { name: /^Attach to/ })).toHaveValue("");
    await page.getByLabel("Choose files to add").setInputFiles([file("policy.pdf"), file("deck.pptx"), file("scan.pdf")]);
    await expect(page.getByText(/deck\.pptx: not a supported type/)).toBeVisible();
    // A second upload attached straight to a project.
    await page.getByRole("combobox", { name: /^Attach to/ }).selectOption({ label: BUDGET });
    await page.getByLabel("Choose files to add").setInputFiles([file("budget.csv")]);

    const rows = page.locator(".ktable tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "policy.pdf" })).toContainText("Library only");
    await expect(rows.filter({ hasText: "budget.csv" })).toContainText(BUDGET);
    await expect(rows.filter({ hasText: "scan.pdf" })).toContainText(/scanned PDFs need OCR/);
    await page.screenshot({ path: `e2e/screenshots/knowledge-workspace-indexing-${scheme}.png`, fullPage: true });

    await expect(rows.filter({ hasText: "policy.pdf" }).locator(".badge")).toHaveText("Ready", { timeout: 10_000 });
    await expect(page.locator(".kstat", { hasText: "Passages" })).toContainText("8", { timeout: 10_000 });
    await expect(page.getByRole("link", { name: /^Knowledge/ }).locator(".navitem__count")).toHaveText("3");

    // Attach policy.pdf to both projects from its checklist.
    const policy = rows.filter({ hasText: "policy.pdf" });
    await policy.getByRole("button", { name: "Projects for policy.pdf" }).click();
    const checklist = page.getByRole("group", { name: "Attach policy.pdf to" });
    await checklist.getByLabel(TRAVEL).check();
    await expect(policy).toContainText(TRAVEL);
    await checklist.getByLabel(BUDGET).check();
    await expect(policy).toContainText(BUDGET);
    await expect(policy).toContainText("Agents can't use yet");
    await page.screenshot({ path: `e2e/screenshots/knowledge-workspace-attach-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "attach")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(checklist).toHaveCount(0);

    // Filters: name, "not attached", a project, status — and clearing them.
    await page.getByLabel("Search file names").fill("PDF");
    await expect(rows).toHaveCount(2);
    await page.getByLabel("Search file names").fill("");
    await page.getByLabel("Filter by project").selectOption({ label: "Not attached to a project" });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("scan.pdf");
    await page.getByLabel("Filter by project").selectOption({ label: BUDGET });
    await expect(rows).toHaveCount(2);
    await page.getByLabel("Filter by project").selectOption("");
    await page.getByLabel("Filter by status").selectOption("failed");
    await expect(rows).toHaveCount(1);
    await page.getByLabel("Search file names").fill("nothing-like-this");
    await expect(page.getByText("No files match")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(3);
    expect(await axeProblems(page, "ready")).toEqual([]);

    // Delete from the library.
    await page.getByRole("button", { name: "Delete scan.pdf" }).click();
    await expect(rows.filter({ hasText: "scan.pdf" })).toContainText("Delete from library?");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(rows).toHaveCount(2);

    // A project link opens that project's Knowledge step, showing the attached file.
    await policy.getByRole("link", { name: TRAVEL }).click();
    await expect(page).toHaveURL(/#\/projects\/e2e0travel0project\/knowledge$/);
    await expect(page.locator(".doclist").getByText("policy.pdf")).toBeVisible();

    expect(errors).toEqual([]);
  });
}
