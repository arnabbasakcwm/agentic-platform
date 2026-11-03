import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// The plan assistant uses the New project composer (components/composer): the same hero,
// chips, popovers and template cards, in the side panel and in fullscreen. Its chips limit
// one change; untouched, a change request is exactly `{message}` as before.
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const PLAN = `/#/projects/${PROJECT}/plan`;
const SCREENS = "e2e/__screens__";
const CHIPS = ["add", "model", "team", "tools"];
const POPOVERS = "[role=dialog], [role=listbox], [role=menu]";

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

const panel = (page) => page.getByRole("complementary", { name: "Plan assistant" });
const visiblePopovers = (page) => page.locator(POPOVERS).filter({ visible: true });

function chip(page, id) {
  const form = panel(page).locator("form.composer");
  return {
    add: form.getByRole("button", { name: "Add context" }),
    model: form.getByRole("button", { name: /^Model/ }),
    team: form.getByRole("button", { name: /^Team/ }),
    tools: form.getByRole("button", { name: /^Tools/ }),
  }[id];
}

async function popoverOf(page, id) {
  const controls = await chip(page, id).getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  return page.locator(`[id="${controls}"]`);
}

async function setup(page, { size = [1440, 900], scheme = "light", full = false, errors } = {}) {
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "1");
    localStorage.removeItem("agentic-platform.assistant-width");
  });
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: size[0], height: size[1] });
  if (errors) {
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
  }
  await page.goto(PLAN);
  await expect(chip(page, "tools")).toBeVisible();
  if (full) {
    await panel(page).getByRole("button", { name: "Fullscreen" }).click();
    await expect(panel(page).getByRole("button", { name: "Exit fullscreen" })).toBeVisible();
  }
}

