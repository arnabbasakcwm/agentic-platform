import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Runs are saved on the server: a run's result survives switching steps, other pages and
// a reload; a run in progress keeps going while you're elsewhere; the last 10 are listed
// and can be reopened; Try-it results on a deployment behave the same way.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const RUN_URL = `/#/projects/${PROJECT}/run`;
const TRIP = { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October", step_ms: 150 };

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function startRun(page, input) {
  await page.locator(".run-input").fill(JSON.stringify(input, null, 2));
  await page.getByRole("button", { name: "Run graph" }).click();
}

const completed = (page) => page.locator(".run-flow .badge--completed");
const advisorCard = (page) => page.locator("#output-travel_advisor");

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
});

for (const scheme of ["light", "dark"]) {
  test(`a finished run survives any navigation, in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(RUN_URL);
    await startRun(page, TRIP);
    await expect(completed(page)).toBeVisible({ timeout: 15_000 });
    await expect(advisorCard(page)).toContainText("Kolkata");

    // Another step and back.
    await page.locator(".stepper").getByRole("link", { name: /Brief/ }).click();
    await page.locator(".stepper").getByRole("link", { name: /Run/ }).click();
    await expect(completed(page)).toBeVisible();
    await expect(advisorCard(page)).toContainText("Kolkata");

    // Another page and back.
    await page.locator(".sidebar").getByRole("link", { name: "Usage", exact: true }).click();
    await page.goto(RUN_URL);
    await expect(advisorCard(page)).toContainText("Kolkata");

    // A reload.
    await page.reload();
    await expect(completed(page)).toBeVisible();
    await expect(advisorCard(page)).toContainText("Kolkata");
    // History is hidden until the History button opens it as a drawer.
    const history = page.getByRole("list", { name: "Previous runs" });
    await expect(history).toBeHidden();
    await page.getByRole("button", { name: /History/ }).click();
    const drawer = page.getByRole("dialog", { name: "Previous runs" });
    await expect(drawer).toBeVisible();
    await expect(history.getByRole("button")).toHaveCount(1);
    await expect(history.getByRole("button").first()).toHaveAttribute("aria-current", "true");
    await page.screenshot({ path: `e2e/screenshots/run-history-${scheme}.png`, fullPage: true, animations: "disabled" });
    expect(await axeProblems(page, "history")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test("a run in progress keeps going while you're on another page", async ({ page }) => {
  await page.goto(RUN_URL);
  await startRun(page, { ...TRIP, step_ms: 900 });
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
  await page.getByRole("link", { name: "Projects", exact: false }).first().click();
  await expect(page).toHaveURL(/#\/projects$/);
  await page.waitForTimeout(1500);
  await page.goto(RUN_URL);
  // Still going (or already done): it reconnected, and ends with every agent's answer.
  await expect(completed(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".flow-node--completed")).toHaveCount(3);
  await expect(advisorCard(page)).toContainText("Kolkata");
});

test("the last 10 runs are listed and an older one can be reopened", async ({ page }) => {
  await page.goto(RUN_URL);
  const cities = [
    "Mumbai (BOM)", "Chennai (MAA)", "Pune (PNQ)", "Goa (GOI)", "Jaipur (JAI)", "Kochi (COK)",
    "Delhi (DEL)", "Hyderabad (HYD)", "Bengaluru (BLR)", "Lucknow (LKO)", "Indore (IDR)",
  ];
  for (const origin of cities) {
    await startRun(page, { ...TRIP, origin, step_ms: 30 });
    await expect(page.getByRole("button", { name: "Run graph" })).toBeEnabled({ timeout: 15_000 });
  }
  const history = page.getByRole("list", { name: "Previous runs" });
  const openHistory = () => page.getByRole("button", { name: /History/ }).click();
  await openHistory();
  await expect(history.getByRole("button")).toHaveCount(10);
  // The oldest kept run (Chennai); Mumbai, the first, fell off the list.
  await history.getByRole("button").last().click();
  // Choosing a run closes the drawer and shows that run.
  await expect(page.getByRole("dialog", { name: "Previous runs" })).toBeHidden();
  await expect(advisorCard(page)).toContainText("Chennai");
  // Its input is in the box, ready to run again, with no "input changed" note.
  await expect(page.locator(".run-input")).toHaveValue(/Chennai/);
  await expect(page.getByText("Input changed since this run")).toHaveCount(0);
  await openHistory();
  await expect(history.getByRole("button").last()).toHaveAttribute("aria-current", "true");
});

test("Try it on the deployment keeps its result across steps", async ({ page, request }) => {
  await request.post(`${API}/__deploy_available`);
  await page.goto(`/#/projects/${PROJECT}/deploy`);
  await page.getByRole("button", { name: "Deploy to AgentCore" }).click();
  const tryIt = page.locator("form", { hasText: "Try the live deployment" });
  // Try it starts from the plan's example input, like the Run page; so do the snippets.
  const example = { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October" };
  await expect(tryIt.getByLabel("Task input (JSON)")).toHaveValue(JSON.stringify(example, null, 2));
  await expect(page.locator(".codeblock").first()).toContainText(JSON.stringify({ input: example }));
  await tryIt.getByLabel("Task input (JSON)").fill(JSON.stringify({ ...TRIP, step_ms: 1500 }));
  await tryIt.getByRole("button", { name: "Run on AgentCore" }).click();
  const result = page.locator("section.panel", { hasText: "From the live deployment" });
  await expect(result.getByRole("status")).toContainText("Running on AgentCore");

  // Leave while it runs; the result is there when you come back.
  await page.locator(".stepper").getByRole("link", { name: /Run/ }).click();
  await page.waitForTimeout(500);
  await page.locator(".stepper").getByRole("link", { name: /Deploy/ }).click();
  await expect(result).toContainText("Kolkata", { timeout: 15_000 });
  await expect(result.getByText(/Finished/)).toBeVisible();

  // And again after it finished.
  await page.locator(".stepper").getByRole("link", { name: /Brief/ }).click();
  await page.locator(".stepper").getByRole("link", { name: /Deploy/ }).click();
  await expect(result).toContainText("Kolkata");
  // History opens as a drawer.
  const history = page.getByRole("list", { name: "Previous runs on AgentCore" });
  await expect(history).toBeHidden();
  await tryIt.getByRole("button", { name: /History/ }).click();
  await expect(history.getByRole("button")).toHaveCount(1);
  await page.screenshot({ path: "e2e/screenshots/deploy-history.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
});
