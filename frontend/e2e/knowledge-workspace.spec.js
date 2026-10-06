import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The Knowledge library page: upload files (to the library only, from the centred upload
// area), attach one file to several projects from the table, choose the default embedding
// model and change one file's model, filter, follow a project link, and delete from the
// library — readable and accessible in both themes.
const API = "http://127.0.0.1:8765";
const TRAVEL = "Travel agent for finding cheap flights";
const BUDGET = "Weekend budget planner";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

const GEMINI = "google_genai/gemini-embedding-001";
const TITAN = "bedrock/amazon.titan-embed-text-v2:0";
const COHERE = "bedrock/global.cohere.embed-v4:0";

const file = (name) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(`contents of ${name}`) });

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

for (const scheme of ["light", "dark"]) {
  test(`knowledge library in ${scheme}: upload, attach, embedding models, filter, delete`, async ({ page }) => {
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

    // The upload area is centred on the page, with no side panel and no "Attach to"
    // option: files are attached from their rows.
    await expect(page.getByRole("combobox", { name: /^Attach to/ })).toHaveCount(0);
    await expect(page.locator(".split__aside")).toHaveCount(0);
    const area = await page.locator(".kadd").boundingBox();
    const drop = await page.locator(".kadd .dropzone").boundingBox();
    expect(Math.abs(area.x + area.width / 2 - (drop.x + drop.width / 2))).toBeLessThan(2);
    const defaultModel = page.getByRole("combobox", { name: "New files use" });
    await expect(defaultModel).toHaveValue("");

    // One file is refused in the page.
    await page.getByLabel("Choose files to add").setInputFiles([file("policy.pdf"), file("deck.pptx"), file("scan.pdf")]);
    await expect(page.getByText(/deck\.pptx: not a supported type/)).toBeVisible();
    await page.getByLabel("Choose files to add").setInputFiles([file("budget.csv")]);

    const rows = page.locator(".ktable tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "policy.pdf" })).toContainText("Library only");
    await expect(rows.filter({ hasText: "budget.csv" })).toContainText("Library only");
    await expect(defaultModel).toHaveValue(GEMINI);
    await expect(page.getByLabel("Embedding model for policy.pdf")).toHaveValue(GEMINI);
    await expect(rows.filter({ hasText: "scan.pdf" })).toContainText(/scanned PDFs need OCR/);
    await page.screenshot({ path: `e2e/screenshots/knowledge-workspace-indexing-${scheme}.png`, fullPage: true });

    await expect(rows.filter({ hasText: "policy.pdf" }).locator(".badge")).toHaveText("Ready", { timeout: 10_000 });
    await expect(page.locator(".kstat", { hasText: "Passages" })).toContainText("8", { timeout: 10_000 });
    await expect(page.getByRole("link", { name: /^Knowledge/ }).locator(".navitem__count")).toHaveText("3");

    // Attach budget.csv to a project from its row.
    const budget = rows.filter({ hasText: "budget.csv" });
    await budget.getByRole("button", { name: "Projects for budget.csv" }).click();
    await page.getByRole("group", { name: "Attach budget.csv to" }).getByLabel(BUDGET).check();
    await expect(budget).toContainText(BUDGET);
    await page.keyboard.press("Escape");

    // The default for new uploads changes without touching existing files.
    await defaultModel.selectOption(TITAN);
    await expect(defaultModel).toHaveValue(TITAN);
    await expect(page.getByLabel("Embedding model for policy.pdf")).toHaveValue(GEMINI);
    await expect(rows.filter({ hasText: "policy.pdf" }).locator(".badge")).toHaveText("Ready");

    // One file's model: asks first; Cancel puts it back; Re-index indexes it again.
    const policyModel = page.getByLabel("Embedding model for policy.pdf");
    await policyModel.selectOption(COHERE);
    const confirm = page.getByRole("group", { name: "Confirm re-indexing policy.pdf" });
    await expect(confirm).toContainText("Re-index with Amazon Bedrock?");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(policyModel).toHaveValue(GEMINI);
    await policyModel.selectOption(TITAN);
    await page.screenshot({ path: `e2e/screenshots/knowledge-workspace-model-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "model confirm")).toEqual([]);
    await confirm.getByRole("button", { name: "Re-index" }).click();
    await expect(rows.filter({ hasText: "policy.pdf" }).locator(".badge")).toHaveText("Indexing");
    await expect(policyModel).toBeDisabled();
    await expect(rows.filter({ hasText: "policy.pdf" }).locator(".badge")).toHaveText("Ready", { timeout: 10_000 });
    await expect(policyModel).toHaveValue(TITAN);
    await expect(page.getByLabel("Embedding model for budget.csv")).toHaveValue(GEMINI);
    // A file with nothing to re-index (it failed before any passages were taken) can't change.
    await expect(page.getByLabel("Embedding model for scan.pdf")).toBeDisabled();

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
