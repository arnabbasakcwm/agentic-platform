import { buildGraph } from "../lib/flow.js";
import { formatDuration } from "../lib/format.js";
import { serverNow } from "../lib/runState.js";

/**
 * Gantt-style view of a run: one bar per agent, positioned at when it started and as
 * long as it ran, against the run's total time. Bars move with transform only
 * (translate + scale), so updating them doesn't trigger layout.
 */
export function RunTimeline({ plan, run, clock }) {
  const { agents } = buildGraph(plan);
  if (run.status === "idle" || run.startedAt == null) return null;

  const now = serverNow(run, clock);
  const end = run.endedAt ?? now ?? run.startedAt;
  const total = Math.max(end - run.startedAt, 0.001);

  return (
    <div className="timeline" role="list" aria-label="Run timeline">
      {agents.map((agent) => {
        const node = run.nodes[agent.id];
        const started = node?.startedAt;
        const finished =
          node?.status === "running" ? end : node?.endedAt ?? (started != null ? end : null);
        const offset = started != null ? (started - run.startedAt) / total : 0;
        const span = started != null && finished != null ? Math.max((finished - started) / total, 0.004) : 0;
        const ms =
          node?.status === "running"
            ? (end - started) * 1000
            : node?.durationMs ?? (started != null && finished != null ? (finished - started) * 1000 : null);
        return (
          <div className="timeline__row" role="listitem" key={agent.id}>
            <span className="timeline__label">
              <span className="legend__dot" style={{ background: agent.color }} aria-hidden="true" />
              {agent.title}
            </span>
            <span className="timeline__track">
              {started != null && (
                <span
                  className={`timeline__bar timeline__bar--${node.status}`}
                  style={{
                    "--agent-color": agent.color,
                    transform: `translateX(${(offset * 100).toFixed(2)}%) scaleX(${span.toFixed(4)})`,
                  }}
                />
              )}
            </span>
            <span className="timeline__time">
              {started != null ? formatDuration(ms) : node?.status === "skipped" ? "Skipped" : "—"}
            </span>
          </div>
        );
      })}
      <div className="timeline__axis" aria-hidden="true">
        <span>0 s</span>
        <span>{formatDuration(total * 1000)}</span>
      </div>
    </div>
  );
}
