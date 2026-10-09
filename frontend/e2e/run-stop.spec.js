import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// A running run can be stopped from the Run page: the Stop button sits beside "Running…"
// (and in the diagram's header), the server ends the run, and the page shows it stopped,
// keeping what finished before then.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const RUN_URL = `/#/projects/${PROJECT}/run`;
const SLOW = { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October", step_ms: 150, scenario: "slow" };

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
});

for (const scheme of ["light", "dark"]) {
  test(`a running run can be stopped, in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(RUN_URL);
    // No Stop button until something runs.
    await expect(page.getByRole("button", { name: "Stop the run" })).toHaveCount(0);

    await page.locator(".run-input").fill(JSON.stringify(SLOW, null, 2));
    await page.getByRole("button", { name: "Run graph" }).click();
    await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
    // The first agent finishes; the second never does in the slow scenario.
    await expect(page.locator("#output-flight_searcher")).toBeVisible({ timeout: 10_000 });
    const stops = page.getByRole("button", { name: "Stop the run" });
    await expect(stops).toHaveCount(2); // beside "Running…" and in the diagram header
    expect(await axeProblems(page, "running")).toEqual([]);
    await page.screenshot({ path: `e2e/screenshots/run-stopping-${scheme}.png`, animations: "disabled" });

    await stops.last().click();
    await expect(page.locator(".run-results")).toContainText("You stopped this run", { timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Stop the run" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run graph" })).toBeEnabled();
    // What finished before the stop is kept.
    await expect(page.locator("#output-flight_searcher")).toBeVisible();

    // The history says Stopped, and so does the run after a reload.
    await page.getByRole("button", { name: /History/ }).click();
    await expect(page.getByRole("list", { name: "Previous runs" })).toContainText("Stopped");
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator(".run-results")).toContainText("You stopped this run");
    await page.screenshot({ path: `e2e/screenshots/run-stopped-${scheme}.png`, fullPage: true, animations: "disabled" });
    expect(await axeProblems(page, "stopped")).toEqual([]);
    expect(errors).toEqual([]);
  });
}
