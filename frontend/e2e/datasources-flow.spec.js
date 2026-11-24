import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Data sources in the project flow: the project's Data step (attach, give agents access,
// test a query, detach) and picking a data source in the new-project chat.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function connectSource(request) {
  const created = await (await request.post(`${API}/datasources`, { data: { name: "Bikeshare" } })).json();
  await request.put(`${API}/datasources/${created.source.id}/tables`, {
    data: { tables: ["agenticdb-510807.mydata.trips", "agenticdb-510807.mydata.stations"] },
  });
  return created.source.id;
}

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

for (const scheme of ["light", "dark"]) {
  test(`project data step in ${scheme}`, async ({ page, request }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await connectSource(request);

    await page.goto(`/#/projects/${PROJECT}/brief`);
    // Databases live on the Resources step, in their own tab.
    const data = page.locator(".stepper").getByRole("link", { name: /Resources/ });
    await expect(data).toContainText("None added");
    await data.click();
    await expect(page).toHaveURL(/\/resources$/);
    await page.getByRole("tab", { name: /Databases/ }).click();
    await expect(page).toHaveURL(/\/resources\/databases$/);
    await expect(page.getByText("No data sources attached")).toBeVisible();

    await page.getByRole("button", { name: "Attach Bikeshare" }).click();
    const attached = page.getByRole("region", { name: "Attached: Bikeshare" });
    await expect(attached).toContainText("mydata.trips");
    await expect(data).toContainText("2 tables");
    await expect(page.getByRole("tab", { name: /Databases/ })).toContainText("1");
    await expect(page.getByText("No agent can query this data yet")).toBeVisible();

    await page.getByRole("button", { name: "Give agents access" }).click();
    await expect(page.getByText("Gave flight_searcher sql_schema and sql_query")).toBeVisible();
    await expect(page.locator(".panel", { hasText: "Agents with access" })).toContainText("flight_searcher");
    await expect(page.locator(".stepper").getByRole("link", { name: /Compile/ })).toContainText("Not compiled");

    await attached.getByRole("button", { name: "Run query" }).click();
    await expect(attached.locator(".dresult__table")).toContainText("21st & Speedway @PCL");
    await page.screenshot({ path: `e2e/screenshots/data-step-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "data step")).toEqual([]);

    await page.getByRole("button", { name: "Detach Bikeshare" }).click();
    await expect(page.getByText("No data sources attached")).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach Bikeshare" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`new project with a data source in ${scheme}`, async ({ page, request }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    const sourceId = await connectSource(request);

    await page.goto("/#/new");
    await page.getByRole("button", { name: "Add context" }).click();
    await page.getByRole("menuitem", { name: /Add data source/ }).click();
    await page.getByRole("checkbox", { name: /Bikeshare/ }).check();
    await expect(page.getByRole("list", { name: "Attachments for this project" })).toContainText("Bikeshare");
    await page.screenshot({ path: `e2e/screenshots/new-project-data-${scheme}.png` });
    expect(await axeProblems(page, "new project data")).toEqual([]);

    await page.getByLabel("Task description").fill("Find the busiest bike stations");
    // Sending talks it through first; planning is the explicit Create plan step.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("region", { name: "Task brief" }).getByRole("button", { name: "Create plan" }).click();
    await expect(page.getByRole("link", { name: /Open project|Review plan/ }).first()).toBeVisible();
    const sent = await (await request.get(`${API}/__last_create`)).json();
    expect(sent.datasource_ids).toEqual([sourceId]);
    expect(errors).toEqual([]);
  });
}
