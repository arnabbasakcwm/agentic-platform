import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// The Run tab's finished outputs: Export (Word, PDF, CSV), Send by email, CSV answers as
// tables, and citations with a Sources panel. The files themselves are checked in the
// backend (test_export.py); here, the UI around them.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const RUN_URL = `/#/projects/${PROJECT}/run`;
const RICH = { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October", step_ms: 40, scenario: "rich" };

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
});

const card = (page, agent) => page.getByRole("article", { name: new RegExp(`^${agent.replace("_", ".")} output`, "i") });

async function runRich(page) {
  await page.goto(RUN_URL);
  await expect(page.locator(".flow-node")).toHaveCount(3);
  await page.locator(".run-input").fill(JSON.stringify(RICH, null, 2));
  await page.getByRole("button", { name: "Run graph" }).click();
  await expect(page.locator(".outcard--completed")).toHaveCount(3, { timeout: 20_000 });
}

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

// ------------------------------------------------------------------ Feature 1: export
test("Export downloads an agent's output and the whole run, in each format", async ({ page, request }) => {
  await runRich(page);
  const analyzer = card(page, "price_analyzer");
  for (const [label, ext] of [["Word", "docx"], ["PDF", "pdf"], ["CSV", "csv"]]) {
    await analyzer.getByRole("button", { name: "Export price_analyzer output" }).click();
    const menu = page.getByRole("menu", { name: "Export price_analyzer output as" });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    const download = page.waitForEvent("download");
    await menu.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(new RegExp(`^Travel-agent_price_analyzer_[\\w-]{1,8}_\\d{8}-\\d{4}\\.${ext}$`));
    const sent = await (await request.get(`${API}/__last_export`)).json();
    expect(sent).toMatchObject({ format: ext, agent: "price_analyzer" });
  }
  // The whole run, from the Result header.
  await page.getByRole("button", { name: "Export the whole run" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^PDF/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^Travel-agent_all_.*\.pdf$/);
  expect((await (await request.get(`${API}/__last_export`)).json()).agent).toBeNull();
});

test("a failed export says so, and the menu works by keyboard", async ({ page }) => {
  await runRich(page);
  await page.route("**/export?*", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error_type: "ExportUnavailable", message: "this run has no finished output to export yet", details: null }),
    }),
  );
  const exportButton = card(page, "flight_searcher").getByRole("button", { name: "Export flight_searcher output" });
  await exportButton.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /^PDF/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(page, "flight_searcher").getByRole("alert")).toHaveText(
    "Export failed: this run has no finished output to export yet",
  );
  await expect(exportButton).toBeFocused();
  // Esc closes the menu without exporting.
  await exportButton.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await axeProblems(page, "run outputs")).toEqual([]);
});

// ------------------------------------------------------------------ Feature 2: email
test("Send by email validates the form, then sends the chosen formats", async ({ page, request }) => {
  await runRich(page);
  await card(page, "price_analyzer").getByRole("button", { name: "Send price_analyzer output by email" }).click();
  const dialog = page.getByRole("dialog", { name: "Send by email" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Subject")).toHaveValue(/price_analyzer output$/);
  await expect(dialog.getByRole("checkbox", { name: /PDF/ })).toBeChecked();

  // Nothing filled in: every problem is named, and nothing is sent.
  await dialog.getByRole("checkbox", { name: /PDF/ }).uncheck();
  await dialog.getByLabel("Subject").fill("");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText("Add at least one recipient.")).toBeVisible();
  await expect(dialog.getByText("Add a subject.")).toBeVisible();
  await expect(dialog.getByText("Choose at least one format.")).toBeVisible();
  await expect(dialog.getByLabel("To", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("To", { exact: true })).toHaveAttribute("aria-invalid", "true");

  await dialog.getByLabel("To", { exact: true }).fill("bob@example.com, not-an-email");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText("Not an email address: not-an-email")).toBeVisible();
  expect(await (await request.get(`${API}/__last_email`)).json()).toEqual({});

  await dialog.getByLabel("To", { exact: true }).fill("bob@example.com; carol@example.com");
  await dialog.getByLabel("CC (optional)").fill("dan@example.com");
  await dialog.getByLabel("Subject").fill("Goa fares");
  await dialog.getByLabel("Message (optional)").fill("See attached.");
  await dialog.getByRole("checkbox", { name: /Word/ }).check();
  await dialog.getByRole("checkbox", { name: /CSV/ }).check();
  await dialog.getByRole("switch", { name: "Include output in email body" }).click();
  expect(await axeProblems(page, "email modal")).toEqual([]);
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByRole("status")).toContainText("Sent to 3 recipients");
  expect(await (await request.get(`${API}/__last_email`)).json()).toEqual({
    to: ["bob@example.com", "carol@example.com"],
    cc: ["dan@example.com"],
    subject: "Goa fares",
    message: "See attached.",
    formats: ["docx", "csv"],
    include_body: false,
    agent_id: "price_analyzer",
  });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(page, "price_analyzer").getByRole("button", { name: "Send price_analyzer output by email" })).toBeFocused();
});

