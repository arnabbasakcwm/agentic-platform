import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Checks for the Run page against e2e/mock-api.js. Screenshots go to e2e/screenshots/.
const PROJECT = "e2e0travel0project";
const RUN_URL = `/#/projects/${PROJECT}/run`;
const SHOTS = "e2e/screenshots";

const KOLKATA = { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October", step_ms: 150 };

let consoleErrors = [];
const MOCK_API = "http://127.0.0.1:8765";

test.beforeEach(async ({ page, request }) => {
  // Runs are saved on the (mock) server now: start every test from a fresh project.
  await request.post(`${MOCK_API}/__reset`);
  consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  page.on("response", (res) => {
    if (res.status() >= 400) consoleErrors.push(`HTTP ${res.status()} ${res.url()}`);
  });
  // A signed-in session, as the app restores it on load.
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
});

test.afterEach(() => {
  expect(consoleErrors, "no console errors").toEqual([]);
});

async function openRunPage(page, { width = 1440, height = 900, scheme = "light", reducedMotion = "no-preference" } = {}) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
  await page.goto(RUN_URL);
  await expect(page.locator(".flow-node")).toHaveCount(3);
}

/** Wait for smooth scrolling to finish, so a screenshot shows where the page lands. */
async function settle(page) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const top = await page.locator(".workspace__main").evaluate((el) => el.scrollTop);
    if (top === last) return;
    last = top;
    await page.waitForTimeout(100);
  }
}

async function reloadRunPage(page) {
  await page.reload();
  await expect(page.locator(".flow-node")).toHaveCount(3);
}

async function startRun(page, input) {
  await page.locator(".run-input").fill(JSON.stringify(input, null, 2));
  await page.getByRole("button", { name: "Run graph" }).click();
}

const card = (page, id) => page.locator(`#output-${id}`);

async function waitCompleted(page) {
  await expect(page.locator(".run-flow .badge--completed")).toBeVisible({ timeout: 15_000 });
}

async function noHorizontalScroll(page) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector(".workspace__main");
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow.page, "page scrolls horizontally").toBeLessThanOrEqual(0);
  expect(overflow.main, "workspace scrolls horizontally").toBeLessThanOrEqual(0);
}

