import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// Model privileges in the console: the organisation's catalog, a team's limit, a member's limit inside
// the team. A limit only narrows; a group admin can only hand out models they may use themselves.
const API = "http://127.0.0.1:8765";
const GEMINI = "gemini-3.1-pro-preview";
const MINI = "gpt-4o-mini";
const CLAUDE = "global.anthropic.claude-sonnet-4-6";

/** Open a dropdown inside `scope`, tick the named models, close it. */
async function tick(scope, ...models) {
  await scope.getByRole("button", { name: /^Allowed models for/ }).click();
  for (const m of models) await scope.getByRole("option", { name: m, exact: true }).click();
  await scope.page().keyboard.press("Escape");
}

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

const as = (request, orgRole, teams) => request.post(`${API}/__access_as`, { data: { orgRole, teams } });
const state = async (request) => (await request.get(`${API}/__access_state`)).json();

async function openModels(page, team = "A") {
  await page.goto(`/#/teams/${team}`);
  await page.getByRole("tab", { name: "Models" }).click();
}

test("the Super Admin limits a team to some models, and clears the limit", async ({ page, request }) => {
  await as(request, "master", {});
  await openModels(page);
  const team = page.getByRole("form", { name: "Models for the team" });
  await expect(team.getByLabel("No limit (every model)")).toBeChecked();
  await team.getByLabel("Only these models").check();
  await tick(team, MINI, GEMINI);
  await team.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await state(request)).allowlists.find((l) => l.scope_type === "team")?.models).toEqual([
    "openai/gpt-4o-mini",
    "google_genai/gemini-3.1-pro-preview",
  ]);
  await page.reload();
  await page.getByRole("tab", { name: "Models" }).click();
  await expect(page.getByRole("form", { name: "Models for the team" }).getByLabel("Only these models")).toBeChecked();

  await page.getByRole("form", { name: "Models for the team" }).getByLabel("No limit (every model)").check();
  await page.getByRole("form", { name: "Models for the team" }).getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await state(request)).allowlists.length).toBe(0);
});

test("a group admin sees the team's limit but can't change it, and limits members within it", async ({ page, request }) => {
  // the Super Admin limits the team to two models first
  await as(request, "master", {});
  await openModels(page);
  const team = page.getByRole("form", { name: "Models for the team" });
  await team.getByLabel("Only these models").check();
  await tick(team, MINI, GEMINI);
  await team.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await state(request)).allowlists.length).toBe(1);

  await as(request, "user", {});
  await page.reload();
  await page.getByRole("tab", { name: "Models" }).click();
  const teamForm = page.getByRole("form", { name: "Models for the team" });
  await expect(teamForm.getByLabel("Only these models")).toBeDisabled();
  await expect(teamForm.getByRole("button", { name: "Save" })).toHaveCount(0);

  // a member's limit: offered only what the team allows (not the Bedrock model)
  await page.getByText("ada@example.com").first().click();
  const member = page.getByRole("form", { name: "Models for ada@example.com" });
  await member.getByLabel("Only these models").check();
  await member.getByRole("button", { name: /^Allowed models for/ }).click();
  await expect(member.getByRole("option", { name: CLAUDE, exact: true })).toHaveCount(0);
  await member.getByRole("option", { name: MINI, exact: true }).click();
  await page.keyboard.press("Escape");
  await member.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await state(request)).allowlists.find((l) => l.scope_type === "member")?.models).toEqual(["openai/gpt-4o-mini"]);
  await expect(page.getByText("1 model", { exact: true })).toBeVisible();
});

test("the organisation's catalog, fallback and unpriced-model exceptions are the Super Admin's to set", async ({ page, request }) => {
  await as(request, "master", {});
  await page.goto("/#/admin");
  const org = page.getByRole("form", { name: "Models for the organisation" });
  await org.getByLabel("Only these models").check();
  await tick(org, MINI, CLAUDE);
  await org.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await state(request)).orgModels.catalog).toEqual(["openai/gpt-4o-mini", "bedrock/global.anthropic.claude-sonnet-4-6"]);

  const fb = page.getByRole("form", { name: "Fallback and unpriced models" });
  await fb.getByRole("button", { name: "Fallback model" }).click();
  await fb.getByRole("option", { name: MINI, exact: true }).click();
  await fb.getByRole("button", { name: "Models allowed without a price" }).click();
  await fb.getByRole("option", { name: CLAUDE, exact: true }).click();
  await page.keyboard.press("Escape");
  await fb.getByRole("button", { name: "Save fallback and exceptions" }).click();
  await expect.poll(async () => (await state(request)).orgModels.fallback_model).toBe("openai/gpt-4o-mini");
  expect((await state(request)).orgModels.unpriced_overrides).toEqual(["bedrock/global.anthropic.claude-sonnet-4-6"]);
  // saving the fallback did not lose the catalog
  expect((await state(request)).orgModels.catalog).toHaveLength(2);
});

test("a Sub Admin reads the organisation's models but can't change them", async ({ page, request }) => {
  await as(request, "admin", {});
  await page.goto("/#/admin");
  await expect(page.getByText("Only the Super Admin changes the organisation's models.")).toBeVisible();
  await expect(page.getByRole("form", { name: "Models for the organisation" }).getByLabel("No limit (every model)")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save fallback and exceptions" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"]) {
  test(`the model editors have no serious accessibility problems, ${scheme}`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await as(request, "master", {});
    await openModels(page);
    await page.getByRole("form", { name: "Models for the team" }).getByLabel("Only these models").check();
    await settled(page);
    let { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual([]);
    await page.goto("/#/admin");
    await expect(page.getByRole("form", { name: "Fallback and unpriced models" })).toBeVisible();
    await settled(page);
    ({ violations } = await new AxeBuilder({ page }).analyze());
    expect(violations.filter((v) => ["serious", "critical"].includes(v.impact))).toEqual([]);
  });
}
