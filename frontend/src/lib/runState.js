// The state of one run, built from the server's run events (see the backend's
// run_graph_events). Pure functions, so the diagram, timeline and cards all derive from
// one source of truth — and every state shown is one the server reported.

/** Node states, in the order a node moves through them. */
export const NODE_STATES = ["idle", "queued", "running", "completed", "failed", "skipped"];

export function idleRun(plan) {
  return {
    status: "idle", // idle | running | completed | failed
    mode: "graph", // graph | agent
    input: null,
    startedAt: null, // server time (s) the run started
    clientStartedAt: null, // client time (ms) the start event arrived, for live elapsed time
    endedAt: null,
    timeoutS: plan.bounds?.timeout_s ?? null,
    nodes: Object.fromEntries(plan.agents.map((a) => [a.id, idleNode()])),
    order: [], // agent ids in the order they produced output
    decisions: [], // supervisor routing decisions
    error: null,
    halted: false,
    usage: null, // models, tokens and estimated cost, once the run ends
  };
}

function idleNode() {
  return {
    status: "idle",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    attempts: 0,
    runs: 0,
    retryError: null,
    output: null,
    error: null,
  };
}

function updateNode(state, id, changes) {
  const node = state.nodes[id] ?? idleNode();
  return { ...state, nodes: { ...state.nodes, [id]: { ...node, ...changes } } };
}

/** A run about to start: every agent it will run is queued until the server says otherwise. */
export function startRun(plan, { input, mode = "graph", agentId = null, clientNow = Date.now() }) {
  const base = idleRun(plan);
  const nodes = Object.fromEntries(
    plan.agents.map((a) => {
      if (mode === "graph") return [a.id, { ...idleNode(), status: "queued" }];
      // A single-agent run is one request: that agent is running from the moment it is
      // sent until the response arrives — the only progress there is to show.
      if (a.id === agentId) {
        return [a.id, { ...idleNode(), status: "running", startedAt: clientNow / 1000, runs: 1 }];
      }
      return [a.id, idleNode()];
    }),
  );
  const startedAt = mode === "graph" ? null : clientNow / 1000;
  return { ...base, status: "running", mode, input, nodes, startedAt, clientStartedAt: clientNow };
}

/** End a run that failed before or outside the event stream (HTTP error, lost connection). */
export function failRun(state, error, clientNow = Date.now()) {
  return applyEvent(state, {
    event: "run_failed",
    data: {
      at: serverNow(state, clientNow) ?? clientNow / 1000,
      error_type: error.errorType ?? "Error",
      message: error.message ?? "The run failed.",
      limit_s: error.details?.limit_s,
    },
  });
}

export function applyEvent(state, { event, data }) {
  switch (event) {
    case "run_started":
      return {
        ...state,
        status: "running",
        startedAt: data.at,
        // Client time the start arrived: live elapsed times are counted from here.
        clientStartedAt: data.receivedAt ?? state.clientStartedAt,
        timeoutS: data.timeout_s ?? state.timeoutS,
      };

    case "node_started": {
      const node = state.nodes[data.node] ?? idleNode();
      return updateNode(state, data.node, {
        status: "running",
        startedAt: data.at,
        endedAt: null,
        retryError: null,
        runs: node.runs + 1,
      });
    }

    case "node_retry":
      return updateNode(state, data.node, { retryError: data.error, attempts: data.attempt });

    case "node_completed": {
      const next = updateNode(state, data.node, {
        status: "completed",
        endedAt: data.at,
        durationMs: data.duration_ms ?? null,
        attempts: data.attempts ?? 1,
        retryError: null,
        ...(data.output ? { output: data.output } : {}),
      });
      const order = data.output
        ? [...next.order.filter((id) => id !== data.node), data.node]
        : next.order;
      const decisions = data.next_agent
        ? [...next.decisions, { at: data.at, next: data.next_agent }]
        : next.decisions;
      return { ...next, order, decisions };
    }

    case "node_failed":
      return updateNode(state, data.node, {
        status: "failed",
        endedAt: data.at,
        durationMs: data.duration_ms ?? null,
        attempts: data.attempts ?? 0,
        error: data.error,
      });

    case "node_skipped":
      return updateNode(state, data.node, { status: "skipped", error: data.reason });

    case "run_completed": {
      // The final result is authoritative: take its outputs, and settle anything that
      // never ran (a halted chain) as skipped.
      let next = {
        ...state,
        status: "completed",
        endedAt: data.at,
        halted: Boolean(data.halted),
        usage: data.usage ?? null,
      };
      for (const [id, output] of Object.entries(data.outputs ?? {})) {
        next = updateNode(next, id, { output, status: "completed" });
        if (!next.order.includes(id)) next = { ...next, order: [...next.order, id] };
      }
      for (const err of data.errors ?? []) {
        if (next.nodes[err.agent_id]?.status !== "completed") {
          next = updateNode(next, err.agent_id, {
            status: err.attempts === 0 ? "skipped" : "failed",
            error: err.error,
          });
        }
      }
      return settle(next, "skipped", "Did not run");
    }

    case "run_failed": {
      const next = {
        ...state,
        status: "failed",
        endedAt: data.at,
        usage: data.usage ?? null,
        error: { errorType: data.error_type, message: data.message, details: data.limit_s ? { limit_s: data.limit_s } : null },
      };
      // A run cut off mid-way: whatever was running didn't finish, and the rest never ran.
      // A run the user stopped didn't fail: the agent working then was stopped.
      if (data.error_type === "RunStopped")
        return settle(settle(next, "skipped", "Stopped before it finished", ["running"]), "skipped", "Did not run");
      return settle(settle(next, "failed", data.message, ["running"]), "skipped", "Did not run");
    }

    default:
      return state;
  }
}

/** Move nodes still in `from` states to `status` at the end of a run. */
function settle(state, status, reason, from = ["queued", "running"]) {
  let next = state;
  for (const [id, node] of Object.entries(state.nodes)) {
    if (from.includes(node.status)) {
      next = updateNode(next, id, { status, error: node.error ?? reason, endedAt: next.endedAt });
    }
  }
  return next;
}

/** A single-agent run's result (one request, no stream), as the same state shape. */
export function finishAgentRun(state, agentId, { startedMs, endedMs, result }) {
  const output = result?.outputs?.[agentId] ?? null;
  const error = (result?.errors ?? []).find((e) => e.agent_id === agentId);
  let next = updateNode(state, agentId, {
    status: output ? "completed" : error?.attempts === 0 ? "skipped" : "failed",
    startedAt: startedMs / 1000,
    endedAt: endedMs / 1000,
    durationMs: endedMs - startedMs,
    output,
    error: error?.error ?? null,
    attempts: error?.attempts ?? 1,
    runs: 1,
  });
  next = {
    ...next,
    status: "completed",
    startedAt: startedMs / 1000,
    endedAt: endedMs / 1000,
    order: output ? [agentId] : [],
    halted: Boolean(result?.halted),
  };
  return next;
}

/** Current time on the server's clock, for live elapsed times while a run is going. */
export function serverNow(state, clientNow = Date.now()) {
  if (state.startedAt == null || state.clientStartedAt == null) return null;
  return state.startedAt + (clientNow - state.clientStartedAt) / 1000;
}

export function runCounts(state) {
  const counts = Object.fromEntries(NODE_STATES.map((s) => [s, 0]));
  for (const node of Object.values(state.nodes)) counts[node.status] += 1;
  return counts;
}
