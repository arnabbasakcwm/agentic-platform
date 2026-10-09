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
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";

function AgentCard({ agent, index, isRouter, externalTools }) {
  return (
    <article className="agent">
      <header className="agent__head">
        <span className="agent__index">{String(index + 1).padStart(2, "0")}</span>
        <span className="agent__id">{agent.id}</span>
        {isRouter && <Pill tone="accent">router</Pill>}
        <span className="agent__role" title={agent.role}>
          {agent.role}
        </span>
      </header>
      <div className="agent__body">
        <p className="agent__prompt" title={agent.system_prompt}>
          {agent.system_prompt}
        </p>
        <div className="agent__meta">
          <Pill>{agent.llm.model}</Pill>
          {agent.tools.map((t) => (
            <Pill key={t} tone={externalTools.includes(t) ? "warn" : undefined}>
              {t}
            </Pill>
          ))}
          {agent.depends_on.length > 0 && <Pill>after {agent.depends_on.join(", ")}</Pill>}
        </div>
      </div>
    </article>
  );
}

export function PlanStep({ project, onSaved }) {
  const { plan } = project;
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
        ) : (
          <>
            <Panel title="Overview">
              <MetaList
                rows={[
                  ["Pattern", <Pill key="Pattern" tone="accent">{plan.orchestration_pattern}</Pill>],
                  ["Router", plan.supervisor_id ? <Pill>{plan.supervisor_id}</Pill> : null],
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

            <Panel
              title="Agents"
              subtitle={`${plan.agents.length} in this team`}
              actions={
                <Button size="sm" onClick={startEditing}>
                  <Icon name="edit" size={14} />
                  Edit as JSON
                </Button>
              }
            >
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
            </Panel>
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
          Brief
        </LinkButton>
        <LinkButton variant="primary" href={paths.project(project.project_id, "compile")}>
          Compile
          <Icon name="arrowRight" />
        </LinkButton>
      </ActionBar>
    </>
  );
}
