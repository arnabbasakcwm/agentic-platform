import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// What the console offers at each access level (it only avoids offering what the API would refuse; the
// API checks every request again), and how a run the platform stopped is explained.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const step = (name) => `/#/projects/${PROJECT}/${name}`;

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
});
test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

const level = (request, projectLevel, extra = {}) =>
  request.post(`${API}/__access_as`, { data: { orgRole: "user", projectLevel, teams: {}, ...extra } });
const notAvailable = (page) => page.getByText("Not available with your access");

test("view access: the plan can be read, nothing can be changed or run", async ({ page, request }) => {
  await level(request, "view");
  await page.goto(step("plan"));
  await expect(page.getByRole("heading", { name: "Agents", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit as JSON" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assistant" })).toHaveCount(0);
  for (const [name, text] of [
    ["brief", "Only the project's owner, or an admin of its team, can change a project's brief"],
    ["resources", "can attach files, data and tools to a project"],
    ["compile", "You need Edit access to compile a project"],
    ["run", "You need Use access to run a project"],
    ["deploy", "can deploy a project"],
  ]) {
    await page.goto(step(name));
    await expect(notAvailable(page)).toBeVisible();
    await expect(page.getByText(text, { exact: false })).toBeVisible();
  }
});

test("use access: can run, can't compile or change anything", async ({ page, request }) => {
  await level(request, "use");
  await page.goto(step("run"));
  await expect(page.getByRole("button", { name: "Run graph" })).toBeVisible();
  await expect(notAvailable(page)).toHaveCount(0);
  await page.goto(step("compile"));
  await expect(notAvailable(page)).toBeVisible();
  await page.goto(step("plan"));
  await expect(page.getByRole("button", { name: "Edit as JSON" })).toHaveCount(0);
});

test("edit access: can compile and edit the plan, can't share or change the brief", async ({ page, request }) => {
  await level(request, "edit");
  await page.goto(step("compile"));
  await expect(notAvailable(page)).toHaveCount(0);
  await page.goto(step("plan"));
  await expect(page.getByRole("button", { name: "Edit as JSON" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  await page.goto(step("brief"));
  await expect(notAvailable(page)).toBeVisible();
});

test("manage access: can share, but the owner's own settings stay the owner's", async ({ page, request }) => {
  await level(request, "manage");
  await page.goto(step("plan"));
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible();
  await page.goto(step("deploy"));
  await expect(notAvailable(page)).toBeVisible();
});

test("the owner is offered everything", async ({ page }) => {
  for (const name of ["brief", "compile", "run"]) {
    await page.goto(step(name));
    await expect(notAvailable(page)).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Assistant" })).toBeVisible();
});

test("a project shared agent by agent shows only its agents", async ({ page, request }) => {
  await level(request, "use", { restricted: true });
  await page.goto(step("plan"));
  await expect(page.getByRole("heading", { name: "Agents", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit as JSON" })).toHaveCount(0);
  await page.goto(step("run"));
  await expect(page.getByText("shared with you one agent at a time")).toBeVisible();
});

async function runWith(page, input) {
  await page.goto(step("run"));
  await expect(page.locator(".flow-node")).toHaveCount(3);
  await page.locator(".run-input").fill(JSON.stringify({ ...input, step_ms: 40 }));
  await page.getByRole("button", { name: "Run graph" }).click();
}

test("a run stopped because the budget ran out says so, and keeps the finished answer", async ({ page }) => {
  await runWith(page, { scenario: "budget" });
  await expect(page.getByText("Stopped: budget used up")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("A budget limit was reached")).toBeVisible();
  await expect(page.locator("pre.callout__detail")).toContainText("the user:u1 budget is used up");
  await expect(page.locator(".outcard--completed")).toHaveCount(1); // the first agent finished before the stop
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("button", { name: /Budget used up/ })).toBeVisible();
});

test("a run stopped because the model isn't allowed says so", async ({ page }) => {
  await runWith(page, { scenario: "model" });
  await expect(page.getByText("Stopped: model not allowed for you")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Ask an admin for access, or for a fallback model")).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("button", { name: /Model not allowed/ })).toBeVisible();
});

for (const scheme of ["light", "dark"]) {
  test(`the explanation pages have no serious accessibility problems, ${scheme}`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await level(request, "view");
    await page.goto(step("run"));
    await expect(notAvailable(page)).toBeVisible();
    await settled(page);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual([]);
  });
}
