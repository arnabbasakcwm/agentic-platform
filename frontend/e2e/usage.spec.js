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

    // Breakdowns.
    const models = page.locator(".panel", { hasText: "By model" });
    await expect(models).toContainText("gemini-3.1-pro-preview");
    await expect(models).toContainText("Price not set");
    await expect(page.locator(".panel", { hasText: "By activity" })).toContainText("Planning");
    await expect(page.locator(".panel", { hasText: "By project" })).toContainText("Deleted project");

    // Recent runs expand to per-agent rows.
    const runs = page.locator(".urun");
    await expect(runs).toHaveCount(2);
    await expect(runs.nth(1)).toContainText("AgentCore");
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
    await expect(page.locator(".panel", { hasText: "By project" })).toHaveCount(0);

    expect(errors).toEqual([]);
  });
}

test("a finished run shows its tokens and cost", async ({ page }) => {
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
