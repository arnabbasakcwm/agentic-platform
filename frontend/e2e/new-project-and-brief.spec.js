import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Signing in lands on New project; the new-project chat can attach knowledge files; the
// Brief page edits each agent's model and tools. Accessible in light and dark.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

test("signing in lands on the New project page", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("a-long-password");
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByRole("heading", { name: "What should your agent team do?" })).toBeVisible();
});

test("opening the console without a route also lands on New project", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What should your agent team do?" })).toBeVisible();
});

for (const scheme of ["light", "dark"]) {
  test(`new project with knowledge files in ${scheme}`, async ({ page, request }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });

    // A file already in the library, to pick.
    await request.post(`${API}/knowledge/documents`, {
      multipart: { files: { name: "policy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") } },
    });

    await page.goto("/#/new");
    await page.getByRole("button", { name: "Add files" }).click();
    const tray = page.locator("#composer-files");
    await expect(tray).toBeVisible();
    await tray.getByLabel("policy.pdf").check();
    await tray.getByLabel("Upload knowledge files").setInputFiles([
      { name: "fares.csv", mimeType: "text/csv", buffer: Buffer.from("city,fare\nGoa,7004\n") },
      { name: "slides.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
    ]);
    await expect(tray).toContainText(/slides\.pptx: not a supported type/);
    const chips = page.getByRole("list", { name: "Knowledge files for this project" });
    await expect(chips.getByText("policy.pdf")).toBeVisible();
    await expect(chips.getByText("fares.csv")).toBeVisible();
    await expect(page.getByRole("button", { name: "2 files" })).toBeVisible();
    await page.screenshot({ path: `e2e/screenshots/new-project-files-${scheme}.png` });
    expect(await axeProblems(page, "files tray")).toEqual([]);

    // Removing a chip, then planning: the request carries the remaining file.
    await chips.getByRole("button", { name: "Remove policy.pdf" }).click();
    await page.getByLabel("Task description").fill("Answer questions about fares");
    await page.getByRole("button", { name: "Plan this team" }).click();
    await expect(page.getByRole("link", { name: "Review plan" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Knowledge files" })).toContainText("fares.csv");
    await expect(page.getByRole("list", { name: "Knowledge files for this project" })).toHaveCount(0);

    const sent = await (await request.get(`${API}/__last_create`)).json();
    expect(sent.brief).toBe("Answer questions about fares");
    expect(sent.document_ids).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test(`brief page edits agents' models and tools in ${scheme}`, async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/#/projects/${PROJECT}/brief`);

    const editor = page.locator(".panel", { hasText: "Models and tools" });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // No knowledge files attached: knowledge_search isn't offered.
    await expect(editor.getByRole("button", { name: "knowledge_search" })).toHaveCount(0);
    // A model without a key can't be chosen.
    // (Playwright's toBeDisabled doesn't read a native <option>'s disabled state.)
    const keyless = editor.getByLabel("Model for price_analyzer").locator("option", { hasText: "claude-sonnet-4-6" });
    expect(await keyless.evaluate((o) => o.disabled)).toBe(true);
    await expect(keyless).toContainText("(no API key)");

    await editor.getByLabel("Model for price_analyzer").selectOption({ label: "OpenAI · gpt-4o-mini" });
    const tools = editor.getByRole("group", { name: "Tools for price_analyzer" });
    await tools.getByRole("button", { name: "wikipedia" }).click();
    await expect(tools.getByRole("button", { name: "wikipedia" })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByText("External access")).toBeVisible();
    await expect(editor).toContainText("1 agent changed — saving makes plan v3");

    await page.screenshot({ path: `e2e/screenshots/brief-editor-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "brief editor")).toEqual([]);

    // Amazon Bedrock models sit in their own group in the menu.
    const select = editor.getByLabel("Model for travel_advisor");
    await expect(select.locator('optgroup[label="Amazon Bedrock"] option')).toHaveCount(3);
    await select.selectOption("bedrock/in.anthropic.claude-haiku-4-5-20251001-v1:0");
    await expect(editor).toContainText("2 agents changed");

    // Reset discards; then save for real.
    await editor.getByRole("button", { name: "Reset" }).click();
    await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await editor.getByLabel("Use one model for every agent").selectOption({ label: "OpenAI · gpt-4o-mini" });
    await expect(editor).toContainText("3 agents changed");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved as plan v3")).toBeVisible();
    await expect(page.locator(".stepper").getByRole("link", { name: /Compile/ })).toContainText("Not compiled");
    await expect(page.locator(".panel", { hasText: "Details" })).toContainText("gpt-4o-mini");
  });
}
