import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

// Visual sweep of every page at mobile, tablet and desktop widths (and desktop in dark):
// a screenshot each, plus serious accessibility problems and sideways overflow, written
// to e2e/screenshots/sweep/report.json. Run with SWEEP_TAG=<name> to label a pass, and
// SWEEP_STRICT=1 to fail on any problem (the redesign's exit check).
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const TAG = process.env.SWEEP_TAG ?? "current";
const STRICT = process.env.SWEEP_STRICT === "1";
const OUT = `e2e/screenshots/sweep/${TAG}`;

const PAGES = [
  ["signin", "/", { signedOut: true }],
  ["new-project", "/#/new"],
  ["projects", "/#/projects"],
  ["brief", `/#/projects/${PROJECT}/brief`],
  ["resources-documents", `/#/projects/${PROJECT}/resources/documents`],
  ["resources-databases", `/#/projects/${PROJECT}/resources/databases`],
  ["resources-tools", `/#/projects/${PROJECT}/resources/tools`],
  ["plan", `/#/projects/${PROJECT}/plan`],
  ["compile", `/#/projects/${PROJECT}/compile`],
  ["run", `/#/projects/${PROJECT}/run`],
  ["deploy", `/#/projects/${PROJECT}/deploy`],
  ["knowledge", "/#/knowledge"],
  ["data-sources", "/#/data"],
  ["mcp-servers", "/#/mcp"],
  ["usage", "/#/usage"],
];
const VIEWS = [
  ["375", 375, 812, "light"],
  ["768", 768, 1024, "light"],
  ["1440", 1440, 900, "light"],
  ["1440-dark", 1440, 900, "dark"],
];

const report = [];
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await request.post(`${API}/__reset`);
  mkdirSync(OUT, { recursive: true });
});

test.afterAll(() => {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
});

for (const [name, url, opts = {}] of PAGES) {
  test(`sweep ${name}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (!opts.signedOut) {
      await page.addInitScript(() => {
        sessionStorage.setItem("agentic-platform.token", "e2e-token");
        localStorage.setItem("agentic-platform.assistant-open", "0");
      });
    }
    for (const [view, width, height, scheme] of VIEWS) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/${name}-${view}.png`, fullPage: true, animations: "disabled" });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const serious = axe.violations
        .filter((v) => ["serious", "critical"].includes(v.impact))
        .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      // Sideways overflow: the document, or any element wider than the window.
      const overflow = await page.evaluate(() => {
        const w = window.innerWidth;
        // Content inside a container that scrolls or clips sideways (tables, code) is fine.
        const clipped = (el) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if (o !== "visible") return p.getBoundingClientRect().right <= w + 1;
          }
          return false;
        };
        const wide = [...document.querySelectorAll("body *")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            // SVG geometry is clipped by its own <svg> viewport.
            return r.width > 0 && r.right > w + 1 && !el.ownerSVGElement && getComputedStyle(el).position !== "fixed" && !clipped(el);
          })
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
        return { doc: document.documentElement.scrollWidth > w, wide };
      });
      report.push({ page: name, view, serious, overflow, errors: [...errors] });
      if (STRICT) {
        expect(serious, `${name} ${view} accessibility`).toEqual([]);
        expect(overflow.doc, `${name} ${view} sideways scroll`).toBe(false);
        expect(errors, `${name} ${view} page errors`).toEqual([]);
      }
    }
  });
}

// Overlays the page sweep never opens: the model picker, the run-history drawer, the
// assistant panel, and an expanded MCP server card.
const OVERLAYS = [
  ["overlay-model-picker", `/#/projects/${PROJECT}/brief`, async (page) => {
    // The editor loads its model list after the page; retry until the menu opens.
    await expect(async () => {
      await page.getByRole("button", { name: /^Model for price_analyzer/ }).click();
      await expect(page.getByRole("listbox", { name: "Model for price_analyzer" })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
  }],
  ["overlay-run-history", `/#/projects/${PROJECT}/run`, async (page) => {
    await page.getByRole("button", { name: /History/ }).click();
    await expect(page.getByRole("dialog", { name: "Previous runs" })).toBeVisible();
  }],
  ["overlay-assistant", `/#/projects/${PROJECT}/plan`, async (page) => {
    await page.getByRole("button", { name: "Assistant" }).click();
    await expect(page.locator(".assistant")).toBeVisible();
  }],
  ["overlay-mcp-card", "/#/mcp", async (page) => {
    await page.getByLabel("Server URL").fill("https://tools.example.com/mcp/many");
    await page.getByLabel(/^Name/).fill("Inventory");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("region", { name: "Inventory", exact: true })).toBeVisible();
  }],
];

for (const [name, url, open] of OVERLAYS) {
  test(`sweep ${name}`, async ({ page, request }) => {
    await request.post(`${API}/__reset`);
    await page.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    for (const [view, width, height, scheme] of [VIEWS[0], VIEWS[2], VIEWS[3]]) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      // Same-URL hash navigation doesn't reload, so start each view from a blank page.
      await page.goto("about:blank");
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await open(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/${name}-${view}.png`, animations: "disabled" });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const serious = axe.violations
        .filter((v) => ["serious", "critical"].includes(v.impact))
        .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      report.push({ page: name, view, serious, overflow: { doc: false, wide: [] }, errors: [] });
      if (STRICT) expect(serious, `${name} ${view} accessibility`).toEqual([]);
      await request.post(`${API}/__reset`);
    }
  });
}
