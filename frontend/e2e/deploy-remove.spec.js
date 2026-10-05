import { expect, test } from "@playwright/test";

// Removing a deployment and deploying again must show the normal "Remove deployment"
// button for the new deployment — not the previous removal's "Yes, remove it / Keep it"
// confirmation (which used to linger until a page refresh).
const API = "http://127.0.0.1:8765";

test.beforeEach(async ({ request }) => {
  await request.post(`${API}/__deploy_available`);
});

test.afterEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

test("remove, then deploy again, shows a fresh Remove button", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.goto("/#/projects/e2e0travel0project/deploy");

  await page.getByRole("button", { name: "Deploy to AgentCore" }).click();
  await expect(page.getByRole("button", { name: "Remove deployment" })).toBeVisible();

  await page.getByRole("button", { name: "Remove deployment" }).click();
  await page.getByRole("button", { name: "Yes, remove it" }).click();
  await expect(page.getByRole("button", { name: "Deploy to AgentCore" })).toBeVisible();

  await page.getByRole("button", { name: "Deploy to AgentCore" }).click();
  await expect(page.getByRole("button", { name: "Redeploy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove deployment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, remove it" })).toHaveCount(0);
  await expect(page.getByText("Apps calling it will stop working")).toHaveCount(0);
});

test("an open removal confirmation closes when the deployment is redeployed", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("agentic-platform.token", "e2e-token"));
  await page.goto("/#/projects/e2e0travel0project/deploy");
  await page.getByRole("button", { name: "Deploy to AgentCore" }).click();

  await page.getByRole("button", { name: "Remove deployment" }).click();
  await expect(page.getByRole("button", { name: "Yes, remove it" })).toBeVisible();
  await page.getByRole("button", { name: "Redeploy" }).click();
  await expect(page.getByRole("button", { name: "Remove deployment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, remove it" })).toHaveCount(0);

  // Keep it still just closes the confirmation.
  await page.getByRole("button", { name: "Remove deployment" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("button", { name: "Remove deployment" })).toBeVisible();
});
