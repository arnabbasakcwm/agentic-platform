import { useCallback, useEffect, useState } from "react";
import { AssistantPanel } from "../components/AssistantPanel.jsx";
import { Icon } from "../components/icons.jsx";
import { Stepper } from "../components/Stepper.jsx";
import { Button, Empty, ErrorCallout, LinkButton, PageHeader, Panel, Pill } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { projectTitle } from "../lib/format.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";
import { BriefStep } from "./project/BriefStep.jsx";
import { CompileStep } from "./project/CompileStep.jsx";
import { DeployStep } from "./project/DeployStep.jsx";
import { PlanStep } from "./project/PlanStep.jsx";
import { RunStep } from "./project/RunStep.jsx";

// The steps where the brief and plan can still change, so where the assistant is offered.
const ASSISTANT_STEPS = ["brief", "plan", "compile"];
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

function runHint(project, result) {
  if (result) return result.halted ? "Last run halted" : "Last run completed";
  return project.compiled ? "Ready" : "Needs compiling";
}

// One project, one step of its workflow per page. Mounted with key={id}, so switching
// projects starts from a clean slate; switching steps keeps the loaded project and the
// latest run result.
export function ProjectWorkspace({ id, step, onChanged }) {
  const [project, setProject] = useState(null);
  const [result, setResult] = useState(null);
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpen);
  const load = useAction();

  // Stable, so the deploy page's status polling isn't restarted on every render.
  const deploymentChanged = useCallback(
    (deployment) => {
      setProject((p) => (p ? { ...p, deployment } : p));
      if (!deployment?.in_progress) onChanged();
    },
    [onChanged],
  );

  useEffect(() => {
    let current = true;
    load.run(() => api.getProject(id)).then((loaded) => {
      if (current && loaded) setProject(loaded);
    });
    return () => {
      current = false;
    };
  }, [id, load.run]);

  if (load.error) {
    return (
      <div className="page">
        <Panel>
          <ErrorCallout error={load.error} />
          <div style={{ marginTop: 12 }}>
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
      hint: runHint(project, result),
      done: Boolean(result && !result.halted),
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

  // A new plan version (from a saved edit or the assistant) needs compiling again, and a
  // result on screen came from the old plan.
  function projectChanged(next, planChanged = true) {
    setProject(next);
    if (planChanged) setResult(null);
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
          <PageHeader
            title={projectTitle(project.brief, 110)}
            meta={
              <>
                <Pill tone="accent">{project.plan.orchestration_pattern}</Pill>
                {project.compiled ? (
                  <Pill tone="success" dot>
                    Ready to run
                  </Pill>
                ) : (
                  <Pill dot>Not compiled</Pill>
                )}
                <span className="mono muted">{project.project_id}</span>
              </>
            }
            actions={
              assistantAvailable && !assistantOpen ? (
                <Button onClick={() => setAssistant(true)} aria-expanded={false}>
                  <Icon name="chat" />
                  Assistant
                </Button>
              ) : null
            }
          />
          <Stepper steps={steps} current={step} />
        </div>

        {step === "brief" && <BriefStep key={stepKey} project={project} />}
        {step === "plan" && (
          <PlanStep key={stepKey} project={project} onSaved={(next) => projectChanged(next)} />
        )}
        {step === "compile" && <CompileStep key={stepKey} project={project} onCompiled={compiled} />}
        {step === "run" && <RunStep project={project} result={result} onResult={setResult} />}
        {step === "deploy" && (
          <DeployStep project={project} onDeploymentChanged={deploymentChanged} />
        )}
      </div>

      {showAssistant && (
        <AssistantPanel
          project={project}
          onRevised={projectChanged}
          onClose={() => setAssistant(false)}
        />
      )}
    </div>
  );
}
