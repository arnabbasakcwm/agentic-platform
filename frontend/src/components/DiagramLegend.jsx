import { useMemo } from "react";
import { buildGraph } from "../lib/flow.js";

const STATE_LABEL = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

/** Agent colours and node states, as used by the diagram, timeline and output cards. */
export function DiagramLegend({ plan }) {
  const graph = useMemo(() => buildGraph(plan), [plan]);
  return (
    <div className="legend">
      <ul className="legend__agents" aria-label="Agents">
        {graph.agents.map((a) => (
          <li key={a.id}>
            <span className="legend__dot" style={{ background: a.color }} aria-hidden="true" />
            {a.title}
          </li>
        ))}
      </ul>
      <ul className="legend__states" aria-label="States">
        {Object.entries(STATE_LABEL).map(([state, label]) => (
          <li key={state}>
            <span className={`legend__swatch legend__swatch--${state}`} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
