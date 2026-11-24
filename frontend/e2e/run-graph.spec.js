import { expect, test } from "@playwright/test";
import fixture from "./fixtures/run-events.json" with { type: "json" };

// The Run graph, driven by a replayed recording (fixtures/run-events.json) released one
// event at a time through the mock API's /__emit: at every step the nodes, the progress
// rows and the edges must show exactly what the events say — with one inference, that an
// active run always shows its next agent as running (see displayRun in lib/runState.js).
const API = "http://127.0.0.1:8765";
const PROJECT = "e2e0travel0project";
const RUN_URL = `/#/projects/${PROJECT}/run`;
const AGENTS = fixture.agents;
const SHOTS = "e2e/__screens__/run";

test.beforeEach(async ({ page, request }) => {
  await request.post(`${API}/__reset`);
  await page.addInitScript(() => {
    sessionStorage.setItem("agentic-platform.token", "e2e-token");
    localStorage.setItem("agentic-platform.assistant-open", "0");
  });
});

async function startManualRun(page, { width = 1440, scheme = "light", reducedMotion = "no-preference" } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
  await page.goto(RUN_URL);
  await expect(page.locator(".flow-node")).toHaveCount(3);
  await page.locator(".run-input").fill(JSON.stringify({ scenario: "manual" }));
  await page.getByRole("button", { name: "Run graph" }).click();
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
}

const emit = (request, step) => request.post(`${API}/__emit`, { data: { event: step.event, data: step.data } });

const nodeStates = (page) =>
  page.locator(".flow-node").evaluateAll(
    (els, agents) =>
      agents.map((id) => {
        const el = els.find((e) => e.querySelector(".flow-node__name")?.textContent === id);
        return [...(el?.classList ?? [])].find((c) => c.startsWith("flow-node--"))?.replace("flow-node--", "") ?? "missing";
      }),
    AGENTS,
  );

// The progress rows under the graph: the bar's state, or "none" before an agent starts.
const rowStates = (page) =>
  page.locator(".timeline__row").evaluateAll((rows) =>
    rows.map((row) => {
      const bar = row.querySelector(".timeline__bar");
      return bar ? [...bar.classList].find((c) => c.startsWith("timeline__bar--")).replace("timeline__bar--", "") : "none";
    }),
  );

// What a row should show for a node state: queued and skipped agents have no bar yet.
const rowFor = (state) => (state === "queued" || state === "skipped" ? "none" : state);

async function expectStep(page, step, label) {
  await expect.poll(() => nodeStates(page), { message: `${label}: nodes`, timeout: 5000 }).toEqual(step.expect);
  // Exactly one running node while the run is going and something is left to run.
  const running = step.expect.filter((s) => s === "running").length;
  const active = !["run_completed", "run_failed"].includes(step.event);
  const left = step.expect.some((s) => s === "queued" || s === "running");
  expect(running, `${label}: running nodes`).toBe(active && left ? 1 : 0);
  await expect.poll(() => rowStates(page), { message: `${label}: progress rows` }).toEqual(step.expect.map(rowFor));
}

