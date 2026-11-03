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
