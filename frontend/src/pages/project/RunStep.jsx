import { RunHistoryDrawer } from "../../components/RunHistory.jsx";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentOutputCard } from "../../components/AgentOutputCard.jsx";
import { OutputActions } from "../../components/OutputActions.jsx";
import { Icon } from "../../components/icons.jsx";
import { DiagramLegend } from "../../components/DiagramLegend.jsx";
import { RunTimeline } from "../../components/RunTimeline.jsx";
import { UsageLine } from "../../components/UsageLine.jsx";
import {
  ActionBar,
  Button,
  Callout,
  Empty,
  ErrorCallout,
  Field,
  LinkButton,
  Panel,
  SlidingThumb,
  StatusBadge,
} from "../../components/ui.jsx";
import { agentTitle, buildGraph, finalAgentIds } from "../../lib/flow.js";
import { formatDuration } from "../../lib/format.js";
import { paths } from "../../lib/router.js";
import { runCounts, serverNow } from "../../lib/runState.js";

// The diagram library is the heaviest part of the console; load it with this page only.
const RunDiagram = lazy(() =>
  import("../../components/RunDiagram.jsx").then((m) => ({
    default: m.RunDiagram,
  })),
);

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Re-renders every `ms` while `active`, for live elapsed times. */
function useClock(active, ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

function runElapsedMs(run, clock) {
  if (run.startedAt == null) return null;
  const end = run.endedAt ?? serverNow(run, clock);
  return end == null ? null : Math.max(0, (end - run.startedAt) * 1000);
}

function runSummary(run, clock) {
  const elapsed = formatDuration(runElapsedMs(run, clock));
  switch (run.status) {
    case "running":
      return elapsed ? `Running · ${elapsed}` : "Starting…";
    case "completed":
      return run.halted ? `Halted after ${elapsed}` : `Completed in ${elapsed}`;
    case "failed":
      if (stopped(run)) return elapsed ? `Stopped after ${elapsed}` : "Stopped";
      return elapsed ? `Failed after ${elapsed}` : "Failed";
    default:
      return "Not run yet";
  }
}

/** Stops the run shown; only while it runs and the server knows its id. */
function StopButton({ run, runId, stopping, onStop, size }) {
  if (run.status !== "running" || !runId) return null;
  return (
    <Button
      size={size}
      variant="danger"
      loading={stopping}
      onClick={onStop}
      aria-label={stopping ? "Stopping the run" : "Stop the run"}
    >
      {!stopping && <Icon name="stop" size={14} />}
      {stopping ? "Stopping…" : "Stop"}
    </Button>
  );
}

const stopped = (run) =>
  run.status === "failed" && run.error?.errorType === "RunStopped";

const badgeStatus = (run) =>
  stopped(run)
    ? "skipped"
    : run.status === "completed" && run.halted
      ? "failed"
      : run.status;

/** Plain-language status changes for screen readers (rendered into an aria-live region). */
function useAnnouncement(run, plan) {
  const [message, setMessage] = useState("");
  const seen = useRef({ status: run.status, nodes: {} });
  useEffect(() => {
    const prev = seen.current;
    let next = null;
    if (run.status !== prev.status) {
      if (run.status === "running") next = "Run started.";
      else if (run.status === "completed")
        next = run.halted ? "Run halted." : "Run completed.";
      else if (stopped(run)) next = "Run stopped.";
      else if (run.status === "failed")
        next = `Run failed: ${run.error?.message ?? ""}`;
    } else {
      for (const agent of plan.agents) {
        const status = run.nodes[agent.id]?.status;
        if (
          status !== prev.nodes[agent.id] &&
          (status === "completed" || status === "failed")
        ) {
          next = `${agentTitle(agent.id)} ${status}.`;
        }
      }
    }
    seen.current = {
      status: run.status,
      nodes: Object.fromEntries(
        Object.entries(run.nodes).map(([id, n]) => [id, n.status]),
      ),
    };
    if (next) setMessage(next);
  }, [run, plan]);
  return message;
}

function InputPanel({
  project,
  run,
  runId,
  draftInput,
  onDraftInput,
  onStart,
  onStop,
  stopping,
  stopError,
}) {
  const [mode, setMode] = useState("graph");
  const [agentId, setAgentId] = useState("");
  const [parseError, setParseError] = useState(null);
  const agents = project.plan.agents;
  const selectedAgent = agentId || agents[0]?.id || "";
  const running = run.status === "running";
  const blocked = mode === "graph" && !project.compiled;
  const noExample = Object.keys(project.plan.example_input ?? {}).length === 0;

  function submit(event) {
    event.preventDefault();
    let parsed;
    try {
      parsed = JSON.parse(draftInput);
    } catch (e) {
      setParseError({ errorType: "Invalid JSON", message: e.message });
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      setParseError({
        errorType: "Invalid input",
        message: 'The task input must be a JSON object, like {"request": "…"}.',
      });
      return;
    }
    setParseError(null);
    onStart({
      input: parsed,
      mode,
      agentId: mode === "agent" ? selectedAgent : null,
    });
  }

  return (
    <form onSubmit={submit} className="run-col">
      <Panel
        title="Input"
        footer={
          <div className="run-actions">
            <Button
              type="submit"
              variant="primary"
              loading={running}
              disabled={blocked || running}
            >
              {!running && <Icon name="play" size={14} />}
              {running
                ? "Running…"
                : mode === "graph"
                  ? "Run graph"
                  : "Run agent"}
            </Button>
            <StopButton
              run={run}
              runId={runId}
              stopping={stopping}
              onStop={onStop}
            />
          </div>
        }
      >
        <div className="segmented" role="tablist" aria-label="What to run">
          <SlidingThumb on={mode} />
          {[
            ["graph", "Full graph"],
            ["agent", "Single agent"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              className={
                mode === key
                  ? "segmented__item segmented__item--on"
                  : "segmented__item"
              }
              onClick={() => setMode(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "agent" && (
          <Field
            label="Agent"
            hint="Runs this one agent on its own, without the rest of the team."
          >
            <select
              value={selectedAgent}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentTitle(a.id)} — {a.role}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Task input (JSON)"
          hint={
            noExample
              ? 'This plan has no example input yet. Describe the task under "request", or ask the assistant to add an example input.'
              : "Pre-filled with this project's example input. Every agent receives it as the shared task input."
          }
        >
          <textarea
            className="mono run-input"
            value={draftInput}
            onChange={(e) => onDraftInput(e.target.value)}
            spellCheck={false}
          />
        </Field>

        {blocked && (
          <Callout tone="warn" title="Not compiled">
            The full graph needs a compiled plan.{" "}
            <a href={paths.project(project.project_id, "compile")}>
              Go to Compile
            </a>
          </Callout>
        )}
        {parseError && <ErrorCallout error={parseError} />}
        {stopError && <ErrorCallout error={stopError} />}
      </Panel>
    </form>
  );
}

function ResultsPanel({
  project,
  run,
  runId,
  clock,
  cardRefs,
  highlighted,
  draftInput,
  onRetry,
}) {
  const graph = useMemo(() => buildGraph(project.plan), [project.plan]);
  const byId = useMemo(
    () => Object.fromEntries(graph.agents.map((a) => [a.id, a])),
    [graph],
  );
  const roleOf = Object.fromEntries(
    project.plan.agents.map((a) => [a.id, a.role]),
  );

  // Cards in execution order: agents that produced output, then the one(s) working now,
  // then any that failed or were skipped.
  const ordered = [
    ...run.order,
    ...project.plan.agents
      .map((a) => a.id)
      .filter(
        (id) =>
          !run.order.includes(id) &&
          ["running", "failed", "skipped"].includes(run.nodes[id]?.status),
      ),
  ];
  const finals = new Set(
    project.plan.orchestration_pattern === "supervisor"
      ? run.order.filter((id) => id !== project.plan.supervisor_id).slice(-1)
      : finalAgentIds(project.plan),
  );
  const ranWith = run.input ? JSON.stringify(run.input) : null;
  let inputChanged = false;
  try {
    inputChanged =
      ranWith != null && JSON.stringify(JSON.parse(draftInput)) !== ranWith;
  } catch {
    inputChanged = ranWith != null;
  }

  return (
    <section
      className="panel run-col run-results"
      aria-labelledby="results-title"
    >
      <header className="panel__header">
        <h2 className="panel__title" id="results-title">
          Result
        </h2>
        <span className="panel__sub">
          {run.mode === "agent" && run.status !== "idle"
            ? "Single agent"
            : "Full graph"}
        </span>
        <div className="panel__spacer" />
        {run.status !== "idle" && (
          <StatusBadge
            status={badgeStatus(run)}
            label={runSummary(run, clock)}
          />
        )}
        {/* The whole run's output, once every agent has finished. */}
        {run.status !== "running" &&
          run.order.some((id) => run.nodes[id]?.status === "completed") && (
            <OutputActions
              projectId={project.project_id}
              runId={runId}
              label="the whole run"
            />
          )}
      </header>
      {ranWith && (
        <div className="ranwith">
          <span className="ranwith__label">Ran with</span>
          <code className="ranwith__value" title={ranWith}>
            {ranWith}
          </code>
          {inputChanged && (
            <span className="ranwith__note">Input changed since this run</span>
          )}
        </div>
      )}
      <UsageLine usage={run.usage} />
      <div className="panel__body run-results__body">
        {run.status === "failed" && run.error && (
          <div className="stack mb-md">
            {run.error.errorType === "RunStopped" ? (
              <Callout tone="info" title="Stopped">
                You stopped this run. Outputs finished before then are kept below.
              </Callout>
            ) : (
              <ErrorCallout error={run.error} />
            )}
            <div>
              <Button onClick={onRetry}>
                <Icon name="play" size={14} />
                Run again
              </Button>
            </div>
          </div>
        )}
        {ordered.length === 0 ? (
          run.status === "running" ? (
            <Empty title="Waiting for the first agent…">
              Outputs appear here as each agent finishes.
            </Empty>
          ) : run.status === "idle" ? (
            <Empty title="No run yet">
              Run the graph to see each agent's answer here, in the order they
              finish.
            </Empty>
          ) : null
        ) : (
          <div className="outcards">
            {ordered.map((id) => (
              <AgentOutputCard
                key={id}
                ref={(el) => {
                  if (el) cardRefs.current[id] = el;
                }}
                agentId={id}
                role={roleOf[id]}
                color={byId[id]?.color}
                node={run.nodes[id]}
                isFinal={
                  finals.has(id) && run.nodes[id]?.status === "completed"
                }
                highlighted={highlighted === id}
                projectId={project.project_id}
                runId={runId}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function RunStep({
  project,
  run,
  runId,
  runVersion,
  history = [],
  onOpenRun,
  draftInput,
  onDraftInput,
  onStart,
  onStop,
  stopping = false,
  stopError = null,
}) {
  const clock = useClock(run.status === "running");
  const cardRefs = useRef({});
  const flowRef = useRef(null);
  const [highlighted, setHighlighted] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const announcement = useAnnouncement(run, project.plan);
  const counts = runCounts(run);

  const selectAgent = useCallback((id) => {
    const card = cardRefs.current[id];
    if (!card) return;
    card.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    card.focus({ preventScroll: true });
    setHighlighted(id);
    setTimeout(() => setHighlighted((h) => (h === id ? null : h)), 1600);
  }, []);

  // Starting a run brings the diagram into view, so the run can be watched as it happens.
  function startAndWatch(request) {
    flowRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    onStart(request);
  }

  function retry() {
    if (!run.input) return;
    const agentId =
      run.mode === "agent"
        ? (Object.keys(run.nodes).find((id) => run.nodes[id].runs > 0) ?? null)
        : null;
    startAndWatch({ input: run.input, mode: run.mode, agentId });
  }

  return (
    <>
      <div className="page run-page">
        <section
          className="panel run-flow"
          aria-labelledby="flow-title"
          ref={flowRef}
        >
          <header className="panel__header">
            <h2 className="panel__title" id="flow-title">
              Orchestration
            </h2>
            <span className="panel__sub">
              {project.plan.orchestration_pattern}
            </span>
            <div className="panel__spacer" />
            {run.status !== "idle" && (
              <span className="run-flow__counts">
                {counts.completed}/{project.plan.agents.length} done
                {counts.failed > 0 && ` · ${counts.failed} failed`}
              </span>
            )}
            <StatusBadge
              status={badgeStatus(run)}
              label={runSummary(run, clock)}
            />
            <StopButton
              run={run}
              runId={runId}
              stopping={stopping}
              onStop={onStop}
              size="sm"
            />
            <Button
              size="sm"
              aria-haspopup="dialog"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(true)}
            >
              <Icon name="clock" size={14} />
              History
              {history.length > 0 && (
                <span className="count-chip">{history.length}</span>
              )}
            </Button>
          </header>
          <Suspense
            fallback={
              <div className="diagram diagram--loading" aria-busy="true" />
            }
          >
            <RunDiagram
              plan={project.plan}
              run={run}
              clock={clock}
              onSelectAgent={selectAgent}
            />
          </Suspense>
          <div className="run-flow__foot">
            <RunTimeline plan={project.plan} run={run} clock={clock} />
            <DiagramLegend plan={project.plan} />
          </div>
        </section>

        <InputPanel
          project={project}
          run={run}
          runId={runId}
          draftInput={draftInput}
          onDraftInput={onDraftInput}
          onStart={startAndWatch}
          onStop={onStop}
          stopping={stopping}
          stopError={stopError}
        />
        <ResultsPanel
          project={project}
          run={run}
          runId={runId}
          clock={clock}
          cardRefs={cardRefs}
          highlighted={highlighted}
          draftInput={draftInput}
          onRetry={retry}
        />
        {runVersion != null && runVersion !== project.plan_version && (
          <p className="muted runhist__older" role="status">
            This run used plan v{runVersion}; the plan is now v
            {project.plan_version}.
          </p>
        )}
      </div>

      <RunHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        runs={history}
        selectedId={runId}
        onSelect={onOpenRun}
        note={`Last ${history.length} saved on the server — they stay when you leave this page`}
      />

      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>

      <ActionBar note="Runs are saved on the server: leave this page while one runs and come back to its result.">
        <LinkButton href={paths.project(project.project_id, "compile")}>
          <Icon name="arrowLeft" />
          Back to Compile
        </LinkButton>
        <LinkButton
          variant="primary"
          href={paths.project(project.project_id, "deploy")}
        >
          Deploy
          <Icon name="arrowRight" />
        </LinkButton>
      </ActionBar>
    </>
  );
}
