import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// The New project composer (design/new-project-composer.html): one composer whose
// settings open from chips. A: the requests match the old page's (fixtures recorded from
// it); B: one popover at a time; C: popovers are never obstructed; D: behaviour;
// E: accessibility and keyboard.
const API = "http://127.0.0.1:8765";
const TASK = "Answer questions about fares and holidays in Goa for a family of four travelling in December.";
const FIXTURES = JSON.parse(fs.readFileSync("e2e/fixtures/composer-requests.json", "utf8"));
const SCREENS = "e2e/__screens__";
const CHIPS = ["add", "model", "team", "tools"];
const POPOVERS = "[role=dialog], [role=listbox], [role=menu]";

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

async function setup(page, { size = [1440, 900], scheme = "light", collapsed = false, errors } = {}) {
  await page.addInitScript((c) => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.sidebar-collapsed", c ? "1" : "0");
  }, collapsed);
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: size[0], height: size[1] });
  if (errors) {
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
  }
  await page.goto("/#/new");
  await expect(chip(page, "tools")).toBeVisible();
}

function chip(page, id) {
  const form = page.locator("form.composer");
  return {
    add: form.getByRole("button", { name: "Add context" }),
    model: form.getByRole("button", { name: /^Model/ }),
    team: form.getByRole("button", { name: /^Team/ }),
    tools: form.getByRole("button", { name: /^Tools/ }),
  }[id];
}

const visiblePopovers = (page) => page.locator(POPOVERS).filter({ visible: true });

/** The popover element a chip controls (the portal root). */
async function popoverOf(page, id) {
  const controls = await chip(page, id).getAttribute("aria-controls");
  expect(controls, `${id} chip names its popover`).toBeTruthy();
  return page.locator(`[id="${controls}"]`);
}

async function planIt(page, request) {
  await page.getByLabel("Task description").fill(TASK);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("region", { name: "Task brief" }).getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByRole("link", { name: "Review plan" })).toBeVisible();
  const create = await (await request.get(`${API}/__last_create`)).json();
  const chat = await (await request.get(`${API}/__last_brief_chat`)).json();
  return { create, chat };
}

// Uploaded files get fresh ids every run; everything else must match byte for byte.
function normalise(body) {
  return JSON.stringify(body, (key, value) =>
    typeof value === "string" && /^doc\d{6,}$/.test(value) ? "<uploaded>" : value,
  );
}

function expectSame(actual, key) {
  expect(normalise(actual.create)).toBe(normalise(FIXTURES[key].create));
  expect(normalise(actual.chat)).toBe(normalise(FIXTURES[key].chat));
}

// ------------------------------------------------------------------ A
test.describe("A. the requests match the old page's", () => {
  test("defaults", async ({ page, request }) => {
    await setup(page);
    expectSame(await planIt(page, request), "defaults");
  });

  test("a non-default model, a team of up to 4, web_search and wikipedia", async ({ page, request }) => {
    await setup(page);
    await chip(page, "model").click();
    await page.getByRole("option", { name: /Claude Haiku 4\.5/ }).click();
    await chip(page, "team").click();
    await page.getByRole("button", { name: "Set a number" }).click();
    await page.getByLabel("Most agents").fill("4");
    await page.getByLabel("Most agents").press("Enter");
    await expect(chip(page, "team")).toContainText("up to 4");
    await chip(page, "tools").click();
    await page.getByRole("switch", { name: "web_search" }).click();
    await page.getByRole("switch", { name: "wikipedia" }).click();
    await page.keyboard.press("Escape");
    expectSame(await planIt(page, request), "modelTeamTools");
  });

  test("a library file, a data source and an MCP server", async ({ page, request }) => {
    await request.post(`${API}/__seed_composer`);
    await setup(page);
    await chip(page, "add").click();
    await page.getByRole("menuitem", { name: /Choose from library/ }).click();
    await page.getByRole("checkbox", { name: /dpdp act 2023\.pdf/ }).check();
    await page.getByRole("button", { name: "Back to the add menu" }).click();
    await page.getByRole("menuitem", { name: /Add data source/ }).click();
    await page.getByRole("checkbox", { name: /Trips warehouse/ }).check();
    await page.getByRole("button", { name: "Back to the add menu" }).click();
    await page.getByRole("menuitem", { name: /Attach MCP server/ }).click();
    await page.getByRole("checkbox", { name: /ZohoMcp/ }).check();
    await page.keyboard.press("Escape");
    const chips = page.getByRole("list", { name: "Attachments for this project" });
    await expect(chips.getByRole("listitem")).toHaveText([/dpdp act 2023\.pdf/, /Trips warehouse/, /ZohoMcp/]);
    expectSame(await planIt(page, request), "libraryDataMcp");
  });

  test("an uploaded file, without knowledge_search in available_tools", async ({ page, request }) => {
    await setup(page);
    await chip(page, "add").click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Upload files/ }).click();
    await (await chooser).setFiles([{ name: "fares.csv", mimeType: "text/csv", buffer: Buffer.from("city,fare\nGoa,7004\n") }]);
    const chips = page.getByRole("list", { name: "Attachments for this project" });
    await expect(chips.getByRole("button", { name: "Remove fares.csv" })).toBeEnabled();
    const sent = await planIt(page, request);
    expectSame(sent, "uploaded");
    expect(sent.create.available_tools).not.toContain("knowledge_search");
  });
});

