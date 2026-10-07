// Rebuild a run's on-screen state from a saved run (the server's RunRecord), so a run can
// be reopened from anywhere: after leaving the page, a refresh, or another browser.
import { applyEvent, finishAgentRun, idleRun, startRun } from "./runState.js";

/** Events as the run stream sends them: each node's output is put back from `outputs`. */
export function streamEvents(record) {
  return (record.events ?? []).map(({ event, ...data }) => ({
    event,
    data:
      event === "node_completed"
        ? { ...data, output: record.outputs?.[data.node] ?? null }
        : data,
  }));
}

const ms = (iso) => (iso ? new Date(iso).getTime() : null);

/** The run state for a saved run, as if it had been watched live. */
export function stateFromRecord(plan, record) {
  const startedMs = ms(record.started_at) ?? Date.now();
  if (record.mode === "agent") {
    const started = startRun(plan, {
      input: record.input,
      mode: "agent",
      agentId: record.agent_id,
      clientNow: startedMs,
    });
    if (record.status === "running") return started;
    let state = finishAgentRun(started, record.agent_id, {
      startedMs,
      endedMs: ms(record.finished_at) ?? startedMs,
      result: {
        outputs: record.outputs,
        errors: record.errors,
        halted: record.halted,
      },
    });
    state = { ...state, usage: record.usage ?? null };
    if (record.status === "failed" && record.error) {
      state = applyEvent(state, {
        event: "run_failed",
        data: {
          ...record.error,
          at: (ms(record.finished_at) ?? startedMs) / 1000,
        },
      });
    }
    return state;
  }
  let state = record.events?.length
    ? startRun(plan, {
        input: record.input,
        mode: "graph",
        clientNow: startedMs,
      })
    : idleRun(plan);
  if (!record.events?.length && record.status === "running") {
    state = startRun(plan, {
      input: record.input,
      mode: "graph",
      clientNow: startedMs,
    });
  }
  for (const event of streamEvents(record)) state = applyEvent(state, event);
  const ended = (record.events ?? []).some(
    (e) => e.event === "run_completed" || e.event === "run_failed",
  );
  if (record.status === "failed" && !ended) {
    // Stopped without a final event (the server restarted): say so.
    state = applyEvent(state, {
      event: "run_failed",
      data: {
        ...(record.error ?? {
          error_type: "RunInterrupted",
          message: "The run stopped before it finished.",
        }),
        at: (ms(record.updated_at) ?? startedMs) / 1000,
      },
    });
  }
  return state;
}
