import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Models that can't call tools: shown as such, disabled for agents that have tools (or
// route), allowed for tool-less agents; an unchecked model is checked when chosen; the
// new-project settings explain that such a model's agents get no tools.
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

for (const scheme of ["light", "dark"]) {
  test(`models without tool calling in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/#/projects/${PROJECT}/brief`);
    const editor = page.locator(".panel", { hasText: "Models and tools" });
    const save = editor.getByRole("button", { name: "Save changes" });

    // flight_searcher has tools: Gemma is shown but can't be picked.
    await editor.getByRole("button", { name: /^Model for flight_searcher/ }).click();
    const gemma = editor
      .getByRole("listbox", { name: "Model for flight_searcher" })
      .getByRole("option", { name: /Gemma 3 12B/ });
    await expect(gemma).toHaveAttribute("aria-disabled", "true");
    await expect(gemma).toContainText("No tool calling");
    await expect(gemma).toHaveAttribute("title", "Can't call tools, and this agent has tools");
    await page.screenshot({ path: `e2e/screenshots/model-tools-menu-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "menu")).toEqual([]);
    await page.keyboard.press("Escape");

    // travel_advisor has no tools: Gemma is fine (it answers by JSON).
    await editor.getByRole("button", { name: /^Model for travel_advisor/ }).click();
    const advisorGemma = editor
      .getByRole("listbox", { name: "Model for travel_advisor" })
      .getByRole("option", { name: /Gemma 3 12B/ });
    await expect(advisorGemma).not.toHaveAttribute("aria-disabled", "true");
    await advisorGemma.click();
    await expect(editor.locator(".agentset__warn")).toHaveCount(0);
    const advisorTools = editor.getByRole("group", { name: "Tools for travel_advisor" });
    await expect(advisorTools.getByRole("button", { name: "lookup" })).toBeDisabled();
    await expect(save).toBeEnabled();

    // An unchecked model is checked when chosen; it can't call tools, and price_analyzer has one.
    await editor.getByRole("button", { name: /^Model for price_analyzer/ }).click();
    await editor
      .getByRole("listbox", { name: "Model for price_analyzer" })
      .getByRole("option", { name: /Llama 3 70B/ })
      .click();
    await expect(editor.getByRole("status")).toContainText("Checking whether Llama 3 70B Instruct can call tools");
    const warning = editor.getByRole("alert");
    await expect(warning).toContainText("Llama 3 70B Instruct can't call tools");
    await expect(save).toBeDisabled();
    await page.screenshot({ path: `e2e/screenshots/model-tools-warning-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "warning")).toEqual([]);

    // Switching its tool off clears the problem; switching one on isn't possible.
    const analyzerTools = editor.getByRole("group", { name: "Tools for price_analyzer" });
    await analyzerTools.getByRole("button", { name: "calculator" }).click();
    await expect(warning).toHaveCount(0);
    await expect(analyzerTools.getByRole("button", { name: "lookup" })).toBeDisabled();
    await expect(save).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test("a new project on a model without tool calling asks for no tools", async ({ page, request }) => {
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/new");
  await page.getByRole("button", { name: /^Model/ }).click();
  await page.getByRole("option", { name: /Gemma 3 12B/ }).click();
  await page.getByRole("button", { name: /^Tools/ }).click();
  const tools = page.getByRole("dialog", { name: "Tools" });
  await expect(tools.getByRole("status")).toContainText("Gemma 3 12B IT can't call tools");
  await expect(tools.getByRole("switch", { name: "lookup" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Tools/ })).toContainText("0");
  await page.keyboard.press("Escape");
  await page.getByLabel("Task description").fill("Explain bike rebalancing");
  // Sending talks it through first; planning is the explicit Create plan step.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("region", { name: "Task brief" }).getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByRole("link", { name: "Review plan" })).toBeVisible();
  const sent = await (await request.get(`${API}/__last_create`)).json();
  expect(sent.available_tools).toEqual([]);
  expect(sent.available_llms).toEqual([{ provider: "bedrock", model: "google.gemma-3-12b-it" }]);
});
