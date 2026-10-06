import { expect, test } from "@playwright/test";

// The model chosen for a new project survives leaving the page (e.g. to connect a data
// source) and reaches the planner; the reply names each agent's model.
const API = "http://127.0.0.1:8765";

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

test("the chosen model survives navigation and is what the agents get", async ({ page, request }) => {
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/#/new");
  await page.getByRole("button", { name: /Auto team size/ }).click();
  await page.getByRole("button", { name: /^Model/ }).click();
  await page.getByRole("option", { name: /Claude Haiku 4\.5/ }).click();
  await expect(page.getByRole("button", { name: /Auto team size/ })).toContainText("Claude Haiku 4.5");

  // Away to Data sources and back: the choice is still there.
  await page.getByRole("link", { name: "Data sources" }).click();
  await expect(page.getByRole("heading", { name: "Data sources", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "New project" }).click();
  await expect(page.getByRole("button", { name: /Auto team size/ })).toContainText("Claude Haiku 4.5");

  await page.getByLabel("Task description").fill("Find the busiest bike stations");
  await page.getByRole("button", { name: "Plan this team" }).click();
  await expect(page.getByRole("link", { name: "Review plan" })).toBeVisible();
  const sent = await (await request.get(`${API}/__last_create`)).json();
  expect(sent.available_llms).toEqual([{ provider: "bedrock", model: "in.anthropic.claude-haiku-4-5-20251001-v1:0" }]);
  await expect(page.locator(".msg__agents")).toContainText("Claude Haiku 4.5 · Anthropic on Bedrock");
  expect(errors).toEqual([]);
});
