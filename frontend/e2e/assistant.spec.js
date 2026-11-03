import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// The plan assistant: drag its left edge to resize (remembered, clamped so the page keeps
// its room), resize with the keyboard, reset with a double-click, and a Fullscreen button
// that fills the work area — readable and accessible in both themes.
const API = "http://127.0.0.1:8765";
const PLAN = "/#/projects/e2e0travel0project/plan";

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
    localStorage.setItem("agentic-platform.assistant-open", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
});

const panel = (page) => page.getByRole("complementary", { name: "Plan assistant" });
const handle = (page) => page.getByRole("separator", { name: "Resize assistant" });
const widthOf = async (locator) => Math.round((await locator.boundingBox()).width);
const fits = (page) => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);

async function dragTo(page, x) {
  const box = await handle(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 200, { steps: 8 });
  await page.mouse.up();
}

for (const scheme of ["light", "dark"]) {
  test(`assistant in ${scheme}: drag to resize, fullscreen`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(PLAN);
    await expect(panel(page)).toBeVisible();
    expect(await widthOf(panel(page))).toBe(360);
    const main = page.locator(".workspace__main");
    const pageBefore = await widthOf(main);

    // Drag the left edge 240px to the left: the panel widens, the page narrows.
    const start = (await handle(page).boundingBox()).x;
    await dragTo(page, start - 240);
    const wide = await widthOf(panel(page));
    expect(wide).toBeGreaterThanOrEqual(590);
    expect(wide).toBeLessThanOrEqual(610);
    expect(await widthOf(main)).toBeLessThan(pageBefore - 200);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `e2e/screenshots/assistant-wide-${scheme}.png` });
    expect(await axeProblems(page, "resized")).toEqual([]);

    // Remembered across a reload (polled: the first frame after a load can still be
    // laying out the panel).
    await page.reload();
    await expect.poll(async () => Math.abs((await widthOf(panel(page))) - wide)).toBeLessThanOrEqual(1);

    // Fullscreen fills the work area; the sidebar and top bar stay.
    const full = panel(page).getByRole("button", { name: "Fullscreen" });
    await expect(full).toBeVisible();
    await full.click();
    const exit = panel(page).getByRole("button", { name: "Exit fullscreen" });
    await expect(exit).toHaveAttribute("aria-pressed", "true");
    const workspace = await page.locator(".workspace").boundingBox();
    const box = await panel(page).boundingBox();
    expect(Math.round(box.width)).toBe(Math.round(workspace.width));
    await expect(page.locator(".sidebar")).toBeInViewport();
    await expect(handle(page)).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `e2e/screenshots/assistant-full-${scheme}.png` });
    expect(await axeProblems(page, "fullscreen")).toEqual([]);

    // Esc restores the width it had.
    await panel(page).getByRole("textbox").focus();
    await page.keyboard.press("Escape");
    await expect(panel(page).getByRole("button", { name: "Fullscreen" })).toBeVisible();
    expect(Math.abs((await widthOf(panel(page))) - wide)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

test("the width is clamped, keyboard-resizable, and resets on double-click", async ({ page }) => {
  await page.goto(PLAN);
  const start = (await handle(page).boundingBox()).x;
  // Far left: stops at the maximum, leaving the page its room.
  await dragTo(page, 10);
  expect(await widthOf(panel(page))).toBeLessThanOrEqual(900);
  expect(await widthOf(page.locator(".workspace__main"))).toBeGreaterThanOrEqual(359);
  // Far right: stops at the minimum.
  await dragTo(page, start + 1000);
  expect(await widthOf(panel(page))).toBe(300);

  // Keyboard: left arrow widens by 24px; End jumps to the largest allowed width.
  await handle(page).focus();
  await page.keyboard.press("ArrowLeft");
  expect(await widthOf(panel(page))).toBe(324);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "324");

  await handle(page).dblclick();
  expect(await widthOf(panel(page))).toBe(360);
});

test("narrow screens: the panel overlays the page and can still be resized", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(PLAN);
  const before = await widthOf(panel(page));
  const start = (await handle(page).boundingBox()).x;
  await dragTo(page, start - 150);
  expect(await widthOf(panel(page))).toBeGreaterThan(before + 100);
  expect(await fits(page)).toBe(true);
});

test("the assistant is offered on every step, Run and Deploy included", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentic-platform.assistant-open", "0"));
  for (const step of ["brief", "resources", "plan", "compile", "run", "deploy"]) {
    await page.goto("about:blank");
    await page.goto(`/#/projects/e2e0travel0project/${step}`);
    const open = page.getByRole("button", { name: "Assistant" });
    await expect(open, step).toBeVisible();
    if (step === "run" || step === "deploy") {
      await open.click();
      await expect(panel(page)).toBeVisible();
      await panel(page).getByRole("button", { name: /Close/ }).click();
      await expect(panel(page)).toHaveCount(0);
    }
  }
});
