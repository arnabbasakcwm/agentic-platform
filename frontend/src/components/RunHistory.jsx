import { formatDuration, fullDate, timeAgo } from "../lib/format.js";
import { formatCost, formatTokens } from "../lib/usage.js";
import { Panel, StatusBadge } from "./ui.jsx";

const ms = (iso) => (iso ? new Date(iso).getTime() : null);

function statusOf(run) {
  if (run.status === "completed" && run.halted)
    return { badge: "failed", label: "Halted" };
  if (run.status === "completed")
    return { badge: "completed", label: "Completed" };
  if (run.status === "failed")
    return {
      badge: "failed",
      label:
        run.error?.error_type === "RunInterrupted" ? "Interrupted" : "Failed",
    };
  return { badge: "running", label: "Running" };
}

function usageText(usage) {
  if (!usage) return null;
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (!tokens) return null;
  return `${formatTokens(tokens)} tokens${usage.cost ? ` · ~${formatCost(usage.cost, usage.currency)}` : ""}`;
}

/**
 * The project's last saved runs (newest first); clicking one shows it. `runs` are run
 * summaries from GET /projects/{id}/runs.
 */
export function RunHistory({
  runs,
  selectedId,
  onSelect,
  title = "Previous runs",
  note,
}) {
  if (!runs?.length) return null;
  return (
    <Panel
      title={title}
      subtitle={note ?? `Last ${runs.length} saved on the server`}
      flush
    >
      <ul className="runhist" aria-label={title}>
        {runs.map((run) => {
          const { badge, label } = statusOf(run);
          const duration =
            run.finished_at && run.started_at
              ? formatDuration(ms(run.finished_at) - ms(run.started_at))
              : null;
          const usage = usageText(run.usage);
          const selected = run.id === selectedId;
          return (
            <li key={run.id}>
              <button
                type="button"
                className={["runhist__row", selected && "runhist__row--on"]
                  .filter(Boolean)
                  .join(" ")}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(run.id)}
              >
                <span
                  className="runhist__when"
                  title={fullDate(run.started_at)}
                >
                  {timeAgo(run.started_at)}
                </span>
                <StatusBadge status={badge} label={label} />
                <span className="runhist__meta">
                  {run.mode === "agent"
                    ? `Agent ${run.agent_id}`
                    : "Full graph"}
                  {run.plan_version != null && ` · plan v${run.plan_version}`}
                </span>
                <span className="runhist__meta mono">
                  {[duration, usage].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