// ------------------------------------------------------------------ B
test.describe("B. one popover at a time", () => {
  test("opening any chip while another is open switches in one click", async ({ page }) => {
    await setup(page);
    for (const a of CHIPS) {
      for (const b of CHIPS) {
        if (a === b) continue;
        await chip(page, a).click();
        await expect(visiblePopovers(page)).toHaveCount(1);
        await chip(page, b).click();
        await expect(visiblePopovers(page), `${a} → ${b}`).toHaveCount(1);
        await expect(chip(page, b)).toHaveAttribute("aria-expanded", "true");
        await expect(chip(page, a)).toHaveAttribute("aria-expanded", "false");
        const pop = await popoverOf(page, b);
        await expect(pop).toBeVisible();
        expect(await pop.locator(POPOVERS).filter({ visible: true }).count() + (await pop.evaluate((el, sel) => el.matches(sel), POPOVERS) ? 1 : 0)).toBe(1);
        await chip(page, b).click(); // the same chip again closes it
        await expect(visiblePopovers(page)).toHaveCount(0);
      }
    }
  });

  test("Esc closes and returns focus; an outside click closes; a sub-view stays one popover", async ({ page }) => {
    await setup(page);
    for (const id of CHIPS) {
      await chip(page, id).click();
      await expect(visiblePopovers(page)).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(visiblePopovers(page)).toHaveCount(0);
      await expect(chip(page, id)).toBeFocused();
    }
    await chip(page, "tools").click();
    await page.getByRole("heading", { name: "What should your agent team do?" }).click();
    await expect(visiblePopovers(page)).toHaveCount(0);

    await chip(page, "add").click();
    await page.getByRole("menuitem", { name: /Choose from library/ }).click();
    await expect(visiblePopovers(page)).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "Choose from library" })).toBeVisible();
    await page.getByRole("button", { name: "Back to the add menu" }).click();
    await expect(page.getByRole("menu", { name: "Add context" })).toBeVisible();
    await expect(visiblePopovers(page)).toHaveCount(1);
  });
});

// ------------------------------------------------------------------ C
function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function usableArea(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bar = document.querySelector(".topbar").getBoundingClientRect();
    const side = document.querySelector(".sidebar").getBoundingClientRect();
    return { top: bar.bottom, left: side.right, right: vw, bottom: window.innerHeight };
  });
}

