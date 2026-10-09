import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The project's Resources step: documents, databases and MCP tools in one step with tabs.
// The tab is in the URL, old Knowledge/Data links land on their tab, and the page never
// grows a second scrollbar — readable and accessible in both themes.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1280, height: 800 });
});

for (const scheme of ["light", "dark"]) {
  test(`resources step in ${scheme}: one step, three tabs`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });

    await page.goto(`/#/projects/${PROJECT}/brief`);
    const stepper = page.locator(".stepper");
    await expect(stepper.getByRole("link")).toHaveCount(6);
    await expect(stepper.getByRole("link", { name: /Knowledge|^Data/ })).toHaveCount(0);
    const step = stepper.getByRole("link", { name: /Resources/ });
    await expect(step).toContainText("Optional");
    await step.click();
    await expect(page).toHaveURL(/\/resources$/);

    const tabs = page.getByRole("tablist", { name: "Resources" });
    const panels = {
      Documents: { url: /\/resources\/documents$/, shows: "Knowledge for this project" },
      Databases: { url: /\/resources\/databases$/, shows: "Data for this project" },
      "MCP tools": { url: /\/resources\/tools$/, shows: "Manage MCP servers" },
    };
    for (const [name, { url, shows }] of Object.entries(panels)) {
      const tab = tabs.getByRole("tab", { name: new RegExp(`^${name}`) });
      await tab.click();
      await expect(page).toHaveURL(url);
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toContainText(shows);
      // One page, one action bar, and nothing stretching the window.
      await expect(page.locator(".actionbar")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
      await page.screenshot({ path: `e2e/screenshots/resources-${name.split(" ")[0].toLowerCase()}-${scheme}.png` });
      expect(await axeProblems(page, `resources ${name}`)).toEqual([]);
    }

    // A refresh keeps the tab.
    await page.reload();
    await expect(tabs.getByRole("tab", { name: /^MCP tools/ })).toHaveAttribute("aria-selected", "true");
    expect(errors).toEqual([]);
  });
}

test("old Knowledge and Data links land on their tabs", async ({ page }) => {
  await page.goto(`/#/projects/${PROJECT}/data`);
  await expect(page.getByRole("tab", { name: /^Databases/ })).toHaveAttribute("aria-selected", "true");
  await page.goto(`/#/projects/${PROJECT}/knowledge`);
  await expect(page.getByRole("tab", { name: /^Documents/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".topbar")).toContainText("Resources");
});
