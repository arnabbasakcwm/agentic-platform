import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// The design tokens and dark theme apply to the whole console: the other pages must
// stay readable and accessible in both themes too.
const PROJECT = "e2e0travel0project";
const PAGES = [
  ["projects", "/#/projects", ".table"],
  ["brief", `/#/projects/${PROJECT}/brief`, ".prose"],
  ["plan", `/#/projects/${PROJECT}/plan`, ".agentgrid"],
  ["compile", `/#/projects/${PROJECT}/compile`, ".flow"],
  ["deploy", `/#/projects/${PROJECT}/deploy`, ".panel"],
  ["knowledge-workspace", "/#/knowledge", ".kstats, .empty"],
  ["new", "/#/new", ".chat"],
];

for (const scheme of ["light", "dark"]) {
  test(`other pages in ${scheme}: render, no console errors, no serious axe issues`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, url, ready] of PAGES) {
      await page.goto(url);
      await expect(page.locator(ready).first()).toBeVisible();
      await page.screenshot({ path: `e2e/screenshots/page-${name}-${scheme}.png` });
      const results = await new AxeBuilder({ page: await settled(page) }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => ["serious", "critical"].includes(v.impact));
      expect(bad.map((v) => `${name}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}