async function checkUnobstructed(page, id, label) {
  const pop = await popoverOf(page, id);
  await expect(pop).toBeVisible();
  await settled(page);
  const box = await pop.boundingBox();
  const area = await usableArea(page);
  const where = `${label} ${id}: ${JSON.stringify(box)} in ${JSON.stringify(area)}`;
  expect(box.y, where).toBeGreaterThanOrEqual(area.top);
  expect(box.x, where).toBeGreaterThanOrEqual(area.left);
  expect(box.x + box.width, where).toBeLessThanOrEqual(area.right + 0.5);
  expect(box.y + box.height, where).toBeLessThanOrEqual(area.bottom + 0.5);
  for (const [name, el] of [
    ["top bar", page.locator(".topbar")],
    ["sidebar", page.locator(".sidebar")],
    ["its chip", chip(page, id)],
    ["the text area", page.getByLabel("Task description")],
  ]) {
    expect(intersects(box, await el.boundingBox()), `${where} covers ${name}`).toBe(false);
  }
  // Scrolling: only when the content overflows, and the last item is reachable.
  const body = pop.locator(".cpop__body");
  const { scrollHeight, clientHeight, overflows } = await body.evaluate((el) => {
    const content = [...el.children].reduce((h, c) => h + c.getBoundingClientRect().height, 0);
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflows: content > el.clientHeight + 1 };
  });
  expect(scrollHeight > clientHeight + 1, `${where} scrolls only when it overflows`).toBe(overflows);
  const last = body.locator("button, [role=option], label, a[href]").last();
  await last.scrollIntoViewIfNeeded();
  const lastBox = await last.boundingBox();
  const bodyBox = await body.boundingBox();
  expect(lastBox.y + lastBox.height, `${where} last item visible`).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
  await last.click({ trial: true });
}

for (const size of [[1280, 720], [1440, 900], [1920, 1080]]) {
  for (const collapsed of [false, true]) {
    test(`C. popovers are never obstructed at ${size.join("×")}, sidebar ${collapsed ? "collapsed" : "expanded"}`, async ({ page, request }) => {
      await request.post(`${API}/__seed_composer`);
      await setup(page, { size, collapsed });
      // An attachment, so the Tools popover has its knowledge row on and the composer is taller.
      await chip(page, "add").click();
      await page.getByRole("menuitem", { name: /Choose from library/ }).click();
      await page.getByRole("checkbox", { name: /dpdp act 2023\.pdf/ }).check();
      await page.keyboard.press("Escape");
      const tag = `${size.join("x")}-${collapsed ? "collapsed" : "expanded"}`;
      for (const id of CHIPS) {
        await chip(page, id).click();
        await checkUnobstructed(page, id, `empty ${tag}`);
        if (!collapsed) await page.screenshot({ path: `${SCREENS}/empty-${tag}-${id}.png` });
        await page.keyboard.press("Escape");
      }
      // Docked: after the first message the composer sits at the bottom.
      await page.getByLabel("Task description").fill("hello");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText("Hello! What would you like your agents to do?")).toBeVisible();
      for (const id of CHIPS) {
        await chip(page, id).click();
        await checkUnobstructed(page, id, `docked ${tag}`);
        if (!collapsed) await page.screenshot({ path: `${SCREENS}/docked-${tag}-${id}.png` });
        await page.keyboard.press("Escape");
      }
    });
  }
}

