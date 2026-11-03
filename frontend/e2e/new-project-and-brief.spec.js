import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Signing in lands on New project; the new-project chat can attach knowledge files; the
// Brief page edits each agent's model and tools. Accessible in light and dark.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
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
    await page.getByRole("button", { name: "Add context" }).click();
    await page.getByRole("menuitem", { name: /Choose from library/ }).click();
    await page.getByRole("checkbox", { name: /policy\.pdf/ }).check();
    await page.keyboard.press("Escape");
    await page.getByLabel("Upload knowledge files").setInputFiles([
      { name: "fares.csv", mimeType: "text/csv", buffer: Buffer.from("city,fare\nGoa,7004\n") },
      { name: "slides.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
    ]);
    const chips = page.getByRole("list", { name: "Attachments for this project" });
    const refused = chips.getByRole("listitem").filter({ hasText: "slides.pptx" });
    await expect(refused).toHaveAttribute("title", /slides\.pptx: not a supported type/);
    await expect(chips.getByText("policy.pdf")).toBeVisible();
    await expect(chips.getByRole("button", { name: "Remove fares.csv" })).toBeEnabled();
    await refused.getByRole("button", { name: "Remove slides.pptx" }).click();
    await page.getByRole("button", { name: /^Tools/ }).click();
    await expect(page.getByText("auto · 2 files")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `e2e/screenshots/new-project-files-${scheme}.png` });
    expect(await axeProblems(page, "attachments")).toEqual([]);

    // Removing a chip, then planning: the request carries the remaining file.
    await chips.getByRole("button", { name: "Remove policy.pdf" }).click();
    await page.getByLabel("Task description").fill("Answer questions about fares");
    // Sending talks it through first; planning is the explicit Create plan step.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("region", { name: "Task brief" }).getByRole("button", { name: "Create plan" }).click();
    await expect(page.getByRole("link", { name: "Review plan" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Knowledge files" })).toContainText("fares.csv");
    await expect(page.getByRole("list", { name: "Attachments for this project" })).toHaveCount(0);

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
    // The model menu: searchable, grouped, and a model without a key can't be chosen.
    await editor.getByRole("button", { name: /^Model for price_analyzer/ }).click();
    const menu = editor.getByRole("listbox", { name: "Model for price_analyzer" });
    await expect(menu.getByRole("group", { name: "Platform models" })).toBeVisible();
    await expect(menu.getByRole("group", { name: "Amazon Bedrock · recommended" }).getByRole("option")).toHaveCount(3);
    await expect(menu.getByRole("group", { name: "Amazon Bedrock · Anthropic" })).toContainText("Claude Opus 4.6");
    const keyless = menu.getByRole("option", { name: /claude-sonnet-4-6/ });
    await expect(keyless).toHaveAttribute("aria-disabled", "true");
    await expect(keyless).toContainText("No API key");
    await page.screenshot({ path: `e2e/screenshots/model-picker-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "model menu")).toEqual([]);
    // Typing filters across sections; arrows and Enter pick.
    const search = editor.getByRole("combobox", { name: "Search model for price_analyzer" });
    await search.fill("4o-mini");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await search.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(editor.getByRole("button", { name: /^Model for price_analyzer/ })).toContainText("gpt-4o-mini · OpenAI");
    const tools = editor.getByRole("group", { name: "Tools for price_analyzer" });
    await tools.getByRole("button", { name: "wikipedia" }).click();
    await expect(tools.getByRole("button", { name: "wikipedia" })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByText("External access")).toBeVisible();
    await expect(editor).toContainText("1 agent changed — saving makes plan v3");

    await page.screenshot({ path: `e2e/screenshots/brief-editor-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "brief editor")).toEqual([]);

    // A Bedrock model, with where it runs; Escape closes without changing anything.
    await editor.getByRole("button", { name: /^Model for travel_advisor/ }).click();
    const advisorMenu = editor.getByRole("listbox", { name: "Model for travel_advisor" });
    await page.keyboard.press("Escape");
    await expect(advisorMenu).toHaveCount(0);
    await editor.getByRole("button", { name: /^Model for travel_advisor/ }).click();
    const haiku = advisorMenu.getByRole("option", { name: /Claude Haiku 4\.5/ });
    await expect(haiku).toContainText("India");
    await haiku.click();
    await expect(editor.getByRole("button", { name: /^Model for travel_advisor/ })).toContainText(
      "Claude Haiku 4.5 · Anthropic on Bedrock",
    );
    await expect(editor).toContainText("2 agents changed");

    // Reset discards; then save for real.
    await editor.getByRole("button", { name: "Reset" }).click();
    await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await editor.getByRole("button", { name: /^Use one model for every agent/ }).click();
    await editor.getByRole("listbox", { name: "Use one model for every agent" }).getByRole("option", { name: /gpt-4o-mini/ }).click();
    await expect(editor).toContainText("3 agents changed");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved as plan v3")).toBeVisible();
    await expect(page.locator(".stepper").getByRole("link", { name: /Compile/ })).toContainText("Not compiled");
    await expect(editor.getByRole("button", { name: /^Model for price_analyzer/ })).toContainText("gpt-4o-mini");
    // The Details panel no longer lists models or tools; the editor above is where they are.
    await expect(page.locator(".panel", { hasText: "Details" })).not.toContainText("gpt-4o-mini");
  });
}
