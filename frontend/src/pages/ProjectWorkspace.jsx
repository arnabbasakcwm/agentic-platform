import { useCallback, useEffect, useState } from "react";
import { AssistantPanel } from "../components/AssistantPanel.jsx";
import { Stepper } from "../components/Stepper.jsx";
import { ProjectHeader } from "../components/ProjectHeader.jsx";
import { Empty, ErrorCallout, LinkButton, Panel } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";
import { resourcesHint, resourcesReady } from "../lib/resources.js";
import { useProjectRun } from "../lib/useProjectRun.js";
import { BriefStep } from "./project/BriefStep.jsx";
import { CompileStep } from "./project/CompileStep.jsx";
import { DeployStep } from "./project/DeployStep.jsx";
import { ResourcesStep } from "./project/ResourcesStep.jsx";
import { PlanStep } from "./project/PlanStep.jsx";
import { RunStep } from "./project/RunStep.jsx";

// The assistant is offered on every step. A change made from Run or Deploy is a new plan
// version, which needs compiling (and redeploying) like any other plan change.
const ASSISTANT_STEPS = ["brief", "resources", "plan", "compile", "run", "deploy"];
const ASSISTANT_KEY = "agentic-platform.assistant-open";

// Open by default where there's room for it beside the page; remembered per browser.
function readAssistantOpen() {
  const roomy = window.innerWidth >= 1280;
  try {
    const saved = localStorage.getItem(ASSISTANT_KEY);
    return saved === null ? roomy : saved === "1";
  } catch {
    return roomy;
  }
}

function deployHint(deployment) {
  if (!deployment) return "Not deployed";
  if (deployment.in_progress) return "Deploying…";
  if (deployment.live) {
    return deployment.outdated
      ? `Live v${deployment.live_plan_version} · outdated`
      : `Live v${deployment.live_plan_version}`;
  }
  return "Failed";
}

function runHint(project, run) {
  if (run?.status === "running") return "Running…";
  if (run?.status === "failed")
    return run.error?.errorType === "RunStopped"
      ? "Last run stopped"
      : "Last run failed";
  if (run?.status === "completed")
    return run.halted ? "Last run halted" : "Last run completed";
  return project.compiled ? "Ready" : "Needs compiling";
}

