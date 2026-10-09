import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Data sources: connect BigQuery, choose tables (browsed and by full name), attach to a
// project, run a test query (and see a write refused), and the Brief editor offering the
// SQL tools only once a source is attached — readable and accessible in both themes.
const API = "http://127.0.0.1:8765";
const TRAVEL = "Travel agent for finding cheap flights";
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

for (const scheme of ["light", "dark"]) {
  test(`data sources in ${scheme}: connect, tables, attach, test query`, async ({ page }) => {
    const errors = [];
    // The failed connection and the refused DELETE are deliberate 422s, which the browser logs.
    page.on("console", (m) => m.type() === "error" && !/status of 422/.test(m.text()) && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });

    // No SQL tools in the Brief editor before a source is attached.
    await page.goto(`/#/projects/${PROJECT}/brief`);
    const editor = page.locator(".panel", { hasText: "Models and tools" });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("button", { name: "sql_query" })).toHaveCount(0);

    await page.getByRole("link", { name: "Data sources" }).click();
    await expect(page).toHaveURL(/#\/data$/);
    await expect(page.getByRole("heading", { name: "Data sources", level: 1 })).toBeVisible();

    // A wrong service account names the failing step.
    const form = page.locator(".panel", { hasText: "Connect BigQuery" });
    await expect(form.getByLabel("Google Cloud project")).toHaveValue("agenticdb-510807");
    await form.getByLabel("Service account").fill("not-a-service-account");
    await form.getByRole("button", { name: "Connect" }).click();
    await expect(form.getByRole("list", { name: "Connection check" })).toContainText("workloadIdentityUser");
    expect(await axeProblems(page, "connect failed")).toEqual([]);

    await form.getByLabel("Service account").fill("agentic-bq-reader@agenticdb-510807.iam.gserviceaccount.com");
    await form.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connected BigQuery")).toBeVisible();

    // Choose tables: browse mydata, and add a public table by name.
    // A just-connected source opens on its Tables tab, with the table picker.
    const source = page.getByRole("region", { name: "BigQuery", exact: true });
    await source.getByLabel("trips").check();
    await source.getByLabel("Add a table by full name").fill("bigquery-public-data.samples.shakespeare");
    await source.getByRole("button", { name: "Add", exact: true }).click();
    await expect(source.getByText("bigquery-public-data.samples.shakespeare")).toBeVisible();
    await page.screenshot({ path: `e2e/screenshots/datasources-tables-${scheme}.png`, fullPage: true });
    await source.getByRole("button", { name: "Save tables" }).click();
    const tables = source.getByRole("region", { name: /Tables in/ });
    await expect(tables.locator(".dtables li")).toHaveCount(2);
    await expect(tables).toContainText("mydata.trips");

    // Attach to the travel project.
    await source.getByRole("tab", { name: /^Projects/ }).click();
    await source.getByLabel(TRAVEL).check();
    await expect(source.getByLabel(TRAVEL)).toBeChecked();
    await expect(source).toContainText("No agent queries it yet");

    await expect(source.getByRole("button", { name: /^BigQuery/ })).toContainText("2 tables · 1 project");

    // Test query: rows and bytes; a write is refused.
    await source.getByRole("tab", { name: "Test query" }).click();
    await source.getByRole("button", { name: "Run query" }).click();
    await expect(source.locator(".dresult__table")).toContainText("21st & Speedway @PCL");
    await expect(source.locator(".dresult__meta")).toContainText("23.0 MB scanned");
    await page.screenshot({ path: `e2e/screenshots/datasources-query-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "query result")).toEqual([]);
    await source.getByRole("textbox", { name: "Test query" }).fill("DELETE FROM `agenticdb-510807.mydata.trips` WHERE TRUE");
    await source.getByRole("button", { name: "Run query" }).click();
    await expect(source.getByText("only SELECT queries are allowed")).toBeVisible();

    // Now the Brief editor offers the SQL tools.
    await page.goto(`/#/projects/${PROJECT}/brief`);
    await expect(editor.getByRole("group", { name: "Tools for flight_searcher" }).getByRole("button", { name: "sql_query" })).toBeVisible();

    // Removing the source asks first.
    await page.goto("/#/data");
    await source.getByRole("button", { name: "Delete BigQuery" }).click();
    await source.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect BigQuery" })).toBeVisible();

    expect(errors).toEqual([]);
  });
}
