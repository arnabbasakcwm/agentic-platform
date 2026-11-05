import { useState } from "react";
import { Icon } from "../../components/icons.jsx";
import {
  ActionBar,
  Button,
  ErrorCallout,
  LinkButton,
  MetaList,
  Panel,
  Pill,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { agentIndex, agentStyle } from "../../lib/flow.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";
import { canEditProject } from "../../lib/access.js";

/**
 * AgentCard (DESIGN.md §5.10): a 3px top bar in the agent's colour, its index, key and
 * role, its model as a pill, an excerpt of its real system prompt, its tools as chips,
 * and what it depends on, from the plan.
 */
function AgentCard({ agent, index, isRouter, externalTools }) {
  return (
    <article className="agent" style={{ ...agentStyle(index), "--i": index }}>
      <header className="agent__head">
        <span className="agent__index">{agentIndex(index)}</span>
        <div className="agent__who">
          <span className="agent__id">
            {agent.id}
            {isRouter && <Pill tone="violet">router</Pill>}
          </span>
          <span className="agent__role" title={agent.role}>
            {agent.role}
          </span>
        </div>
        <span className="agent__model" title={agent.llm.model}>
          {agent.llm.model}
        </span>
      </header>
      <div className="agent__body">
        <div className="agent__promptbox">
          <span className="agent__label">System prompt</span>
          <p className="agent__prompt" title={agent.system_prompt}>
            {agent.system_prompt}
          </p>
        </div>
        {agent.tools.length > 0 && (
          <div>
            <span className="agent__label">Tools</span>
            <div className="agent__tools">
              {agent.tools.map((t) => (
                <span
                  key={t}
                  className={`toolchip${externalTools.includes(t) ? " toolchip--external" : ""}`}
                  title={externalTools.includes(t) ? "Sends data to a third party" : undefined}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <footer className="agent__foot">
        <span className="agent__foot-label">
          <Icon name="loop" size={13} />
          Depends on
        </span>
        <span className="agent__deps">
          {agent.depends_on.length > 0
            ? agent.depends_on.map((d) => (
                <span key={d} className="agent__dep">
                  {d}
                </span>
              ))
            : <span className="agent__dep agent__dep--start">Start (task input)</span>}
        </span>
      </footer>
    </article>
  );
}

export function PlanStep({ project, onSaved }) {
  const { plan } = project;
  // Editing needs Edit access, and a project shared agent by agent has only those agents to show.
  const canEdit = canEditProject(project) && !project.restricted;
  const partial = Boolean(project.restricted);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [parseError, setParseError] = useState(null);
  const save = useAction();
  const external = project.side_effect_tools_enabled ?? [];

  function startEditing() {
    setDraft(JSON.stringify(plan, null, 2));
    setParseError(null);
    setEditing(true);
  }

  async function saveDraft() {
    let parsed;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setParseError({ errorType: "Invalid JSON", message: e.message });
      return;
    }
    setParseError(null);
    const updated = await save.run(() => api.updatePlan(project.project_id, parsed));
    if (!updated) return;
    onSaved(updated);
    setEditing(false);
  }

  return (
    <>
      <div className="page">
        {editing ? (
          <div className="ap-fade">
            <Panel
              title="Edit plan"
              subtitle="Saved plans are re-validated by the server before they replace the current one."
              actions={
                <div className="row">
                  <Button size="sm" onClick={() => setEditing(false)} disabled={save.busy}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" loading={save.busy} onClick={saveDraft}>
                    Save plan
                  </Button>
                </div>
              }
            >
              <textarea
                className="mono minh-plan-json"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Plan JSON"
                spellCheck={false}
              />
              <span className="field__hint">
                Dependency cycles, unknown agent ids and unknown tools are rejected. Saving a
                change means the project must be compiled again.
              </span>
              {(parseError || save.error) && (
                <div className="mt-sm">
                  <ErrorCallout error={parseError ?? save.error} />
                </div>
              )}
            </Panel>
          </div>
        ) : (
          <>
            {!partial && (
            <Panel title="Overview">
              <MetaList
                rows={[
                  ["Pattern", <Pill key="Pattern" tone="violet">{plan.orchestration_pattern}</Pill>],
                  ["Router", plan.supervisor_id ? <Pill tone="violet">{plan.supervisor_id}</Pill> : null],
                  [
                    "Limits",
                    <>
                      <Pill>{plan.bounds.max_steps} tool steps per agent</Pill>
                      <Pill>{plan.bounds.max_retries} attempts per agent</Pill>
                      <Pill>{plan.bounds.timeout_s}s per run</Pill>
                    </>,
                  ],
                ]}
              />
            </Panel>
            )}

            <section className="section ap-fade" aria-labelledby="agents-title">
              <header className="section__head">
                <h2 className="section__title" id="agents-title">
                  Agents
                </h2>
                <Pill tone="slate">{plan.agents.length} in this team</Pill>
                <div className="panel__spacer" />
                {canEdit && (
                  <Button size="sm" onClick={startEditing}>
                    <Icon name="edit" size={14} />
                    Edit as JSON
                  </Button>
                )}
              </header>
              <div className="agentgrid">
                {plan.agents.map((agent, i) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    index={i}
                    isRouter={agent.id === plan.supervisor_id}
                    externalTools={external}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </div>

      <ActionBar
        note={
          project.compiled
            ? "This plan is compiled and ready to run."
            : "Happy with the team? Compile the plan to make it runnable."
        }
      >
        <LinkButton href={paths.project(project.project_id, "brief")}>
          <Icon name="arrowLeft" />
          Back to Brief
        </LinkButton>
        <LinkButton variant="primary" href={paths.project(project.project_id, "compile")}>
          Compile
          <Icon name="arrowRight" />
        </LinkButton>
      </ActionBar>
    </>
  );
}
