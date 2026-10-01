import { buildGraph, finalAgentIds } from "../lib/flow.js";
import { AgentOutputCard } from "./AgentOutputCard.jsx";
import { Empty } from "./ui.jsx";

/**
 * A finished result ({outputs, errors, halted}, as /run and a deployed runtime return it)
 * as the same output cards the Run page shows — for places with no live run to follow,
 * such as trying a deployment.
 */
export function ResultOutputs({ plan, result }) {
  const graph = buildGraph(plan);
  const colorOf = Object.fromEntries(graph.agents.map((a) => [a.id, a.color]));
  const roleOf = Object.fromEntries(plan.agents.map((a) => [a.id, a.role]));
  const outputs = result.outputs ?? {};
  const errors = Object.fromEntries((result.errors ?? []).map((e) => [e.agent_id, e]));
  const finals = new Set(finalAgentIds(plan));
  const ids = [...Object.keys(outputs), ...Object.keys(errors).filter((id) => !(id in outputs))];

  if (ids.length === 0) return <Empty>The run produced no output.</Empty>;

  return (
    <div className="outcards">
      {ids.map((id) => {
        const error = errors[id];
        const node = {
          status: outputs[id] ? "completed" : error?.attempts === 0 ? "skipped" : "failed",
          output: outputs[id] ?? null,
          error: error?.error ?? null,
          durationMs: null,
          attempts: error?.attempts ?? 1,
        };
        return (
          <AgentOutputCard
            key={id}
            agentId={id}
            role={roleOf[id]}
            color={colorOf[id]}
            node={node}
            isFinal={finals.has(id) && Boolean(outputs[id])}
          />
        );
      })}
    </div>
  );
}
