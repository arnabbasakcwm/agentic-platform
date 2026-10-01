import { Icon } from "../../components/icons.jsx";
import {
  ActionBar,
  Button,
  Callout,
  ErrorCallout,
  LinkButton,
  MetaList,
  Panel,
  Pill,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { parallelStages, sequentialOrder } from "../../lib/flow.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";

function Stage({ label, nodes, router }) {
  return (
    <div className="flow__stage">
      <span className="flow__label">{label}</span>
      <div className="flow__nodes">
        {nodes.map((id) => (
          <span key={id} className={`flow__node ${router ? "flow__node--router" : ""}`}>
            {id}
          </span>
        ))}
      </div>
    </div>
  );
}

function Arrow({ loop }) {
  return (
    <div className="flow__arrow">
      <Icon name={loop ? "loop" : "arrowRight"} size={18} />
    </div>
  );
}

function Flow({ plan }) {
  if (plan.orchestration_pattern === "supervisor") {
    const workers = plan.agents.filter((a) => a.id !== plan.supervisor_id).map((a) => a.id);
    return (
      <div className="flow">
        <Stage label="Router" nodes={[plan.supervisor_id]} router />
        <Arrow loop />
        <Stage label={`Workers (${workers.length})`} nodes={workers} />
      </div>
    );
  }

  const stages =
    plan.orchestration_pattern === "sequential"
      ? sequentialOrder(plan.agents).map((id) => [id])
      : parallelStages(plan.agents);

  return (
    <div className="flow">
      {stages.map((nodes, i) => (
        <div key={i} style={{ display: "contents" }}>
          {i > 0 && <Arrow />}
          <Stage label={`Stage ${i + 1}`} nodes={nodes} />
        </div>
      ))}
    </div>
  );
}

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

export function CompileStep({ project, onCompiled }) {
  const { plan } = project;
  const compile = useAction();

  async function run() {
    const ok = await compile.run(() => api.compile(project.project_id));
    if (ok) onCompiled();
  }

  return (
    <>
      <div className="page">
        <div className="split">
          <Panel
            title="Execution flow"
            subtitle="How the compiled graph will run."
            actions={<Pill tone="accent">{plan.orchestration_pattern}</Pill>}
          >
            <Flow plan={plan} />
            <p className="muted" style={{ marginTop: 14 }}>
              {describe(plan)}
            </p>
          </Panel>

          <aside className="split__aside">
            <Panel title="Status">
              {project.compiled ? (
                <Callout tone="success" title="Compiled">
                  The graph is built from the current plan and ready to run.
                </Callout>
              ) : (
                <Callout tone="warn" title="Not compiled">
                  The current plan hasn't been built into a runnable graph yet.
                </Callout>
              )}
              <div style={{ marginTop: 12 }}>
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
                <div style={{ marginTop: 12 }}>
                  <ErrorCallout error={compile.error} />
                </div>
              )}
            </Panel>

            <Panel title="Run limits" subtitle="Enforced on every run.">
              <MetaList
                rows={[
                  ["Tool steps per agent", <span key="Tool steps per agent" className="mono">{plan.bounds.max_steps}</span>],
                  ["Attempts per agent", <span key="Attempts per agent" className="mono">{plan.bounds.max_retries}</span>],
                  ["Time per run", <span key="Time per run" className="mono">{plan.bounds.timeout_s}s</span>],
                ]}
              />
            </Panel>
          </aside>
        </div>
      </div>

      <ActionBar note="Compiling checks every agent's tools and wires the graph. It makes no model calls.">
        <LinkButton href={paths.project(project.project_id, "plan")}>
          <Icon name="arrowLeft" />
          Plan
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
