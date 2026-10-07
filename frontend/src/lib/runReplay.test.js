import { describe, expect, it } from "vitest";
import { stateFromRecord, streamEvents } from "./runReplay.js";

const plan = {
  agents: [
    { id: "searcher", tools: [], depends_on: [] },
    { id: "writer", tools: [], depends_on: ["searcher"] },
  ],
  orchestration_pattern: "sequential",
  bounds: { timeout_s: 300 },
};

const graphRecord = {
  id: "r1",
  mode: "graph",
  status: "completed",
  input: { q: "bikes" },
  started_at: "2026-10-06T12:00:00Z",
  finished_at: "2026-10-06T12:00:03Z",
  outputs: { searcher: { content: "found" }, writer: { content: "## Report" } },
  events: [
    { event: "run_started", at: 1000, timeout_s: 300 },
    { event: "node_started", node: "searcher", at: 1000.1 },
    { event: "node_completed", node: "searcher", at: 1001, attempts: 1 },
    { event: "node_started", node: "writer", at: 1001.1 },
    { event: "node_completed", node: "writer", at: 1002, attempts: 1 },
    {
      event: "run_completed",
      at: 1003,
      duration_ms: 3000,
      outputs: {
        searcher: { content: "found" },
        writer: { content: "## Report" },
      },
      errors: [],
      halted: false,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cost: 0.01,
        currency: "USD",
        entries: [],
        unpriced_models: [],
      },
    },
  ],
};

describe("saved runs", () => {
  it("puts each node's output back into the replayed events", () => {
    const events = streamEvents(graphRecord);
    expect(events[2]).toEqual({
      event: "node_completed",
      data: {
        node: "searcher",
        at: 1001,
        attempts: 1,
        output: { content: "found" },
      },
    });
  });

  it("rebuilds a finished graph run as if it had been watched", () => {
    const state = stateFromRecord(plan, graphRecord);
    expect(state.status).toBe("completed");
    expect(state.nodes.writer.output).toEqual({ content: "## Report" });
    expect(state.order).toEqual(["searcher", "writer"]);
    expect(state.input).toEqual({ q: "bikes" });
  });

  it("shows a run that stopped without a final event as interrupted", () => {
    const state = stateFromRecord(plan, {
      ...graphRecord,
      status: "failed",
      error: { error_type: "RunInterrupted", message: "Interrupted" },
      events: graphRecord.events.slice(0, 3),
    });
    expect(state.status).toBe("failed");
    expect(state.error.errorType ?? state.error.error_type).toBe(
      "RunInterrupted",
    );
    expect(state.nodes.searcher.output).toEqual({ content: "found" });
  });

  it("rebuilds a single-agent run from its result", () => {
    const state = stateFromRecord(plan, {
      id: "r2",
      mode: "agent",
      agent_id: "writer",
      status: "completed",
      input: { q: "x" },
      started_at: "2026-10-06T12:00:00Z",
      finished_at: "2026-10-06T12:00:02Z",
      outputs: { writer: { content: "solo" } },
      errors: [],
      halted: false,
      events: [],
    });
    expect(state.mode).toBe("agent");
    expect(state.nodes.writer.output).toEqual({ content: "solo" });
    expect(state.nodes.writer.durationMs).toBe(2000);
  });
});