// ------------------------------------------------------------------ D
test.describe("D. behaviour", () => {
  test("knowledge_search is locked and follows the attached files", async ({ page, request }) => {
    await request.post(`${API}/__seed_composer`);
    await request.post(`${API}/knowledge/documents`, {
      multipart: { files: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") } },
    });
    await setup(page);
    await chip(page, "tools").click();
    const ks = page.getByRole("switch", { name: "knowledge_search (automatic)" });
    await expect(ks).toBeDisabled();
    await expect(ks).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Turns on when you attach files")).toBeVisible();
    await expect(chip(page, "tools")).toContainText("2");

    await chip(page, "add").click();
    await page.getByRole("menuitem", { name: /Choose from library/ }).click();
    await page.getByRole("checkbox", { name: /dpdp act 2023\.pdf/ }).check();
    await page.getByRole("checkbox", { name: /notes\.txt/ }).check();
    await chip(page, "tools").click();
    await expect(ks).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("auto · 2 files")).toBeVisible();
    await expect(chip(page, "tools")).toContainText("3");
    await page.keyboard.press("Escape");

    const chips = page.getByRole("list", { name: "Attachments for this project" });
    await chips.getByRole("button", { name: "Remove notes.txt" }).click();
    await chip(page, "tools").click();
    await expect(page.getByText("auto · 1 file")).toBeVisible();
    await page.keyboard.press("Escape");
    await chips.getByRole("button", { name: "Remove dpdp act 2023.pdf" }).click();
    await chip(page, "tools").click();
    await expect(ks).toHaveAttribute("aria-checked", "false");
  });

  test("team: Auto omits agent_count, a number sends it, out of range is refused", async ({ page, request }) => {
    await setup(page);
    await chip(page, "team").click();
    await page.getByRole("button", { name: "Set a number" }).click();
    const input = page.getByLabel("Most agents");
    await input.fill("11");
    await expect(page.getByRole("alert")).toHaveText("Choose between 1 and 10 agents.");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.press("Enter"); // refused: stays open
    await expect(page.getByRole("dialog", { name: "Team size" })).toBeVisible();
    await input.fill("0");
    await expect(page.getByRole("alert")).toHaveText("Choose between 1 and 10 agents.");
    await input.fill("6");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("The planner uses up to 6 agents")).toBeVisible();
    await input.press("Enter");
    await expect(chip(page, "team")).toHaveText(/Team\s*up to 6/);
    await expect(chip(page, "team")).toBeFocused();
    expect((await planIt(page, request)).create.agent_count).toBe(6);

    await chip(page, "team").click();
    await page.getByRole("button", { name: "Auto" }).click();
    await expect(chip(page, "team")).toHaveText(/Team\s*Auto/);
    await page.getByLabel("Task description").fill(TASK);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("region", { name: "Task brief" }).last().getByRole("button", { name: "Create plan" }).click();
    await expect(page.getByRole("link", { name: "Review plan" })).toHaveCount(2);
    const sent = await (await request.get(`${API}/__last_create`)).json();
    expect(sent).not.toHaveProperty("agent_count");
  });

  test("model search filters; arrows and Enter pick; keyless models are one row with no link", async ({ page }) => {
    await setup(page);
    await chip(page, "model").click();
    const list = page.getByRole("listbox", { name: "Model" });
    await expect(list.getByRole("group", { name: "Recommended" }).getByRole("option")).toHaveCount(4);
    await expect(list.getByRole("option", { name: /Gemini|gemini/ }).first()).toContainText("Default");
    await expect(list.getByRole("option", { name: /claude-sonnet-4-6/ })).toHaveCount(0);
    const keyless = page.getByText("1 model needs an API key");
    await expect(keyless).toBeVisible();
    await expect(keyless.locator("xpath=ancestor-or-self::*[@title][1]")).toHaveAttribute("title", "API keys are set on the server by an administrator.");
    await expect(page.locator(".cpop__keyless a")).toHaveCount(0);

    const search = page.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeFocused();
    await search.fill("mistral");
    await expect(list.getByRole("option")).toHaveCount(1);
    await search.fill("claude");
    await expect(list.getByRole("option")).toHaveCount(3);
    await search.press("ArrowDown");
    const active = await search.getAttribute("aria-activedescendant");
    await expect(page.locator(`[id="${active}"]`)).toContainText("Claude Haiku 4.5");
    await search.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(chip(page, "model")).toContainText("Claude Haiku 4.5");
    await expect(chip(page, "model")).toBeFocused();
    await expect(chip(page, "model")).toHaveClass(/cchip--changed/);
  });

  test("an upload shows a spinner chip, then the file; a failure shows an error chip", async ({ page }) => {
    await setup(page);
    await chip(page, "add").click();
    let chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Upload files/ }).click();
    await (await chooser).setFiles([{ name: "fares.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") }]);
    const chips = page.getByRole("list", { name: "Attachments for this project" });
    const fares = chips.getByRole("listitem").filter({ hasText: "fares.csv" });
    await expect(fares.locator(".spin")).toBeVisible();
    await expect(fares).toContainText("uploading");
    await expect(fares.locator(".spin")).toHaveCount(0);
    await expect(fares.getByRole("button", { name: "Remove fares.csv" })).toBeEnabled();

    await chip(page, "add").click();
    chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Upload files/ }).click();
    await (await chooser).setFiles([{ name: "boom.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") }]);
    const boom = chips.getByRole("listitem").filter({ hasText: "boom.pdf" });
    await expect(boom).toHaveClass(/att--error/);
    await expect(boom).toHaveAttribute("title", "the upload failed on the server");
    await boom.getByRole("button", { name: "Remove boom.pdf" }).click();
    await expect(boom).toHaveCount(0);
    await expect(chips.getByRole("listitem")).toHaveCount(1);
  });

  test("sub-view ticks add and remove chips", async ({ page, request }) => {
    await request.post(`${API}/__seed_composer`);
    await setup(page);
    await chip(page, "add").click();
    await page.getByRole("menuitem", { name: /Add data source/ }).click();
    const box = page.getByRole("checkbox", { name: /Trips warehouse/ });
    await box.check();
    const chips = page.getByRole("list", { name: "Attachments for this project" });
    await expect(chips).toContainText("Trips warehouse");
    await box.uncheck();
    await expect(chips).toHaveCount(0);
    await page.getByRole("button", { name: "Back to the add menu" }).click();
    await page.getByRole("menuitem", { name: /Attach MCP server/ }).click();
    await page.getByRole("checkbox", { name: /ZohoMcp/ }).check();
    await expect(chips).toContainText("ZohoMcp");
    // The Tools popover's MCP group shows the same attachment.
    await chip(page, "tools").click();
    await page.getByRole("dialog", { name: "Tools" }).getByRole("button", { name: "Remove ZohoMcp" }).click();
    await expect(chips).toHaveCount(0);
  });
});