// A running node is obvious without any animation: a 2px sky border, the Running pill
// with a spinner, a live time, and the glow layer.
async function expectRunningVisible(page, id) {
  const node = page.locator(".flow-node--running", { hasText: id });
  await expect(node).toBeVisible();
  await expect(node.locator(".pill", { hasText: "Running" })).toBeVisible();
  await expect(node.locator(".spin")).toBeVisible();
  await expect(node.locator(".flow-node__time")).toBeVisible();
  expect(await node.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("2px");
  expect(await node.evaluate((el) => getComputedStyle(el, "::after").boxShadow)).not.toBe("none");
  expect(Number(await node.evaluate((el) => getComputedStyle(el, "::after").opacity))).toBeGreaterThan(0.2);
}

for (const [name, reducedMotion] of [
  ["with motion", "no-preference"],
  ["with reduced motion", "reduce"],
]) {
  for (const [shape, steps] of [
    ["a well-formed stream", fixture.wellFormed],
    ["a stream whose node_started events arrive late", fixture.bugShaped],
  ]) {
    test(`status timeline: ${shape}, ${name}`, async ({ page, request }) => {
      test.setTimeout(90_000);
      await startManualRun(page, { reducedMotion });
      for (const [i, step] of steps.entries()) {
        await emit(request, step);
        await expectStep(page, step, `${shape} step ${i + 1} (${step.event})`);
        const at = step.expect.indexOf("running");
        if (at >= 0) await expectRunningVisible(page, AGENTS[at]);
      }
      await expect(page.getByRole("button", { name: "Run graph" })).toBeEnabled();
    });
  }
}

test("status timeline: a failure mid-run shows failed, then skipped", async ({ page, request }) => {
  await startManualRun(page);
  for (const [i, step] of fixture.failing.entries()) {
    await emit(request, step);
    await expectStep(page, step, `failing step ${i + 1}`);
  }
  await expect(page.locator(".flow-node--failed")).toHaveCount(1);
  await expect(page.locator(".flow-node--skipped")).toHaveCount(1);
  await expect(page.locator(".flow-node--running")).toHaveCount(0);
});

test("status timeline: reloading mid-run shows the current state, not all queued", async ({ page, request }) => {
  await startManualRun(page);
  const steps = fixture.wellFormed;
  for (const step of steps.slice(0, 4)) await emit(request, step);
  await expectStep(page, steps[3], "before reload");
  await page.reload();
  await expectStep(page, steps[3], "after reload");
  await expectRunningVisible(page, AGENTS[1]);
  for (const step of steps.slice(4)) {
    await emit(request, step);
    await expectStep(page, step, `after reload, ${step.event}`);
  }
});

// ------------------------------------------------------------------ straight edges
const geometry = (page) =>
  page.evaluate(() => {
    const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    const nodes = {};
    for (const el of document.querySelectorAll(".react-flow__node")) {
      nodes[el.dataset.id] = centre(el.getBoundingClientRect());
    }
    // React Flow ends an edge on the handle's outer face (left of a target handle, right of
    // a source handle), at its vertical centre: that is where the arrow tip must be.
    const handle = (nodeId, kind) => {
      const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"] .react-flow__handle.${kind}`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: kind === "target" ? r.x : r.x + r.width, y: r.y + r.height / 2 };
    };
    const edges = [...document.querySelectorAll(".react-flow__edge")].map((edge) => {
      const [source, target] = edge.dataset.id.replace(/^xy-edge__/, "").split("->");
      const path = edge.querySelector("path.react-flow__edge-path");
      const m = path.getScreenCTM();
      const at = (len) => {
        const p = path.getPointAtLength(len);
        return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
      };
      return {
        id: edge.dataset.id,
        start: at(0),
        end: at(path.getTotalLength()),
        source,
        target,
        sh: handle(source, "source"),
        th: handle(target, "target"),
      };
    });
    return { nodes, edges };
  });

async function expectStraight(page, label) {
  const { nodes, edges } = await geometry(page);
  const ys = Object.values(nodes).map((c) => c.y);
  expect(Math.max(...ys) - Math.min(...ys), `${label}: node centres share one y`).toBeLessThanOrEqual(1);
  expect(edges.length).toBe(AGENTS.length + 1);
  for (const e of edges) {
    expect(Math.abs(e.start.y - e.end.y), `${label}: ${e.id} is horizontal`).toBeLessThanOrEqual(1);
    expect(e.th, `${label}: ${e.id} has a target handle`).not.toBeNull();
    const gap = Math.hypot(e.end.x - e.th.x, e.end.y - e.th.y);
    expect(gap, `${label}: ${e.id} arrow tip meets its handle`).toBeLessThanOrEqual(2);
    const from = Math.hypot(e.start.x - e.sh.x, e.start.y - e.sh.y);
    expect(from, `${label}: ${e.id} starts at its source handle`).toBeLessThanOrEqual(2);
  }
}

const settle = (page, ms = 500) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

for (const width of [1280, 1440, 1920]) {
  test(`straight edges at ${width}px, also after zooming`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(RUN_URL);
    await expect(page.locator(".flow-node")).toHaveCount(3);
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);
    // The first measurement re-lays the graph out: wait for it to settle.
    await settle(page, 700);
    await expectStraight(page, `${width}px`);
    await page.locator(".react-flow__controls-zoomin").click();
    await page.locator(".react-flow__controls-zoomin").click();
    await settle(page);
    await expectStraight(page, `${width}px zoomed in`);
    for (let i = 0; i < 3; i += 1) await page.locator(".react-flow__controls-zoomout").click();
    await settle(page);
    await expectStraight(page, `${width}px zoomed out`);
  });
}

// ------------------------------------------------------------------ screenshots
for (const scheme of ["light", "dark"]) {
  test(`screenshots of a run's four moments, ${scheme}`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await startManualRun(page, { scheme });
    const steps = fixture.wellFormed;
    const diagram = page.locator(".run-flow");
    const shot = async (name) => {
      await settle(page, 350);
      await diagram.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
    };
    await shot("1-start");
    await emit(request, steps[0]);
    await emit(request, steps[1]);
    await expectStep(page, steps[1], "first agent running");
    await shot("2-first-agent-running");
    for (const step of steps.slice(2, 4)) await emit(request, step);
    await expectStep(page, steps[3], "mid-run");
    await shot("3-mid-run");
    for (const step of steps.slice(4)) await emit(request, step);
    await expectStep(page, steps[steps.length - 1], "completed");
    await shot("4-completed");
  });
}
