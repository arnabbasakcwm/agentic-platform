import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// The Run tab's finished outputs: Export (Word, PDF, CSV), Send by email, CSV answers as
// tables, and citations with a Sources panel. The files themselves are checked in the
// backend (test_export.py); here, the UI around them.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const RUN_URL = `/#/projects/${PROJECT}/run`;
const RICH = { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October", step_ms: 40, scenario: "rich" };

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
});

const card = (page, agent) => page.getByRole("article", { name: new RegExp(`^${agent.replace("_", ".")} output`, "i") });

async function runRich(page) {
  await page.goto(RUN_URL);
  await expect(page.locator(".flow-node")).toHaveCount(3);
  await page.locator(".run-input").fill(JSON.stringify(RICH, null, 2));
  await page.getByRole("button", { name: "Run graph" }).click();
  await expect(page.locator(".outcard--completed")).toHaveCount(3, { timeout: 20_000 });
}

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

// ------------------------------------------------------------------ Feature 1: export
test("Export downloads an agent's output and the whole run, in each format", async ({ page, request }) => {
  await runRich(page);
  const analyzer = card(page, "price_analyzer");
  for (const [label, ext] of [["Word", "docx"], ["PDF", "pdf"], ["CSV", "csv"]]) {
    await analyzer.getByRole("button", { name: "Export price_analyzer output" }).click();
    const menu = page.getByRole("menu", { name: "Export price_analyzer output as" });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    const download = page.waitForEvent("download");
    await menu.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(new RegExp(`^Travel-agent_price_analyzer_[\\w-]{1,8}_\\d{8}-\\d{4}\\.${ext}$`));
    const sent = await (await request.get(`${API}/__last_export`)).json();
    expect(sent).toMatchObject({ format: ext, agent: "price_analyzer" });
  }
  // The whole run, from the Result header.
  await page.getByRole("button", { name: "Export the whole run" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^PDF/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^Travel-agent_all_.*\.pdf$/);
  expect((await (await request.get(`${API}/__last_export`)).json()).agent).toBeNull();
});

test("a failed export says so, and the menu works by keyboard", async ({ page }) => {
  await runRich(page);
  await page.route("**/export?*", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error_type: "ExportUnavailable", message: "this run has no finished output to export yet", details: null }),
    }),
  );
  const exportButton = card(page, "flight_searcher").getByRole("button", { name: "Export flight_searcher output" });
  await exportButton.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /^PDF/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(page, "flight_searcher").getByRole("alert")).toHaveText(
    "Export failed: this run has no finished output to export yet",
  );
  await expect(exportButton).toBeFocused();
  // Esc closes the menu without exporting.
  await exportButton.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await axeProblems(page, "run outputs")).toEqual([]);
});
