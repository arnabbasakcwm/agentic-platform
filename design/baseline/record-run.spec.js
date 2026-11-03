// Records the Run page's graph through a run, before and after the redesign, so the two
// can be compared state by state (design/baseline/comparison.md).
//
//   cd frontend
//   npm run test:baseline                       # writes design/baseline/before/
//   BASELINE_OUT=after npm run test:baseline    # writes design/baseline/after/
//
// It runs against the scripted mock API (frontend/e2e/mock-api.js): no backend, no model
// calls, and the same timing every time. Nodes are found by their accessible names
// ("Flight Searcher: running, …"), not by CSS classes, so the script works unchanged on
// both sides of the redesign.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The frontend's own copy: this file sits outside frontend/, where Node can't find the
// package by name, and it must be the same instance as the runner's.
import { expect, test } from "../../frontend/node_modules/@playwright/test/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, process.env.BASELINE_OUT ?? "before");
const MOCK_API = "http://127.0.0.1:8765";
const RUN_URL = "/#/projects/e2e0travel0project/run";
const VIEWPORT = { width: 1440, height: 900 };

// Three sequential agents; with step_ms 1500 they take 1.5 s, 3 s and 4.5 s, long enough
// to catch each state on camera.
const INPUT = { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October", step_ms: 1500 };

const node = (page, title, state) =>
  page.getByRole("button", { name: new RegExp(`^${title}: ${state}`) });

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK_API}/__reset`);
});

async function open(browser, name, { reducedMotion = "no-preference", scheme = "light" } = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    reducedMotion,
    colorScheme: scheme,
    recordVideo: { dir: path.join(OUT, ".video-tmp"), size: VIEWPORT },
  });
  await context.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
  const page = await context.newPage();
  await page.goto(RUN_URL);
  await expect(page.locator(".react-flow__node")).toHaveCount(5); // 3 agents + Start + End
  // Bring the diagram to the top of the view, as starting a run does.
  await page.locator(".react-flow").first().scrollIntoViewIfNeeded();
  const close = async () => {
    const video = page.video();
    await context.close();
    if (video) await video.saveAs(path.join(OUT, `${name}.webm`));
  };
  return { page, close };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await page.locator(".react-flow").first().screenshot({ path: path.join(OUT, `${name}--graph.png`) });
}

async function startRun(page, input) {
  await page.locator(".run-input").fill(JSON.stringify(input, null, 2));
  await page.getByRole("button", { name: "Run graph" }).click();
}

/** Frame and long-task counters, installed before the run starts. */
async function startMeter(page) {
  await page.evaluate(() => {
    const m = { frames: [], longTasks: [] };
    window.__meter = m;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) m.longTasks.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: false });
    let last = performance.now();
    const tick = (now) => {
      m.frames.push(now - last);
      last = now;
      if (!m.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopMeter(page) {
  return page.evaluate(() => {
    const m = window.__meter;
    m.stop = true;
    const frames = m.frames.slice(1);
    const budget = 1000 / 60;
    const dropped = frames.reduce((n, f) => n + Math.max(0, Math.round(f / budget) - 1), 0);
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      frames: frames.length,
      dropped_frames: dropped,
      worst_frame_ms: Math.round(sorted.at(-1) ?? 0),
      p95_frame_ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      long_tasks: m.longTasks.length,
      long_task_ms: m.longTasks.reduce((a, b) => a + b, 0),
    };
  });
}

test("a run, state by state", async ({ browser }) => {
  const { page, close } = await open(browser, "run");
  await shot(page, "01-idle");

  // Chrome trace of the whole run, for frame-by-frame inspection in DevTools.
  await browser.startTracing(page, { path: path.join(OUT, "run-trace.json"), screenshots: false });
  await startMeter(page);
  await startRun(page, INPUT);

  await expect(node(page, "Flight Searcher", "running")).toBeVisible();
  await page.waitForTimeout(700); // let the glow and spinner reach mid-animation
  await shot(page, "02-first-agent-running");

  await expect(node(page, "Price Analyzer", "running")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(900);
  await shot(page, "03-mid-run");

  await expect(node(page, "Travel Advisor", "completed")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500); // edge colour and border transitions
  const perf = await stopMeter(page);
  await browser.stopTracing();
  await shot(page, "04-completed");

  fs.writeFileSync(path.join(OUT, "performance.json"), JSON.stringify(perf, null, 2) + "\n");
  await close();
});

test("a failed run", async ({ browser }) => {
  const { page, close } = await open(browser, "failed");
  await startRun(page, { ...INPUT, scenario: "fail" });
  await expect(node(page, "Price Analyzer", "failed")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot(page, "05-failed");
  await close();
});

test("reduced motion: still shows every state", async ({ browser }) => {
  const { page, close } = await open(browser, "reduced-motion", { reducedMotion: "reduce" });
  await startRun(page, INPUT);
  await expect(node(page, "Price Analyzer", "running")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot(page, "06-reduced-motion-mid-run");
  await close();
});

test("dark theme, mid-run", async ({ browser }) => {
  const { page, close } = await open(browser, "dark", { scheme: "dark" });
  await startRun(page, INPUT);
  await expect(node(page, "Price Analyzer", "running")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(900);
  await shot(page, "07-dark-mid-run");
  await close();
});

test.afterAll(() => {
  fs.rmSync(path.join(OUT, ".video-tmp"), { recursive: true, force: true });
});
