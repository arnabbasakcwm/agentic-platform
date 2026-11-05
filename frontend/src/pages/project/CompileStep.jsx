import { useState } from "react";
import { Icon } from "../../components/icons.jsx";
import {
  ActionBar,
  Button,
  Callout,
  ErrorCallout,
  LinkButton,
  Panel,
  Pill,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { agentStyle, parallelStages, sequentialOrder } from "../../lib/flow.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";
import { requireAccess } from "../../components/AccessGuard.jsx";

// One stage box: a coloured top bar (its first agent's colour), "Stage 01", and each
// agent in it with its real role, model and number of tools. Boxes enter left to right.
function Stage({ label, nodes, order, byId, router }) {
  const lead = order.indexOf(nodes[0]);
  return (
    <div className="flow__stage" style={{ ...agentStyle(lead), "--i": lead }}>
      <span className="flow__label">{label}</span>
      <div className="flow__nodes">
        {nodes.map((id) => {
          const agent = byId[id];
          const tools = agent.tools.length;
          return (
            <div
              key={id}
              className={`flow__node ${router ? "flow__node--router" : ""}`}
              style={agentStyle(order.indexOf(id))}
            >
              <span className="flow__id">{id}</span>
              <span className="flow__role">{agent.role}</span>
              <span className="flow__facts">
                <span className="mono">{agent.llm.model}</span>
                <span>
                  {router ? "routes the team" : `${tools} tool${tools === 1 ? "" : "s"}`}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The link between stages: a line that draws in after the stage before it.
function Arrow({ loop, index }) {
  return (
    <div className="flow__arrow" style={{ "--i": index }} aria-hidden="true">
      <span className="flow__line ap-connector-fill" />
      <Icon name={loop ? "loop" : "arrowRight"} size={16} />
    </div>
  );
}

function Flow({ plan }) {
  const order = plan.agents.map((a) => a.id);
  const byId = Object.fromEntries(plan.agents.map((a) => [a.id, a]));
  if (plan.orchestration_pattern === "supervisor") {
    const workers = plan.agents.filter((a) => a.id !== plan.supervisor_id).map((a) => a.id);
    return (
      <div className="flow" tabIndex={0} role="region" aria-label="Execution flow">
        <Stage label="Router" nodes={[plan.supervisor_id]} order={order} byId={byId} router />
        <Arrow loop index={1} />
        <Stage label={`Workers (${workers.length})`} nodes={workers} order={order} byId={byId} />
      </div>
    );
  }

  const stages =
    plan.orchestration_pattern === "sequential"
      ? sequentialOrder(plan.agents).map((id) => [id])
      : parallelStages(plan.agents);

  return (
    <div className="flow" tabIndex={0} role="region" aria-label="Execution flow">
      {stages.map((nodes, i) => (
        <div key={i} className="contents">
          {i > 0 && <Arrow index={i} />}
          <Stage
            label={`Stage ${String(i + 1).padStart(2, "0")}`}
            nodes={nodes}
            order={order}
            byId={byId}
          />
        </div>
      ))}
    </div>
  );
}

/** A check that draws itself (.ap-check-draw). */
function DrawnCheck() {
  return (
    <svg className="ap-check-draw" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const PATTERN_TITLE = {
  sequential: "Sequential execution",
  parallel: "Parallel execution",
  supervisor: "Routed execution",
};

function describe(plan) {
  const { bounds } = plan;
  switch (plan.orchestration_pattern) {
    case "sequential":
      return "Agents run one at a time, in this order, each seeing the output of the agents it depends on. If an agent still fails after its retries, the agents after it are skipped.";
    case "parallel":
      return "Agents in the same stage run at the same time. An agent starts once everything it depends on has finished; if one of those failed, it is skipped while unrelated branches carry on.";
    case "supervisor": {
      const workers = plan.agents.length - 1;
      const turns = Math.max(bounds.max_steps, 2 * workers + 2);
      return `The router decides which worker acts next, one at a time, and sees every result so far. It stops when it judges the task finished, or after ${turns} routing turns at most.`;
    }
    default:
      return "";
  }
}

function CompileStepInner({ project, onCompiled }) {
  const { plan } = project;
  const compile = useAction();
  // Compiled while this page was open: the status card glows briefly (visual only).
  const [justCompiled, setJustCompiled] = useState(false);

  async function run() {
    const ok = await compile.run(() => api.compile(project.project_id));
    if (ok) {
      setJustCompiled(true);
      onCompiled();
    }
  }

  return (
    <>
      <div className="page">
        <div className="split">
          <Panel
            title="Execution flow"
            subtitle="How the compiled graph will run."
            actions={<Pill tone="violet">{plan.orchestration_pattern}</Pill>}
          >
            <Flow plan={plan} />
            <div className="flow__note">
              <Icon name="flag" size={16} />
              <p>
                <strong className="flow__note-title">
                  {PATTERN_TITLE[plan.orchestration_pattern] ?? "Execution"}
                </strong>
                {describe(plan)}
              </p>
            </div>
          </Panel>

          <aside className="split__aside">
            <Panel title="Status">
              {project.compiled ? (
                <div
                  key={justCompiled ? "fresh" : "loaded"}
                  className={`compiled${justCompiled ? " compiled--fresh" : ""}`}
                  role="status"
                >
                  <span className="compiled__icon">
                    <DrawnCheck />
                  </span>
                  <span>
                    <strong className="compiled__title">Compiled</strong>
                    The graph is built from the current plan and ready to run.
                  </span>
                </div>
              ) : (
                <Callout tone="warn" title="Not compiled">
                  The current plan hasn't been built into a runnable graph yet.
                </Callout>
              )}
              <div className="mt-sm">
                <Button
                  variant={project.compiled ? undefined : "primary"}
                  block
                  loading={compile.busy}
                  onClick={run}
                >
                  {!compile.busy && <Icon name="bolt" />}
                  {compile.busy ? "Compiling…" : project.compiled ? "Compile again" : "Compile plan"}
                </Button>
              </div>
              {compile.error && (
                <div className="mt-sm">
                  <ErrorCallout error={compile.error} />
                </div>
              )}
            </Panel>

            <Panel title="Run limits" subtitle="Enforced on every run.">
              <dl className="limits">
                <div className="limits__row">
                  <dt>Tool steps per agent</dt>
                  <dd className="mono">{plan.bounds.max_steps}</dd>
                </div>
                <div className="limits__row">
                  <dt>Attempts per agent</dt>
                  <dd className="mono">{plan.bounds.max_retries}</dd>
                </div>
                <div className="limits__row">
                  <dt>Time per run</dt>
                  <dd className="mono">{plan.bounds.timeout_s}s</dd>
                </div>
              </dl>
            </Panel>
          </aside>
        </div>
      </div>

      <ActionBar note="Compiling checks every agent's tools and wires the graph. It makes no model calls.">
        <LinkButton href={paths.project(project.project_id, "plan")}>
          <Icon name="arrowLeft" />
          Back to Plan
        </LinkButton>
        {project.compiled ? (
          <LinkButton variant="primary" href={paths.project(project.project_id, "run")}>
            Run
            <Icon name="arrowRight" />
          </LinkButton>
        ) : (
          <Button variant="primary" disabled title="Compile the plan first">
            Run
            <Icon name="arrowRight" />
          </Button>
        )}
      </ActionBar>
    </>
  );
}

export const CompileStep = requireAccess("edit", CompileStepInner, "compile a project");
