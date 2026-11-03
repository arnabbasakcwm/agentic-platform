import { test } from "../../frontend/node_modules/@playwright/test/index.mjs";

// Slow frames during a run, measured with Chrome's Long Animation Frames API (no tracing
// running, so nothing but the page is measured). Six runs; prints each run's slow frames
// (≥ 50 ms) and blocking time, and the scripts behind any frame of 80 ms or more.
//
//   cd frontend && BASELINE_MATCH=frames.spec.js npx playwright test -c playwright.baseline.config.js
test("slow frames during a run", async ({ browser, request }) => {
  const all = [];
  for (let i = 0; i < 6; i++) {
    await request.post("http://127.0.0.1:8765/__reset");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      sessionStorage.setItem("agentic-platform.token", "e2e-token");
      localStorage.setItem("agentic-platform.assistant-open", "0");
    });
    const page = await context.newPage();
    await page.goto("/#/projects/e2e0travel0project/run");
    await page.locator(".react-flow__node").nth(4).waitFor();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      window.__loaf = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__loaf.push({
            ms: Math.round(e.duration),
            blocking: Math.round(e.blockingDuration),
            style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
            scripts: e.scripts.map((s) => `${s.invoker} ${Math.round(s.duration)}ms ${s.sourceFunctionName || ""} ${(s.sourceURL || "").split("/").pop()}`),
          });
        }
      }).observe({ type: "long-animation-frame" });
    });
    await page.locator(".run-input").fill(JSON.stringify({ step_ms: 1500 }));
    await page.getByRole("button", { name: "Run graph" }).click();
    await page.getByRole("button", { name: /^Travel Advisor: completed/ }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(600);
    all.push(await page.evaluate(() => window.__loaf));
    await context.close();
  }
  for (const [i, frames] of all.entries()) {
    console.log(`RUN ${i}: ${frames.length} slow frames, ${frames.reduce((t, f) => t + f.blocking, 0)}ms blocking`);
    for (const f of frames.filter((f) => f.ms >= 80)) console.log("  ", JSON.stringify(f));
  }
});
