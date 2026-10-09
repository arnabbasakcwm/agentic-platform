import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The Knowledge page against the mock API: upload, indexing status, test search, giving
// agents access through the assistant, and deleting — readable and accessible in both
// themes.
const PROJECT = "e2e0travel0project";
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

for (const scheme of ["light", "dark"]) {
  test(`knowledge page in ${scheme}: upload, search, give access, delete`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.emulateMedia({ colorScheme: scheme });

    // The old Knowledge step URL lands on the Resources step's Documents tab.
    await page.goto(`/#/projects/${PROJECT}/knowledge`);
    await expect(page.getByRole("tab", { name: /Documents/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("No files attached")).toBeVisible();
    await expect(page.locator(".stepper").getByRole("link", { name: /Resources/ })).toContainText("Optional");
    await expect(page.getByText("Agents can't use these files yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Give agents access" })).toBeDisabled();
    expect(await axeProblems(page, "empty")).toEqual([]);

    // Unsupported files are refused in the page, before anything is sent.
    const picker = page.getByLabel("Choose files to add");
    await picker.setInputFiles([
      { name: "policy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 travel policy") },
      { name: "slides.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
      { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 scan") },
    ]);
    await expect(page.getByText("Some files weren't added")).toBeVisible();
    await expect(page.getByText(/slides\.pptx: not a supported type/)).toBeVisible();

    const files = page.locator(".panel", { hasText: "Attached files" }).locator(".doclist");
    await expect(files.getByText("policy.pdf")).toBeVisible();
    await expect(files.locator(".badge", { hasText: "Indexing" })).toBeVisible();
    await expect(files.getByText(/scanned PDFs need OCR/)).toBeVisible();
    await page.screenshot({ path: `e2e/screenshots/knowledge-indexing-${scheme}.png`, fullPage: true });

    // Polling picks up the finished indexing.
    await expect(files.locator(".badge", { hasText: "Ready" })).toBeVisible({ timeout: 10_000 });
    await expect(files.getByText("4 passages")).toBeVisible();
    await expect(page.locator(".stepper").getByRole("link", { name: /Resources/ })).toContainText("1/2 docs ready");
    await expect(page.getByText(/sent to\s+Google Gemini/)).toBeVisible();

    await page.getByLabel("Search the knowledge base").fill("hotel cap in Delhi");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const hit = page.locator(".hit").first();
    await expect(hit).toContainText("policy.pdf");
    await expect(hit).toContainText("page 2");
    await expect(hit).toContainText("INR 9,000");

    await page.getByRole("button", { name: "Give agents access" }).click();
    await expect(page.getByText(/Gave flight_searcher the knowledge_search tool/)).toBeVisible();
    await expect(page.locator(".panel", { hasText: "Agent access" }).locator(".pill", { hasText: "flight_searcher" })).toBeVisible();
    await expect(page.locator(".stepper").getByRole("link", { name: /Compile/ })).toContainText("Not compiled");
    await page.screenshot({ path: `e2e/screenshots/knowledge-ready-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "ready")).toEqual([]);

    // Detaching keeps the file in the library, offered under "Add from your library".
    await page.getByRole("button", { name: "Detach scan.pdf from this project" }).click();
    await expect(files.getByText("scan.pdf")).toHaveCount(0);
    await expect(page.locator(".stepper").getByRole("link", { name: /Resources/ })).toContainText("1 doc");
    const library = page.locator(".panel", { hasText: "Add from your library" });
    await expect(library.getByText("scan.pdf")).toBeVisible();
    await library.getByRole("button", { name: "Attach scan.pdf" }).click();
    await expect(files.getByText("scan.pdf")).toBeVisible();
    await expect(page.locator(".panel", { hasText: "Add from your library" })).toHaveCount(0);

    expect(errors).toEqual([]);
  });
}
