// The orchestration graph of a plan, as the compiler wires it: which agent runs after
// which. Used by the Compile page's flow view and the Run page's diagram, so both show
// the graph that actually runs.

export const START = "__start__";
export const END = "__end__";

// One colour per agent, in plan order, used for its diagram node, output card, timeline
// bar and legend entry: mid-saturation hues (no orange, pink or purple) that mark
// identity (stripes, dots, bars), never carrying text. Defined as CSS tokens.
export const AGENT_PALETTE = Array.from({ length: 6 }, (_, i) => `var(--agent-${i + 1})`);

export function agentColor(index) {
  return AGENT_PALETTE[index % AGENT_PALETTE.length];
}

/** "travel_advisor" → "Travel Advisor". */
export function agentTitle(id) {
  return String(id)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// The order a sequential plan runs in: dependencies first, the planner's own ordering
// among agents that are ready at the same time — the compiler's rule.
export function sequentialOrder(agents) {
  const indegree = Object.fromEntries(agents.map((a) => [a.id, 0]));
  const dependents = Object.fromEntries(agents.map((a) => [a.id, []]));
  for (const agent of agents) {
    for (const dep of agent.depends_on) {
      if (!(dep in indegree)) continue;
      indegree[agent.id] += 1;
      dependents[dep].push(agent.id);
    }
  }
  const ready = agents.filter((a) => indegree[a.id] === 0).map((a) => a.id);
  const order = [];
  while (ready.length > 0) {
    const current = ready.shift();
    order.push(current);
    for (const next of dependents[current]) {
      indegree[next] -= 1;
      if (indegree[next] === 0) ready.push(next);
    }
  }
  return order;
}

// Groups agents into stages: an agent sits one stage after the latest thing it depends
// on, so everything in a stage can run at the same time.
export function parallelStages(agents) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const level = {};
  const resolve = (id, path = []) => {
    if (id in level) return level[id];
    if (path.includes(id)) return 0; // plans are validated acyclic; never loop regardless
    const deps = byId[id].depends_on.filter((d) => d in byId);
    level[id] = deps.length ? 1 + Math.max(...deps.map((d) => resolve(d, [...path, id]))) : 0;
    return level[id];
  };
  const stages = [];
  for (const agent of agents) {
    const l = resolve(agent.id);
    (stages[l] ??= []).push(agent.id);
  }
  return stages.filter(Boolean);
}

/**
 * The plan as a graph: { agents, edges }.
 * agents: [{ id, title, role, color, isRouter }] in plan order.
 * edges:  [{ id, source, target }] including the Start and End terminals.
 */
export function buildGraph(plan) {
  const agents = plan.agents.map((agent, i) => ({
    id: agent.id,
    title: agentTitle(agent.id),
    role: agent.role,
    color: agentColor(i),
    isRouter: agent.id === plan.supervisor_id,
  }));
  const edges = [];
  const link = (source, target) =>
    edges.push({ id: `${source}->${target}`, source, target });

  if (plan.orchestration_pattern === "supervisor" && plan.supervisor_id) {
    const router = plan.supervisor_id;
    link(START, router);
    for (const a of plan.agents) {
      if (a.id === router) continue;
      link(router, a.id);
      link(a.id, router);
    }
    link(router, END);
  } else if (plan.orchestration_pattern === "sequential") {
    const order = sequentialOrder(plan.agents);
    order.forEach((id, i) => link(i === 0 ? START : order[i - 1], id));
    if (order.length) link(order[order.length - 1], END);
  } else {
    const hasDependents = new Set(plan.agents.flatMap((a) => a.depends_on));
    for (const a of plan.agents) {
      if (a.depends_on.length === 0) link(START, a.id);
      for (const dep of a.depends_on) link(dep, a.id);
      if (!hasDependents.has(a.id)) link(a.id, END);
    }
  }
  return { agents, edges };
}

/** The agents whose output is the run's answer: the ones nothing else runs after. */
export function finalAgentIds(plan) {
  const { edges } = buildGraph(plan);
  return edges.filter((e) => e.target === END).map((e) => e.source)
    .filter((id) => id !== plan.supervisor_id);
}
