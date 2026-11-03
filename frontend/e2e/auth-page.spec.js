import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settled } from "./settled.js";

// The sign-in page: signing in and creating an account, at desktop and phone widths, in
// light and dark, with no serious accessibility problems.
const API = "http://127.0.0.1:8765";

async function axeProblems(page, label) {
  const results = await new AxeBuilder({ page: await settled(page) }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact))
    .map((v) => `${label}: ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

for (const scheme of ["light", "dark"]) {
  for (const [label, width, height] of [["desktop", 1280, 860], ["phone", 390, 844]]) {
    test(`sign-in page at ${label} width, in ${scheme}`, async ({ page }) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
      await page.screenshot({ path: `e2e/screenshots/auth-signin-${label}-${scheme}.png`, animations: "disabled" });
      expect(await axeProblems(page, "sign in")).toEqual([]);

      await page.getByRole("tab", { name: "Create account" }).click();
      await expect(page.getByLabel("Confirm password", { exact: true })).toBeVisible();
      await page.screenshot({ path: `e2e/screenshots/auth-register-${label}-${scheme}.png`, animations: "disabled" });
      expect(await axeProblems(page, "create account")).toEqual([]);
      // No sideways scrolling at any width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}

test("mistakes are explained before anything is sent, then signing in works", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Email", { exact: true }).fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByLabel("Confirm password", { exact: true }).fill("short");
  await page.locator("form").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("at least 8 characters").last()).toBeVisible();

  await page.getByRole("tab", { name: "Sign in" }).click();
  await page.getByLabel("Email", { exact: true }).fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("a-long-password");
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
});
