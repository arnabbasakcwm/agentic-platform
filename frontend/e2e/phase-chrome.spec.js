import { expect, test } from "@playwright/test";

// The phase chrome (DESIGN.md §5: ProjectHeader, PhaseStepper, StickyFooter) must be
// identical on every project phase page: same size, same place; only the highlighted
// step and the footer's text and buttons change.
const PROJECT = "e2e0travel0project";
const PHASES = ["brief", "resources", "plan", "compile", "run", "deploy"];
const MOCK_API = "http://127.0.0.1:8765";

test.beforeEach(async ({ page, request }) => {
  await request.post(`${MOCK_API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
});

for (const scheme of ["light", "dark"]) {
  test(`header, stepper and footer don't move between phases (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const seen = [];
    for (const phase of PHASES) {
      await page.goto(`/#/projects/${PROJECT}/${phase}`);
      await expect(page.locator(".projhead")).toBeVisible();
      await expect(page.locator(".actionbar")).toBeVisible();
      // A hash navigation keeps the document: measure only once this phase is the
      // current one and layout has settled for two frames.
      await expect(page.locator(".stepper [aria-current='step']")).toHaveAttribute("data-phase", phase);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const box = async (sel) => {
        const b = await page.locator(sel).boundingBox();
        return [b.x, b.y, b.width, b.height].map(Math.round);
      };
      seen.push({
        phase,
        header: await box(".projhead"),
        stepper: await box(".stepper"),
        footer: await box(".actionbar"),
        current: await page.locator(".stepper [aria-current='step']").getAttribute("data-phase"),
        // Everything about the steps except which one is current.
        steps: await page.locator(".stepper .step").evaluateAll((els) =>
          els.map((el) => [
            el.dataset.phase,
            el.classList.contains("step--done"),
            el.querySelector(".step__hint").textContent,
          ]),
        ),
      });
    }
    for (const s of seen) {
      expect(s.current, `${s.phase}: highlighted step`).toBe(s.phase);
      for (const part of ["header", "stepper", "footer", "steps"]) {
        expect(s[part], `${s.phase}: ${part} matches brief`).toEqual(seen[0][part]);
      }
    }
  });
}

// ------------------------------------------------------------------ stepper: skipped / completed / pending
// Resources is optional. Empty while a later step is completed it reads "skipped"
// (dashed slate circle, a dash, "None added"); with items it is completed; on a fresh
// project (only Brief done) it is pending and the line stays grey.
const SLATE = "rgb(100, 116, 139)";
const lineColours = (page) =>
  page.locator(".stepper .step__line").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
const resourcesStep = (page) => page.locator(".stepper .step[data-phase='resources']");

test("stepper: Resources with nothing attached is skipped, with progress connectors", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/#/projects/${PROJECT}/resources`);
  const step = resourcesStep(page);
  await expect(step).toHaveClass(/step--skipped/);
  await expect(step).toHaveAttribute("aria-current", "step"); // still highlighted when current
  await expect(step.locator(".step__hint")).toHaveText("None added");
  await expect(step.locator(".step__dot")).toHaveText("–");
  const dot = await step.locator(".step__dot").evaluate((el) => {
    const c = getComputedStyle(el);
    return { w: c.width, style: c.borderTopStyle, bw: c.borderTopWidth, colour: c.borderTopColor };
  });
  // The CSS is 1.5px; Chrome snaps borders to whole device pixels at 1x.
  expect(["1px", "1.5px"]).toContain(dot.bw);
  expect({ w: dot.w, style: dot.style, colour: dot.colour }).toEqual({ w: "28px", style: "dashed", colour: SLATE });
  await page.goto(`/#/projects/${PROJECT}/plan`);
  await expect(page.locator(".stepper [aria-current='step']")).toHaveAttribute("data-phase", "plan");
  // Still a link, with normal (strong, not muted) label weight.
  await expect(step).toHaveAttribute("href", `#/projects/${PROJECT}/resources`);
  expect(await step.locator(".step__label").evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600");

  // Connectors: Brief→Resources and Resources→Plan lead to reached steps; the one out of
  // the skipped step is slate; Plan→Compile is coloured; Compile→Run, Run→Deploy are grey
  // because Run has not been completed.
  const lines = await lineColours(page);
  const grey = lines[3];
  expect(lines[1]).toBe(SLATE);
  expect(lines[0]).not.toBe(grey);
  expect(lines[2]).not.toBe(grey);
  expect(lines[3]).toBe(lines[4]);
  expect(lines[3]).not.toBe(lines[2]);
});

test("stepper: Resources with items is completed and summarises them", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const created = await (await request.post(`${MOCK_API}/datasources`, { data: { name: "Bikeshare" } })).json();
  await request.put(`${MOCK_API}/datasources/${created.source.id}/tables`, {
    data: { tables: ["agenticdb-510807.mydata.trips"] },
  });
  await request.post(`${MOCK_API}/projects/${PROJECT}/datasources/${created.source.id}`);
  await page.goto(`/#/projects/${PROJECT}/plan`);
  const step = resourcesStep(page);
  await expect(step).toHaveClass(/step--done/);
  await expect(step).not.toHaveClass(/step--skipped/);
  await expect(step.locator(".step__hint")).toHaveText("1 table");
  await expect(step.locator(".step__dot svg")).toBeVisible(); // the check
  const lines = await lineColours(page);
  expect(lines[1]).not.toBe(SLATE); // out of a completed step: its own colour
  expect(lines[1]).not.toBe(lines[3]);
});

test("stepper: on a fresh project Resources is pending and the line is grey", async ({ page }) => {
  // A saved project always has a plan, so the app never shows this state; the reference
  // page does (it is the design's source of truth).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(new URL("../../design/reference/phase-chrome.html", import.meta.url).href);
  const fresh = page.locator(".stepper").last();
  const step = fresh.locator(".step[data-phase='resources']");
  await expect(step).not.toHaveClass(/is-done|is-skipped/);
  await expect(step.locator(".dot")).toHaveText("2");
  const after = (n) => fresh.locator(".steps > li").nth(n).locator(".step").evaluate((el) => getComputedStyle(el, "::after").backgroundColor);
  const grey = await after(1);
  expect(await after(0)).toBe(grey); // Brief→Resources: Resources not reached yet
  expect(grey).not.toBe(SLATE);
});
