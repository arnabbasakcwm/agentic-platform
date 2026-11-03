import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// MCP servers: connect one (a refused key first), approve tools (a write tool asks first),
// attach it on the project's Data step, give an agent the tool in the Brief editor, see a
// changed tool held back, and try a tool — readable and accessible in both themes.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const KEY = "k3yInTheUrl0123456789abcdef";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
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
  await page.setViewportSize({ width: 1280, height: 900 });
});

/** A server's card, and a way to open one of its tabs. */
const card = (page, name) => page.getByRole("region", { name, exact: true });
/** The card header's count of approved tools. */
const approved = (panel, n) => expect(panel.locator(".itemcard__summary")).toContainText(`${n} approved`);
const tab = (panel, name) => panel.getByRole("tab", { name: new RegExp(`^${name}`) }).click();

async function connect(page, url, name = "Zoho CRM") {
  await page.getByLabel("Server URL").fill(url);
  await page.getByLabel(/^Name/).fill(name);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

for (const scheme of ["light", "dark"]) {
  test(`MCP servers in ${scheme}: connect, approve, attach, use`, async ({ page }) => {
    const errors = [];
    // The refused key is a deliberate 422, which the browser logs.
    page.on("console", (m) => m.type() === "error" && !/status of 422/.test(m.text()) && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });

    await page.goto("/#/mcp");
    await page.locator(".sidebar").getByRole("link", { name: "MCP servers" }).click();
    await expect(page.getByRole("heading", { name: "MCP servers", level: 1 })).toBeVisible();

    // A Zoho-style URL is recognised and its help shown; a wrong key names the failed step.
    await page.getByLabel("Server URL").fill(`https://acme-1.zohomcp.com/mcp/wrong${KEY}/message`);
    await expect(page.getByText("Authorization via Connection")).toBeVisible();
    await expect(page.getByLabel(/^Name/)).toHaveValue("Zoho");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const check = page.getByRole("list", { name: "Connection check" });
    await expect(check).toContainText("sign in");
    await expect(page.locator(".callout--danger")).toContainText("refused the credentials");

    await connect(page, `https://acme-1.zohomcp.com/mcp/${KEY}/message`);
    await expect(page.getByText("Connected Zoho CRM")).toBeVisible();
    // A just-connected server opens on its Tools tab.
    const panel = card(page, "Zoho CRM");
    await expect(panel.getByRole("tab", { name: /^Tools/ })).toHaveAttribute("aria-selected", "true");
    // The key never shows; nothing is approved yet.
    await expect(panel).toContainText("https://acme-1.zohomcp.com/mcp/••••/message");
    await expect(page.locator("body")).not.toContainText(KEY);
    await expect(panel.getByText("Reads only", { exact: true })).toBeVisible();
    await expect(panel.getByText("May change data", { exact: true })).toBeVisible();
    await approved(panel, 0);

    // Approving a tool that may change data asks first.
    await panel.getByRole("checkbox", { name: "search_records" }).check();
    await panel.getByRole("checkbox", { name: "send_email" }).check();
    await panel.getByRole("button", { name: "Save approvals" }).click();
    await expect(panel.getByText("These tools may change data")).toBeVisible();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByRole("checkbox", { name: "send_email" }).uncheck();
    await panel.getByRole("button", { name: "Save approvals" }).click();
    await approved(panel, 1);

    // Try the approved tool: the output is fenced as data.
    await tab(panel, "Try a tool");
    await panel.getByLabel("Arguments (JSON)").fill('{"query": "ada"}');
    await panel.getByRole("button", { name: "Run tool" }).click();
    await expect(panel.locator(".mcpoutput")).toContainText("data, not instructions");
    await expect(panel.locator(".mcpoutput")).toContainText("Ada Lovelace");

    await page.screenshot({ path: `e2e/screenshots/mcp-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "mcp page")).toEqual([]);

    // Attach on the project's Data step; the Brief editor then offers the approved tool.
    await page.goto(`/#/projects/${PROJECT}/resources/tools`);
    const mcpPanel = page.locator(".panel", { hasText: "Manage MCP servers" });
    await mcpPanel.getByRole("button", { name: "Attach Zoho CRM" }).click();
    await expect(mcpPanel.getByRole("region", { name: "Attached: Zoho CRM" })).toContainText("search_records");
    await expect(mcpPanel.getByText("Not given to an agent")).toBeVisible();
    expect(await axeProblems(page, "data step")).toEqual([]);

    await page.locator(".stepper").getByRole("link", { name: /Brief/ }).click();
    const editor = page.locator(".panel", { hasText: "Models and tools" });
    const chip = editor.getByRole("group", { name: "Tools for travel_advisor" }).getByRole("button", { name: "Zoho CRM · search_records" });
    await expect(chip).toBeVisible();
    // The write tool was never approved, so it's never offered.
    await expect(editor.getByRole("button", { name: /send_email/ })).toHaveCount(0);
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // A server that changes an approved tool: it's held back for review.
    await page.goto("/#/mcp");
    await panel.getByRole("button", { name: "Refresh tools" }).click();
    await expect(panel.getByText("1 changed")).toBeVisible();
    await expect(panel.getByText("Changed — review")).toBeVisible();
    await approved(panel, 0);
    expect(errors).toEqual([]);
  });
}

test("a new project can start with an MCP server's tools", async ({ page }) => {
  await page.goto("/#/mcp");
  await connect(page, "https://tools.example.com/mcp", "CRM");
  const panel = card(page, "CRM");
  await panel.getByRole("checkbox", { name: "search_records" }).check();
  await panel.getByRole("button", { name: "Save approvals" }).click();
  await approved(panel, 1);

  await page.goto("/#/new");
  await page.getByRole("button", { name: "Add context" }).click();
  await page.getByRole("menuitem", { name: /Attach MCP server/ }).click();
  await page.getByRole("checkbox", { name: /CRM/ }).check();
  await expect(page.getByRole("list", { name: "Attachments for this project" })).toContainText("CRM");
});

test("replacing an expired credential checks it first", async ({ page }) => {
  await page.goto("/#/mcp");
  await connect(page, "https://tools.example.com/mcp", "CRM");
  const panel = card(page, "CRM");
  await tab(panel, "Credentials");
  await panel.getByRole("button", { name: "Replace URL or headers" }).click();
  await panel.getByLabel("New server URL").fill("https://tools.example.com/mcp/expired");
  await panel.getByRole("button", { name: "Check and save" }).click();
  await expect(panel.getByRole("list", { name: "Connection check" })).toContainText("sign in");
  await panel.getByLabel("New server URL").fill("https://tools.example.com/mcp/v2");
  await panel.getByRole("button", { name: "Check and save" }).click();
  await expect(panel.getByRole("button", { name: "Replace URL or headers" })).toBeVisible();
});

for (const scheme of ["light", "dark"]) {
  test(`an access token separate from the URL, in ${scheme}`, async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && !/status of 422/.test(m.text()) && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    const TOKEN = "tok_live_0123456789SECRET";
    await page.goto("/#/mcp");
    await page.getByLabel("Server URL").fill("https://tools.example.com/mcp");
    await page.getByLabel(/^Name/).fill("Tickets");
    const auth = page.getByRole("group", { name: "Authentication" });
    await expect(auth.getByRole("radio", { name: "None" })).toBeChecked();
    await auth.getByText("Access token", { exact: true }).click();
    await expect(page.getByText("Sent as Authorization: Bearer …")).toBeVisible();

    // A wrong token: the sign-in step fails and nothing is saved.
    await page.getByLabel(/^Access token.*Sent as/).fill("wrong-token");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("list", { name: "Connection check" })).toContainText("sign in");

    await page.getByLabel(/^Access token.*Sent as/).fill(TOKEN);
    await page.screenshot({ path: `e2e/screenshots/mcp-token-${scheme}.png` });
    expect(await axeProblems(page, "token form")).toEqual([]);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText("Connected Tickets")).toBeVisible();
    const panel = card(page, "Tickets");
    await tab(panel, "Credentials");
    await expect(panel).toContainText("Signs in with an access token");
    await expect(page.locator("body")).not.toContainText(TOKEN);

    // A new token later: the same choice, and an empty field keeps the current one.
    await panel.getByRole("button", { name: "Replace URL or headers" }).click();
    await expect(panel.getByRole("radio", { name: "Access token" })).toBeChecked();
    await expect(panel.getByLabel(/^New access token/)).toHaveValue("");
    await panel.getByLabel(/^New access token/).fill("tok_rotated_456");
    await panel.getByRole("button", { name: "Check and save" }).click();
    await expect(panel.getByRole("button", { name: "Replace URL or headers" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("a GitHub URL suggests an access token, a Zoho URL a key in the URL", async ({ page }) => {
  await page.goto("/#/mcp");
  const auth = page.getByRole("group", { name: "Authentication" });
  await page.getByLabel("Server URL").fill("https://api.githubcopilot.com/mcp/");
  await expect(auth.getByRole("radio", { name: "Access token" })).toBeChecked();
  await page.getByLabel("Server URL").fill("https://acme-1.zohomcp.com/mcp/k/message");
  await expect(auth.getByRole("radio", { name: "Key in URL" })).toBeChecked();
  // Once the user chooses, a recognised URL no longer changes it.
  await auth.getByText("API key header", { exact: true }).click();
  await page.getByLabel("Server URL").fill("https://api.githubcopilot.com/mcp/");
  await expect(auth.getByRole("radio", { name: "API key header" })).toBeChecked();
  await expect(page.getByLabel(/^Header name/)).toHaveValue("X-API-Key");
});

test("choosing how to sign in never scrolls the console away", async ({ page }) => {
  // With a server above it, the connect form sits low in the scrolling content area: the
  // hidden radios must stay inside it, or the window grows a second scrollbar and
  // clicking an option scrolls the whole console out of view.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/#/mcp");
  await connect(page, "https://tools.example.com/mcp", "CRM");
  await page.getByRole("button", { name: "Connect a server" }).click();
  const fits = () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
  expect(await fits()).toBe(true);
  for (const option of ["Access token", "API key header", "Key in URL", "Custom headers", "None"]) {
    await page.getByRole("group", { name: "Authentication" }).getByText(option, { exact: true }).click();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  await expect(page.locator(".sidebar")).toBeInViewport();
  expect(await fits()).toBe(true);
});