// One project, one step of its workflow per page. Mounted with key={id}, so switching
// projects starts from a clean slate; switching steps keeps the loaded project and the
// latest run, which keeps streaming while another step is open.
export function ProjectWorkspace({
  id,
  step,
  tab,
  onChanged,
  tools,
  providers,
}) {
  const [project, setProject] = useState(null);
  const {
    run,
    runId,
    runVersion,
    history,
    open,
    draftInput,
    setDraftInput,
    start,
    stop,
    stopping,
    stopError,
  } = useProjectRun(project);
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpen);
  const load = useAction();
  const { run: runLoad } = load;

  // Stable, so the deploy page's status polling isn't restarted on every render.
  const deploymentChanged = useCallback(
    (deployment) => {
      setProject((p) => (p ? { ...p, deployment } : p));
      if (!deployment?.in_progress) onChanged();
    },
    [onChanged],
  );

  const knowledgeChanged = useCallback((knowledge) => {
    setProject((p) => (p ? { ...p, knowledge } : p));
  }, []);

  const dataChanged = useCallback((dataSources) => {
    setProject((p) => (p ? { ...p, data_sources: dataSources } : p));
  }, []);

  useEffect(() => {
    let current = true;
    runLoad(() => api.getProject(id)).then((loaded) => {
      if (current && loaded) setProject(loaded);
    });
    return () => {
      current = false;
    };
  }, [id, runLoad]);

  if (load.error) {
    return (
      <div className="page">
        <Panel>
          <ErrorCallout error={load.error} />
          <div className="mt-sm">
            <LinkButton href={paths.projects}>Back to projects</LinkButton>
          </div>
        </Panel>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page">
        <Panel>
          <Empty>Loading project…</Empty>
        </Panel>
      </div>
    );
  }

  const agentCount = project.plan.agents.length;
  const steps = [
    { key: "brief", label: "Brief", hint: "Defined", done: true },
    {
      // Documents, databases and MCP tools: what the agents can use.
      key: "resources",
      label: "Resources",
      hint: resourcesHint(project),
      done: resourcesReady(project),
    },
    {
      key: "plan",
      label: "Plan",
      hint: `v${project.plan_version} · ${agentCount} agent${agentCount === 1 ? "" : "s"}`,
      done: true,
    },
    {
      key: "compile",
      label: "Compile",
      hint: project.compiled ? "Compiled" : "Not compiled",
      done: project.compiled,
    },
    {
      key: "run",
      label: "Run",
      hint: runHint(project, run),
      done: run?.status === "completed" && !run.halted,
      busy: run?.status === "running",
    },
    {
      key: "deploy",
      label: "Deploy",
      hint: deployHint(project.deployment),
      done: Boolean(project.deployment?.live && !project.deployment.outdated),
    },
  ].map((s) => ({ ...s, href: paths.project(id, s.key) }));

  const assistantAvailable = ASSISTANT_STEPS.includes(step);
  const showAssistant = assistantAvailable && assistantOpen;

  function setAssistant(open) {
    setAssistantOpen(open);
    try {
      localStorage.setItem(ASSISTANT_KEY, open ? "1" : "0");
    } catch {
      // Not remembered across visits; still works for this one.
    }
  }

  // A new plan version (from a saved edit or the assistant) needs compiling again; the
  // run hook starts from an idle run of the new version by itself.
  function projectChanged(next) {
    setProject(next);
    onChanged();
  }

  function compiled() {
    setProject((p) => ({ ...p, compiled: true }));
    onChanged();
  }

  // Steps re-mount when the plan version changes, so nothing shows a stale draft.
  const stepKey = `${step}-${project.plan_version}`;

  return (
    <div className="workspace">
      <div className="workspace__main">
        <div className="page page--head">
          <ProjectHeader
            project={project}
            onRenamed={(updated) => {
              setProject((p) => ({
                ...p,
                name: updated.name,
                named: updated.named,
              }));
              onChanged();
            }}
            assistant={
              assistantAvailable && !assistantOpen
                ? { onOpen: () => setAssistant(true) }
                : null
            }
          />
        </div>
        {/* Its own bar so it stays in view (sticky) while the step below scrolls. */}
        <div className="stepper-bar">
          <div className="stepper-bar__inner">
            <Stepper steps={steps} current={step} />
          </div>
        </div>

        {step === "brief" && (
          // Not keyed by plan version: its model/tools editor saves new versions itself.
          <BriefStep
            project={project}
            tools={tools}
            providers={providers}
            onSaved={projectChanged}
          />
        )}
        {step === "resources" && (
          <ResourcesStep
            project={project}
            tab={tab}
            onKnowledgeChanged={knowledgeChanged}
            onDataChanged={dataChanged}
            onRevised={projectChanged}
          />
        )}
        {step === "plan" && (
          <PlanStep
            key={stepKey}
            project={project}
            onSaved={(next) => projectChanged(next)}
          />
        )}
        {step === "compile" && (
          <CompileStep key={stepKey} project={project} onCompiled={compiled} />
        )}
        {step === "run" && (
          <RunStep
            project={project}
            run={run}
            runId={runId}
            runVersion={runVersion}
            history={history}
            onOpenRun={(id) => {
              setDraftInput(null); // show that run's input, ready to run again
              open(id);
            }}
            draftInput={draftInput}
            onDraftInput={setDraftInput}
            onStart={start}
            onStop={stop}
            stopping={stopping}
            stopError={stopError}
          />
        )}
        {step === "deploy" && (
          <DeployStep
            project={project}
            onDeploymentChanged={deploymentChanged}
          />
        )}
      </div>

      {showAssistant && (
        <AssistantPanel
          project={project}
          tools={tools}
          providers={providers}
          onRevised={projectChanged}
          onResourcesChanged={() =>
            api.getProject(id).then(projectChanged, () => {})
          }
          onClose={() => setAssistant(false)}
        />
      )}
    </div>
  );
}