// ------------------------------------------------------------------ E
async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

for (const scheme of ["light", "dark"]) {
  test(`E. accessible with every popover open in ${scheme}, no console errors`, async ({ page, request }) => {
    const errors = [];
    await request.post(`${API}/__seed_composer`);
    await setup(page, { scheme, errors });
    const problems = [...(await axeProblems(page, "empty"))];
    for (const id of CHIPS) {
      await chip(page, id).click();
      problems.push(...(await axeProblems(page, id)));
      await page.screenshot({ path: `${SCREENS}/${scheme}-${id}.png` });
      await page.keyboard.press("Escape");
    }
    await chip(page, "add").click();
    await page.getByRole("menuitem", { name: /Choose from library/ }).click();
    await page.getByRole("checkbox", { name: /dpdp act 2023\.pdf/ }).check();
    problems.push(...(await axeProblems(page, "library sub-view")));
    await page.keyboard.press("Escape");
    problems.push(...(await axeProblems(page, "with attachments")));
    await page.screenshot({ path: `${SCREENS}/${scheme}-empty.png` });
    expect(problems).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("E. keyboard only: Tab order, menu arrows, Enter sends, Shift+Enter adds a line", async ({ page, request }) => {
  await request.post(`${API}/__seed_composer`);
  await setup(page);
  const box = page.getByLabel("Task description");
  await box.focus();
  await box.type("First line");
  await box.press("Shift+Enter");
  await box.type("second line");
  await expect(box).toHaveValue("First line\nsecond line");

  await page.keyboard.press("Tab");
  await expect(chip(page, "add")).toBeFocused();
  for (const id of ["model", "team", "tools"]) {
    await page.keyboard.press("Tab");
    await expect(chip(page, id)).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeFocused();

  // The + menu by keyboard: Enter opens, arrows move, Enter picks, Back returns.
  await chip(page, "add").focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Add context" });
  await expect(menu.getByRole("menuitem", { name: /Upload files/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Choose from library/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: /Attach MCP server/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Back to the add menu" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(page.getByRole("list", { name: "Attachments for this project" })).toContainText("ZohoMcp");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem", { name: /Attach MCP server/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(chip(page, "add")).toBeFocused();

  // Tools by keyboard: Space toggles a switch; Tab past the end goes on to the next chip...
  await chip(page, "tools").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("switch", { name: "web_search" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("switch", { name: "web_search" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(chip(page, "tools")).toBeFocused();
  await expect(chip(page, "tools")).toContainText("3");

  // Enter sends.
  await box.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg--user")).toContainText("First line");
});