test("a sending failure is shown in the modal, and Esc closes it", async ({ page }) => {
  await runRich(page);
  await page.getByRole("button", { name: "Send the whole run by email" }).click();
  const dialog = page.getByRole("dialog", { name: "Send by email" });
  await dialog.getByLabel("To", { exact: true }).fill("ops@fail.example");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText("the email couldn't be sent; try again later")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// ------------------------------------------------------------------ Feature 3: CSV tables
test("a CSV answer shows as a sortable table, with Raw and Copy", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    d.dismiss();
  });
  await runRich(page);
  const analyzer = card(page, "price_analyzer");
  const table = analyzer.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText(["airline", "fare_inr", "notes"]);
  await expect(analyzer.getByText("4 rows", { exact: true })).toBeVisible();
  // Quoted commas and doubled quotes are one cell each; markup is shown as text.
  await expect(table.getByRole("cell", { name: "Promotional, mornings only" })).toBeVisible();
  await expect(table.getByRole("cell", { name: 'Full service, "premium"' })).toBeVisible();
  await expect(table.getByRole("cell", { name: "<script>alert(1)</script>" })).toBeVisible();
  expect(dialogs).toBe(0);
  // The empty fare is "—"; numbers are right-aligned.
  const fares = table.locator("tbody tr td:nth-child(2)");
  await expect(fares.nth(2)).toHaveText(/—/);
  await expect(fares.first()).toHaveCSS("text-align", "right");

  // Sorting by fare: ascending, descending, then back to the original order.
  const sortFare = table.getByRole("button", { name: "fare_inr" });
  await sortFare.click();
  await expect(table.getByRole("columnheader", { name: "fare_inr" })).toHaveAttribute("aria-sort", "ascending");
  await expect(fares).toHaveText(["6899", "7004", "8249", /—/]);
  await sortFare.click();
  await expect(fares).toHaveText(["8249", "7004", "6899", /—/]);
  await sortFare.click();
  await expect(fares).toHaveText(["7004", "8249", /—/, "6899"]);

  // Raw shows the text exactly as the agent wrote it.
  await analyzer.getByRole("button", { name: "Raw" }).click();
  await expect(analyzer.locator(".datatable__raw")).toContainText('Air India,,"Full service, ""premium"""');
  await expect(table).toHaveCount(0);
  await analyzer.getByRole("button", { name: "Table" }).click();
  await expect(analyzer.getByRole("table")).toBeVisible();
  await expect(analyzer.getByRole("button", { name: "Copy" }).last()).toBeVisible();
  expect(await axeProblems(page, "csv table")).toEqual([]);
});

test("a long table is paged, and a broken one falls back to the raw text", async ({ page }) => {
  await page.goto(RUN_URL);
  await expect(page.locator(".flow-node")).toHaveCount(3);
  await page.locator(".run-input").fill(JSON.stringify({ ...RICH, rows: 150 }));
  await page.getByRole("button", { name: "Run graph" }).click();
  const analyzer = card(page, "price_analyzer");
  await expect(analyzer.getByText("150 rows · rows 1–100")).toBeVisible({ timeout: 20_000 });
  await expect(analyzer.locator("tbody tr")).toHaveCount(100);
  await analyzer.getByRole("button", { name: "Next" }).click();
  await expect(analyzer.locator("tbody tr")).toHaveCount(50);
  await expect(analyzer.getByText("Page 2 of 2")).toBeVisible();

  await page.locator(".run-input").fill(JSON.stringify({ ...RICH, broken: true }));
  await page.getByRole("button", { name: "Run graph" }).click();
  await expect(card(page, "price_analyzer").getByRole("note")).toContainText("couldn't be read as one", { timeout: 20_000 });
  await expect(card(page, "price_analyzer").locator(".datatable__raw")).toContainText('"Akasa Air,7004');
  // The other outputs still render.
  await expect(card(page, "flight_searcher")).toContainText("Flights found");
});

// ------------------------------------------------------------------ Feature 4: citations
test("cited answers show clickable markers with a preview and a Sources panel", async ({ page }) => {
  await runRich(page);
  const searcher = card(page, "flight_searcher");
  const marker = searcher.getByRole("button", { name: "Source 1: IndiGo schedule" });
  await expect(marker).toHaveText("[1]");
  // Hover preview: title, domain, snippet.
  await marker.hover();
  const tip = searcher.getByRole("tooltip").filter({ hasText: "IndiGo schedule" });
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("www.goindigo.in");
  await expect(tip).toContainText("Six daily departures");
  // Clicking jumps to the source in the panel.
  await marker.click();
  await expect(searcher.locator("#source-flight_searcher-1")).toBeFocused();

  const sources = searcher.getByRole("region", { name: "Sources" });
  const link = sources.getByRole("link", { name: /IndiGo schedule/ });
  await expect(link).toHaveAttribute("href", "https://www.goindigo.in/schedule");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(sources).toContainText("fares.pdf, p. 3");
  // The written Sources section gives way to the panel (shown once).
  await expect(searcher.getByText("[1] IndiGo schedule — https://www.goindigo.in/schedule")).toHaveCount(0);
  await expect(sources.getByText("Added by the platform")).toHaveCount(0);

  // An answer whose sources the platform appended carries a badge.
  const advisor = card(page, "travel_advisor");
  await expect(advisor.getByRole("region", { name: "Sources" }).getByText("Added by the platform")).toBeVisible();
  // Answers without citations are unchanged (no panel).
  await expect(card(page, "price_analyzer").getByRole("region", { name: "Sources" })).toHaveCount(0);
  expect(await axeProblems(page, "citations")).toEqual([]);
});

test("old outputs without citations still render as before", async ({ page }) => {
  await page.goto(RUN_URL);
  await expect(page.locator(".flow-node")).toHaveCount(3);
  await page.locator(".run-input").fill(JSON.stringify({ ...RICH, scenario: undefined }));
  await page.getByRole("button", { name: "Run graph" }).click();
  await expect(page.locator(".outcard--completed")).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Sources" })).toHaveCount(0);
  await expect(card(page, "price_analyzer").getByRole("table")).toBeVisible(); // its Markdown table
  await expect(page.locator(".cite__marker")).toHaveCount(0);
});
