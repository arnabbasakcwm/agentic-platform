import { expect, test } from "@playwright/test";

// Any page that fails to render shows what went wrong (and keeps the sidebar), never a
// blank white page; another page then works again.
test("a page that fails to render shows the error, not a blank page", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.route("**/mcp", (route) =>
    route.fulfill({ json: { configured: true, servers: [{ id: "x", name: "Broken", tools: null }], projects: [] } }));
  await page.goto("/#/mcp");
  await expect(page.getByText("This page couldn't be shown")).toBeVisible();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/error-boundary.png" });
  // Another page works again.
  await page.locator(".sidebar").getByRole("link", { name: "Usage", exact: true }).click();
  await expect(page.getByText("This page couldn't be shown")).toHaveCount(0);
});
