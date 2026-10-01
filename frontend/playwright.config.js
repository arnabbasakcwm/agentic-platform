import { defineConfig } from "@playwright/test";

// Browser checks for the Run page against a scripted mock API (e2e/mock-api.js): no
// backend, database or model calls needed. Uses the installed Microsoft Edge, so no
// browser download is required.
const MOCK_API_PORT = 8765;
const APP_PORT = 5299;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    channel: "msedge",
    trace: "off",
  },
  webServer: [
    {
      command: `node e2e/mock-api.js ${MOCK_API_PORT}`,
      url: `http://127.0.0.1:${MOCK_API_PORT}/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: false,
      env: { VITE_API_BASE: `http://127.0.0.1:${MOCK_API_PORT}` },
    },
  ],
});
