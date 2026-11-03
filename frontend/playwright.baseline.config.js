import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

// The Run-graph baseline recording (design/baseline/record-run.spec.js), against the
// same mock API and dev server as the e2e checks. `npm run test:baseline`.
export default defineConfig({
  ...base,
  testDir: "../design/baseline",
  testMatch: process.env.BASELINE_MATCH ?? "record-run.spec.js",
  timeout: 120_000,
});
