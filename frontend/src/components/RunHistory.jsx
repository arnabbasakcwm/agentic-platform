import { formatDuration, fullDate, timeAgo } from "../lib/format.js";
import { formatCost, formatTokens } from "../lib/usage.js";
import { useEffect, useRef } from "react";
import { Icon } from "./icons.jsx";
import { StatusBadge } from "./ui.jsx";
import { accessErrorInfo } from "../lib/access.js";

// Short history labels for the runs the platform stopped for a budget, model or access reason.
const ACCESS_LABELS = {
  BUDGET_EXCEEDED: "Budget used up",
  MODEL_NOT_PERMITTED: "Model not allowed",
  AccessRevokedError: "Access removed",
  AccessRevoked: "Access removed",
};
const accessLabel = (type) => (accessErrorInfo(type) ? ACCESS_LABELS[type] : null);

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
        run.error?.error_type === "RunInterrupted"
          ? "Interrupted"
          : run.error?.error_type === "RunStopped"
            ? "Stopped"
            : accessLabel(run.error?.error_type) ?? "Failed",
    };
  return { badge: "running", label: "Running" };
}

function usageText(usage) {
  if (!usage) return null;
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (!tokens) return null;
  return `${formatTokens(tokens)} tokens${usage.cost ? ` · ~${formatCost(usage.cost, usage.currency)}` : ""}`;
}

function RunList({ runs, selectedId, onSelect, label }) {
  return (
    <ul className="runhist" aria-label={label}>
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
              <span className="runhist__when" title={fullDate(run.started_at)}>
                {timeAgo(run.started_at)}
              </span>
              <StatusBadge status={badge} label={label} />
              <span className="runhist__meta">
                {run.mode === "agent" ? `Agent ${run.agent_id}` : "Full graph"}
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
  );
}

/**
 * The last saved runs (newest first), in a modal panel that slides in from the right;
 * clicking one shows it. `runs` are run summaries from GET /projects/{id}/runs (or the
 * deployment's runs). Escape, the close
 * button or a click on the backdrop closes it; choosing a run closes it too.
 */
export function RunHistoryDrawer({
  open,
  onClose,
  runs,
  selectedId,
  onSelect,
  title = "Previous runs",
  note,
}) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="runhist-drawer-title"
      onClose={onClose}
      onClick={(e) => {
        // A click on the dialog element itself is a click on the backdrop.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="drawer__inner">
        <header className="drawer__header">
          <h2 className="drawer__title" id="runhist-drawer-title">
            {title}
          </h2>
          <button
            type="button"
            className="iconbtn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <p className="drawer__sub muted">
          {note ?? `Last ${runs?.length ?? 0} saved on the server`}
        </p>
        <div className="drawer__body">
          {runs?.length ? (
            <RunList
              runs={runs}
              selectedId={selectedId}
              onSelect={(id) => {
                onSelect(id);
                onClose();
              }}
              label={title}
            />
          ) : (
            <p className="muted drawer__empty">No saved runs yet.</p>
          )}
        </div>
      </div>
    </dialog>
  );
}
