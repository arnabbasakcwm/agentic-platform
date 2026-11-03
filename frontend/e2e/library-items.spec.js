import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Library pages with several items: each data source / MCP server is a one-line card that
// expands to tabs. Cards needing attention open on their own, the expanded state is
// remembered across reloads, the list can be filtered, expanded and collapsed, and long
// tool lists can be searched — in both themes, at desktop and phone widths.
const API = "http://127.0.0.1:8765";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

const card = (page, name) => page.getByRole("region", { name, exact: true });
const toggle = (page, name) => card(page, name).getByRole("button", { name: new RegExp(`^${name}`) }).first();

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

async function connectServer(page, url, name) {
  const header = page.getByRole("button", { name: "Connect a server" });
  if (await header.isVisible()) await header.click();
  await page.getByLabel("Server URL").fill(url);
  await page.getByLabel(/^Name/).fill(name);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(`Connected ${name}`)).toBeVisible();
}

for (const scheme of ["light", "dark"]) {
  test(`MCP servers as collapsible cards, in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/#/mcp");
    await connectServer(page, "https://tools.example.com/mcp", "CRM");
    await connectServer(page, "https://tools.example.com/mcp/many", "Inventory");
    await connectServer(page, "https://tools.example.com/mcp/stale", "Legacy");
    await connectServer(page, "https://docs.example.com/mcp", "Docs");

    // A first visit (nothing remembered): only the server whose sign-in failed is open,
    // on its Credentials tab; the others are one-line summaries.
    await page.evaluate(() => localStorage.removeItem("agentic-platform.mcp-servers-open"));
    await page.reload();
    await expect(page.getByText("4 servers")).toBeVisible();
    await expect(toggle(page, "Legacy")).toHaveAttribute("aria-expanded", "true");
    await expect(card(page, "Legacy").getByRole("tab", { name: "Credentials" })).toHaveAttribute("aria-selected", "true");
    await expect(card(page, "Legacy").getByText("Sign-in failed").first()).toBeVisible();
    for (const name of ["CRM", "Inventory", "Docs"]) {
      await expect(toggle(page, name)).toHaveAttribute("aria-expanded", "false");
    }
    await expect(toggle(page, "Inventory")).toContainText("11 tools · 0 approved · 0 projects");
    await page.screenshot({ path: `e2e/screenshots/library-mcp-${scheme}.png`, fullPage: true, animations: "disabled" });
    expect(await axeProblems(page, "collapsed list")).toEqual([]);

    // Inside a card: tabs with counts, a searchable tool list, details per tool.
    await toggle(page, "Inventory").click();
    const inventory = card(page, "Inventory");
    await expect(inventory.getByRole("tab", { name: /^Tools/ })).toContainText("0/11");
    await inventory.getByLabel("Filter tools").fill("items_3");
    await expect(inventory.locator(".mcptools__item")).toHaveCount(1);
    await inventory.getByRole("button", { name: "Show details of list_items_3" }).click();
    await expect(inventory.locator(".mcptools__schema")).toBeVisible();
    await inventory.getByRole("tab", { name: /^Projects/ }).click();
    await expect(inventory.getByRole("tabpanel")).toContainText("ticked here");
    await page.screenshot({ path: `e2e/screenshots/library-mcp-open-${scheme}.png`, fullPage: true, animations: "disabled" });
    expect(await axeProblems(page, "open card")).toEqual([]);

    // What's open is remembered across a reload.
    await page.reload();
    await expect(toggle(page, "Inventory")).toHaveAttribute("aria-expanded", "true");
    await expect(toggle(page, "Legacy")).toHaveAttribute("aria-expanded", "true");

    // Collapse all / expand all, also remembered.
    await page.getByRole("button", { name: "Collapse all" }).click();
    await expect(page.locator(".itemcard--open")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".itemcard--open")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(page.locator(".itemcard--open")).toHaveCount(4);

    // The filter narrows the list.
    await page.getByLabel("Filter servers").fill("docs.example");
    await expect(page.getByText("1 of 4 servers")).toBeVisible();
    await expect(page.locator(".itemcard")).toHaveCount(1);
    await page.getByLabel("Filter servers").fill("nothing like this");
    await expect(page.getByText("No servers match")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("MCP cards fit a phone screen", async ({ page }) => {
  await page.goto("/#/mcp");
  await connectServer(page, "https://tools.example.com/mcp", "CRM");
  await connectServer(page, "https://tools.example.com/mcp/many", "Inventory");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(toggle(page, "Inventory")).toHaveAttribute("aria-expanded", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Every card, and its actions and tool details, stay inside the screen.
  const inside = async (locator) => {
    const box = await locator.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  };
  await inside(card(page, "Inventory"));
  await inside(card(page, "Inventory").getByRole("button", { name: "Refresh tools" }));
  await inside(card(page, "Inventory").getByRole("button", { name: "Show details of list_items_1" }));
  await page.screenshot({ path: "e2e/screenshots/library-mcp-phone.png", fullPage: true, animations: "disabled" });
  expect(await axeProblems(page, "phone")).toEqual([]);
});

test("data sources as collapsible cards", async ({ page }) => {
  await page.goto("/#/data");
  const form = page.locator(".panel", { hasText: "Connect BigQuery" });
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected BigQuery")).toBeVisible();
  // A new source opens on its Tables tab, with the picker.
  const first = card(page, "BigQuery");
  await first.getByLabel("trips").check();
  await first.getByRole("button", { name: "Save tables" }).click();
  await expect(first.getByRole("tab", { name: /^Tables/ })).toContainText("1");

  await page.getByRole("button", { name: "Connect a source" }).click();
  await form.getByLabel("Name").fill("Warehouse");
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected Warehouse")).toBeVisible();

  // First visit: the source without tables needs attention and opens; the other doesn't.
  await page.evaluate(() => localStorage.removeItem("agentic-platform.data-sources-open"));
  await page.reload();
  await expect(page.getByText("2 sources")).toBeVisible();
  await expect(toggle(page, "Warehouse")).toHaveAttribute("aria-expanded", "true");
  await expect(card(page, "Warehouse").getByText("No tables", { exact: true })).toBeVisible();
  await expect(toggle(page, "BigQuery")).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, "BigQuery")).toContainText("1 table · 0 projects");

  await toggle(page, "BigQuery").click();
  await card(page, "BigQuery").getByRole("tab", { name: "Test query" }).click();
  await card(page, "BigQuery").getByRole("button", { name: "Run query" }).click();
  await expect(card(page, "BigQuery").locator(".dresult__table")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/library-data.png", fullPage: true, animations: "disabled" });
  expect(await axeProblems(page, "data sources")).toEqual([]);
});