async function axe(page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = results.violations.filter((v) => ["serious", "critical"].includes(v.impact));
  expect(
    bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`),
    "axe serious/critical violations",
  ).toEqual([]);
}

// ---------------------------------------------------------------- content
test("agent output renders as Markdown with structured data cards", async ({ page }) => {
  await openRunPage(page);
  await startRun(page, KOLKATA);
  await waitCompleted(page);

  const prose = await page.locator(".outcard .md").allInnerTexts();
  expect(prose.length).toBe(3);
  for (const text of prose) {
    expect(text).not.toContain("**");
    expect(text).not.toContain("###");
    expect(text).not.toMatch(/^\s*\* /m);
  }
  // Headings, list items and a table exist as real elements, on their own lines.
  const advisor = card(page, "travel_advisor");
  await expect(advisor.locator(".md h3")).toHaveCount(3);
  expect(await advisor.locator(".md li").count()).toBeGreaterThanOrEqual(7);
  await expect(card(page, "price_analyzer").locator(".md table")).toBeVisible();
  await expect(advisor.getByText("Final answer")).toBeVisible();
  await expect(advisor.locator(".outcard__title")).toContainText("Travel Advisor");

  // Structured data: a readable card, currency formatted, raw JSON collapsible + copyable.
  const data = card(page, "flight_searcher").locator(".data");
  await expect(data.getByText("Cheapest one way price (INR)")).toBeVisible();
  await expect(data.locator(".data__value", { hasText: "₹7,004" })).toBeVisible();
  await expect(data.locator(".data__value", { hasText: "$118" })).toBeVisible();
  await expect(data.locator(".data__table th", { hasText: "Fare (INR)" })).toBeVisible();
  const raw = data.locator("details.data__raw");
  await expect(raw.locator(".json")).toBeHidden();
  await raw.locator("summary").click();
  await expect(raw.locator(".json__key").first()).toBeVisible();
  await expect(raw.getByRole("button", { name: "Copy JSON" })).toBeVisible();
});

test("the task input reaches the agents: different inputs, different answers", async ({ page }) => {
  await openRunPage(page);
  // Pre-filled from the plan's example input, not a generic sample.
  await expect(page.locator(".run-input")).toHaveValue(/Kolkata \(CCU\)/);

  await startRun(page, KOLKATA);
  await waitCompleted(page);
  await expect(card(page, "travel_advisor")).toContainText("Kolkata (CCU) → New Delhi (DEL)");
  await expect(page.locator(".ranwith__value")).toContainText("Kolkata (CCU)");

  await startRun(page, { origin: "Mumbai (BOM)", destination: "Dubai (DXB)", month: "March", step_ms: 150 });
  await expect(page.locator(".ranwith__value")).toContainText("Mumbai (BOM)");
  await waitCompleted(page);
  await expect(card(page, "travel_advisor")).toContainText("Mumbai (BOM) → Dubai (DXB)");
  await expect(card(page, "travel_advisor")).not.toContainText("Kolkata");

  // The input box keeps what was typed when moving between steps and back.
  await page.getByRole("link", { name: /Compile/ }).first().click();
  await page.goto(RUN_URL);
  await expect(page.locator(".run-input")).toHaveValue(/Mumbai/);
});

// ---------------------------------------------------------------- diagram
test("the diagram is the real graph, animates during a run, and ends in the true states", async ({ page }) => {
  await openRunPage(page);
  await expect(page.locator(".flow-terminal")).toHaveCount(2);
  // Laid out, not stacked: every node is fully visible and no two overlap.
  const boxes = await page.locator(".react-flow__node").evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()).map(({ x, y, width, height }) => ({ x, y, width, height })),
  );
  const diagram = await page.locator(".diagram").boundingBox();
  for (const [i, a] of boxes.entries()) {
    expect(a.x).toBeGreaterThanOrEqual(diagram.x);
    expect(a.x + a.width).toBeLessThanOrEqual(diagram.x + diagram.width);
    for (const b of boxes.slice(i + 1)) {
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, "diagram nodes overlap").toBe(false);
    }
  }
  await expect(page.locator(".react-flow__edge")).toHaveCount(4); // start→a→b→c→end
  await expect(page.locator(".flow-node--idle")).toHaveCount(3);

  await startRun(page, { ...KOLKATA, scenario: "slow" });
  const analyzer = page.locator(".flow-node", { hasText: "Price Analyzer" });
  await expect(analyzer).toHaveClass(/flow-node--running/);
  await expect(page.locator(".flow-node", { hasText: "Flight Searcher" })).toHaveClass(/flow-node--completed/);
  await expect(page.locator(".flow-node", { hasText: "Travel Advisor" })).toHaveClass(/flow-node--queued/);
  await expect(page.locator(".flow-edge__dash")).toHaveCount(1);
  await expect(page.locator(".timeline__bar")).toHaveCount(2);

  // The Run button stays disabled while a run is in progress. Runs are saved on the server,
  // so a reload reconnects to it, still running.
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
  await reloadRunPage(page);
  await expect(analyzer).toHaveClass(/flow-node--running/);
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
  // The mock's slow agent never finishes: clear it to carry on.
  await page.request.post(`${MOCK_API}/__reset`);
  await reloadRunPage(page);
  await startRun(page, KOLKATA);
  await waitCompleted(page);
  await expect(page.locator(".flow-node--completed")).toHaveCount(3);
  await expect(page.locator(".flow-edge__dash")).toHaveCount(0);
  await expect(page.locator(".flow-terminal--completed")).toHaveCount(2);
});

test("a failed run shows the true final state of every node", async ({ page }) => {
  await openRunPage(page);
  await startRun(page, { ...KOLKATA, scenario: "fail" });
  await expect(page.getByText("RunTimeout")).toBeVisible();
  await expect(page.locator(".flow-node", { hasText: "Flight Searcher" })).toHaveClass(/flow-node--completed/);
  await expect(page.locator(".flow-node", { hasText: "Price Analyzer" })).toHaveClass(/flow-node--failed/);
  await expect(page.locator(".flow-node", { hasText: "Travel Advisor" })).toHaveClass(/flow-node--skipped/);
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();
});

test("clicking a node scrolls to its output card", async ({ page }) => {
  await openRunPage(page, { height: 760 });
  await startRun(page, KOLKATA);
  await waitCompleted(page);
  await page.locator(".flow-node", { hasText: "Travel Advisor" }).click();
  const target = card(page, "travel_advisor");
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
});

test("reduced motion turns the animations off", async ({ page }) => {
  await openRunPage(page, { reducedMotion: "reduce" });
  await startRun(page, { ...KOLKATA, scenario: "slow" });
  // Price Analyzer stays running in the slow scenario; the first agent is running only
  // for a moment, and reading its glow just as it finishes was a race.
  const running = page.locator(".flow-node--running", { hasText: "Price Analyzer" });
  await expect(running).toHaveCount(1);
  await expect(page.locator(".flow-edge__dash")).toHaveCount(1);
  const glow = await running.evaluate((el) => getComputedStyle(el, "::after").animationName);
  const dash = await page.locator(".flow-edge__dash").evaluate((el) => getComputedStyle(el).animationName);
  expect(glow).toBe("none");
  expect(dash).toBe("none");
});

// ---------------------------------------------------------------- layout
test("nothing is hidden under the header or behind the action bar", async ({ page }) => {
  for (const width of [1440, 1024, 390]) {
    await openRunPage(page, { width, height: 800 });
    await startRun(page, KOLKATA);
    await waitCompleted(page);
    await noHorizontalScroll(page);

    // Scroll the workspace to the end: the stepper stays below the top bar, and the
    // results panel ends above the action bar.
    await page.locator(".workspace__main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const topbar = await page.locator(".topbar").boundingBox();
    const stepper = await page.locator(".stepper-bar").boundingBox();
    expect(stepper.y).toBeGreaterThanOrEqual(topbar.y + topbar.height - 1);
    const bar = await page.locator(".actionbar").boundingBox();
    const results = await page.locator(".run-results").boundingBox();
    expect(results.y + results.height).toBeLessThanOrEqual(bar.y + 1);

    // Inside the results panel, the last card can be scrolled fully into view.
    const body = page.locator(".run-results__body");
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const bodyBox = await body.boundingBox();
    const lastCard = await page.locator(".outcard").last().boundingBox();
    expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
  }
});

// ---------------------------------------------------------------- existing features
test("single agent, compile, deploy and API status still work", async ({ page }) => {
  await openRunPage(page);
  await expect(page.getByText("API online")).toBeVisible();
  await page.getByRole("tab", { name: "Single agent" }).click();
  await page.locator(".run-col select").selectOption("price_analyzer");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(card(page, "price_analyzer").locator(".md table")).toBeVisible();
  await expect(page.locator(".flow-node", { hasText: "Price Analyzer" })).toHaveClass(/flow-node--completed/);
  await expect(page.locator(".flow-node", { hasText: "Flight Searcher" })).toHaveClass(/flow-node--idle/);

  await page.locator(".actionbar").getByRole("link", { name: "Compile" }).click();
  await expect(page.getByText("Execution flow")).toBeVisible();
  await page.goto(RUN_URL);
  await page.locator(".actionbar").getByRole("link", { name: "Deploy" }).click();
  await expect(page.getByText("Deployment isn't set up on this server")).toBeVisible();
});

// ---------------------------------------------------------------- screenshots + axe
for (const scheme of ["light", "dark"]) {
  for (const width of [1440, 1024, 390]) {
    test(`states at ${width}px, ${scheme}: screenshots and accessibility`, async ({ page }) => {
      const shot = (state) => page.screenshot({ path: `${SHOTS}/${state}-${width}-${scheme}.png`, fullPage: true });

      await openRunPage(page, { width, scheme });
      await noHorizontalScroll(page);
      await shot("idle");
      await axe(page);

      await startRun(page, { ...KOLKATA, scenario: "slow" });
      // Mid-run: the first agent done, the second working, the third queued.
      await expect(page.locator(".flow-node", { hasText: "Price Analyzer" })).toHaveClass(/flow-node--running/);
      await settle(page);
      await shot("running");
      await axe(page);

      // The mock's slow agent never finishes: clear it to carry on.
      await page.request.post(`${MOCK_API}/__reset`);
      await reloadRunPage(page);
      await startRun(page, KOLKATA);
      await waitCompleted(page);
      await noHorizontalScroll(page);
      await settle(page);
      await shot("completed");
      // The answers themselves: the results panel, scrolled to the final agent's card.
      await card(page, "travel_advisor").scrollIntoViewIfNeeded();
      await page.locator(".run-results").screenshot({ path: `${SHOTS}/results-${width}-${scheme}.png` });
      await axe(page);

      await startRun(page, { ...KOLKATA, scenario: "fail" });
      await expect(page.getByText("RunTimeout")).toBeVisible();
      await settle(page);
      await shot("failed");
      await axe(page);
    });
  }
}

// ---------------------------------------------------------------- theme toggle
test("the theme toggle switches light and dark, overrides the system, and is remembered", async ({ page }) => {
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const LIGHT = "rgb(248, 250, 252)";
  const DARK = "rgb(11, 17, 32)";

  // System light: the console starts light and offers dark.
  await openRunPage(page, { scheme: "light" });
  expect(await background()).toBe(LIGHT);
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).toBe(DARK);
  await expect(page.locator(".react-flow")).toHaveClass(/\bdark\b/);
  await axe(page);

  // Remembered across a reload, before the app even renders (no flash).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).toBe(DARK);
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();

  // A chosen theme wins over the system: light chosen while the system is dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe(LIGHT);
  await axe(page);
});
