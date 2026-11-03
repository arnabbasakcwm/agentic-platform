import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// New project: the assistant talks the task through first — a greeting creates nothing,
// questions come with quick answers, the brief card shows when it's ready to plan — and
// the plan is made only when the user says so (Create plan, or "yes, plan it").
const API = "http://127.0.0.1:8765";

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
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.setViewportSize({ width: 1280, height: 900 });
});

async function say(page, text) {
  await page.getByLabel("Task description").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

const lastCreate = async (request) => (await request.get(`${API}/__last_create`)).json();

for (const scheme of ["light", "dark"]) {
  test(`talk first, plan when asked, in ${scheme}`, async ({ page, request }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/#/new");

    // A greeting: a reply and a question, no brief, nothing planned.
    await say(page, "hello");
    await expect(page.getByText("Hello! What would you like your agents to do?")).toBeVisible();
    await expect(page.getByRole("region", { name: "Task brief" })).toHaveCount(0);
    expect(await lastCreate(request)).toEqual({});

    // A quick answer fills the composer; the user sends it.
    await page.getByRole("group", { name: /Answers to: What kind of task/ }).getByRole("button", { name: "Summarise emails" }).click();
    await expect(page.getByLabel("Task description")).toHaveValue("What kind of task is it? Summarise emails");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Not ready yet: a draft brief, Create plan still possible but not the main action.
    const card = page.getByRole("region", { name: "Task brief" });
    await expect(card).toContainText("Draft — answer the questions for a better plan");
    await expect(card.getByRole("button", { name: "Create plan" })).not.toHaveClass(/btn--primary/);
    await expect(page.getByText("May agents send or post anything?")).toBeVisible();
    expect(await lastCreate(request)).toEqual({});

    // Enough detail: ready to plan, and the assistant asks.
    await say(page, "Summarise the one email I name each run in 3 lines and post it to the chat I name; read-only on mail.");
    await expect(page.getByText("Shall I plan the team now?")).toBeVisible();
    await expect(card).toContainText("Ready to plan");
    await expect(card.getByRole("button", { name: "Create plan" })).toHaveClass(/btn--primary/);
    await page.screenshot({ path: `e2e/screenshots/intake-ready-${scheme}.png`, fullPage: true });
    expect(await axeProblems(page, "intake")).toEqual([]);

    // The brief is editable; Create plan uses the edited text and keeps the conversation.
    await card.getByLabel("Task brief (you can edit it)").fill("Summarise one named email in 3 lines and post it to a named chat.");
    await card.getByRole("button", { name: "Create plan" }).click();
    await expect(page.getByRole("link", { name: "Review plan" })).toBeVisible();
    const created = await lastCreate(request);
    expect(created.brief).toBe("Summarise one named email in 3 lines and post it to a named chat.");
    expect(created.intake.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    // The next message starts a new task.
    await expect(page.getByRole("separator").filter({ hasText: "New task" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Task brief" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("saying yes in the chat plans the team", async ({ page, request }) => {
  await page.goto("/#/new");
  await say(page, "Summarise the one email I name each run and post the summary to the chat I name.");
  await expect(page.getByText("Shall I plan the team now?")).toBeVisible();
  expect(await lastCreate(request)).toEqual({});
  await say(page, "yes, plan it");
  await expect(page.getByRole("link", { name: "Review plan" })).toBeVisible();
  const created = await lastCreate(request);
  expect(created.brief).toContain("Summarise the one email I name");
  expect(created.intake.at(-1)).toEqual({ role: "assistant", content: "Great, planning your team now." });
});