async function sendChange(page, request, text) {
  await panel(page).getByRole("textbox", { name: "Change request" }).fill(text);
  await panel(page).getByRole("button", { name: "Send change request" }).click();
  await expect(panel(page).locator(".msg--assistant").last()).toContainText("Gave flight_searcher");
  return (await request.get(`${API}/__last_revise`)).json();
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function checkUnobstructed(page, id, label) {
  const pop = await popoverOf(page, id);
  await expect(pop).toBeVisible();
  await settled(page);
  const box = await pop.boundingBox();
  const area = await page.evaluate(() => ({
    top: document.querySelector(".topbar").getBoundingClientRect().bottom,
    left: document.querySelector(".sidebar").getBoundingClientRect().right,
    right: document.documentElement.clientWidth,
    bottom: window.innerHeight,
  }));
  const where = `${label} ${id}: ${JSON.stringify(box)} in ${JSON.stringify(area)}`;
  expect(box.y, where).toBeGreaterThanOrEqual(area.top);
  expect(box.x, where).toBeGreaterThanOrEqual(area.left);
  expect(box.x + box.width, where).toBeLessThanOrEqual(area.right + 0.5);
  expect(box.y + box.height, where).toBeLessThanOrEqual(area.bottom + 0.5);
  for (const [name, el] of [
    ["top bar", page.locator(".topbar")],
    ["sidebar", page.locator(".sidebar")],
    ["its chip", chip(page, id)],
    ["the text box", panel(page).getByRole("textbox", { name: "Change request" })],
  ]) {
    expect(intersects(box, await el.boundingBox()), `${where} covers ${name}`).toBe(false);
  }
  const last = pop.locator(".cpop__body").locator("button, [role=option], label, a[href]").last();
  await last.scrollIntoViewIfNeeded();
  await last.click({ trial: true });
}

// ------------------------------------------------------------------ requests
test("untouched chips send exactly the message, as before", async ({ page, request }) => {
  await setup(page);
  await expect(chip(page, "model")).toContainText("Current");
  await expect(chip(page, "team")).toContainText("Auto");
  await expect(chip(page, "tools")).toContainText("3"); // lookup, calculator + the opted-in web_search
  const body = await sendChange(page, request, "Give the searcher knowledge_search");
  expect(JSON.stringify(body)).toBe(JSON.stringify({ message: "Give the searcher knowledge_search" }));
});

test("changed chips send only what changed", async ({ page, request }) => {
  await setup(page);
  await chip(page, "model").click();
  const list = page.getByRole("listbox", { name: "Model" });
  await expect(list.getByRole("option").first()).toContainText("Keep each agent's model");
  await list.getByRole("option", { name: /Claude Haiku 4\.5/ }).click();
  await expect(chip(page, "model")).toContainText("Claude Haiku 4.5");
  await chip(page, "team").click();
  await page.getByRole("button", { name: "Set a number" }).click();
  await page.getByLabel("Most agents").fill("3");
  await page.getByLabel("Most agents").press("Enter");
  await chip(page, "tools").click();
  await page.getByRole("switch", { name: "wikipedia" }).click();
  await page.keyboard.press("Escape");
  const body = await sendChange(page, request, "Give the searcher knowledge_search");
  expect(body).toEqual({
    message: "Give the searcher knowledge_search",
    model: { provider: "bedrock", model: "in.anthropic.claude-haiku-4-5-20251001-v1:0" },
    agent_count: 3,
    tools: ["lookup", "calculator", "web_search", "wikipedia"],
  });

  // Switching a tool on and off again, and choosing "keep" again: back to just the message.
  await chip(page, "tools").click();
  await page.getByRole("switch", { name: "wikipedia" }).click();
  await page.keyboard.press("Escape");
  await chip(page, "model").click();
  await page.getByRole("option", { name: /Keep each agent's model/ }).click();
  await chip(page, "team").click();
  await page.getByRole("button", { name: "Auto" }).click();
  const plain = await sendChange(page, request, "Give the searcher knowledge_search again");
  expect(plain).toEqual({ message: "Give the searcher knowledge_search again" });
});

// ------------------------------------------------------------------ popovers
for (const full of [false, true]) {
  const mode = full ? "fullscreen" : "side panel";
  test(`one popover at a time in the ${mode}; Esc closes it first`, async ({ page }) => {
    await setup(page, { full });
    for (const a of CHIPS) {
      for (const b of CHIPS) {
        if (a === b) continue;
        await chip(page, a).click();
        await chip(page, b).click();
        await expect(visiblePopovers(page), `${a} → ${b}`).toHaveCount(1);
        await expect(chip(page, b)).toHaveAttribute("aria-expanded", "true");
        await chip(page, b).click();
        await expect(visiblePopovers(page)).toHaveCount(0);
      }
    }
    for (const id of CHIPS) {
      await chip(page, id).click();
      await page.keyboard.press("Escape");
      await expect(visiblePopovers(page)).toHaveCount(0);
      await expect(chip(page, id)).toBeFocused();
      // Esc closed only the popover; fullscreen stays.
      if (full) await expect(panel(page).getByRole("button", { name: "Exit fullscreen" })).toBeVisible();
    }
  });

  for (const size of [[1280, 720], [1440, 900]]) {
    test(`popovers are never obstructed in the ${mode} at ${size.join("×")}`, async ({ page, request }) => {
      await request.post(`${API}/__seed_composer`);
      await setup(page, { size, full });
      const tag = `${full ? "full" : "panel"}-${size.join("x")}`;
      for (const id of CHIPS) {
        await chip(page, id).click();
        await checkUnobstructed(page, id, tag);
        await page.screenshot({ path: `${SCREENS}/assistant-${tag}-${id}.png` });
        await page.keyboard.press("Escape");
      }
      // After a message the conversation is no longer empty.
      await sendChange(page, request, "Give the searcher knowledge_search");
      for (const id of CHIPS) {
        await chip(page, id).click();
        await checkUnobstructed(page, id, `${tag} with messages`);
        await page.keyboard.press("Escape");
      }
    });
  }
}

// ------------------------------------------------------------------ + menu
test("the + menu attaches to this project at once, and × detaches", async ({ page, request }) => {
  await request.post(`${API}/__seed_composer`);
  await setup(page);
  const chips = panel(page).getByRole("list", { name: "Attachments for this project" });
  await chip(page, "add").click();
  await page.getByRole("menuitem", { name: /Choose from library/ }).click();
  await page.getByRole("checkbox", { name: /dpdp act 2023\.pdf/ }).check();
  await expect(chips).toContainText("dpdp act 2023.pdf");
  await page.getByRole("button", { name: "Back to the add menu" }).click();
  await page.getByRole("menuitem", { name: /Add data source/ }).click();
  await page.getByRole("checkbox", { name: /Trips warehouse/ }).check();
  await expect(chips).toContainText("Trips warehouse");
  await page.getByRole("button", { name: "Back to the add menu" }).click();
  await page.getByRole("menuitem", { name: /Attach MCP server/ }).click();
  await page.getByRole("checkbox", { name: /ZohoMcp/ }).check();
  await expect(chips).toContainText("ZohoMcp");
  await page.keyboard.press("Escape");

  // The project really has them (the Resources step's own API says so).
  const knowledge = await (await request.get(`${API}/projects/${PROJECT}/knowledge`)).json();
  expect(knowledge.documents.map((d) => d.filename)).toEqual(["dpdp act 2023.pdf"]);
  const data = await (await request.get(`${API}/projects/${PROJECT}/datasources`)).json();
  expect(data.attached.map((s) => s.name)).toEqual(["Trips warehouse"]);
  const mcp = await (await request.get(`${API}/projects/${PROJECT}/mcp`)).json();
  expect(mcp.servers.filter((s) => s.attached).map((s) => s.name)).toEqual(["ZohoMcp"]);

  // knowledge_search follows the attached file, locked.
  await chip(page, "tools").click();
  await expect(page.getByRole("switch", { name: "knowledge_search (automatic)" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("auto · 1 file")).toBeVisible();
  await page.keyboard.press("Escape");

  await chips.getByRole("button", { name: "Remove Trips warehouse" }).click();
  await expect(chips).not.toContainText("Trips warehouse");
  const after = await (await request.get(`${API}/projects/${PROJECT}/datasources`)).json();
  expect(after.attached).toEqual([]);
});

test("an upload goes into this project", async ({ page, request }) => {
  await setup(page);
  await chip(page, "add").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /Upload files/ }).click();
  await (await chooser).setFiles([{ name: "fares.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") }]);
  const chips = panel(page).getByRole("list", { name: "Attachments for this project" });
  await expect(chips.getByRole("button", { name: "Remove fares.csv" })).toBeEnabled();
  const knowledge = await (await request.get(`${API}/projects/${PROJECT}/knowledge`)).json();
  expect(knowledge.documents.map((d) => d.filename)).toEqual(["fares.csv"]);
});

// ------------------------------------------------------------------ look, a11y, keyboard
test("an empty conversation shows the New project hero and template cards", async ({ page }) => {
  await setup(page);
  await expect(panel(page).getByRole("heading", { name: "What should change?" })).toBeVisible();
  const card = panel(page).locator(".suggestion", { hasText: "Use fewer agents" });
  await card.click();
  await expect(panel(page).getByRole("textbox", { name: "Change request" })).toHaveValue("Use fewer agents");
  await expect(panel(page).getByRole("button", { name: "Send change request" })).toHaveClass(/ap-btn-primary/);
});

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

for (const scheme of ["light", "dark"]) {
  for (const full of [false, true]) {
    test(`accessible in ${scheme}, ${full ? "fullscreen" : "side panel"}, every popover open`, async ({ page, request }) => {
      const errors = [];
      await request.post(`${API}/__seed_composer`);
      await setup(page, { scheme, full, errors });
      const tag = `${scheme}-${full ? "full" : "panel"}`;
      const problems = [...(await axeProblems(page, "empty"))];
      await page.screenshot({ path: `${SCREENS}/assistant-${tag}-empty.png` });
      for (const id of CHIPS) {
        await chip(page, id).click();
        problems.push(...(await axeProblems(page, id)));
        await page.keyboard.press("Escape");
      }
      expect(problems).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test("keyboard: Tab order, Shift+Enter adds a line, Enter sends", async ({ page, request }) => {
  await setup(page);
  const box = panel(page).getByRole("textbox", { name: "Change request" });
  await box.focus();
  await box.type("Give the searcher");
  await box.press("Shift+Enter");
  await box.type("knowledge_search");
  await expect(box).toHaveValue("Give the searcher\nknowledge_search");
  await page.keyboard.press("Tab");
  await expect(chip(page, "add")).toBeFocused();
  for (const id of ["model", "team", "tools"]) {
    await page.keyboard.press("Tab");
    await expect(chip(page, id)).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(panel(page).getByRole("button", { name: "Send change request" })).toBeFocused();
  await box.focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).locator(".msg--assistant").last()).toContainText("Gave flight_searcher");
  expect((await (await request.get(`${API}/__last_revise`)).json()).message).toBe("Give the searcher\nknowledge_search");
});
