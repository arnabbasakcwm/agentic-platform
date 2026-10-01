import { describe, expect, it } from "vitest";
import { applyEvent, failRun, finishAgentRun, idleRun, startRun } from "./runState.js";

const plan = {
  orchestration_pattern: "sequential",
  bounds: { timeout_s: 300 },
  agents: [
    { id: "a", depends_on: [] },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["b"] },
  ],
};

const play = (events) =>
  events.reduce(
    (s, [event, data]) => applyEvent(s, { event, data }),
    startRun(plan, { input: { q: 1 } }),
  );

const statuses = (s) => Object.values(s.nodes).map((n) => n.status);

describe("run state", () => {
  it("starts idle, then queues every agent when a graph run starts", () => {
    expect(statuses(idleRun(plan))).toEqual(["idle", "idle", "idle"]);
    expect(statuses(startRun(plan, { input: {} }))).toEqual(["queued", "queued", "queued"]);
  });

  it("follows events: running, then completed with output and duration, in execution order", () => {
    const s = play([
      ["run_started", { at: 100 }],
      ["node_started", { node: "a", at: 100.1 }],
      [
        "node_completed",
        { node: "a", at: 102, duration_ms: 1900, attempts: 1, output: { content: "A", data: {} } },
      ],
      ["node_started", { node: "b", at: 102.1 }],
    ]);
    expect(s.nodes.a).toMatchObject({ status: "completed", durationMs: 1900, output: { content: "A" } });
    expect(s.nodes.b.status).toBe("running");
    expect(s.nodes.c.status).toBe("queued");
    expect(s.order).toEqual(["a"]);
  });

  it("settles a halted chain: the failed agent failed, the rest never ran", () => {
    const s = play([
      ["run_started", { at: 1 }],
      ["node_started", { node: "a", at: 1 }],
      ["node_failed", { node: "a", at: 2, error: "boom", attempts: 3 }],
      [
        "run_completed",
        { at: 2, outputs: {}, errors: [{ agent_id: "a", error: "boom", attempts: 3 }], halted: true },
      ],
    ]);
    expect(s.status).toBe("completed");
    expect(s.halted).toBe(true);
    expect(statuses(s)).toEqual(["failed", "skipped", "skipped"]);
  });

  it("a timed-out run fails what was running and skips what never started", () => {
    const s = play([
      ["run_started", { at: 1 }],
      ["node_started", { node: "a", at: 1 }],
      [
        "run_failed",
        { at: 61, error_type: "RunTimeout", message: "the run exceeded its 60s time limit", limit_s: 60 },
      ],
    ]);
    expect(s.status).toBe("failed");
    expect(s.error).toMatchObject({ errorType: "RunTimeout", details: { limit_s: 60 } });
    expect(statuses(s)).toEqual(["failed", "skipped", "skipped"]);
  });

  it("records an HTTP failure from before the stream started", () => {
    const s = failRun(startRun(plan, { input: {} }), { errorType: "NotCompiled", message: "compile first" });
    expect(s.status).toBe("failed");
    expect(s.error.errorType).toBe("NotCompiled");
  });

  it("a single-agent run marks only that agent", () => {
    const started = startRun(plan, { input: {}, mode: "agent", agentId: "b", clientNow: 1000 });
    expect([started.nodes.a.status, started.nodes.b.status]).toEqual(["idle", "running"]);
    const done = finishAgentRun(started, "b", {
      startedMs: 1000,
      endedMs: 3500,
      result: { outputs: { b: { content: "B", data: {} } } },
    });
    expect(done.nodes.b).toMatchObject({ status: "completed", durationMs: 2500 });
    expect(done.nodes.a.status).toBe("idle");
  });
});
