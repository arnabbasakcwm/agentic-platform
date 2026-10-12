import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The Usage page: totals, the cost-per-day chart (hover, keyboard, table view), the
// breakdowns, recent runs with per-agent detail, filters — and the per-run usage line on
// the Run page. Readable and accessible in both themes.

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

for (const scheme of ["light", "dark"]) {
  test(`usage dashboard in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });

    await page.goto("/#/projects");
    await page.getByRole("link", { name: "Usage", exact: true }).click();
    await expect(page).toHaveURL(/#\/usage$/);
    await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();

    const stats = page.locator(".kstats");
    await expect(stats.locator(".kstat", { hasText: "Estimated cost" })).toContainText("~$");
    // BigQuery is measured in bytes billed, not tokens.
    await expect(stats.locator(".kstat", { hasText: "BigQuery billed" })).toContainText("23.1 MB");
    await expect(page.locator("tr", { hasText: "Google BigQuery" }).first()).toContainText("23.1 MB billed");
    await expect(stats.locator(".kstat", { hasText: "Runs" })).toContainText("2");
    await expect(page.getByText("Some models have no price yet")).toBeVisible();
    await expect(page.getByText("google_genai/gemini-embedding-001").first()).toBeVisible();

    // Chart: 30 days by default; keyboard reads each day, the table shows them all.
    const chart = page.getByRole("group", { name: /Estimated cost per day/ });
    await expect(chart).toBeVisible();
    await chart.focus();
    await page.keyboard.press("End");
    await expect(page.locator(".costchart__tip")).toContainText("~$");
    await page.getByRole("button", { name: "Show as table" }).click();
    await expect(page.getByRole("region", { name: "Cost per day table" }).locator("tbody tr")).toHaveCount(30);

    // Breakdowns are tabs, with a count on each; Models is first.
    const tabs = page.getByRole("tablist", { name: "Usage breakdown" });
    const panel = page.getByRole("tabpanel");
    await expect(tabs.getByRole("tab")).toHaveText(["Models3", "Activity8", "Projects2", "Runs3"]);
    await expect(tabs.getByRole("tab", { name: /Models/ })).toHaveAttribute("aria-selected", "true");
    await expect(panel).toContainText("gemini-3.1-pro-preview");
    await expect(panel).toContainText("Price not set");
    // Three models: no arrow.
    await expect(panel.locator(".showmore")).toHaveCount(0);

    // Activity: 8 rows, 5 shown until the arrow opens the rest.
    await tabs.getByRole("tab", { name: /Activity/ }).click();
    await expect(page).toHaveURL(/#\/usage\/activity$/);
    await expect(panel.locator("tbody tr")).toHaveCount(5);
    await expect(panel).toContainText("Planning");
    const more = panel.getByRole("button", { name: "Show all 8 activities" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(panel.locator("tbody tr")).toHaveCount(8);
    await expect(panel.locator("tr", { hasText: "Data queries (BigQuery)" })).toContainText("23.1 MB billed");
    await expect(panel.locator("tr", { hasText: "Data queries (BigQuery)" })).toContainText("Price not set");
    await panel.getByRole("button", { name: "Show fewer" }).click();
    await expect(panel.locator("tbody tr")).toHaveCount(5);

    // Arrow keys move between tabs.
    await tabs.getByRole("tab", { name: /Activity/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: /Projects/ })).toBeFocused();
    await expect(panel).toContainText("Deleted project");

    // Direct AWS calls: sync status, Sync now, and the warning for an old runtime.
    const sync = page.locator(".usync");
    await expect(sync).toContainText(/not synced yet|synced/);
    await expect(sync.getByText("Redeploy to count direct AWS calls")).toBeVisible();
    await expect(sync).toContainText("Old deployed flow");
    await sync.getByRole("button", { name: "Sync now" }).click();
    await expect(sync).toContainText(/synced (just now|\d+ (second|seconds|minute|minutes) ago)/);

    // Recent runs expand to per-agent rows; direct AWS calls are tagged as such. The
    // tab survives a reload.
    await tabs.getByRole("tab", { name: /Runs/ }).click();
    await page.reload();
    await expect(page).toHaveURL(/#\/usage\/runs$/);
    await expect(tabs.getByRole("tab", { name: /Runs/ })).toHaveAttribute("aria-selected", "true");
    const runs = page.locator(".urun");
    await expect(runs).toHaveCount(3);
    await expect(runs.nth(1)).toContainText("AgentCore");
    await expect(runs.nth(2)).toContainText("AgentCore · direct");
    await runs.first().getByRole("button").click();
    await expect(runs.first().locator(".urun__detail")).toContainText("travel_advisor");
    await expect(runs.first().locator(".urun__detail")).toContainText("knowledge search");
    await page.screenshot({ path: `e2e/screenshots/usage-${scheme}.png`, fullPage: true });
    await page.locator(".content").evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({ path: `e2e/screenshots/usage-top-${scheme}.png` });
    expect(await axeProblems(page, "usage")).toEqual([]);

    // Period and project filters.
    await page.getByRole("button", { name: "7 days" }).click();
    await expect(page.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".panel", { hasText: "Estimated cost per day" })).toContainText("Last 7 days");
    await page.getByLabel("Filter by project").selectOption({ index: 1 });
    await expect(tabs.getByRole("tab", { name: /Projects/ })).toHaveCount(0);

    // The notes are tucked away until asked for.
    await expect(page.getByText(/Costs are estimates from list prices/)).toBeHidden();
    await page.getByText("How costs are counted").click();
    await expect(page.getByText(/Costs are estimates from list prices/)).toBeVisible();

    expect(errors).toEqual([]);
  });
}

test("a finished run shows its tokens and cost", async ({ page, request }) => {
  // Start clean: the Run page pre-fills the last run's input, which another spec may
  // have left as one that never finishes.
  await request.post("http://127.0.0.1:8765/__reset");
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/projects/e2e0travel0project/run");
  await page.getByRole("button", { name: /Run/ }).first().click();
  await expect(page.locator(".usageline")).toContainText("50.9K tokens · ~$0.198", { timeout: 20_000 });
  await page.locator(".usageline").getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL(/#\/usage$/);
});
